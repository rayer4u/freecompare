use crate::buffer::{BufferError, TextBuffer};
use imara_diff::{diff, intern::InternedInput, Algorithm};
use serde::{Deserialize, Serialize};
use std::ops::Range;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreeWayStatus {
    Equal,
    LeftModified,
    RightModified,
    BothModifiedIdentical,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    Unresolved,
    UseLeft,
    UseRight,
    UseBase,
    UseBothLeftFirst,
    UseBothRightFirst,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreeWayHunk {
    pub id: usize,
    pub status: ThreeWayStatus,
    pub resolution: ConflictResolution,
    pub virtual_start: usize,
    pub virtual_end: usize,
    pub base_range: Range<usize>,
    pub left_range: Range<usize>,
    pub right_range: Range<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreeWayRow {
    pub virtual_idx: usize,
    pub left_line_no: Option<usize>,
    pub base_line_no: Option<usize>,
    pub right_line_no: Option<usize>,
    pub left_text: Option<String>,
    pub base_text: Option<String>,
    pub right_text: Option<String>,
    pub status: ThreeWayStatus,
    pub hunk_id: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreeWayDiffResult {
    pub total_virtual_rows: usize,
    pub hunks: Vec<ThreeWayHunk>,
    pub unresolved_conflicts: usize,
    pub merged_lines: Vec<String>,
}

pub struct ThreeWaySession {
    pub left: TextBuffer,
    pub base: TextBuffer,
    pub right: TextBuffer,
    pub output_path: Option<std::path::PathBuf>,
    pub rows: Vec<ThreeWayRow>,
    pub hunks: Vec<ThreeWayHunk>,
    pub merged_lines: Vec<String>,
}

impl ThreeWaySession {
    pub fn from_strings(left_text: &str, base_text: &str, right_text: &str) -> Self {
        let mut session = Self {
            left: TextBuffer::from_str_content(left_text),
            base: TextBuffer::from_str_content(base_text),
            right: TextBuffer::from_str_content(right_text),
            output_path: None,
            rows: Vec::new(),
            hunks: Vec::new(),
            merged_lines: Vec::new(),
        };
        session.recompute();
        session
    }

    pub fn from_files(
        left_path: impl AsRef<Path>,
        base_path: impl AsRef<Path>,
        right_path: impl AsRef<Path>,
        output_path: Option<std::path::PathBuf>,
    ) -> Result<Self, BufferError> {
        let mut session = Self {
            left: TextBuffer::from_file(left_path)?,
            base: TextBuffer::from_file(base_path)?,
            right: TextBuffer::from_file(right_path)?,
            output_path,
            rows: Vec::new(),
            hunks: Vec::new(),
            merged_lines: Vec::new(),
        };
        session.recompute();
        Ok(session)
    }

    pub fn recompute(&mut self) {
        let base_lines = self.base.lines_vec();
        let left_lines = self.left.lines_vec();
        let right_lines = self.right.lines_vec();

        let base_str = base_lines.join("\n");
        let left_str = left_lines.join("\n");
        let right_str = right_lines.join("\n");

        let left_changes = compute_change_ranges(&base_str, &left_str, base_lines.len(), left_lines.len());
        let right_changes = compute_change_ranges(&base_str, &right_str, base_lines.len(), right_lines.len());

        // Merge intervals on Base coordinates
        let mut intervals: Vec<(Range<usize>, Range<usize>, Range<usize>)> = Vec::new();
        let mut li = 0usize;
        let mut ri = 0usize;
        let mut b_cursor = 0usize;
        let mut l_cursor = 0usize;
        let mut r_cursor = 0usize;

        while li < left_changes.len() || ri < right_changes.len() {
            let next_l_base = left_changes.get(li).map(|c| c.0.start).unwrap_or(usize::MAX);
            let next_r_base = right_changes.get(ri).map(|c| c.0.start).unwrap_or(usize::MAX);
            let next_change_base = next_l_base.min(next_r_base);

            if b_cursor < next_change_base {
                let eq_len = next_change_base - b_cursor;
                intervals.push((
                    b_cursor..(b_cursor + eq_len),
                    l_cursor..(l_cursor + eq_len),
                    r_cursor..(r_cursor + eq_len),
                ));
                b_cursor += eq_len;
                l_cursor += eq_len;
                r_cursor += eq_len;
            }

            // Coalesce overlapping base ranges between left_changes and right_changes
            let mut region_b_end = b_cursor;
            let mut region_l_end = l_cursor;
            let mut region_r_end = r_cursor;

            loop {
                let mut advanced = false;
                if let Some((lb, ll)) = left_changes.get(li) {
                    if lb.start <= region_b_end && (lb.start < region_b_end || region_b_end == b_cursor && lb.start == b_cursor) {
                        if lb.end > region_b_end {
                            let extra_b = lb.end - region_b_end;
                            region_r_end += extra_b;
                            region_b_end = lb.end;
                        }
                        region_l_end = ll.end;
                        li += 1;
                        advanced = true;
                    }
                }
                if let Some((rb, rr)) = right_changes.get(ri) {
                    if rb.start <= region_b_end && (rb.start < region_b_end || region_b_end == b_cursor && rb.start == b_cursor) {
                        if rb.end > region_b_end {
                            let extra_b = rb.end - region_b_end;
                            region_l_end += extra_b;
                            region_b_end = rb.end;
                        }
                        region_r_end = rr.end;
                        ri += 1;
                        advanced = true;
                    }
                }
                if !advanced {
                    break;
                }
            }

            intervals.push((
                b_cursor..region_b_end,
                l_cursor..region_l_end,
                r_cursor..region_r_end,
            ));

            b_cursor = region_b_end;
            l_cursor = region_l_end;
            r_cursor = region_r_end;
        }

        if b_cursor < base_lines.len() {
            let rem = base_lines.len() - b_cursor;
            intervals.push((
                b_cursor..base_lines.len(),
                l_cursor..(l_cursor + rem).min(left_lines.len()),
                r_cursor..(r_cursor + rem).min(right_lines.len()),
            ));
        }

        let mut rows = Vec::new();
        let mut hunks = Vec::new();

        for (b_range, l_range, r_range) in intervals {
            let b_slice = &base_lines[b_range.start.min(base_lines.len())..b_range.end.min(base_lines.len())];
            let l_slice = &left_lines[l_range.start.min(left_lines.len())..l_range.end.min(left_lines.len())];
            let r_slice = &right_lines[r_range.start.min(right_lines.len())..r_range.end.min(right_lines.len())];

            let status = if b_slice == l_slice && b_slice == r_slice {
                ThreeWayStatus::Equal
            } else if b_slice != l_slice && b_slice == r_slice {
                ThreeWayStatus::LeftModified
            } else if b_slice == l_slice && b_slice != r_slice {
                ThreeWayStatus::RightModified
            } else if l_slice == r_slice {
                ThreeWayStatus::BothModifiedIdentical
            } else {
                ThreeWayStatus::Conflict
            };

            // Split large conflict intervals on common equal anchor lines between Left and Right
            // so independent edits inside a region don't bloat into one giant conflict hunk.
            let sub_blocks = if status == ThreeWayStatus::Conflict && b_slice.len() >= 2 && l_slice.len() >= 2 && r_slice.len() >= 2 {
                split_conflict_on_common_anchors(&b_range, &l_range, &r_range, &base_lines, &left_lines, &right_lines)
            } else {
                vec![(b_range, l_range, r_range)]
            };

            for (sb_range, sl_range, sr_range) in sub_blocks {
                let sb_slice = &base_lines[sb_range.start.min(base_lines.len())..sb_range.end.min(base_lines.len())];
                let sl_slice = &left_lines[sl_range.start.min(left_lines.len())..sl_range.end.min(left_lines.len())];
                let sr_slice = &right_lines[sr_range.start.min(right_lines.len())..sr_range.end.min(right_lines.len())];

                let sub_status = if sb_slice == sl_slice && sb_slice == sr_slice {
                    ThreeWayStatus::Equal
                } else if sb_slice != sl_slice && sb_slice == sr_slice {
                    ThreeWayStatus::LeftModified
                } else if sb_slice == sl_slice && sb_slice != sr_slice {
                    ThreeWayStatus::RightModified
                } else if sl_slice == sr_slice {
                    ThreeWayStatus::BothModifiedIdentical
                } else {
                    ThreeWayStatus::Conflict
                };

                let v_start = rows.len();
                let max_len = sb_slice.len().max(sl_slice.len()).max(sr_slice.len());
                let hunk_id = if sub_status != ThreeWayStatus::Equal {
                    Some(hunks.len())
                } else {
                    None
                };

                for offset in 0..max_len {
                    let l_idx = (offset < sl_slice.len()).then_some(sl_range.start + offset);
                    let b_idx = (offset < sb_slice.len()).then_some(sb_range.start + offset);
                    let r_idx = (offset < sr_slice.len()).then_some(sr_range.start + offset);

                    rows.push(ThreeWayRow {
                        virtual_idx: rows.len(),
                        left_line_no: l_idx.map(|i| i + 1),
                        base_line_no: b_idx.map(|i| i + 1),
                        right_line_no: r_idx.map(|i| i + 1),
                        left_text: l_idx.and_then(|i| left_lines.get(i).cloned()),
                        base_text: b_idx.and_then(|i| base_lines.get(i).cloned()),
                        right_text: r_idx.and_then(|i| right_lines.get(i).cloned()),
                        status: sub_status,
                        hunk_id,
                    });
                }

                if let Some(id) = hunk_id {
                    let resolution = match sub_status {
                        ThreeWayStatus::LeftModified | ThreeWayStatus::BothModifiedIdentical => {
                            ConflictResolution::UseLeft
                        }
                        ThreeWayStatus::RightModified => ConflictResolution::UseRight,
                        ThreeWayStatus::Conflict => ConflictResolution::Unresolved,
                        ThreeWayStatus::Equal => ConflictResolution::UseBase,
                    };
                    hunks.push(ThreeWayHunk {
                        id,
                        status: sub_status,
                        resolution,
                        virtual_start: v_start,
                        virtual_end: rows.len(),
                        base_range: sb_range,
                        left_range: sl_range,
                        right_range: sr_range,
                    });
                }
            }
        }

        self.rows = rows;
        self.hunks = hunks;
        self.rebuild_merged_output();
    }

    pub fn resolve_hunk(&mut self, hunk_id: usize, resolution: ConflictResolution) -> ThreeWayDiffResult {
        if let Some(hunk) = self.hunks.get_mut(hunk_id) {
            hunk.resolution = resolution;
        }
        self.rebuild_merged_output();
        self.summary()
    }

    fn rebuild_merged_output(&mut self) {
        let base_lines = self.base.lines_vec();
        let left_lines = self.left.lines_vec();
        let right_lines = self.right.lines_vec();
        let mut out = Vec::new();
        let mut base_cursor = 0usize;

        for hunk in &self.hunks {
            while base_cursor < hunk.base_range.start && base_cursor < base_lines.len() {
                out.push(base_lines[base_cursor].clone());
                base_cursor += 1;
            }
            let l_slice = &left_lines[hunk.left_range.start.min(left_lines.len())..hunk.left_range.end.min(left_lines.len())];
            let r_slice = &right_lines[hunk.right_range.start.min(right_lines.len())..hunk.right_range.end.min(right_lines.len())];
            let b_slice = &base_lines[hunk.base_range.start.min(base_lines.len())..hunk.base_range.end.min(base_lines.len())];

            match hunk.resolution {
                ConflictResolution::UseLeft => out.extend_from_slice(l_slice),
                ConflictResolution::UseRight => out.extend_from_slice(r_slice),
                ConflictResolution::UseBase => out.extend_from_slice(b_slice),
                ConflictResolution::UseBothLeftFirst => {
                    out.extend_from_slice(l_slice);
                    out.extend_from_slice(r_slice);
                }
                ConflictResolution::UseBothRightFirst => {
                    out.extend_from_slice(r_slice);
                    out.extend_from_slice(l_slice);
                }
                ConflictResolution::Unresolved => {
                    out.push("<<<<<<< LEFT".to_string());
                    out.extend_from_slice(l_slice);
                    out.push("=======".to_string());
                    out.extend_from_slice(r_slice);
                    out.push(">>>>>>> RIGHT".to_string());
                }
            }
            base_cursor = hunk.base_range.end;
        }

        while base_cursor < base_lines.len() {
            out.push(base_lines[base_cursor].clone());
            base_cursor += 1;
        }

        self.merged_lines = out;
    }

    pub fn summary(&self) -> ThreeWayDiffResult {
        let unresolved_conflicts = self
            .hunks
            .iter()
            .filter(|h| h.resolution == ConflictResolution::Unresolved)
            .count();
        ThreeWayDiffResult {
            total_virtual_rows: self.rows.len(),
            hunks: self.hunks.clone(),
            unresolved_conflicts,
            merged_lines: self.merged_lines.clone(),
        }
    }

    pub fn get_viewport_rows(&self, start_row: usize, count: usize) -> Vec<ThreeWayRow> {
        let total = self.rows.len();
        let s = start_row.min(total);
        let e = (s + count).min(total);
        self.rows[s..e].to_vec()
    }

    pub fn save_merged(&self, target_path: Option<&Path>) -> Result<(), BufferError> {
        let out_path = match target_path
            .or(self.output_path.as_deref())
            .or(self.base.path())
            .or(self.left.path())
        {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(BufferError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "No output file path specified for 3-way merge",
                )))
            }
        };
        let mut content = self.merged_lines.join(self.base.line_ending().as_str());
        if !content.is_empty() {
            content.push_str(self.base.line_ending().as_str());
        }
        std::fs::write(out_path, content.as_bytes())?;
        Ok(())
    }
}

fn compute_change_ranges(
    base_str: &str,
    target_str: &str,
    base_len: usize,
    target_len: usize,
) -> Vec<(Range<usize>, Range<usize>)> {
    if base_len == 0 && target_len == 0 {
        return Vec::new();
    }
    if base_len == 0 {
        return vec![(0..0, 0..target_len)];
    }
    if target_len == 0 {
        return vec![(0..base_len, 0..0)];
    }

    let input = InternedInput::new(base_str, target_str);
    let mut changes = Vec::new();
    diff(Algorithm::Histogram, &input, |b: Range<u32>, t: Range<u32>| {
        changes.push((
            (b.start as usize).min(base_len)..(b.end as usize).min(base_len),
            (t.start as usize).min(target_len)..(t.end as usize).min(target_len),
        ));
    });
    changes
}

fn split_conflict_on_common_anchors(
    b_range: &Range<usize>,
    l_range: &Range<usize>,
    r_range: &Range<usize>,
    base_lines: &[String],
    left_lines: &[String],
    right_lines: &[String],
) -> Vec<(Range<usize>, Range<usize>, Range<usize>)> {
    let mut sub_blocks = Vec::new();
    let mut b_cur = b_range.start;
    let mut l_cur = l_range.start;
    let mut r_cur = r_range.start;

    for bi in b_range.start..b_range.end {
        let b_line = &base_lines[bi];
        if b_line.trim().is_empty() {
            continue;
        }
        // Find if `b_line` appears uniquely in the remaining slice of left and right
        let l_matches: Vec<usize> = (l_cur..l_range.end)
            .filter(|&li| &left_lines[li] == b_line)
            .collect();
        let r_matches: Vec<usize> = (r_cur..r_range.end)
            .filter(|&ri| &right_lines[ri] == b_line)
            .collect();

        if l_matches.len() == 1 && r_matches.len() == 1 {
            let li = l_matches[0];
            let ri = r_matches[0];
            if bi > b_cur || li > l_cur || ri > r_cur {
                sub_blocks.push((b_cur..bi, l_cur..li, r_cur..ri));
            }
            sub_blocks.push((bi..(bi + 1), li..(li + 1), ri..(ri + 1)));
            b_cur = bi + 1;
            l_cur = li + 1;
            r_cur = ri + 1;
        }
    }

    if b_cur < b_range.end || l_cur < l_range.end || r_cur < r_range.end {
        sub_blocks.push((b_cur..b_range.end, l_cur..l_range.end, r_cur..r_range.end));
    }

    if sub_blocks.is_empty() {
        vec![(b_range.clone(), l_range.clone(), r_range.clone())]
    } else {
        sub_blocks
    }
}
