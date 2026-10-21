// Shared data transfer objects mirroring `freecompare-core` Rust types

export type DiffStatus = "equal" | "modified" | "inserted" | "deleted";
export type InlineTag = "equal" | "delete" | "insert";
export type MergeDirection = "left_to_right" | "right_to_left";

export interface DiffOptions {
  ignore_whitespace: boolean;
  ignore_case: boolean;
  show_only_diffs: boolean;
  context_lines: number;
}

export interface InlineSegment {
  text: string;
  tag: InlineTag;
}

export interface SyntaxToken {
  text: string;
  kind: "plain" | "keyword" | "string" | "comment" | "number" | "type";
}

export interface TwoWayHunk {
  id: number;
  status: DiffStatus;
  virtual_start: number;
  virtual_end: number;
  left_range: { start: number; end: number };
  right_range: { start: number; end: number };
}

export interface DiffStats {
  modified_hunks: number;
  inserted_hunks: number;
  deleted_hunks: number;
  equal_lines: number;
  diff_lines: number;
}

export interface ViewportRowDto {
  virtual_idx: number;
  left_line_no: number | null;
  right_line_no: number | null;
  left_text: string | null;
  right_text: string | null;
  status: DiffStatus;
  hunk_id: number | null;
  left_inline: InlineSegment[];
  right_inline: InlineSegment[];
  left_tokens: SyntaxToken[];
  right_tokens: SyntaxToken[];
}

export interface ViewportSliceDto {
  start_row: number;
  total_rows: number;
  rows: ViewportRowDto[];
}

export interface TwoWayDiffResult {
  total_virtual_rows: number;
  left_line_count: number;
  right_line_count: number;
  left_dirty: boolean;
  right_dirty: boolean;
  left_encoding: string;
  right_encoding: string;
  left_line_ending: string;
  right_line_ending: string;
  hunks: TwoWayHunk[];
  stats: DiffStats;
}

// 3-Way Merge DTOs
export type ThreeWayStatus =
  | "equal"
  | "left_modified"
  | "right_modified"
  | "both_modified_identical"
  | "conflict";

export type ConflictResolution =
  | "unresolved"
  | "use_left"
  | "use_right"
  | "use_base"
  | "use_both_left_first"
  | "use_both_right_first";

export interface ThreeWayHunk {
  id: number;
  status: ThreeWayStatus;
  resolution: ConflictResolution;
  virtual_start: number;
  virtual_end: number;
  base_range: { start: number; end: number };
  left_range: { start: number; end: number };
  right_range: { start: number; end: number };
}

export interface ThreeWayRow {
  virtual_idx: number;
  left_line_no: number | null;
  base_line_no: number | null;
  right_line_no: number | null;
  left_text: string | null;
  base_text: string | null;
  right_text: string | null;
  status: ThreeWayStatus;
  hunk_id: number | null;
}

export interface ThreeWayDiffResult {
  total_virtual_rows: number;
  hunks: ThreeWayHunk[];
  unresolved_conflicts: number;
  merged_lines: string[];
}

// Folder Compare DTOs
export type FolderItemStatus = "equal" | "modified" | "left_only" | "right_only";

export interface FolderEntryDto {
  relative_path: string;
  name: string;
  is_dir: boolean;
  depth: number;
  status: FolderItemStatus;
  left_size: number | null;
  right_size: number | null;
  left_modified_ms: number | null;
  right_modified_ms: number | null;
}

export interface FolderDiffStats {
  total_items: number;
  equal_items: number;
  modified_items: number;
  left_only_items: number;
  right_only_items: number;
}

export interface FolderDiffResult {
  left_root: string;
  right_root: string;
  entries: FolderEntryDto[];
  stats: FolderDiffStats;
}

export type SessionTabKind = "home" | "two_way" | "folder" | "three_way";

export interface WorkspaceTab {
  id: string;
  title: string;
  kind: SessionTabKind;
  leftPath?: string;
  rightPath?: string;
  basePath?: string;
}
