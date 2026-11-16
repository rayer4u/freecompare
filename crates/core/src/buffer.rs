use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BufferError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Line index {0} out of bounds (total lines: {1})")]
    LineOutOfBounds(usize, usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EncodingKind {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gb18030,
}

impl EncodingKind {
    pub fn label(&self) -> &'static str {
        match self {
            EncodingKind::Utf8 => "UTF-8",
            EncodingKind::Utf8Bom => "UTF-8 (BOM)",
            EncodingKind::Utf16Le => "UTF-16 LE",
            EncodingKind::Utf16Be => "UTF-16 BE",
            EncodingKind::Gb18030 => "GB18030 / GBK",
        }
    }

    pub fn from_label_or_name(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" => Some(EncodingKind::Utf8),
            "utf-8 (bom)" | "utf-8-bom" | "utf8bom" | "utf8_bom" => Some(EncodingKind::Utf8Bom),
            "utf-16 le" | "utf-16le" | "utf16le" | "utf16_le" => Some(EncodingKind::Utf16Le),
            "utf-16 be" | "utf-16be" | "utf16be" | "utf16_be" => Some(EncodingKind::Utf16Be),
            "gb18030 / gbk" | "gb18030" | "gbk" => Some(EncodingKind::Gb18030),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEnding {
    Lf,
    CrLf,
    Cr,
    Mixed,
}

impl LineEnding {
    pub fn as_str(&self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
            LineEnding::Cr => "\r",
            LineEnding::Mixed => "\n",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            LineEnding::Lf => "LF (Unix/macOS)",
            LineEnding::CrLf => "CRLF (Windows)",
            LineEnding::Cr => "CR",
            LineEnding::Mixed => "Mixed",
        }
    }

    pub fn from_label_or_name(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "lf" | "lf (unix/macos)" | "unix" | "\\n" => Some(LineEnding::Lf),
            "crlf" | "crlf (windows)" | "windows" | "\\r\\n" => Some(LineEnding::CrLf),
            "cr" | "mac" | "\\r" => Some(LineEnding::Cr),
            "mixed" => Some(LineEnding::Mixed),
            _ => None,
        }
    }

    /// Normalizes line endings in `text` and converts them to this `LineEnding`.
    pub fn apply_to(&self, text: &str) -> String {
        let normalized = normalize_line_endings(text);
        match self {
            LineEnding::CrLf => normalized.replace('\n', "\r\n"),
            LineEnding::Cr => normalized.replace('\n', "\r"),
            LineEnding::Lf | LineEnding::Mixed => normalized,
        }
    }
}

#[derive(Debug, Clone)]
struct EditSnapshot {
    rope: Rope,
}

/// High-performance Rope-backed text buffer with encoding detection and undo/redo history.
#[derive(Debug, Clone)]
pub struct TextBuffer {
    path: Option<PathBuf>,
    rope: Rope,
    encoding: EncodingKind,
    line_ending: LineEnding,
    dirty: bool,
    undo_stack: Vec<EditSnapshot>,
    redo_stack: Vec<EditSnapshot>,
}

impl TextBuffer {
    pub fn from_str_content(content: &str) -> Self {
        let line_ending = detect_line_ending(content);
        let normalized = normalize_line_endings(content);
        Self {
            path: None,
            rope: Rope::from_str(&normalized),
            encoding: EncodingKind::Utf8,
            line_ending,
            dirty: false,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, BufferError> {
        let path_buf = expand_path(path);
        let bytes = fs::read(&path_buf)?;
        let (decoded, encoding) = decode_bytes(&bytes);
        let line_ending = detect_line_ending(&decoded);
        let normalized = normalize_line_endings(&decoded);

        Ok(Self {
            path: Some(path_buf),
            rope: Rope::from_str(&normalized),
            encoding,
            line_ending,
            dirty: false,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn set_path(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    pub fn encoding(&self) -> EncodingKind {
        self.encoding
    }

    pub fn line_ending(&self) -> LineEnding {
        self.line_ending
    }

    pub fn set_line_ending(&mut self, le: LineEnding) {
        if self.line_ending != le {
            self.line_ending = le;
            self.dirty = true;
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Number of logical lines in the buffer.
    /// An empty buffer has 0 logical lines; otherwise trailing newline handling is consistent.
    pub fn line_count(&self) -> usize {
        if self.rope.len_bytes() == 0 {
            return 0;
        }
        let raw_lines = self.rope.len_lines();
        // If the buffer ends with '\n', ropey counts an extra empty line at the end.
        // In code editors, a file "a\nb\n" has 2 lines, or if we want exact line representation:
        let last_char = self.rope.char(self.rope.len_chars().saturating_sub(1));
        if last_char == '\n' && raw_lines > 1 {
            raw_lines - 1
        } else {
            raw_lines
        }
    }

    /// Returns the content of logical line `idx` (0-based) without trailing `\n`.
    pub fn line_text(&self, idx: usize) -> Option<String> {
        let count = self.line_count();
        if idx >= count {
            return None;
        }
        let slice = self.rope.line(idx);
        let mut s = slice.to_string();
        if s.ends_with('\n') {
            s.pop();
        }
        if s.ends_with('\r') {
            s.pop();
        }
        Some(s)
    }

    /// Returns all lines as a Vec<String> without trailing newline characters.
    pub fn lines_vec(&self) -> Vec<String> {
        let count = self.line_count();
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            if let Some(line) = self.line_text(i) {
                out.push(line);
            }
        }
        out
    }

    pub fn full_text(&self) -> String {
        self.rope.to_string()
    }

    fn push_undo(&mut self) {
        if self.undo_stack.len() >= 100 {
            self.undo_stack.remove(0);
        }
        self.undo_stack.push(EditSnapshot {
            rope: self.rope.clone(),
        });
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        if let Some(prev) = self.undo_stack.pop() {
            self.redo_stack.push(EditSnapshot {
                rope: self.rope.clone(),
            });
            self.rope = prev.rope;
            self.dirty = !self.undo_stack.is_empty();
            true
        } else {
            false
        }
    }

    pub fn redo(&mut self) -> bool {
        if let Some(next) = self.redo_stack.pop() {
            self.undo_stack.push(EditSnapshot {
                rope: self.rope.clone(),
            });
            self.rope = next.rope;
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// Replaces the range of lines `[start_line..end_line)` (0-based) with `new_lines`.
    pub fn replace_line_range(
        &mut self,
        start_line: usize,
        end_line: usize,
        new_lines: &[String],
    ) -> Result<(), BufferError> {
        let mut lines = self.lines_vec();
        if start_line > lines.len() || end_line > lines.len() || start_line > end_line {
            return Err(BufferError::LineOutOfBounds(end_line, lines.len()));
        }
        self.push_undo();
        lines.splice(start_line..end_line, new_lines.iter().cloned());
        let rebuilt = if lines.is_empty() {
            String::new()
        } else {
            let mut s = lines.join("\n");
            s.push('\n');
            s
        };
        self.rope = Rope::from_str(&rebuilt);
        self.dirty = true;
        Ok(())
    }

    /// Replaces a single line at `line_idx` with `new_content`.
    pub fn edit_line(&mut self, line_idx: usize, new_content: String) -> Result<(), BufferError> {
        self.replace_line_range(line_idx, line_idx + 1, &[new_content])
    }

    /// Replaces the entire buffer content.
    pub fn set_full_text(&mut self, content: &str) {
        self.push_undo();
        let normalized = normalize_line_endings(content);
        self.rope = Rope::from_str(&normalized);
        self.dirty = true;
    }

    /// Saves the buffer back to its file (or a specified target path), preserving original encoding and line endings.
    pub fn save(&mut self, target_path: Option<&Path>) -> Result<(), BufferError> {
        let out_path = match target_path.map(expand_path).or_else(|| self.path.clone()) {
            Some(p) => p,
            None => {
                return Err(BufferError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "No file path specified for saving",
                )))
            }
        };
        if let Some(parent) = out_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let raw_text = self.rope.to_string();
        let text_with_le = match self.line_ending {
            LineEnding::CrLf => raw_text.replace('\n', "\r\n"),
            LineEnding::Cr => raw_text.replace('\n', "\r"),
            LineEnding::Lf | LineEnding::Mixed => raw_text,
        };

        let bytes = encode_string(&text_with_le, self.encoding);
        fs::write(&out_path, bytes)?;
        self.path = Some(out_path);
        self.dirty = false;
        Ok(())
    }
}

pub fn decode_bytes(bytes: &[u8]) -> (String, EncodingKind) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (cow, _, _) = UTF_8.decode(&bytes[3..]);
        return (cow.into_owned(), EncodingKind::Utf8Bom);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = UTF_16LE.decode(&bytes[2..]);
        return (cow.into_owned(), EncodingKind::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = UTF_16BE.decode(&bytes[2..]);
        return (cow.into_owned(), EncodingKind::Utf16Be);
    }

    if let Ok(utf8_str) = std::str::from_utf8(bytes) {
        return (utf8_str.to_owned(), EncodingKind::Utf8);
    }

    let (cow, _, _) = GB18030.decode(bytes);
    (cow.into_owned(), EncodingKind::Gb18030)
}

pub fn encode_string(text: &str, encoding: EncodingKind) -> Vec<u8> {
    match encoding {
        EncodingKind::Utf8 => text.as_bytes().to_vec(),
        EncodingKind::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        EncodingKind::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for code_unit in text.encode_utf16() {
                out.extend_from_slice(&code_unit.to_le_bytes());
            }
            out
        }
        EncodingKind::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            for code_unit in text.encode_utf16() {
                out.extend_from_slice(&code_unit.to_be_bytes());
            }
            out
        }
        EncodingKind::Gb18030 => {
            let (cow, _, _) = Encoding::for_label(b"gb18030")
                .unwrap_or(GB18030)
                .encode(text);
            cow.into_owned()
        }
    }
}

/// Detects line endings in `text`, returning `None` if no line ending characters exist.
pub fn detect_line_ending_opt(text: &str) -> Option<LineEnding> {
    let mut crlf_count = 0usize;
    let mut lf_only_count = 0usize;
    let mut cr_only_count = 0usize;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                crlf_count += 1;
                i += 2;
                continue;
            }
            cr_only_count += 1;
        } else if bytes[i] == b'\n' {
            lf_only_count += 1;
        }
        i += 1;
    }

    match (crlf_count > 0, lf_only_count > 0, cr_only_count > 0) {
        (true, false, false) => Some(LineEnding::CrLf),
        (false, true, false) => Some(LineEnding::Lf),
        (false, false, true) => Some(LineEnding::Cr),
        (false, false, false) => None,
        _ => Some(LineEnding::Mixed),
    }
}

pub fn detect_line_ending(text: &str) -> LineEnding {
    detect_line_ending_opt(text).unwrap_or(if cfg!(windows) {
        LineEnding::CrLf
    } else {
        LineEnding::Lf
    })
}

/// Detects the encoding and optional line ending of an existing file on disk.
pub fn detect_file_format(
    path: impl AsRef<Path>,
) -> Result<(EncodingKind, Option<LineEnding>), BufferError> {
    let path_buf = expand_path(path);
    let bytes = fs::read(&path_buf)?;
    let (decoded, encoding) = decode_bytes(&bytes);
    Ok((encoding, detect_line_ending_opt(&decoded)))
}

pub fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn resolve_home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

fn join_normalized_rel(base: PathBuf, rel: &str) -> PathBuf {
    let mut out = base;
    for comp in rel.split(['/', '\\']) {
        if !comp.is_empty() && comp != "." {
            out.push(comp);
        }
    }
    out
}

/// Expands user home directory (e.g. `~/path`, `~`, `$HOME`, `%USERPROFILE%`) and resolves relative paths to absolute paths.
pub fn expand_path(path: impl AsRef<Path>) -> PathBuf {
    let p = path.as_ref();
    let s = p.to_string_lossy();
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }

    let expanded = if trimmed == "~"
        || trimmed == "$HOME"
        || trimmed == "${HOME}"
        || trimmed.eq_ignore_ascii_case("%USERPROFILE%")
    {
        resolve_home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        .or_else(|| trimmed.strip_prefix("$HOME/"))
        .or_else(|| trimmed.strip_prefix("$HOME\\"))
        .or_else(|| trimmed.strip_prefix("${HOME}/"))
        .or_else(|| trimmed.strip_prefix("${HOME}\\"))
        .or_else(|| {
            let prefix = "%userprofile%";
            if trimmed.len() > prefix.len()
                && trimmed[..prefix.len()].eq_ignore_ascii_case(prefix)
                && (trimmed.as_bytes()[prefix.len()] == b'/'
                    || trimmed.as_bytes()[prefix.len()] == b'\\')
            {
                Some(&trimmed[prefix.len() + 1..])
            } else {
                None
            }
        })
    {
        if let Some(home) = resolve_home_dir() {
            join_normalized_rel(home, rest)
        } else {
            PathBuf::from(trimmed)
        }
    } else if cfg!(windows) {
        PathBuf::from(trimmed.replace('/', "\\"))
    } else {
        PathBuf::from(trimmed)
    };

    if expanded.is_relative() {
        if let Ok(cwd) = std::env::current_dir() {
            let combined = cwd.join(&expanded);
            if let Ok(canon) = combined.canonicalize() {
                return canon;
            }
            return combined;
        }
    } else if let Ok(canon) = expanded.canonicalize() {
        return canon;
    }

    expanded
}
