//! Read-only Word (`.docx`) extraction using `zip` + `quick-xml` over in-memory byte buffers.

use super::{OfficeDocument, OfficeError, OfficeKind, MAX_XML_BYTES};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::{Cursor, Read};
use zip::ZipArchive;

pub const MAX_DOCX_LINES: usize = 100_000;
pub const MAX_DOCX_CHARS: usize = 10_000_000;
pub const DEFAULT_WRAP_WIDTH: usize = 100;

#[derive(Debug, Clone, Copy)]
pub struct DocxLimits {
    pub max_xml_bytes: u64,
    pub max_lines: usize,
    pub max_chars: usize,
    pub wrap_width: usize,
}

impl Default for DocxLimits {
    fn default() -> Self {
        Self {
            max_xml_bytes: MAX_XML_BYTES,
            max_lines: MAX_DOCX_LINES,
            max_chars: MAX_DOCX_CHARS,
            wrap_width: DEFAULT_WRAP_WIDTH,
        }
    }
}

pub fn extract_docx(bytes: &[u8]) -> Result<OfficeDocument, OfficeError> {
    extract_docx_with_limits(bytes, DocxLimits::default())
}

pub fn extract_docx_with_limits(
    bytes: &[u8],
    limits: DocxLimits,
) -> Result<OfficeDocument, OfficeError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| OfficeError::ParseError(format!("无法打开 .docx 压缩包: {e}")))?;

    let xml_file = archive
        .by_name("word/document.xml")
        .map_err(|_| OfficeError::ParseError("无效的 .docx 文件：缺少 word/document.xml".to_string()))?;

    let mut truncated = false;
    let mut xml_bytes = Vec::new();
    let mut limited_reader = xml_file.take(limits.max_xml_bytes.saturating_add(1));
    limited_reader
        .read_to_end(&mut xml_bytes)
        .map_err(|e| OfficeError::ParseError(format!("读取 word/document.xml 失败: {e}")))?;

    if xml_bytes.len() as u64 > limits.max_xml_bytes {
        xml_bytes.truncate(limits.max_xml_bytes as usize);
        truncated = true;
    }

    let (lines, xml_truncated) = parse_document_xml(&xml_bytes, limits)?;
    if xml_truncated {
        truncated = true;
    }

    let mut out = lines.join("\n");
    if truncated {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str("[已截断: Word 文档内容超过只读比对上限，仅展示前序部分]");
    }

    Ok(OfficeDocument {
        kind: OfficeKind::WordDocx,
        doc_info: OfficeKind::WordDocx.doc_info().to_string(),
        text: out,
        truncated,
    })
}

fn parse_document_xml(xml_bytes: &[u8], limits: DocxLimits) -> Result<(Vec<String>, bool), OfficeError> {
    let mut reader = Reader::from_reader(xml_bytes);
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut total_chars = 0usize;
    let mut truncated = false;

    let mut in_paragraph = false;
    let mut in_w_t = false;
    let mut del_depth = 0usize;
    let mut ignored_text_depth = 0usize;
    let mut table_depth = 0usize;
    let mut in_cell = false;

    let mut heading_level: Option<usize> = None;
    let mut current_para = String::new();
    let mut current_cell = String::new();
    let mut current_row: Vec<String> = Vec::new();

    loop {
        if lines.len() >= limits.max_lines || total_chars >= limits.max_chars {
            truncated = true;
            break;
        }

        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    b"del" | b"moveFrom" => del_depth += 1,
                    b"delText" | b"instrText" => ignored_text_depth += 1,
                    b"p" => {
                        in_paragraph = true;
                        current_para.clear();
                        heading_level = None;
                    }
                    b"pStyle" if in_paragraph => {
                        heading_level = extract_heading_level(&e);
                    }
                    b"t" => in_w_t = true,
                    b"tab" if in_paragraph && del_depth == 0 && ignored_text_depth == 0 => {
                        current_para.push(' ');
                    }
                    b"br" | b"cr" if in_paragraph && del_depth == 0 && ignored_text_depth == 0 => {
                        current_para.push('\n');
                    }
                    b"tbl" => table_depth += 1,
                    b"tr" if table_depth > 0 => current_row.clear(),
                    b"tc" if table_depth > 0 => {
                        current_cell.clear();
                        in_cell = true;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    b"pStyle" if in_paragraph => {
                        heading_level = extract_heading_level(&e);
                    }
                    b"tab" if in_paragraph && del_depth == 0 && ignored_text_depth == 0 => {
                        current_para.push(' ');
                    }
                    b"br" | b"cr" if in_paragraph && del_depth == 0 && ignored_text_depth == 0 => {
                        current_para.push('\n');
                    }
                    b"p" => {
                        if !in_cell {
                            lines.push(String::new());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_w_t && del_depth == 0 && ignored_text_depth == 0 {
                    let text = e
                        .unescape()
                        .map(|cow| cow.into_owned())
                        .unwrap_or_else(|_| String::from_utf8_lossy(e.as_ref()).into_owned());
                    current_para.push_str(&text);
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    b"t" => in_w_t = false,
                    b"del" | b"moveFrom" => del_depth = del_depth.saturating_sub(1),
                    b"delText" | b"instrText" => {
                        ignored_text_depth = ignored_text_depth.saturating_sub(1)
                    }
                    b"p" => {
                        if in_cell && table_depth > 0 {
                            let cleaned = current_para
                                .split('\n')
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .collect::<Vec<_>>()
                                .join(" ");
                            if !cleaned.is_empty() {
                                if !current_cell.is_empty() {
                                    current_cell.push(' ');
                                }
                                current_cell.push_str(&cleaned);
                            }
                        } else {
                            flush_paragraph(
                                &current_para,
                                heading_level,
                                limits.wrap_width,
                                &mut lines,
                                &mut total_chars,
                            );
                        }
                        in_paragraph = false;
                        current_para.clear();
                        heading_level = None;
                    }
                    b"tc" if in_cell => {
                        current_row.push(current_cell.trim().to_string());
                        current_cell.clear();
                        in_cell = false;
                    }
                    b"tr" if table_depth > 0 => {
                        if !current_row.is_empty() {
                            let row_line = format!("| {} |", current_row.join(" | "));
                            total_chars += row_line.len();
                            lines.push(row_line);
                        }
                        current_row.clear();
                    }
                    b"tbl" => {
                        table_depth = table_depth.saturating_sub(1);
                        if table_depth == 0 && !lines.last().is_some_and(|l| l.is_empty()) {
                            lines.push(String::new());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                // If XML was truncated due to Zip-Bomb guard, stop gracefully instead of failing.
                if xml_bytes.len() as u64 >= limits.max_xml_bytes {
                    truncated = true;
                    break;
                }
                return Err(OfficeError::ParseError(format!(
                    "解析 word/document.xml 失败: {e}"
                )));
            }
            _ => {}
        }
        buf.clear();
    }

    // Trim trailing empty lines
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }

    Ok((lines, truncated))
}

fn extract_heading_level(e: &quick_xml::events::BytesStart<'_>) -> Option<usize> {
    for attr in e.attributes().flatten() {
        if attr.key.local_name().as_ref() == b"val" {
            let val = attr.unescape_value().ok()?.to_string();
            let lower = val.to_ascii_lowercase();
            if lower == "title" {
                return Some(1);
            }
            if lower == "subtitle" {
                return Some(2);
            }
            if let Some(rest) = lower.strip_prefix("heading") {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    return Some(n.clamp(1, 6));
                }
            }
            if let Ok(n) = lower.parse::<usize>() {
                if (1..=6).contains(&n) {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn flush_paragraph(
    para: &str,
    heading_level: Option<usize>,
    wrap_width: usize,
    lines: &mut Vec<String>,
    total_chars: &mut usize,
) {
    let prefix = match heading_level {
        Some(n) => format!("{} ", "#".repeat(n)),
        None => String::new(),
    };

    let segments: Vec<&str> = para.split('\n').collect();
    if segments.iter().all(|s| s.trim().is_empty()) {
        lines.push(String::new());
        return;
    }

    for (seg_idx, seg) in segments.into_iter().enumerate() {
        let trimmed = seg.trim();
        if trimmed.is_empty() {
            continue;
        }
        let full = if seg_idx == 0 && !prefix.is_empty() {
            format!("{prefix}{trimmed}")
        } else {
            trimmed.to_string()
        };
        for wrapped in wrap_text_line(&full, wrap_width) {
            *total_chars += wrapped.len();
            lines.push(wrapped);
        }
    }
}

/// Wraps a single paragraph line around `max_width` chars, preferring punctuation or whitespace boundaries.
pub fn wrap_text_line(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 || text.chars().count() <= max_width {
        return vec![text.to_string()];
    }

    let mut result = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut start = 0usize;

    while start < chars.len() {
        let remaining = chars.len() - start;
        if remaining <= max_width {
            let s: String = chars[start..].iter().collect();
            result.push(s.trim_start().to_string());
            break;
        }

        let end = start + max_width;
        let search_floor = start + max_width / 2;
        let mut split_at = None;

        // Prefer breaking right after punctuation or on whitespace in the second half of the window.
        for idx in (search_floor..end).rev() {
            let ch = chars[idx];
            if is_break_punctuation(ch) {
                split_at = Some(idx + 1);
                break;
            }
            if ch.is_whitespace() {
                split_at = Some(idx);
                break;
            }
        }

        let next_start = split_at.unwrap_or(end);
        let chunk: String = chars[start..next_start].iter().collect();
        let cleaned = chunk.trim();
        if !cleaned.is_empty() {
            result.push(cleaned.to_string());
        }

        start = next_start;
        while start < chars.len() && chars[start].is_whitespace() {
            start += 1;
        }
    }

    if result.is_empty() {
        result.push(String::new());
    }
    result
}

fn is_break_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '。' | '，' | '；' | '：' | '！' | '？' | '、' | '.' | ',' | ';' | ':' | '!' | '?'
    )
}
