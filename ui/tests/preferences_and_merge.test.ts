import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callRustRpc,
  CompareBackendClient,
  loadRealThreeWayFiles,
  resolveThreeWayHunk,
  saveThreeWayMerged,
  subscribeUserPreferences,
} from "../src/bridge.ts";
import {
  computeNextHunkIndex,
  computeThreeWayNavTarget,
  DEFAULT_FOLDER_EXCLUDE_GLOBS,
  formatGlyphText,
  mergeFolderExcludeGlobs,
  parseGlobsInput,
} from "../src/utils/preferences.ts";
import {
  collectExpandedLoadedDirs,
  mergeSubtreeEntries,
  mergeTopLevelPreservingSubtrees,
  resolveBatchTargetPaths,
} from "../src/utils/folder_sync.ts";
import type { ThreeWayHunk } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.resolve(__dirname, "../src");

test("P1-1: mergeFolderExcludeGlobs respects user prefs (including empty []) and normalizes CLI -filters", () => {
  assert.deepStrictEqual(
    mergeFolderExcludeGlobs(undefined, undefined),
    [...DEFAULT_FOLDER_EXCLUDE_GLOBS]
  );

  // Explicit empty array from SettingsModal must NOT revert to hardcoded defaults
  assert.deepStrictEqual(mergeFolderExcludeGlobs([], undefined), []);

  // Custom prefs + Beyond Compare style CLI -filters
  const merged = mergeFolderExcludeGlobs(
    ["dist", "*.log"],
    ["-*.tmp", "-target/", "+*.rs", "*.bak", "dist"]
  );
  assert.deepStrictEqual(merged, ["dist", "*.log", "*.tmp", "target", "*.bak"]);

  assert.deepStrictEqual(
    parseGlobsInput(".git, node_modules; *.tmp\nbuild/"),
    [".git", "node_modules", "*.tmp", "build/"]
  );
});

test("P1-1: computeNextHunkIndex respects wrap_around_navigation setting", () => {
  // Wrap around enabled
  assert.deepStrictEqual(computeNextHunkIndex(2, 3, 1, true), {
    nextIdx: 0,
    boundary: null,
  });
  assert.deepStrictEqual(computeNextHunkIndex(0, 3, -1, true), {
    nextIdx: 2,
    boundary: null,
  });

  // Wrap around disabled
  assert.deepStrictEqual(computeNextHunkIndex(2, 3, 1, false), {
    nextIdx: 2,
    boundary: "last",
  });
  assert.deepStrictEqual(computeNextHunkIndex(0, 3, -1, false), {
    nextIdx: 0,
    boundary: "first",
  });
  assert.deepStrictEqual(computeNextHunkIndex(1, 3, 1, false), {
    nextIdx: 2,
    boundary: null,
  });
});

test("P1-1: formatGlyphText scales tab glyphs according to tab_width", () => {
  assert.strictEqual(formatGlyphText("\ta b", false, 2), "\ta b");
  assert.strictEqual(formatGlyphText("\ta b", true, 2), "→ a·b");
  assert.strictEqual(formatGlyphText("\ta b", true, 4), "→   a·b");
  assert.strictEqual(formatGlyphText("\ta", true, 8), "→       a");
});

test("P1-2: computeThreeWayNavTarget prioritizes conflict hunks and falls back to all hunks", () => {
  const mixedHunks: ThreeWayHunk[] = [
    {
      id: 0,
      status: "left_modified",
      resolution: "use_left",
      virtual_start: 1,
      virtual_end: 2,
      base_range: { start: 1, end: 2 },
      left_range: { start: 1, end: 2 },
      right_range: { start: 1, end: 2 },
    },
    {
      id: 1,
      status: "conflict",
      resolution: "unresolved",
      virtual_start: 5,
      virtual_end: 8,
      base_range: { start: 5, end: 6 },
      left_range: { start: 5, end: 8 },
      right_range: { start: 5, end: 7 },
    },
    {
      id: 2,
      status: "conflict",
      resolution: "unresolved",
      virtual_start: 12,
      virtual_end: 15,
      base_range: { start: 10, end: 11 },
      left_range: { start: 12, end: 15 },
      right_range: { start: 11, end: 13 },
    },
  ];

  // Starts at first conflict (id=1), skipping auto-merged hunk 0
  const first = computeThreeWayNavTarget(mixedHunks, null, 1, true);
  assert.strictEqual(first.targetHunk?.id, 1);

  // Advances to next conflict (id=2)
  const second = computeThreeWayNavTarget(mixedHunks, 1, 1, true);
  assert.strictEqual(second.targetHunk?.id, 2);

  // Stops at boundary when wrapAround=false
  const atEnd = computeThreeWayNavTarget(mixedHunks, 2, 1, false);
  assert.strictEqual(atEnd.boundary, "last");
  assert.strictEqual(atEnd.targetHunk?.id, 2);

  // When no conflicts exist, navigates auto-merged hunks
  const autoOnly = [mixedHunks[0]];
  const autoNav = computeThreeWayNavTarget(autoOnly, null, 1, true);
  assert.strictEqual(autoNav.targetHunk?.id, 0);
});

test("P1-2: 3-Way merge resolves sync to backendSessionId and calls save_three_way_merged", async () => {
  const rpcCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      cmd: string;
      args: Record<string, unknown>;
    };
    rpcCalls.push(body);
    if (body.cmd === "open_three_way_files") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            session_id: "merge-backend-42",
            summary: {
              total_virtual_rows: 3,
              hunks: [
                {
                  id: 0,
                  status: "conflict",
                  resolution: "unresolved",
                  virtual_start: 1,
                  virtual_end: 2,
                  base_range: { start: 1, end: 2 },
                  left_range: { start: 1, end: 2 },
                  right_range: { start: 1, end: 2 },
                },
              ],
              unresolved_conflicts: 1,
              merged_lines: ["a", "<<<<<<< LEFT", "b1", "=======", "b2", ">>>>>>> RIGHT", "c"],
            },
            initial_rows: [
              {
                virtual_idx: 0,
                left_line_no: 1,
                base_line_no: 1,
                right_line_no: 1,
                left_text: "a",
                base_text: "a",
                right_text: "a",
                status: "equal",
                hunk_id: null,
              },
              {
                virtual_idx: 1,
                left_line_no: 2,
                base_line_no: 2,
                right_line_no: 2,
                left_text: "b1",
                base_text: "b",
                right_text: "b2",
                status: "conflict",
                hunk_id: 0,
              },
              {
                virtual_idx: 2,
                left_line_no: 3,
                base_line_no: 3,
                right_line_no: 3,
                left_text: "c",
                base_text: "c",
                right_text: "c",
                status: "equal",
                hunk_id: null,
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (body.cmd === "resolve_three_way_conflict") {
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
    }
    if (body.cmd === "save_three_way_merged") {
      return new Response(JSON.stringify({ ok: true, data: { saved: true } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ ok: false, error: `Unknown cmd: ${body.cmd}` }),
      { status: 400 }
    );
  }) as typeof fetch;

  try {
    const loaded = await loadRealThreeWayFiles(
      "tab-three_way-99",
      "/tmp/l.txt",
      "/tmp/b.txt",
      "/tmp/r.txt",
      "/tmp/out.txt"
    );
    assert.ok(loaded);
    assert.strictEqual(loaded.summary.unresolved_conflicts, 1);

    const updated = resolveThreeWayHunk("tab-three_way-99", 0, "use_left");
    assert.strictEqual(updated.unresolved_conflicts, 0);
    assert.deepStrictEqual(updated.merged_lines, ["a", "b1", "c"]);

    const saveRes = await saveThreeWayMerged("tab-three_way-99", "/tmp/out.txt");
    assert.deepStrictEqual(saveRes, { saved: true, usedBackend: true });

    assert.deepStrictEqual(
      rpcCalls.map((c) => c.cmd),
      ["open_three_way_files", "resolve_three_way_conflict", "save_three_way_merged"]
    );
    assert.strictEqual(rpcCalls[1].args.session_id, "merge-backend-42");
    assert.strictEqual(rpcCalls[2].args.session_id, "merge-backend-42");
    assert.strictEqual(rpcCalls[2].args.target_path, "/tmp/out.txt");

    // Explicit RPC error should propagate instead of silently returning null
    await assert.rejects(
      () => callRustRpc("non_existent_cmd"),
      /Unknown cmd: non_existent_cmd/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("P1-1 & P1-3 source contracts: no hardcoded exclude_globs in FolderDiffView and settings wired", () => {
  const folderSrc = fs.readFileSync(
    path.join(uiSrcDir, "views/FolderDiffView.tsx"),
    "utf8"
  );
  assert.strictEqual(
    folderSrc.includes('exclude_globs: [".git"'),
    false,
    "FolderDiffView must not hardcode exclude_globs"
  );
  assert.ok(
    folderSrc.includes("recursive: isRecursiveScan()"),
    "sync_folder_item must forward recursive: isRecursiveScan()"
  );
  assert.ok(
    folderSrc.includes('"delete_left"') && folderSrc.includes('"delete_right"'),
    "FolderDiffView must support delete_left and delete_right"
  );

  const settingsSrc = fs.readFileSync(
    path.join(uiSrcDir, "components/SettingsModal.tsx"),
    "utf8"
  );
  assert.ok(
    settingsSrc.includes("syntax_highlighting"),
    "SettingsModal must expose syntax_highlighting toggle"
  );
});

test("P0-2: loadRealDiskFiles preserves encoding & line_ending and rejects on read errors", async () => {
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      cmd: string;
      args: Record<string, unknown>;
    };
    if (body.cmd === "read_text_file") {
      if (body.args.path === "/tmp/gbk.txt") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              path: "/tmp/gbk.txt",
              content: "第一行\n第二行",
              line_count: 2,
              encoding: "GB18030",
              line_ending: "CRLF",
            },
          }),
          { status: 200 }
        );
      }
      if (body.args.path === "/tmp/utf16.txt") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              path: "/tmp/utf16.txt",
              content: "alpha\nbeta",
              line_count: 2,
              encoding: "UTF-16 LE",
              line_ending: "CR",
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: `无法读取文件 (${body.args.path}): No such file or directory`,
        }),
        { status: 400 }
      );
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await CompareBackendClient.loadRealDiskFiles(
      "test-encoding-preserve",
      "/tmp/gbk.txt",
      "/tmp/utf16.txt",
      {
        ignore_whitespace: false,
        ignore_case: false,
        show_only_diffs: false,
        context_lines: 3,
      }
    );
    assert.ok(res);
    assert.strictEqual(res.left_encoding, "GB18030");
    assert.strictEqual(res.left_line_ending, "CRLF");
    assert.strictEqual(res.right_encoding, "UTF-16 LE");
    assert.strictEqual(res.right_line_ending, "CR");

    const swapped = CompareBackendClient.swapSides("test-encoding-preserve");
    assert.strictEqual(swapped.left_encoding, "UTF-16 LE");
    assert.strictEqual(swapped.left_line_ending, "CR");
    assert.strictEqual(swapped.right_encoding, "GB18030");
    assert.strictEqual(swapped.right_line_ending, "CRLF");

    // Missing file must reject instead of silently loading empty string
    await assert.rejects(
      () =>
        CompareBackendClient.loadRealDiskFiles(
          "test-encoding-missing",
          "/tmp/missing.txt",
          "/tmp/utf16.txt",
          {
            ignore_whitespace: false,
            ignore_case: false,
            show_only_diffs: false,
            context_lines: 3,
          }
        ),
      /No such file or directory/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});


test("Regression: preference createEffect uses untrack to prevent SolidJS infinite recursion", async () => {
  const { createRoot, createSignal, createEffect, untrack } = await import(
    "../node_modules/solid-js/dist/solid.js"
  );

  const textViewSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/TextDiffView.tsx"),
    "utf8"
  );
  const folderViewSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/FolderDiffView.tsx"),
    "utf8"
  );
  assert.match(textViewSrc, /untrack\(\(\) => applyUserPreferences\(prefs,\s*mountedOnce\)\)/);
  assert.match(folderViewSrc, /untrack\(\(\) => applyFolderPreferences\(prefs,\s*folderMountedOnce\)\)/);

  let runs = 0;
  let disposeFn: (() => void) | undefined;
  let updatePrefs: ((v: { ignore_whitespace: boolean }) => void) | undefined;
  let getOptions: (() => { ignore_whitespace: boolean }) | undefined;

  createRoot((dispose) => {
    disposeFn = dispose;
    const [prefs, setPrefs] = createSignal<{ ignore_whitespace: boolean } | null>({
      ignore_whitespace: false,
    });
    const [options, setOptions] = createSignal({ ignore_whitespace: false });
    updatePrefs = setPrefs;
    getOptions = options;

    createEffect(() => {
      const p = prefs();
      if (!p) return;
      untrack(() => {
        runs += 1;
        const prev = options();
        if (prev.ignore_whitespace !== p.ignore_whitespace || runs === 1) {
          setOptions({ ignore_whitespace: p.ignore_whitespace });
        }
      });
    });
  });

  await Promise.resolve();
  assert.strictEqual(runs, 1);
  updatePrefs?.({ ignore_whitespace: true });
  await Promise.resolve();
  assert.strictEqual(runs, 2);
  assert.strictEqual(getOptions?.().ignore_whitespace, true);
  disposeFn?.();
});


test("FolderDiffView single-side focus & one-shot compare_to_another contract", () => {
  const folderSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/FolderDiffView.tsx"),
    "utf8"
  );
  // Plain click replaces selection with single item; Ctrl/Cmd + click toggles in selectedItems (same-side or cross-side)
  assert.match(folderSrc, /setSelectedItems\(\[target\]\)/);
  assert.match(folderSrc, /items\.length !== 2/);
  assert.match(folderSrc, /selectedFilePair\(\)/);
  // Ctrl/Cmd + click still allows pairing 2 items
  assert.match(folderSrc, /e\?\.ctrlKey \|\| e\?\.metaKey/);
  // Context menu uses one-shot Compare To... instead of persistent "Select as Left/Right"
  assert.match(folderSrc, /folder_diff\.compare_to_another/);
  assert.doesNotMatch(folderSrc, /folder_diff\.select_as_left/);
  assert.doesNotMatch(folderSrc, /folder_diff\.select_as_right/);
  // No inline "selected left/right" badge, no jumping compare banner, and no inline copy buttons on directory rows
  assert.doesNotMatch(folderSrc, /side-selected-tag/);
  assert.doesNotMatch(folderSrc, /selected-compare-bar/);
  assert.match(folderSrc, /!props\.entry\.is_dir && props\.entry\.status !== "equal" && props\.entry\.status !== "right_only"/);
  assert.match(folderSrc, /!props\.entry\.is_dir && props\.entry\.status !== "equal" && props\.entry\.status !== "left_only"/);
});

test("FolderDiffView context menu copy/delete/global actions & full-height hit-area contracts", () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const folderSrc = fs.readFileSync(path.join(rootDir, "src/views/FolderDiffView.tsx"), "utf8");
  const stylesSrc = fs.readFileSync(path.join(rootDir, "src/styles.css"), "utf8");

  // Selection-driven copy visibility: only show target side copy when that side is selected, hide when both sides selected
  assert.match(folderSrc, /const hasLeftSel = selectedItems\(\)\.some\(\(i\) => i\.side === "left"\);/);
  assert.match(folderSrc, /const hasRightSel = selectedItems\(\)\.some\(\(i\) => i\.side === "right"\);/);
  assert.match(folderSrc, /const bothSidesSelected = hasLeftSel && hasRightSel;/);
  assert.match(folderSrc, /!bothSidesSelected && hasLeftSel && entry\.status !== "right_only"/);
  assert.match(folderSrc, /!bothSidesSelected && hasRightSel && entry\.status !== "left_only"/);
  assert.match(folderSrc, /folder_diff\.copy_to_right_item/);
  assert.match(folderSrc, /folder_diff\.copy_to_left_item/);

  // Unified delete selected item (no split delete_left_item / delete_right_item, no clear_selection)
  assert.match(folderSrc, /folder_diff\.delete_selected_item/);
  assert.doesNotMatch(folderSrc, /folder_diff\.delete_left_item/);
  assert.doesNotMatch(folderSrc, /folder_diff\.delete_right_item/);
  assert.doesNotMatch(folderSrc, /folder_diff\.clear_selection/);

  // Global actions retained in folder context menu
  assert.match(folderSrc, /folder_diff\.ctx_swap_dirs/);
  assert.match(folderSrc, /folder_diff\.ctx_rescan/);

  // Full-height row hit-area & center-column click isolation
  assert.match(folderSrc, /<div class="folder-col-center" onClick=\{\(e\) => e\.stopPropagation\(\)\}>/);
  assert.match(stylesSrc, /\.folder-col-left,\s*\.folder-col-right\s*\{[^}]*height:\s*100%;/);
});

test("TextDiffView context menu readonly/null-row guards & no global swap/reload", () => {
  const textSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/TextDiffView.tsx"),
    "utf8"
  );
  const menuMatch = textSrc.match(/<Show when=\{contextMenu\(\)\}>[\s\S]*?<\/Show>\s*\n\s*\{\/\* 视图与规则浮动菜单/);
  assert.ok(menuMatch, "expected TextDiffView context menu block");
  const menuBlock = menuMatch[0];

  // Merge actions gated on target side writability
  assert.match(menuBlock, /<Show when=\{!isRightReadonly\(\)\}>/);
  assert.match(menuBlock, /<Show when=\{!isLeftReadonly\(\)\}>/);
  // Edit/undo/redo/save gated on active side writability
  assert.match(menuBlock, /<Show when=\{!isSideReadonly\(isLeft\(\)\)\}>/);
  // Copy line gated on non-null text on that side
  assert.match(
    menuBlock,
    /<Show\s+when=\{\s*menu\(\)\.row &&\s*\(isLeft\(\) \? menu\(\)\.row!\.left_text !== null : menu\(\)\.row!\.right_text !== null\)\s*\}\s*>/
  );
  // Global swap_sides / reload removed from context menu
  assert.doesNotMatch(menuBlock, /text_diff\.swap_sides/);
  assert.doesNotMatch(menuBlock, /text_diff\.reload/);
});

test("FolderDiffView sync_folder_item preserves expanded subdirs & subtree merge", () => {
  // 1. collectExpandedLoadedDirs filters collapsed dirs and sorts shallow-to-deep
  const scanned = new Set(["a/b/c", "b", "a", "a/b", "collapsed_dir"]);
  const collapsed = new Set(["collapsed_dir"]);
  assert.deepEqual(collectExpandedLoadedDirs(scanned, collapsed), [
    "a",
    "b",
    "a/b",
    "a/b/c",
  ]);

  // 2. mergeSubtreeEntries updates parent status and replaces cached subtree children
  const baseEntries = [
    {
      relative_path: "prometheus",
      is_dir: true,
      status: "right_only" as const,
      left_size: null,
      right_size: null,
      left_modified_ms: null,
      right_modified_ms: 100,
    },
    {
      relative_path: "prometheus/old.yml",
      is_dir: false,
      status: "right_only" as const,
      left_size: null,
      right_size: 10,
      left_modified_ms: null,
      right_modified_ms: 100,
    },
    {
      relative_path: "tools",
      is_dir: true,
      status: "right_only" as const,
      left_size: null,
      right_size: null,
      left_modified_ms: null,
      right_modified_ms: 100,
    },
  ];

  const merged = mergeSubtreeEntries(baseEntries, {
    relative_path: "prometheus",
    status: "modified",
    entries: [
      {
        relative_path: "prometheus/alert.yml",
        is_dir: false,
        status: "equal",
        left_size: 42,
        right_size: 42,
        left_modified_ms: 200,
        right_modified_ms: 200,
      },
    ],
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[0].relative_path, "prometheus");
  assert.equal(merged[0].status, "modified");
  assert.equal(merged[1].relative_path, "prometheus/alert.yml");
  assert.equal(merged[1].status, "equal");
  assert.equal(merged[2].relative_path, "tools");

  // Missing parent returns shallow copy unchanged
  const untouched = mergeSubtreeEntries(baseEntries, {
    relative_path: "nonexistent",
    status: "equal",
    entries: [],
  });
  assert.deepEqual(untouched, baseEntries);

  // 3. mergeTopLevelPreservingSubtrees retains untouched expanded subtrees and drops invalidatedDir
  const preserved = mergeTopLevelPreservingSubtrees(
    [
      {
        relative_path: "certs",
        is_dir: true,
        status: "modified",
        left_size: null,
        right_size: null,
        left_modified_ms: 10,
        right_modified_ms: 10,
      },
      {
        relative_path: "certs/a.pem",
        is_dir: false,
        status: "equal",
        left_size: 5,
        right_size: 5,
        left_modified_ms: 10,
        right_modified_ms: 10,
      },
      {
        relative_path: "deleted_dir",
        is_dir: true,
        status: "left_only",
        left_size: null,
        right_size: null,
        left_modified_ms: 10,
        right_modified_ms: 0,
      },
      {
        relative_path: "deleted_dir/x.txt",
        is_dir: false,
        status: "left_only",
        left_size: 3,
        right_size: null,
        left_modified_ms: 10,
        right_modified_ms: 0,
      },
    ],
    [
      {
        relative_path: "certs",
        is_dir: true,
        status: "modified",
        left_size: null,
        right_size: null,
        left_modified_ms: 20,
        right_modified_ms: 20,
      },
    ],
    "deleted_dir"
  );
  assert.deepEqual(
    preserved.map((e) => e.relative_path),
    ["certs", "certs/a.pem"]
  );

  // 4. Source contract: copy & delete use atomic applySyncFolderResult and preserve scrollTop
  const folderSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/FolderDiffView.tsx"),
    "utf8"
  );
  assert.equal((folderSrc.match(/setFolderData\(remoteRes\)/g) ?? []).length, 1);
  assert.equal((folderSrc.match(/await applySyncFolderResult\(\s*lastRemoteRes,/g) ?? []).length, 2);
  assert.match(folderSrc, /mergeTopLevelPreservingSubtrees\(/);
  assert.match(folderSrc, /const prevScrollTop = treeBodyRef\?\.scrollTop \?\? 0;/);
  assert.match(folderSrc, /if \(treeBodyRef\) treeBodyRef\.scrollTop = prevScrollTop;/);
});

test("FolderDiffView multi-select batch copy/delete target resolution", () => {
  // Multi-select within selected items returns all unique targets excluding descendants of selected dirs
  assert.deepEqual(
    resolveBatchTargetPaths("a.txt", ["dir1", "dir1/child.txt", "a.txt", "b.txt", "a.txt"]),
    ["dir1", "a.txt", "b.txt"]
  );
  // Right-clicking an unselected item targets only that item
  assert.deepEqual(resolveBatchTargetPaths("other.txt", ["a.txt", "b.txt"]), ["other.txt"]);

  const folderSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views/FolderDiffView.tsx"),
    "utf8"
  );
  assert.equal((folderSrc.match(/resolveBatchTargetPaths\(/g) ?? []).length, 3);
  assert.match(folderSrc, /handleCopyItem\("left_to_right", targets\)/);
  assert.match(folderSrc, /handleCopyItem\("right_to_left", targets\)/);
});

test("App global userPrefs syncs when update_user_preferences is called", async () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ text_row_filter?: string }> = [];
  const unsub = subscribeUserPreferences((prefs) => {
    received.push(prefs);
  });
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            text_row_filter: "all",
            folder_filter_status: "diffs",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    await callRustRpc("update_user_preferences", { text_row_filter: "all" });
    assert.equal(received.length, 1);
    assert.equal(received[0].text_row_filter, "all");
  } finally {
    unsub();
    globalThis.fetch = originalFetch;
  }

  const appSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx"),
    "utf8"
  );
  assert.match(appSrc, /subscribeUserPreferences\(\(nextPrefs\) => \{\s*setUserPrefs\(nextPrefs\);/);
});
