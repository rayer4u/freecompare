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

test("FolderScanController: discards stale scanSeq response and cancels superseded scan", async () => {
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

  // Start second scan before first finishes
  const p2 = controller.runScan(
    (scanId) =>
      new Promise<string>((resolve) => {
        resolvers.push({ scanId, resolve });
      })
  );
  const scan2Id = controller.getActiveScanId();
  assert.ok(scan2Id);
  assert.notEqual(scan1Id, scan2Id);
  assert.deepStrictEqual(cancelledIds, [scan1Id]);
  assert.equal(scanning, true);

  // Progress for stale scan1 must be ignored; progress for scan2 must apply
  assert.equal(
    controller.handleProgress({ scan_id: scan1Id, dirs_scanned: 99, items_found: 999 }),
    false
  );
  assert.deepStrictEqual(progress, { dirsScanned: 0, itemsFound: 0 });
  assert.equal(
    controller.handleProgress({ scan_id: scan2Id, dirs_scanned: 5, items_found: 42 }),
    true
  );
  assert.deepStrictEqual(progress, { dirsScanned: 5, itemsFound: 42 });

  // Resolve stale scan1 first -> must be discarded and keep scanning=true
  resolvers[0].resolve("old-result");
  const out1 = await p1;
  assert.equal(out1.status, "stale");
  assert.equal(scanning, true);
  assert.equal(controller.getActiveScanId(), scan2Id);

  // Resolve active scan2 -> completes and clears scanning
  resolvers[1].resolve("new-result");
  const out2 = await p2;
  assert.deepStrictEqual(out2, { status: "completed", result: "new-result" });
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
});
