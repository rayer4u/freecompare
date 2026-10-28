import type {
  ConflictResolution,
  DiffOptions,
  DiffRowFilter as ViewRowFilter,
  DiffStats,
  DiffStatus,
  FolderDiffResult,
  FolderEntryDto,
  InlineSegment,
  MergeDirection,
  SyntaxToken,
  ThreeWayDiffResult,
  ThreeWayHunk,
  ThreeWayRow,
  ThreeWayStatus,
  TwoWayDiffResult,
  TwoWayHunk,
  ViewportRowDto,
  ViewportSliceDto,
} from "./types.ts";
import {
  computeInlineSegments,
  computeTwoWayDiffCore,
  type DiffComputationResult,
} from "./diff_core.ts";
import { computeDiffAsync } from "./diff_worker_client.ts";

export { computeInlineSegments };

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export interface StartupLaunchSessionDto {
  kind: "two_way_text" | "three_way_merge" | "folder_compare" | null;
  session_id: string | null;
  title: string;
  left_path: string;
  right_path: string;
  base_path: string | null;
  output_path: string | null;
  titles: [string | null, string | null, string | null, string | null];
  readonly: [boolean, boolean, boolean];
  expand_all: boolean;
  filters: string[];
  review_mode: boolean;
}

export interface SessionRecordDto {
  id: string;
  title: string;
  kind: "two_way_text" | "three_way_merge" | "folder_compare";
  left_path: string;
  right_path: string;
  base_path: string | null;
  output_path: string | null;
  updated_at_ms: number;
}

export interface ReadTextFileResult {
  content: string;
  path: string;
  line_count: number;
  encoding: string;
}

export interface AppInfoDto {
  name: string;
  version: string;
  git_hash: string;
  git_hash_short: string;
  git_dirty: boolean;
  binary_path: string;
  target_triple: string;
  build_profile: string;
}

export interface UserPreferencesDto {
  theme: "dark" | "light";
  language: "zh-CN" | "en-US";
  ignore_whitespace: boolean;
  ignore_case: boolean;
  text_row_filter: "all" | "diffs" | "equals";
  folder_compare_mode: "hash" | "fast";
  folder_filter_status: "all" | "diffs" | "orphans" | "equals";
  folder_exclude_globs: string[];
  show_files_sidebar: boolean;
  last_browsed_dir: string | null;
  window_width: number;
  window_height: number;
  window_x: number | null;
  window_y: number | null;
  window_maximized: boolean;
  show_line_inspector: boolean;
  editor_font_size: number;
  tab_width: number;
  show_whitespace_glyphs: boolean;
  syntax_highlighting: boolean;
  auto_jump_first_diff: boolean;
  wrap_around_navigation: boolean;
  confirm_before_exit_dirty: boolean;
  recent_left_paths: string[];
  recent_right_paths: string[];
  recent_folder_paths: string[];
}

/**
 * Calls the Rust `AppBackend` via Tauri v2 IPC (`rpc_invoke`) or via the local
 * HTTP RPC server started by `fc` / `bcompare <left> <right>`.
 */
export async function callRustRpc<T>(
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T | null> {
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>("rpc_invoke", { cmd, args });
    }
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, args }),
    });
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => null);
      if (errJson?.error) {
        throw new Error(errJson.error);
      }
      return null;
    }
    const json = await resp.json();
    if (json && json.ok) {
      return json.data as T;
    }
    return null;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("无法")) {
      throw err;
    }
    return null;
  }
}

const KEYWORDS = new Set([
  "fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod",
  "match", "if", "else", "for", "while", "loop", "return", "async", "await",
  "const", "static", "function", "class", "interface", "type", "import", "export",
  "from", "default", "true", "false", "null", "None", "Some", "Ok", "Err",
]);

function tokenizeLine(line: string): SyntaxToken[] {
  if (!line) return [];
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return [{ text: line, kind: "comment" }];
  }
  const parts = line.split(/(\s+|[(){}[\].,:;=<>&|+\-*/]+)/);
  const tokens: SyntaxToken[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (KEYWORDS.has(p)) {
      tokens.push({ text: p, kind: "keyword" });
    } else if (/^["'`].*["'`]$/.test(p)) {
      tokens.push({ text: p, kind: "string" });
    } else if (/^\d+$/.test(p)) {
      tokens.push({ text: p, kind: "number" });
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(p)) {
      tokens.push({ text: p, kind: "type" });
    } else {
      tokens.push({ text: p, kind: "plain" });
    }
  }
  return tokens;
}







export type { ViewRowFilter };

interface LocalTwoWayState {
  leftLines: string[];
  rightLines: string[];
  leftUndo: string[][];
  rightUndo: string[][];
  leftRedo: string[][];
  rightRedo: string[][];
  leftDirty: boolean;
  rightDirty: boolean;
  options: DiffOptions;
  rowFilter: ViewRowFilter;
  allRows: ViewportRowDto[];
  visibleRows: ViewportRowDto[];
  hunks: TwoWayHunk[];
  stats: DiffStats;
}

const localTwoWayStore = new Map<string, LocalTwoWayState>();



function recomputeLocalTwoWay(state: LocalTwoWayState): void {
  const computed = computeTwoWayDiffCore(
    state.leftLines,
    state.rightLines,
    state.options,
    state.rowFilter
  );
  state.allRows = computed.allRows;
  state.visibleRows = computed.visibleRows;
  state.hunks = computed.hunks;
  state.stats = computed.stats;
}

function summarizeLocalTwoWay(state: LocalTwoWayState): TwoWayDiffResult {
  return {
    total_virtual_rows: state.visibleRows.length,
    left_line_count: state.leftLines.length,
    right_line_count: state.rightLines.length,
    left_dirty: state.leftDirty,
    right_dirty: state.rightDirty,
    left_encoding: "UTF-8",
    right_encoding: "UTF-8",
    left_line_ending: "LF",
    right_line_ending: "LF",
    hunks: state.hunks,
    stats: state.stats,
  };
}

export class CompareBackendClient {
  static createTwoWaySession(
    sessionId: string,
    leftContent: string = "",
    rightContent: string = "",
    options: DiffOptions = {
      ignore_whitespace: false,
      ignore_case: false,
      show_only_diffs: false,
      context_lines: 3,
    }
  ): TwoWayDiffResult {
    const splitLines = (txt: string) =>
      txt.length === 0 ? [] : txt.replace(/\r\n/g, "\n").split("\n");
    const state: LocalTwoWayState = {
      leftLines: splitLines(leftContent),
      rightLines: splitLines(rightContent),
      leftUndo: [],
      rightUndo: [],
      leftRedo: [],
      rightRedo: [],
      leftDirty: false,
      rightDirty: false,
      options,
      rowFilter: "all",
      allRows: [],
      visibleRows: [],
      hunks: [],
      stats: {
        modified_hunks: 0,
        inserted_hunks: 0,
        deleted_hunks: 0,
        equal_lines: 0,
        diff_lines: 0,
      },
    };
    recomputeLocalTwoWay(state);
    localTwoWayStore.set(sessionId, state);
    return summarizeLocalTwoWay(state);
  }

  static async createTwoWaySessionAsync(
    sessionId: string,
    leftContent: string = "",
    rightContent: string = "",
    options: DiffOptions = {
      ignore_whitespace: false,
      ignore_case: false,
      show_only_diffs: false,
      context_lines: 3,
    }
  ): Promise<TwoWayDiffResult> {
    const computed = await computeDiffAsync(
      sessionId,
      leftContent,
      rightContent,
      options,
      "all"
    );
    const state: LocalTwoWayState = {
      leftLines: computed.leftLines,
      rightLines: computed.rightLines,
      leftUndo: [],
      rightUndo: [],
      leftRedo: [],
      rightRedo: [],
      leftDirty: false,
      rightDirty: false,
      options,
      rowFilter: "all",
      allRows: computed.allRows,
      visibleRows: computed.visibleRows,
      hunks: computed.hunks,
      stats: computed.stats,
    };
    localTwoWayStore.set(sessionId, state);
    return summarizeLocalTwoWay(state);
  }

  static getViewportSlice(
    sessionId: string,
    startRow: number,
    count: number
  ): ViewportSliceDto {
    const state = localTwoWayStore.get(sessionId);
    if (!state) {
      return { start_row: 0, total_rows: 0, rows: [] };
    }
    const total = state.visibleRows.length;
    const s = Math.max(0, Math.min(startRow, total));
    const e = Math.min(total, s + count);
    const rawRows = state.visibleRows.slice(s, e);
    const rows = rawRows.map((r) => {
      let lInline = r.left_inline;
      let rInline = r.right_inline;
      if (r.status === "equal") {
        if (!lInline.length && r.left_text !== null) {
          lInline = [{ text: r.left_text, tag: "equal" }];
        }
        if (!rInline.length && r.right_text !== null) {
          rInline = [{ text: r.right_text, tag: "equal" }];
        }
      } else if (r.status === "modified" && !lInline.length && !rInline.length) {
        if (r.left_text !== null && r.right_text !== null) {
          [lInline, rInline] = computeInlineSegments(r.left_text, r.right_text);
          r.left_inline = lInline;
          r.right_inline = rInline;
        }
      }
      const lTokens =
        r.left_tokens.length || r.left_text === null ? r.left_tokens : tokenizeLine(r.left_text);
      const rTokens =
        r.right_tokens.length || r.right_text === null ? r.right_tokens : tokenizeLine(r.right_text);

      return {
        ...r,
        left_inline: lInline,
        right_inline: rInline,
        left_tokens: lTokens,
        right_tokens: rTokens,
      };
    });
    return {
      start_row: s,
      total_rows: total,
      rows,
    };
  }

  static updateOptions(
    sessionId: string,
    options: DiffOptions,
    rowFilter?: ViewRowFilter
  ): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    state.options = { ...options };
    if (rowFilter) state.rowFilter = rowFilter;
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static mergeHunk(
    sessionId: string,
    hunkId: number,
    direction: MergeDirection
  ): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    const hunk = state.hunks.find((h) => h.id === hunkId);
    if (!hunk) return summarizeLocalTwoWay(state);

    if (direction === "left_to_right") {
      state.rightUndo.push([...state.rightLines]);
      state.rightRedo = [];
      const src = state.leftLines.slice(hunk.left_range.start, hunk.left_range.end);
      state.rightLines.splice(
        hunk.right_range.start,
        hunk.right_range.end - hunk.right_range.start,
        ...src
      );
      state.rightDirty = true;
    } else {
      state.leftUndo.push([...state.leftLines]);
      state.leftRedo = [];
      const src = state.rightLines.slice(hunk.right_range.start, hunk.right_range.end);
      state.leftLines.splice(
        hunk.left_range.start,
        hunk.left_range.end - hunk.left_range.start,
        ...src
      );
      state.leftDirty = true;
    }

    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static editLine(
    sessionId: string,
    isLeft: boolean,
    lineNo1Based: number,
    newText: string
  ): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    const idx = lineNo1Based - 1;
    if (isLeft) {
      if (idx >= 0 && idx < state.leftLines.length) {
        state.leftUndo.push([...state.leftLines]);
        state.leftRedo = [];
        state.leftLines[idx] = newText;
        state.leftDirty = true;
      }
    } else {
      if (idx >= 0 && idx < state.rightLines.length) {
        state.rightUndo.push([...state.rightLines]);
        state.rightRedo = [];
        state.rightLines[idx] = newText;
        state.rightDirty = true;
      }
    }
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static undoSide(sessionId: string, isLeft: boolean): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    if (isLeft && state.leftUndo.length > 0) {
      state.leftRedo.push([...state.leftLines]);
      state.leftLines = state.leftUndo.pop()!;
      state.leftDirty = state.leftUndo.length > 0;
    } else if (!isLeft && state.rightUndo.length > 0) {
      state.rightRedo.push([...state.rightLines]);
      state.rightLines = state.rightUndo.pop()!;
      state.rightDirty = state.rightUndo.length > 0;
    }
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static redoSide(sessionId: string, isLeft: boolean): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    if (isLeft && state.leftRedo.length > 0) {
      state.leftUndo.push([...state.leftLines]);
      state.leftLines = state.leftRedo.pop()!;
      state.leftDirty = true;
    } else if (!isLeft && state.rightRedo.length > 0) {
      state.rightUndo.push([...state.rightLines]);
      state.rightLines = state.rightRedo.pop()!;
      state.rightDirty = true;
    }
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static getSideFullText(sessionId: string, isLeft: boolean): string {
    const state = localTwoWayStore.get(sessionId);
    if (!state) return "";
    return (isLeft ? state.leftLines : state.rightLines).join("\n");
  }

  static replaceSideText(
    sessionId: string,
    isLeft: boolean,
    newFullText: string
  ): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    const lines =
      newFullText.length === 0 ? [] : newFullText.replace(/\r\n/g, "\n").split("\n");
    if (isLeft) {
      state.leftUndo.push([...state.leftLines]);
      state.leftRedo = [];
      state.leftLines = lines;
      state.leftDirty = true;
    } else {
      state.rightUndo.push([...state.rightLines]);
      state.rightRedo = [];
      state.rightLines = lines;
      state.rightDirty = true;
    }
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static swapSides(sessionId: string): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    const tmpLines = state.leftLines;
    state.leftLines = state.rightLines;
    state.rightLines = tmpLines;
    const tmpDirty = state.leftDirty;
    state.leftDirty = state.rightDirty;
    state.rightDirty = tmpDirty;
    const tmpUndo = state.leftUndo;
    state.leftUndo = state.rightUndo;
    state.rightUndo = tmpUndo;
    const tmpRedo = state.leftRedo;
    state.leftRedo = state.rightRedo;
    state.rightRedo = tmpRedo;
    recomputeLocalTwoWay(state);
    return summarizeLocalTwoWay(state);
  }

  static markSideSaved(sessionId: string, isLeft: boolean): TwoWayDiffResult {
    const state = localTwoWayStore.get(sessionId);
    if (!state) throw new Error("Session not found");
    if (isLeft) state.leftDirty = false;
    else state.rightDirty = false;
    return summarizeLocalTwoWay(state);
  }

  static async loadRealDiskFiles(
    sessionId: string,
    leftPath: string,
    rightPath: string,
    options: DiffOptions
  ): Promise<TwoWayDiffResult | null> {
    const trimmedL = leftPath.trim();
    const trimmedR = rightPath.trim();

    const [leftRes, rightRes] = await Promise.all([
      trimmedL
        ? callRustRpc<ReadTextFileResult>("read_text_file", { path: trimmedL }).catch(() => ({
            content: "",
            path: trimmedL,
            line_count: 0,
            encoding: "UTF-8",
          }))
        : Promise.resolve({
            content: "",
            path: "",
            line_count: 0,
            encoding: "UTF-8",
          }),
      trimmedR
        ? callRustRpc<ReadTextFileResult>("read_text_file", { path: trimmedR }).catch(() => ({
            content: "",
            path: trimmedR,
            line_count: 0,
            encoding: "UTF-8",
          }))
        : Promise.resolve({
            content: "",
            path: "",
            line_count: 0,
            encoding: "UTF-8",
          }),
    ]);

    if (!leftRes && !rightRes) return null;

    return CompareBackendClient.createTwoWaySessionAsync(
      sessionId,
      leftRes?.content ?? "",
      rightRes?.content ?? "",
      options
    );
  }
}

// 3-Way Merge Engine (starts completely blank unless files or text are provided)
interface LocalThreeWayState {
  rows: ThreeWayRow[];
  hunks: ThreeWayHunk[];
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
}

const localThreeWayStore = new Map<string, LocalThreeWayState>();

export function createBlankThreeWaySession(
  sessionId: string
): { summary: ThreeWayDiffResult; rows: ThreeWayRow[] } {
  const state: LocalThreeWayState = {
    rows: [],
    hunks: [],
    baseLines: [],
    leftLines: [],
    rightLines: [],
  };
  localThreeWayStore.set(sessionId, state);
  return {
    summary: {
      total_virtual_rows: 0,
      hunks: [],
      unresolved_conflicts: 0,
      merged_lines: [],
    },
    rows: [],
  };
}

export async function loadRealThreeWayFiles(
  sessionId: string,
  leftPath: string,
  basePath: string,
  rightPath: string,
  outputPath?: string
): Promise<{ summary: ThreeWayDiffResult; rows: ThreeWayRow[] } | null> {
  const res = await callRustRpc<{
    session_id: string;
    summary: ThreeWayDiffResult;
    initial_rows: ThreeWayRow[];
  }>("open_three_way_files", {
    left_path: leftPath,
    base_path: basePath,
    right_path: rightPath,
    output_path: outputPath ?? null,
    initial_row_count: 50000,
  });

  if (!res) return null;

  const baseLines: string[] = [];
  const leftLines: string[] = [];
  const rightLines: string[] = [];
  for (const r of res.initial_rows) {
    if (r.base_text !== null) baseLines.push(r.base_text);
    if (r.left_text !== null) leftLines.push(r.left_text);
    if (r.right_text !== null) rightLines.push(r.right_text);
  }

  localThreeWayStore.set(sessionId, {
    rows: res.initial_rows,
    hunks: res.summary.hunks,
    baseLines,
    leftLines,
    rightLines,
  });

  return {
    summary: res.summary,
    rows: res.initial_rows,
  };
}

export function resolveThreeWayHunk(
  sessionId: string,
  hunkId: number,
  resolution: ConflictResolution
): ThreeWayDiffResult {
  const state = localThreeWayStore.get(sessionId);
  if (!state) throw new Error("3-Way session not found");
  const hunk = state.hunks.find((h) => h.id === hunkId);
  if (hunk) {
    hunk.resolution = resolution;
  }
  return buildThreeWaySummary(state);
}

function buildThreeWaySummary(state: LocalThreeWayState): ThreeWayDiffResult {
  const merged: string[] = [];
  let cursor = 0;
  for (const hunk of state.hunks) {
    while (cursor < hunk.base_range.start) {
      merged.push(state.baseLines[cursor++]);
    }
    const lSlice = state.leftLines.slice(hunk.left_range.start, hunk.left_range.end);
    const rSlice = state.rightLines.slice(hunk.right_range.start, hunk.right_range.end);
    const bSlice = state.baseLines.slice(hunk.base_range.start, hunk.base_range.end);

    switch (hunk.resolution) {
      case "use_left":
        merged.push(...lSlice);
        break;
      case "use_right":
        merged.push(...rSlice);
        break;
      case "use_base":
        merged.push(...bSlice);
        break;
      case "use_both_left_first":
        merged.push(...lSlice, ...rSlice);
        break;
      case "use_both_right_first":
        merged.push(...rSlice, ...lSlice);
        break;
      case "unresolved":
        merged.push("<<<<<<< LEFT", ...lSlice, "=======", ...rSlice, ">>>>>>> RIGHT");
        break;
    }
    cursor = hunk.base_range.end;
  }
  while (cursor < state.baseLines.length) {
    merged.push(state.baseLines[cursor++]);
  }

  return {
    total_virtual_rows: state.rows.length,
    hunks: state.hunks.map((h) => ({ ...h })),
    unresolved_conflicts: state.hunks.filter((h) => h.resolution === "unresolved").length,
    merged_lines: merged,
  };
}

export function createBlankFolderDiff(): FolderDiffResult {
  return {
    left_root: "",
    right_root: "",
    entries: [],
    stats: {
      total_items: 0,
      equal_items: 0,
      modified_items: 0,
      left_only_items: 0,
      right_only_items: 0,
    },
  };
}

export function recomputeFolderStats(entries: FolderEntryDto[]) {
  const files = entries.filter((e) => !e.is_dir);
  return {
    total_items: files.length,
    equal_items: files.filter((e) => e.status === "equal").length,
    modified_items: files.filter((e) => e.status === "modified").length,
    left_only_items: files.filter((e) => e.status === "left_only").length,
    right_only_items: files.filter((e) => e.status === "right_only").length,
  };
}
