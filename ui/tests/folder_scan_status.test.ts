import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelFolderScan,
  subscribeFolderScanProgress,
  type FolderScanProgressEvent,
} from "../src/bridge.ts";
import {
  createFolderScanController,
  isScanCancelledError,
  type FolderScanProgress,
} from "../src/utils/folder_scan_state.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import type { FolderDiffResult } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.resolve(__dirname, "../src");

test("FolderScanController: rejects re-entrant scan with busy status without interrupting active scan", async () => {
  let scanning = false;
  let progress: FolderScanProgress = { dirsScanned: 0, itemsFound: 0 };
  const cancelledIds: string[] = [];
  const resolvers: Array<{ scanId: string; resolve: (val: string) => void }> = [];

  const controller = createFolderScanController({
    onScanningChange: (v) => {
      scanning = v;
    },
    onProgressChange: (p) => {
      progress = p;
    },
    cancelRpc: (id) => {
      cancelledIds.push(id);
    },
    idPrefix: "test",
  });

  const p1 = controller.runScan(
    (scanId) =>
      new Promise<string>((resolve) => {
        resolvers.push({ scanId, resolve });
      })
  );
  const scan1Id = controller.getActiveScanId();
  assert.ok(scan1Id);
  assert.equal(scanning, true);
  assert.equal(controller.isBusy(), true);

  assert.equal(
    controller.handleProgress({ scan_id: scan1Id, dirs_scanned: 5, items_found: 42 }),
    true
  );
  assert.deepStrictEqual(progress, { dirsScanned: 5, itemsFound: 42 });

  // Attempt second scan while first is active -> must reject as busy without cancelling scan1
  let secondExecuteCalled = false;
  const out2 = await controller.runScan(async () => {
    secondExecuteCalled = true;
    return "should-not-run";
  });
  assert.deepStrictEqual(out2, { status: "busy" });
  assert.equal(secondExecuteCalled, false);
  assert.deepStrictEqual(cancelledIds, []);
  assert.equal(controller.getActiveScanId(), scan1Id);
  assert.equal(scanning, true);
  assert.equal(controller.isBusy(), true);
  assert.deepStrictEqual(progress, { dirsScanned: 5, itemsFound: 42 });

  // Unrelated scan_id progress is still ignored
  assert.equal(
    controller.handleProgress({ scan_id: "other-scan", dirs_scanned: 99, items_found: 999 }),
    false
  );
  assert.deepStrictEqual(progress, { dirsScanned: 5, itemsFound: 42 });

  // Resolve active scan1 -> completes and clears scanning
  resolvers[0].resolve("first-result");
  const out1 = await p1;
  assert.deepStrictEqual(out1, { status: "completed", result: "first-result" });
  assert.equal(scanning, false);
  assert.equal(controller.isBusy(), false);
  assert.equal(controller.getActiveScanId(), null);

  // Now a new scan can start
  const out3 = await controller.runScan(async () => "next-result");
  assert.deepStrictEqual(out3, { status: "completed", result: "next-result" });
});

test("FolderScanController: must cancel active scan before running a new scan", async () => {
  let scanning = false;
  const cancelledIds: string[] = [];
  let rejectFirst: ((err: Error) => void) | null = null;
  let resolveSecond: ((val: string) => void) | null = null;

  const controller = createFolderScanController({
    onScanningChange: (v) => {
      scanning = v;
    },
    onProgressChange: () => {},
    cancelRpc: (id) => {
      cancelledIds.push(id);
    },
    idPrefix: "sub",
  });

  const p1 = controller.runScan(
    () =>
      new Promise<string>((_, reject) => {
        rejectFirst = reject;
      })
  );
  const scan1Id = controller.getActiveScanId();
  assert.ok(scan1Id);

  // Re-entrant attempt before cancelling is rejected
  const busyOut = await controller.runScan(async () => "blocked");
  assert.deepStrictEqual(busyOut, { status: "busy" });
  assert.deepStrictEqual(cancelledIds, []);

  // Cancel active scan -> now a new scan can be started
  const cancelledId = controller.cancelActiveScan();
  assert.equal(cancelledId, scan1Id);
  assert.deepStrictEqual(cancelledIds, [scan1Id]);
  assert.equal(scanning, false);

  const p2 = controller.runScan(
    () =>
      new Promise<string>((resolve) => {
        resolveSecond = resolve;
      })
  );
  const scan2Id = controller.getActiveScanId();
  assert.ok(scan2Id);
  assert.notEqual(scan1Id, scan2Id);
  assert.equal(scanning, true);

  // Late rejection of scan1 must not clobber scan2
  rejectFirst!(new Error("SCAN_CANCELLED"));
  const out1 = await p1;
  assert.equal(out1.status, "stale");
  assert.equal(scanning, true);
  assert.equal(controller.getActiveScanId(), scan2Id);

  resolveSecond!("after-cancel");
  const out2 = await p2;
  assert.deepStrictEqual(out2, { status: "completed", result: "after-cancel" });
  assert.equal(scanning, false);
  assert.equal(controller.getActiveScanId(), null);
});

test("FolderScanController: cancelActiveScan clears scanning immediately and ignores late resolution", async () => {
  let scanning = false;
  const cancelledIds: string[] = [];
  let rejectFn: ((err: Error) => void) | null = null;

  const controller = createFolderScanController({
    onScanningChange: (v) => {
      scanning = v;
    },
    onProgressChange: () => {},
    cancelRpc: (id) => {
      cancelledIds.push(id);
    },
  });

  const scanPromise = controller.runScan(
    () =>
      new Promise<string>((_, reject) => {
        rejectFn = reject;
      })
  );
  const activeId = controller.getActiveScanId();
  assert.ok(activeId);
  assert.equal(scanning, true);

  const cancelledId = controller.cancelActiveScan();
  assert.equal(cancelledId, activeId);
  assert.equal(scanning, false);
  assert.equal(controller.getActiveScanId(), null);
  assert.deepStrictEqual(cancelledIds, [activeId]);

  rejectFn!(new Error("SCAN_CANCELLED"));
  const outcome = await scanPromise;
  assert.equal(outcome.status, "stale");
  assert.equal(scanning, false);
});

test("FolderScanController: backend SCAN_CANCELLED error finishes silently as cancelled", async () => {
  let scanning = false;
  const controller = createFolderScanController({
    onScanningChange: (v) => {
      scanning = v;
    },
    onProgressChange: () => {},
    cancelRpc: () => {},
  });

  const outcome = await controller.runScan(async () => {
    throw new Error("SCAN_CANCELLED");
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(scanning, false);
  assert.equal(isScanCancelledError(new Error("SCAN_CANCELLED")), true);
  assert.equal(isScanCancelledError(new Error("Permission denied")), false);

  const errOutcome = await controller.runScan(async () => {
    throw new Error("Permission denied");
  });
  assert.equal(errOutcome.status, "error");
  assert.equal(scanning, false);
});

test("bridge: cancelFolderScan calls cancel_folder_scan RPC and subscribeFolderScanProgress manages EventSource", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const rpcCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    rpcCalls.push(body);
    return new Response(JSON.stringify({ ok: true, data: { cancelled: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  let esInstances = 0;
  let esClosed = 0;
  const listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  class MockEventSource {
    url: string;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      esInstances += 1;
    }
    addEventListener(type: string, cb: (ev: MessageEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    }
    close() {
      esClosed += 1;
    }
  }
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;

  try {
    const res = await cancelFolderScan("scan-123");
    assert.deepStrictEqual(res, { cancelled: true });
    assert.deepStrictEqual(rpcCalls[0], {
      cmd: "cancel_folder_scan",
      args: { scan_id: "scan-123" },
    });

    const received1: FolderScanProgressEvent[] = [];
    const received2: FolderScanProgressEvent[] = [];
    const unsub1 = subscribeFolderScanProgress((ev) => received1.push(ev));
    const unsub2 = subscribeFolderScanProgress((ev) => received2.push(ev));

    // Reuses a single EventSource across multiple subscribers
    assert.equal(esInstances, 1);

    const sseHandlers = listeners.get("folder_scan_progress");
    assert.ok(sseHandlers && sseHandlers.size === 1);
    const payload = JSON.stringify({
      scan_id: "scan-123",
      dirs_scanned: 12,
      items_found: 345,
    });
    for (const h of sseHandlers) {
      h({ data: payload } as MessageEvent);
    }

    assert.deepStrictEqual(received1, [
      { scan_id: "scan-123", dirs_scanned: 12, items_found: 345 },
    ]);
    assert.deepStrictEqual(received2, [
      { scan_id: "scan-123", dirs_scanned: 12, items_found: 345 },
    ]);

    unsub1();
    assert.equal(esClosed, 0);
    unsub2();
    assert.equal(esClosed, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) {
      delete (globalThis as Record<string, unknown>).EventSource;
    } else {
      globalThis.EventSource = originalEventSource;
    }
  }
});

test("i18n & FolderDiffView statusbar contracts: progress, truncated hint, expandAll & recursive fix", () => {
  assert.equal(
    zhCN.folder_diff.scanning_progress
      .replace("{items}", "120")
      .replace("{dirs}", "8"),
    "正在扫描 · 已发现 120 项 / 8 目录"
  );
  assert.equal(zhCN.folder_diff.cancel_scan, "取消");
  assert.equal(zhCN.folder_diff.truncated_hint, "(已截断至 30,000 项)");
  assert.equal(zhCN.folder_diff.status_total_items.replace("{count}", "5"), "5 项");
  const enUsSrc = fs.readFileSync(path.join(uiSrcDir, "i18n/en-US.ts"), "utf8");
  assert.ok(enUsSrc.includes('scanning_progress: "Scanning · {items} items / {dirs} dirs"'));
  assert.ok(enUsSrc.includes('cancel_scan: "Cancel"'));
  assert.ok(enUsSrc.includes('truncated_hint: "(truncated at 30,000 items)"'));

  const sampleTruncatedResult: FolderDiffResult = {
    left_root: "/a",
    right_root: "/b",
    entries: [],
    stats: {
      total_items: 0,
      equal_items: 0,
      modified_items: 0,
      left_only_items: 0,
      right_only_items: 0,
    },
    truncated: true,
  };
  assert.equal(sampleTruncatedResult.truncated, true);

  const folderViewSrc = fs.readFileSync(
    path.join(uiSrcDir, "views/FolderDiffView.tsx"),
    "utf8"
  );
  // L129 fix: must check `!recursive`, not `!props.expandAll && !recursive`
  assert.equal(folderViewSrc.includes("!props.expandAll && !recursive"), false);
  assert.ok(folderViewSrc.includes("if (!recursive)"));
  // expandAll must abort before clearing collapsedDirs when scan fails or is cancelled
  assert.match(
    folderViewSrc,
    /const ok = await scanRealFolders\(leftInput\(\), rightInput\(\), true\);\s*if \(!ok\) \{\s*return;\s*\}/
  );
  // No scanning Toast in expandAll or refreshSubfolder
  assert.equal(folderViewSrc.includes("folder_diff.expanding_all"), false);
  assert.equal(folderViewSrc.includes("folder_diff.scanning_subdir"), false);
  // Status bar contains progress, cancel button, and truncated hint
  assert.ok(folderViewSrc.includes("statusbar-scan-progress"));
  assert.ok(folderViewSrc.includes("statusbar-cancel-btn"));
  assert.ok(folderViewSrc.includes("statusbar-truncated"));

  // Mutual exclusion & compare_subfolder progress/cancel/recursive-expand contracts
  assert.equal(
    zhCN.folder_diff.busy_reject,
    "当前已有扫描操作正在进行，请先取消后再运行"
  );
  assert.ok(
    enUsSrc.includes(
      'busy_reject: "A scan operation is already in progress. Please cancel it first."'
    )
  );
  assert.ok(folderViewSrc.includes('t("folder_diff.busy_reject")'));
  assert.ok(folderViewSrc.includes("scan_id: scanId"));
  assert.match(
    folderViewSrc,
    /fetchSubfolder\s*=\s*\(subRel:\s*string,\s*recursive\s*=\s*false,\s*scanId\?:\s*string\)/
  );
  assert.ok(folderViewSrc.includes("rollbackScannedDir(subRel)"));
  assert.match(
    folderViewSrc,
    /const refreshSubfolder[\s\S]*scanController\.runScan\(\(scanId\) =>\s*fetchSubfolder\(subRel, recursive, scanId\)/
  );
  assert.match(
    folderViewSrc,
    /const expandAll = async \(\) => \{\s*if \(isScanning\(\)\) \{\s*notify\(t\("folder_diff\.busy_reject"\)\);\s*return;\s*\}/
  );
});
