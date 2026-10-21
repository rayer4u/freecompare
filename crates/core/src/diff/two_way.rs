use crate::buffer::{BufferError, TextBuffer};
use crate::syntax::{highlight_line, SyntaxToken};
use imara_diff::{diff, intern::InternedInput, Algorithm, UnifiedDiffBuilder};
use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use std::ops::Range;
use std::path::Path;

/// Minimum similarity score [0.0..1.0] required to pair a left and right line
/// inside a modified hunk as a `Modified` row rather than separate `Deleted` + `Inserted` rows.
const INTRA_HUNK_PAIR_THRESHOLD: f64 = 0.38;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffOptions {
    pub ignore_whitespace: bool,
    pub ignore_case: bool,
    pub show_only_diffs: bool,
    pub context_lines: usize,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            ignore_whitespace: false,
            ignore_case: false,
            show_only_diffs: false,
            context_lines: 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    Equal,
    Modified,
    Inserted,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InlineTag {
    Equal,
    Delete,
    Insert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineSegment {
    pub text: String,
    pub tag: InlineTag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwoWayHunk {
    pub id: usize,
    pub status: DiffStatus,
    pub virtual_start: usize,
    pub virtual_end: usize,
    pub left_range: Range<usize>,
    pub right_range: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlignmentRow {
    pub virtual_idx: usize,
    pub left_line_idx: Option<usize>,
    pub right_line_idx: Option<usize>,
    pub status: DiffStatus,
    pub hunk_id: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewportRowDto {
    pub virtual_idx: usize,
    pub left_line_no: Option<usize>,
    pub right_line_no: Option<usize>,
    pub left_text: Option<String>,
    pub right_text: Option<String>,
    pub status: DiffStatus,
    pub hunk_id: Option<usize>,
    pub left_inline: Vec<InlineSegment>,
    pub right_inline: Vec<InlineSegment>,
    pub left_tokens: Vec<SyntaxToken>,
    pub right_tokens: Vec<SyntaxToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewportSliceDto {
    pub start_row: usize,
    pub total_rows: usize,
    pub rows: Vec<ViewportRowDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwoWayDiffResult {
    pub total_virtual_rows: usize,
    pub left_line_count: usize,
    pub right_line_count: usize,
    pub left_dirty: bool,
    pub right_dirty: bool,
    pub left_encoding: String,
    pub right_encoding: String,
    pub left_line_ending: String,
    pub right_line_ending: String,
    pub hunks: Vec<TwoWayHunk>,
    pub stats: DiffStats,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiffStats {
    pub modified_hunks: usize,
    pub inserted_hunks: usize,
    pub deleted_hunks: usize,
    pub equal_lines: usize,
    pub diff_lines: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeDirection {
    LeftToRight,
    RightToLeft,
}

/// Holds a 2-way comparison session with two Rope buffers and their computed alignment table.
pub struct TwoWaySession {
    pub left: TextBuffer,
    pub right: TextBuffer,
    pub options: DiffOptions,
    pub all_rows: Vec<AlignmentRow>,
    pub visible_rows: Vec<usize>,
    pub hunks: Vec<TwoWayHunk>,
    pub stats: DiffStats,
    pub syntax_ext: Option<String>,
}

impl TwoWaySession {
    pub fn from_strings(left_text: &str, right_text: &str, options: DiffOptions) -> Self {
        let left = TextBuffer::from_str_content(left_text);
        let right = TextBuffer::from_str_content(right_text);
        let mut session = Self {
            left,
            right,
            options,
            all_rows: Vec::new(),
            visible_rows: Vec::new(),
            hunks: Vec::new(),
            stats: DiffStats::default(),
            syntax_ext: None,
        };
        session.recompute();
        session
    }

    pub fn from_files(
        left_path: impl AsRef<Path>,
        right_path: impl AsRef<Path>,
        options: DiffOptions,
    ) -> Result<Self, BufferError> {
        let ext = left_path
            .as_ref()
            .extension()
            .or_else(|| right_path.as_ref().extension())
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        let left = TextBuffer::from_file(left_path)?;
        let right = TextBuffer::from_file(right_path)?;
        let mut session = Self {
            left,
            right,
            options,
            all_rows: Vec::new(),
            visible_rows: Vec::new(),
            hunks: Vec::new(),
            stats: DiffStats::default(),
            syntax_ext: ext,
        };
        session.recompute();
        Ok(session)
    }

    pub fn set_options(&mut self, options: DiffOptions) {
        self.options = options;
        self.recompute();
    }

    /// Recomputes the alignment table and hunks using:
    /// 1. `imara-diff` Histogram low-frequency anchor algorithm
    /// 2. Indentation & blank-line Slider Heuristic to prevent brace misalignment
    /// 3. Intra-hunk Needleman-Wunsch similarity DP alignment
    pub fn recompute(&mut self) {
        let left_raw = self.left.lines_vec();
        let right_raw = self.right.lines_vec();

        let left_norm: Vec<String> = left_raw
            .iter()
            .map(|l| normalize_for_diff(l, &self.options))
            .collect();
        let right_norm: Vec<String> = right_raw
            .iter()
            .map(|l| normalize_for_diff(l, &self.options))
            .collect();

        let left_joined = left_norm.join("\n");
        let right_joined = right_norm.join("\n");

        let input = InternedInput::new(left_joined.as_str(), right_joined.as_str());
        let mut raw_hunks: Vec<(Range<usize>, Range<usize>)> = Vec::new();

        diff(
            Algorithm::Histogram,
            &input,
            |before: Range<u32>, after: Range<u32>| {
                raw_hunks.push((
                    (before.start as usize).min(left_raw.len())
                        ..(before.end as usize).min(left_raw.len()),
                    (after.start as usize).min(right_raw.len())
                        ..(after.end as usize).min(right_raw.len()),
                ));
            },
        );

        if left_raw.is_empty() && right_raw.is_empty() {
            raw_hunks.clear();
        } else if left_raw.is_empty() {
            raw_hunks = vec![(0..0, 0..right_raw.len())];
        } else if right_raw.is_empty() {
            raw_hunks = vec![(0..left_raw.len(), 0..0)];
        } else {
            // Stage 2: Apply Indentation & Blank-Line Slider Heuristic
            optimize_hunk_sliders(&mut raw_hunks, &left_norm, &right_norm, &left_raw, &right_raw);
        }

        let mut all_rows = Vec::new();
        let mut hunks = Vec::new();
        let mut stats = DiffStats::default();

        let mut left_cursor = 0usize;
        let mut right_cursor = 0usize;

        for (b_range, a_range) in raw_hunks {
            let b_start = b_range.start.min(left_raw.len());
            let b_end = b_range.end.min(left_raw.len());
            let a_start = a_range.start.min(right_raw.len());
            let a_end = a_range.end.min(right_raw.len());

            // Emit equal rows preceding this hunk
            while left_cursor < b_start && right_cursor < a_start {
                let v_idx = all_rows.len();
                all_rows.push(AlignmentRow {
                    virtual_idx: v_idx,
                    left_line_idx: Some(left_cursor),
                    right_line_idx: Some(right_cursor),
                    status: DiffStatus::Equal,
                    hunk_id: None,
                });
                left_cursor += 1;
                right_cursor += 1;
                stats.equal_lines += 1;
            }

            let left_len = b_end.saturating_sub(b_start);
            let right_len = a_end.saturating_sub(a_start);
            if left_len == 0 && right_len == 0 {
                continue;
            }

            let hunk_id = hunks.len();
            let status = match (left_len > 0, right_len > 0) {
                (true, true) => {
                    stats.modified_hunks += 1;
                    DiffStatus::Modified
                }
                (false, true) => {
                    stats.inserted_hunks += 1;
                    DiffStatus::Inserted
                }
                (true, false) => {
                    stats.deleted_hunks += 1;
                    DiffStatus::Deleted
                }
                (false, false) => DiffStatus::Equal,
            };

            let v_start = all_rows.len();

            // Stage 3: Intra-hunk intelligent line pairing via DP similarity
            let paired_rows = align_intra_hunk_lines(
                &left_norm[b_start..b_end],
                &right_norm[a_start..a_end],
                b_start,
                a_start,
            );

            for (l_idx, r_idx) in paired_rows {
                let row_status = match (l_idx.is_some(), r_idx.is_some()) {
                    (true, true) => DiffStatus::Modified,
                    (false, true) => DiffStatus::Inserted,
                    (true, false) => DiffStatus::Deleted,
                    (false, false) => DiffStatus::Equal,
                };
                let v_idx = all_rows.len();
                all_rows.push(AlignmentRow {
                    virtual_idx: v_idx,
                    left_line_idx: l_idx,
                    right_line_idx: r_idx,
                    status: row_status,
                    hunk_id: Some(hunk_id),
                });
                stats.diff_lines += 1;
            }

            let v_end = all_rows.len();
            hunks.push(TwoWayHunk {
                id: hunk_id,
                status,
                virtual_start: v_start,
                virtual_end: v_end,
                left_range: b_start..b_end,
                right_range: a_start..a_end,
            });

            left_cursor = b_end;
            right_cursor = a_end;
        }

        // Remaining trailing equal rows
        while left_cursor < left_raw.len() && right_cursor < right_raw.len() {
            let v_idx = all_rows.len();
            all_rows.push(AlignmentRow {
                virtual_idx: v_idx,
                left_line_idx: Some(left_cursor),
                right_line_idx: Some(right_cursor),
                status: DiffStatus::Equal,
                hunk_id: None,
            });
            left_cursor += 1;
            right_cursor += 1;
            stats.equal_lines += 1;
        }

        let visible_rows = if self.options.show_only_diffs {
            all_rows
                .iter()
                .enumerate()
                .filter(|(_, r)| r.status != DiffStatus::Equal)
                .map(|(idx, _)| idx)
                .collect()
        } else {
            (0..all_rows.len()).collect()
        };

        self.all_rows = all_rows;
        self.visible_rows = visible_rows;
        self.hunks = hunks;
        self.stats = stats;
        let _ = UnifiedDiffBuilder::new(&input);
    }

    pub fn summary(&self) -> TwoWayDiffResult {
        TwoWayDiffResult {
            total_virtual_rows: self.visible_rows.len(),
            left_line_count: self.left.line_count(),
            right_line_count: self.right.line_count(),
            left_dirty: self.left.is_dirty(),
            right_dirty: self.right.is_dirty(),
            left_encoding: self.left.encoding().label().to_string(),
            right_encoding: self.right.encoding().label().to_string(),
            left_line_ending: self.left.line_ending().label().to_string(),
            right_line_ending: self.right.line_ending().label().to_string(),
            hunks: self.hunks.clone(),
            stats: self.stats.clone(),
        }
    }

    /// Extracts a slice of rows for the virtual scrolling viewport and computes
    /// word/token-aware inline diffs + syntax tokens ONLY for visible rows.
    pub fn get_viewport_slice(&self, start_row: usize, count: usize) -> ViewportSliceDto {
        let total = self.visible_rows.len();
        let clamped_start = start_row.min(total);
        let clamped_end = (clamped_start + count).min(total);
        let ext = self.syntax_ext.as_deref().unwrap_or("txt");

        let mut rows = Vec::with_capacity(clamped_end.saturating_sub(clamped_start));
        for vis_idx in clamped_start..clamped_end {
            let real_virtual_idx = self.visible_rows[vis_idx];
            let align = &self.all_rows[real_virtual_idx];

            let left_text = align.left_line_idx.and_then(|i| self.left.line_text(i));
            let right_text = align.right_line_idx.and_then(|i| self.right.line_text(i));

            let (left_inline, right_inline) = match (&left_text, &right_text, align.status) {
                (Some(l), Some(r), DiffStatus::Modified) => compute_inline_diff(l, r),
                (Some(l), _, DiffStatus::Deleted) => (
                    vec![InlineSegment {
                        text: l.clone(),
                        tag: InlineTag::Delete,
                    }],
                    Vec::new(),
                ),
                (_, Some(r), DiffStatus::Inserted) => (
                    Vec::new(),
                    vec![InlineSegment {
                        text: r.clone(),
                        tag: InlineTag::Insert,
                    }],
                ),
                (Some(l), Some(r), _) => (
                    vec![InlineSegment {
                        text: l.clone(),
                        tag: InlineTag::Equal,
                    }],
                    vec![InlineSegment {
                        text: r.clone(),
                        tag: InlineTag::Equal,
                    }],
                ),
                _ => (Vec::new(), Vec::new()),
            };

            let left_tokens = left_text
                .as_deref()
                .map(|s| highlight_line(s, ext))
                .unwrap_or_default();
            let right_tokens = right_text
                .as_deref()
                .map(|s| highlight_line(s, ext))
                .unwrap_or_default();

            rows.push(ViewportRowDto {
                virtual_idx: vis_idx,
                left_line_no: align.left_line_idx.map(|i| i + 1),
                right_line_no: align.right_line_idx.map(|i| i + 1),
                left_text,
                right_text,
                status: align.status,
                hunk_id: align.hunk_id,
                left_inline,
                right_inline,
                left_tokens,
                right_tokens,
            });
        }

        ViewportSliceDto {
            start_row: clamped_start,
            total_rows: total,
            rows,
        }
    }

    pub fn merge_hunk(
        &mut self,
        hunk_id: usize,
        direction: MergeDirection,
    ) -> Result<TwoWayDiffResult, BufferError> {
        let hunk = match self.hunks.get(hunk_id) {
            Some(h) => h.clone(),
            None => return Ok(self.summary()),
        };

        match direction {
            MergeDirection::LeftToRight => {
                let source_lines: Vec<String> = (hunk.left_range.start..hunk.left_range.end)
                    .filter_map(|idx| self.left.line_text(idx))
                    .collect();
                self.right.replace_line_range(
                    hunk.right_range.start,
                    hunk.right_range.end,
                    &source_lines,
                )?;
            }
            MergeDirection::RightToLeft => {
                let source_lines: Vec<String> = (hunk.right_range.start..hunk.right_range.end)
                    .filter_map(|idx| self.right.line_text(idx))
                    .collect();
                self.left.replace_line_range(
                    hunk.left_range.start,
                    hunk.left_range.end,
                    &source_lines,
                )?;
            }
        }

        self.recompute();
        Ok(self.summary())
    }

    pub fn edit_side_line(
        &mut self,
        is_left: bool,
        line_idx: usize,
        new_content: String,
    ) -> Result<TwoWayDiffResult, BufferError> {
        if is_left {
            self.left.edit_line(line_idx, new_content)?;
        } else {
            self.right.edit_line(line_idx, new_content)?;
        }
        self.recompute();
        Ok(self.summary())
    }

    pub fn undo(&mut self, is_left: bool) -> TwoWayDiffResult {
        let changed = if is_left {
            self.left.undo()
        } else {
            self.right.undo()
        };
        if changed {
            self.recompute();
        }
        self.summary()
    }

    pub fn redo(&mut self, is_left: bool) -> TwoWayDiffResult {
        let changed = if is_left {
            self.left.redo()
        } else {
            self.right.redo()
        };
        if changed {
            self.recompute();
        }
        self.summary()
    }
}

fn normalize_for_diff(line: &str, options: &DiffOptions) -> String {
    let mut s = if options.ignore_whitespace {
        line.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        line.to_string()
    };
    if options.ignore_case {
        s = s.to_lowercase();
    }
    s
}

/// Stage 2: Indentation & Blank-Line Slider Heuristic (inspired by Git's diff slider heuristic).
/// When an insertion or deletion block can be shifted up or down without changing edit distance
/// (e.g. because its first line equals the line immediately preceding the block, or its last line
/// equals the line immediately following), slide the block to the most natural structural boundary
/// (such as a blank line or top-level function boundary rather than splitting inside braces).
fn optimize_hunk_sliders(
    hunks: &mut [(Range<usize>, Range<usize>)],
    left_norm: &[String],
    right_norm: &[String],
    left_raw: &[String],
    right_raw: &[String],
) {
    let len = hunks.len();
    for idx in 0..len {
        let prev_left_end = if idx > 0 { hunks[idx - 1].0.end } else { 0 };
        let prev_right_end = if idx > 0 { hunks[idx - 1].1.end } else { 0 };
        let next_left_start = if idx + 1 < len {
            hunks[idx + 1].0.start
        } else {
            left_norm.len()
        };
        let next_right_start = if idx + 1 < len {
            hunks[idx + 1].1.start
        } else {
            right_norm.len()
        };

        let (ref mut l_range, ref mut r_range) = hunks[idx];

        // Pure insertion on right or pure deletion on left can slide along identical boundary lines
        if l_range.start == l_range.end && r_range.start < r_range.end {
            // Slide earliest possible position
            while l_range.start > prev_left_end
                && r_range.start > prev_right_end
                && right_norm[r_range.end - 1] == left_norm[l_range.start - 1]
                && right_norm[r_range.end - 1] == right_norm[r_range.start - 1]
            {
                l_range.start -= 1;
                l_range.end -= 1;
                r_range.start -= 1;
                r_range.end -= 1;
            }

            // Evaluate all valid slide positions from earliest to latest and pick highest boundary score
            let mut best_l = l_range.clone();
            let mut best_r = r_range.clone();
            let mut best_score = score_split_boundary(right_raw, r_range.start, r_range.end);

            let mut cur_l = l_range.clone();
            let mut cur_r = r_range.clone();
            while cur_l.end < next_left_start
                && cur_r.end < next_right_start
                && right_norm[cur_r.start] == left_norm[cur_l.end]
                && right_norm[cur_r.start] == right_norm[cur_r.end]
            {
                cur_l.start += 1;
                cur_l.end += 1;
                cur_r.start += 1;
                cur_r.end += 1;
                let score = score_split_boundary(right_raw, cur_r.start, cur_r.end);
                if score >= best_score {
                    best_score = score;
                    best_l = cur_l.clone();
                    best_r = cur_r.clone();
                }
            }
            *l_range = best_l;
            *r_range = best_r;
        } else if l_range.start < l_range.end && r_range.start == r_range.end {
            while l_range.start > prev_left_end
                && r_range.start > prev_right_end
                && left_norm[l_range.end - 1] == right_norm[r_range.start - 1]
                && left_norm[l_range.end - 1] == left_norm[l_range.start - 1]
            {
                l_range.start -= 1;
                l_range.end -= 1;
                r_range.start -= 1;
                r_range.end -= 1;
            }

            let mut best_l = l_range.clone();
            let mut best_r = r_range.clone();
            let mut best_score = score_split_boundary(left_raw, l_range.start, l_range.end);

            let mut cur_l = l_range.clone();
            let mut cur_r = r_range.clone();
            while cur_l.end < next_left_start
                && cur_r.end < next_right_start
                && left_norm[cur_l.start] == right_norm[cur_r.end]
                && left_norm[cur_l.start] == left_norm[cur_l.end]
            {
                cur_l.start += 1;
                cur_l.end += 1;
                cur_r.start += 1;
                cur_r.end += 1;
                let score = score_split_boundary(left_raw, cur_l.start, cur_l.end);
                if score >= best_score {
                    best_score = score;
                    best_l = cur_l.clone();
                    best_r = cur_r.clone();
                }
            }
            *l_range = best_l;
            *r_range = best_r;
        }
    }
}

/// Scores how clean a hunk boundary `[start..end)` is within `lines`.
/// Higher score means cleaner separation (e.g. preceded by blank line or closing brace at outer indent).
fn score_split_boundary(lines: &[String], start: usize, end: usize) -> i32 {
    let mut score = 0i32;
    if start == 0 || end == lines.len() {
        score += 50;
    }
    if start > 0 && lines[start - 1].trim().is_empty() {
        score += 100;
    }
    if start < lines.len() && lines[start].trim().is_empty() {
        score += 80;
    }
    if end > 0 && end <= lines.len() && lines[end - 1].trim().is_empty() {
        score += 90;
    }
    if start > 0 {
        let prev_trim = lines[start - 1].trim();
        if prev_trim == "}" || prev_trim == "};" {
            score += 60;
        }
    }
    if end < lines.len() {
        let indent = leading_indent(&lines[end]);
        score -= indent as i32;
    }
    score
}

fn leading_indent(s: &str) -> usize {
    s.chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

/// Stage 3: Intra-hunk Needleman-Wunsch Dynamic Programming alignment.
/// Pairs modified lines within a hunk by character/token similarity instead of blind index `0..span`.
/// Prevents line shift misalignment when lines/comments are inserted or removed inside a modified block!
fn align_intra_hunk_lines(
    left_slice: &[String],
    right_slice: &[String],
    left_offset: usize,
    right_offset: usize,
) -> Vec<(Option<usize>, Option<usize>)> {
    let n = left_slice.len();
    let m = right_slice.len();

    if n == 0 {
        return (0..m).map(|j| (None, Some(right_offset + j))).collect();
    }
    if m == 0 {
        return (0..n).map(|i| (Some(left_offset + i), None)).collect();
    }

    // For huge hunks (> 120 lines on both sides), fall back to linear pairing to bound latency
    if n * m > 14_400 {
        let span = n.max(m);
        return (0..span)
            .map(|k| {
                (
                    (k < n).then_some(left_offset + k),
                    (k < m).then_some(right_offset + k),
                )
            })
            .collect();
    }

    // DP table where dp[i][j] = max similarity score for aligning left_slice[i..] and right_slice[j..]
    let cols = m + 1;
    let mut dp = vec![0.0f64; (n + 1) * cols];
    let mut choice = vec![0u8; (n + 1) * cols]; // 1 = Pair(i, j), 2 = Delete(i), 3 = Insert(j)

    for i in (0..n).rev() {
        for j in (0..m).rev() {
            let sim = line_similarity(&left_slice[i], &right_slice[j]);
            let delete_score = dp[(i + 1) * cols + j];
            let insert_score = dp[i * cols + (j + 1)];

            let mut best_score = delete_score;
            let mut best_act = 2u8; // prefer delete before insert for canonical ordering

            if insert_score > best_score {
                best_score = insert_score;
                best_act = 3u8;
            }

            if sim >= INTRA_HUNK_PAIR_THRESHOLD {
                let pair_score = sim + dp[(i + 1) * cols + (j + 1)];
                if pair_score >= best_score {
                    best_score = pair_score;
                    best_act = 1u8;
                }
            }

            dp[i * cols + j] = best_score;
            choice[i * cols + j] = best_act;
        }
    }

    let mut result = Vec::with_capacity(n + m);
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        match choice[i * cols + j] {
            1 => {
                result.push((Some(left_offset + i), Some(right_offset + j)));
                i += 1;
                j += 1;
            }
            2 => {
                result.push((Some(left_offset + i), None));
                i += 1;
            }
            _ => {
                result.push((None, Some(right_offset + j)));
                j += 1;
            }
        }
    }
    while i < n {
        result.push((Some(left_offset + i), None));
        i += 1;
    }
    while j < m {
        result.push((None, Some(right_offset + j)));
        j += 1;
    }

    result
}

/// Computes structural similarity in `[0.0, 1.0]` between two lines using Dice coefficient
/// over character bigrams + shared token prefix/suffix bonuses.
pub fn line_similarity(a: &str, b: &str) -> f64 {
    let a_trim = a.trim();
    let b_trim = b.trim();
    if a_trim.is_empty() && b_trim.is_empty() {
        return 1.0;
    }
    if a_trim.is_empty() || b_trim.is_empty() {
        return 0.0;
    }
    if a_trim == b_trim {
        return 1.0;
    }

    // Prevent pairing a pure comment line with a non-comment code line
    let a_is_comment = a_trim.starts_with("//") || a_trim.starts_with('#');
    let b_is_comment = b_trim.starts_with("//") || b_trim.starts_with('#');
    if a_is_comment != b_is_comment {
        return 0.0;
    }

    let a_chars: Vec<char> = a_trim.chars().collect();
    let b_chars: Vec<char> = b_trim.chars().collect();

    if a_chars.len() == 1 || b_chars.len() == 1 {
        return if a_chars[0] == b_chars[0] { 0.5 } else { 0.0 };
    }

    let mut a_bigrams: Vec<(char, char)> = a_chars.windows(2).map(|w| (w[0], w[1])).collect();
    let mut b_bigrams: Vec<(char, char)> = b_chars.windows(2).map(|w| (w[0], w[1])).collect();
    a_bigrams.sort_unstable();
    b_bigrams.sort_unstable();

    let mut matches = 0usize;
    let mut ia = 0usize;
    let mut ib = 0usize;
    while ia < a_bigrams.len() && ib < b_bigrams.len() {
        if a_bigrams[ia] == b_bigrams[ib] {
            matches += 1;
            ia += 1;
            ib += 1;
        } else if a_bigrams[ia] < b_bigrams[ib] {
            ia += 1;
        } else {
            ib += 1;
        }
    }

    (2.0 * matches as f64) / ((a_bigrams.len() + b_bigrams.len()) as f64)
}

/// Stage 4: Word/Identifier-aware inline diff.
/// Tokenizes lines into identifier words, whitespace, and punctuation before diffing so that
/// renaming `status_code` to `response_state` highlights the entire identifier cleanly
/// rather than fragmenting on coincidental shared letters (`s`, `t`, `a`, `e`).
pub fn compute_inline_diff(left: &str, right: &str) -> (Vec<InlineSegment>, Vec<InlineSegment>) {
    let left_tokens = split_lexical_words(left);
    let right_tokens = split_lexical_words(right);

    let left_refs: Vec<&str> = left_tokens.iter().map(|s| s.as_str()).collect();
    let right_refs: Vec<&str> = right_tokens.iter().map(|s| s.as_str()).collect();

    let diff = TextDiff::from_slices(&left_refs, &right_refs);
    let mut left_segs: Vec<InlineSegment> = Vec::new();
    let mut right_segs: Vec<InlineSegment> = Vec::new();

    for change in diff.iter_all_changes() {
        let val = change.value();
        match change.tag() {
            ChangeTag::Equal => {
                push_coalesced(&mut left_segs, InlineTag::Equal, val);
                push_coalesced(&mut right_segs, InlineTag::Equal, val);
            }
            ChangeTag::Delete => {
                push_coalesced(&mut left_segs, InlineTag::Delete, val);
            }
            ChangeTag::Insert => {
                push_coalesced(&mut right_segs, InlineTag::Insert, val);
            }
        }
    }

    (left_segs, right_segs)
}

/// Splits a code line into lexical tokens:
/// - Identifier/number words (`[A-Za-z0-9_]+`) are kept intact as a single unit
/// - Whitespace runs are grouped
/// - Punctuation symbols are individual tokens
fn split_lexical_words(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
        } else if c.is_whitespace() {
            let start = i;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
        } else {
            tokens.push(c.to_string());
            i += 1;
        }
    }

    tokens
}

fn push_coalesced(segments: &mut Vec<InlineSegment>, tag: InlineTag, text: &str) {
    if let Some(last) = segments.last_mut() {
        if last.tag == tag {
            last.text.push_str(text);
            return;
        }
    }
    segments.push(InlineSegment {
        text: text.to_string(),
        tag,
    });
}
