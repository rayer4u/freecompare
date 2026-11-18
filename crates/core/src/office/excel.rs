//! Read-only Excel / ODS extraction using `calamine` over in-memory byte buffers.

use super::{OfficeDocument, OfficeError, OfficeKind};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use std::io::Cursor;

pub const MAX_EXCEL_SHEETS: usize = 100;
pub const MAX_EXCEL_TOTAL_ROWS: usize = 100_000;
pub const MAX_EXCEL_TOTAL_CELLS: usize = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetSnapshot {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkbookSnapshot {
    pub sheets: Vec<SheetSnapshot>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ExcelLimits {
    pub max_sheets: usize,
    pub max_total_rows: usize,
    pub max_total_cells: usize,
}

impl Default for ExcelLimits {
    fn default() -> Self {
        Self {
            max_sheets: MAX_EXCEL_SHEETS,
            max_total_rows: MAX_EXCEL_TOTAL_ROWS,
            max_total_cells: MAX_EXCEL_TOTAL_CELLS,
        }
    }
}

pub fn extract_excel(bytes: &[u8], kind: OfficeKind) -> Result<OfficeDocument, OfficeError> {
    let snapshot = extract_workbook_snapshot(bytes, ExcelLimits::default())?;
    let truncated = snapshot.truncated;
    let text = render_workbook_text(&snapshot);
    Ok(OfficeDocument {
        kind,
        doc_info: kind.doc_info().to_string(),
        text,
        truncated,
    })
}

pub fn extract_workbook_snapshot(
    bytes: &[u8],
    limits: ExcelLimits,
) -> Result<WorkbookSnapshot, OfficeError> {
    let cursor = Cursor::new(bytes);
    let mut workbook = open_workbook_auto_from_rs(cursor)
        .map_err(|e| OfficeError::ParseError(format!("无法打开电子表格: {e}")))?;

    let sheet_names = workbook.sheet_names();
    let mut sheets = Vec::new();
    let mut total_rows = 0usize;
    let mut total_cells = 0usize;
    let mut workbook_truncated = false;

    for (idx, name) in sheet_names.into_iter().enumerate() {
        if idx >= limits.max_sheets {
            workbook_truncated = true;
            break;
        }

        let range = match workbook.worksheet_range(&name) {
            Ok(r) => r,
            Err(e) => {
                sheets.push(SheetSnapshot {
                    name,
                    rows: vec![vec![format!("[无法读取工作表: {e}]")]],
                    truncated: false,
                });
                continue;
            }
        };

        let mut rows_out = Vec::new();
        let mut sheet_truncated = false;

        for row in range.rows() {
            if total_rows >= limits.max_total_rows || total_cells >= limits.max_total_cells {
                sheet_truncated = true;
                workbook_truncated = true;
                break;
            }

            let mut cells: Vec<String> = row.iter().map(format_cell).collect();
            while cells.last().is_some_and(|c| c.is_empty()) {
                cells.pop();
            }

            total_rows += 1;
            total_cells += cells.len().max(1);
            rows_out.push(cells);
        }

        sheets.push(SheetSnapshot {
            name,
            rows: rows_out,
            truncated: sheet_truncated,
        });

        if workbook_truncated {
            break;
        }
    }

    Ok(WorkbookSnapshot {
        sheets,
        truncated: workbook_truncated,
    })
}

pub fn render_workbook_text(snapshot: &WorkbookSnapshot) -> String {
    let mut lines = Vec::new();
    for (idx, sheet) in snapshot.sheets.iter().enumerate() {
        if idx > 0 {
            lines.push(String::new());
        }
        lines.push(format!("[Sheet: {}]", sheet.name));
        for row in &sheet.rows {
            if row.is_empty() {
                lines.push(String::new());
            } else {
                let escaped: Vec<String> = row.iter().map(|c| escape_cell_for_tsv(c)).collect();
                lines.push(escaped.join("\t"));
            }
        }
    }

    if snapshot.truncated {
        lines.push(String::new());
        lines.push("[已截断: Excel 行数或单元格数超过只读比对上限，仅展示前序部分]".to_string());
    }

    lines.join("\n")
}

fn escape_cell_for_tsv(cell: &str) -> String {
    if !cell.contains(['\n', '\r', '\t']) {
        return cell.to_string();
    }
    cell.replace("\r\n", "\\n")
        .replace(['\r', '\n'], "\\n")
        .replace('\t', " ")
}

fn format_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Data::DateTime(dt) => {
            if let Some(ndt) = dt.as_datetime() {
                let formatted = ndt.format("%Y-%m-%d %H:%M:%S").to_string();
                formatted
                    .strip_suffix(" 00:00:00")
                    .unwrap_or(&formatted)
                    .to_string()
            } else {
                format!("{dt}")
            }
        }
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR:{e:?}"),
    }
}
