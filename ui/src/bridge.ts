import {
  ConflictResolution,
  DiffOptions,
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
} from "./types";

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

export interface UserPreferencesDto {
  theme: "dark" | "light";
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

function splitLexicalTokens(line: string): string[] {
  return line.match(/[A-Za-z0-9_]+|\s+|[^\w\s]/g) ?? [];
}

function lineSimilarity(a: string, b: string): number {
  const at = a.trim();
  const bt = b.trim();
  if (!at && !bt) return 1.0;
  if (!at || !bt) return 0.0;
  if (at === bt) return 1.0;
  const aComment = at.startsWith("//") || at.startsWith("#");
  const bComment = bt.startsWith("//") || bt.startsWith("#");
  if (aComment !== bComment) return 0.0;

  if (at.length === 1 || bt.length === 1) {
    return at[0] === bt[0] ? 0.5 : 0.0;
  }

  const aBigrams: string[] = [];
  const bBigrams: string[] = [];
  for (let i = 0; i < at.length - 1; i++) aBigrams.push(at.slice(i, i + 2));
  for (let i = 0; i < bt.length - 1; i++) bBigrams.push(bt.slice(i, i + 2));
  aBigrams.sort();
  bBigrams.sort();

  let matches = 0;
  let ia = 0;
  let ib = 0;
  while (ia < aBigrams.length && ib < bBigrams.length) {
    if (aBigrams[ia] === bBigrams[ib]) {
      matches++;
      ia++;
      ib++;
    } else if (aBigrams[ia] < bBigrams[ib]) {
      ia++;
    } else {
      ib++;
    }
  }
  return (2.0 * matches) / (aBigrams.length + bBigrams.length);
}

function pushCoalescedSeg(
  arr: InlineSegment[],
  tag: "equal" | "delete" | "insert",
  text: string
) {
  if (!text) return;
  const last = arr[arr.length - 1];
  if (last && last.tag === tag) {
    last.text += text;
  } else {
    arr.push({ text, tag });
  }
}

function computeInlineSegments(
  left: string,
  right: string
): [InlineSegment[], InlineSegment[]] {
  const lToks = splitLexicalTokens(left);
  const rToks = splitLexicalTokens(right);
  const n = lToks.length;
  const m = rToks.length;

  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (lToks[i] === rToks[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lSegs: InlineSegment[] = [];
  const rSegs: InlineSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lToks[i] === rToks[j]) {
      pushCoalescedSeg(lSegs, "equal", lToks[i]);
      pushCoalescedSeg(rSegs, "equal", rToks[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushCoalescedSeg(lSegs, "delete", lToks[i++]);
    } else {
      pushCoalescedSeg(rSegs, "insert", rToks[j++]);
    }
  }
  while (i < n) pushCoalescedSeg(lSegs, "delete", lToks[i++]);
  while (j < m) pushCoalescedSeg(rSegs, "insert", rToks[j++]);

  return [lSegs, rSegs];
}

function alignIntraHunkLines(
  L: string[],
  R: string[],
  delIndices: number[],
  insIndices: number[]
): Array<[number | null, number | null]> {
  const n = delIndices.length;
  const m = insIndices.length;
  if (n === 0) return insIndices.map((r) => [null, r]);
  if (m === 0) return delIndices.map((l) => [l, null]);

  const cols = m + 1;
  const dp = new Float64Array((n + 1) * cols);
  const choice = new Uint8Array((n + 1) * cols);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const sim = lineSimilarity(L[delIndices[i]], R[insIndices[j]]);
      let bestScore = dp[(i + 1) * cols + j];
      let bestAct = 2; // Delete
      const insScore = dp[i * cols + (j + 1)];
      if (insScore > bestScore) {
        bestScore = insScore;
        bestAct = 3; // Insert
      }
      if (sim >= 0.38) {
        const pairScore = sim + dp[(i + 1) * cols + (j + 1)];
        if (pairScore >= bestScore) {
          bestScore = pairScore;
          bestAct = 1; // Pair as Modified
        }
      }
      dp[i * cols + j] = bestScore;
      choice[i * cols + j] = bestAct;
    }
  }

  const pairs: Array<[number | null, number | null]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const act = choice[i * cols + j];
    if (act === 1) {
      pairs.push([delIndices[i++], insIndices[j++]]);
    } else if (act === 2) {
      pairs.push([delIndices[i++], null]);
    } else {
      pairs.push([null, insIndices[j++]]);
    }
  }
  while (i < n) pairs.push([delIndices[i++], null]);
  while (j < m) pairs.push([null, insIndices[j++]]);
  return pairs;
}

export type ViewRowFilter = "all" | "diffs" | "equals";

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

function normalizeLine(line: string, opts: DiffOptions): string {
  let s = opts.ignore_whitespace ? line.trim().replace(/\s+/g, " ") : line;
  if (opts.ignore_case) s = s.toLowerCase();
  return s;
}

function recomputeLocalTwoWay(state: LocalTwoWayState): void {
  const L = state.leftLines;
  const R = state.rightLines;
  const n = L.length;
  const m = R.length;

  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const nl = normalizeLine(L[i], state.options);
    for (let j = m - 1; j >= 0; j--) {
      if (nl === normalizeLine(R[j], state.options)) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  type Op =
    | { type: "eq"; l: number; r: number }
    | { type: "del"; l: number }
    | { type: "ins"; r: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (normalizeLine(L[i], state.options) === normalizeLine(R[j], state.options)) {
      ops.push({ type: "eq", l: i++, r: j++ });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", l: i++ });
    } else {
      ops.push({ type: "ins", r: j++ });
    }
  }
  while (i < n) ops.push({ type: "del", l: i++ });
  while (j < m) ops.push({ type: "ins", r: j++ });

  const allRows: ViewportRowDto[] = [];
  const hunks: TwoWayHunk[] = [];
  const stats: DiffStats = {
    modified_hunks: 0,
    inserted_hunks: 0,
    deleted_hunks: 0,
    equal_lines: 0,
    diff_lines: 0,
  };

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === "eq") {
      const lText = L[op.l];
      const rText = R[op.r];
      allRows.push({
        virtual_idx: allRows.length,
        left_line_no: op.l + 1,
        right_line_no: op.r + 1,
        left_text: lText,
        right_text: rText,
        status: "equal",
        hunk_id: null,
        left_inline: [{ text: lText, tag: "equal" }],
        right_inline: [{ text: rText, tag: "equal" }],
        left_tokens: tokenizeLine(lText),
        right_tokens: tokenizeLine(rText),
      });
      stats.equal_lines++;
      k++;
    } else {
      const delIndices: number[] = [];
      const insIndices: number[] = [];
      while (k < ops.length && ops[k].type !== "eq") {
        const cur = ops[k];
        if (cur.type === "del") delIndices.push(cur.l);
        if (cur.type === "ins") insIndices.push(cur.r);
        k++;
      }

      const hunkId = hunks.length;
      const vStart = allRows.length;
      let hunkStatus: DiffStatus = "modified";
      if (delIndices.length > 0 && insIndices.length > 0) {
        hunkStatus = "modified";
        stats.modified_hunks++;
      } else if (delIndices.length === 0) {
        hunkStatus = "inserted";
        stats.inserted_hunks++;
      } else {
        hunkStatus = "deleted";
        stats.deleted_hunks++;
      }

      const pairedRows = alignIntraHunkLines(L, R, delIndices, insIndices);
      for (const [lIdx, rIdx] of pairedRows) {
        const lText = lIdx !== null ? L[lIdx] : null;
        const rText = rIdx !== null ? R[rIdx] : null;

        let rowStatus: DiffStatus = "modified";
        let lInline: InlineSegment[] = [];
        let rInline: InlineSegment[] = [];

        if (lText !== null && rText !== null) {
          rowStatus = "modified";
          [lInline, rInline] = computeInlineSegments(lText, rText);
        } else if (lText !== null) {
          rowStatus = "deleted";
          lInline = [{ text: lText, tag: "delete" }];
        } else if (rText !== null) {
          rowStatus = "inserted";
          rInline = [{ text: rText, tag: "insert" }];
        }

        allRows.push({
          virtual_idx: allRows.length,
          left_line_no: lIdx !== null ? lIdx + 1 : null,
          right_line_no: rIdx !== null ? rIdx + 1 : null,
          left_text: lText,
          right_text: rText,
          status: rowStatus,
          hunk_id: hunkId,
          left_inline: lInline,
          right_inline: rInline,
          left_tokens: lText ? tokenizeLine(lText) : [],
          right_tokens: rText ? tokenizeLine(rText) : [],
        });
        stats.diff_lines++;
      }

      const lStart = delIndices.length > 0 ? delIndices[0] : (insIndices[0] ?? 0);
      const lEnd = delIndices.length > 0 ? delIndices[delIndices.length - 1] + 1 : lStart;
      const rStart = insIndices.length > 0 ? insIndices[0] : (delIndices[0] ?? 0);
      const rEnd = insIndices.length > 0 ? insIndices[insIndices.length - 1] + 1 : rStart;

      hunks.push({
        id: hunkId,
        status: hunkStatus,
        virtual_start: vStart,
        virtual_end: allRows.length,
        left_range: { start: lStart, end: lEnd },
        right_range: { start: rStart, end: rEnd },
      });
    }
  }

  state.allRows = allRows;
  if (state.rowFilter === "diffs" || state.options.show_only_diffs) {
    state.visibleRows = allRows
      .filter((r) => r.status !== "equal")
      .map((r, idx) => ({ ...r, virtual_idx: idx }));
  } else if (state.rowFilter === "equals") {
    state.visibleRows = allRows
      .filter((r) => r.status === "equal")
      .map((r, idx) => ({ ...r, virtual_idx: idx }));
  } else {
    state.visibleRows = allRows;
  }
  state.hunks = hunks;
  state.stats = stats;
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
    return {
      start_row: s,
      total_rows: total,
      rows: state.visibleRows.slice(s, e),
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
    const data = await callRustRpc<{
      session_id: string;
      left_path: string;
      right_path: string;
      summary: TwoWayDiffResult;
      initial_slice: ViewportSliceDto;
    }>("open_two_way_files", {
      left_path: leftPath,
      right_path: rightPath,
      options,
      initial_row_count: 50000,
    });

    if (!data) return null;

    const leftLines: string[] = [];
    const rightLines: string[] = [];
    for (const r of data.initial_slice.rows) {
      if (r.left_text !== null && r.left_text !== undefined) {
        leftLines.push(r.left_text);
      }
      if (r.right_text !== null && r.right_text !== undefined) {
        rightLines.push(r.right_text);
      }
    }

    localTwoWayStore.set(sessionId, {
      leftLines,
      rightLines,
      leftUndo: [],
      rightUndo: [],
      leftRedo: [],
      rightRedo: [],
      leftDirty: data.summary.left_dirty,
      rightDirty: data.summary.right_dirty,
      options,
      rowFilter: "all",
      allRows: data.initial_slice.rows,
      visibleRows: data.initial_slice.rows,
      hunks: data.summary.hunks,
      stats: data.summary.stats,
    });

    return data.summary;
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
