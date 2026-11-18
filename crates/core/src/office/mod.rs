//! Read-only Office document extraction (Excel & Word `.docx`).
//!
//! All file I/O goes through [`crate::vfs`] so Local and SFTP paths behave identically,
//! and strict size / Zip-Bomb / row-count limits are enforced.

pub mod excel;
pub mod word;

use crate::vfs;
use std::path::Path;
use thiserror::Error;

/// Maximum raw Office file size allowed for read-only comparison (50 MB).
pub const MAX_OFFICE_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Maximum uncompressed XML stream size read from a Zip-based Office container (20 MB).
pub const MAX_XML_BYTES: u64 = 20 * 1024 * 1024;

/// ZIP / OOXML local file header magic (`PK\x03\x04`).
pub const ZIP_MAGIC: &[u8] = &[0x50, 0x4B, 0x03, 0x04];

/// OLE2 Compound Document Binary Format magic (`.doc`, `.xls`).
pub const OLE2_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeKind {
    ExcelXlsx,
    ExcelXlsm,
    ExcelXlsb,
    ExcelXls,
    ExcelOds,
    WordDocx,
}

impl OfficeKind {
    /// Human-readable status-bar label for the UI.
    pub fn doc_info(&self) -> &'static str {
        match self {
            Self::ExcelXlsx => "XLSX · 只读 · 缓存值",
            Self::ExcelXlsm => "XLSM · 只读 · 缓存值",
            Self::ExcelXlsb => "XLSB · 只读 · 缓存值",
            Self::ExcelXls => "XLS · 只读 · 缓存值",
            Self::ExcelOds => "ODS · 只读 · 缓存值",
            Self::WordDocx => "DOCX · 只读",
        }
    }

    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "xlsx" => Some(Self::ExcelXlsx),
            "xlsm" => Some(Self::ExcelXlsm),
            "xlsb" => Some(Self::ExcelXlsb),
            "xls" => Some(Self::ExcelXls),
            "ods" => Some(Self::ExcelOds),
            "docx" => Some(Self::WordDocx),
            _ => None,
        }
    }

    pub fn is_excel(&self) -> bool {
        matches!(
            self,
            Self::ExcelXlsx | Self::ExcelXlsm | Self::ExcelXlsb | Self::ExcelXls | Self::ExcelOds
        )
    }
}

#[derive(Debug, Clone)]
pub struct OfficeDocument {
    pub kind: OfficeKind,
    pub doc_info: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Error)]
pub enum OfficeError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("暂不支持老式二进制 Word (.doc) 格式，请使用 Word/WPS/LibreOffice 另存为 .docx 后再进行比对")]
    LegacyDocUnsupported,
    #[error("Office 文件过大 ({size_mb:.1} MB)，超过只读比对上限 ({max_mb:.0} MB)")]
    FileTooLarge { size_mb: f64, max_mb: f64 },
    #[error("无法解析 Office 文档: {0}")]
    ParseError(String),
}

pub fn is_zip_magic(bytes: &[u8]) -> bool {
    bytes.len() >= ZIP_MAGIC.len() && &bytes[..ZIP_MAGIC.len()] == ZIP_MAGIC
}

pub fn is_ole2_magic(bytes: &[u8]) -> bool {
    bytes.len() >= OLE2_MAGIC.len() && &bytes[..OLE2_MAGIC.len()] == OLE2_MAGIC
}

/// Extracts lowercase file extension from a local path or `sftp://` URI.
pub fn extract_extension(path: &str) -> Option<String> {
    let trimmed = path.trim();
    let candidate = if crate::sftp::is_sftp_uri(trimmed) {
        trimmed.split(['?', '#']).next().unwrap_or(trimmed)
    } else {
        trimmed
    };
    Path::new(candidate)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

/// Returns `true` if `path` has a recognized Office extension (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, `.docx`, `.doc`).
pub fn is_office_path(path: &str) -> bool {
    let Some(ext) = extract_extension(path) else {
        return false;
    };
    matches!(
        ext.as_str(),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "docx" | "doc"
    )
}

/// Hard write-protection gate: rejects saving text over any Office extension or existing Zip/OLE2 binary file.
pub fn ensure_writable_text_target(path: &str) -> Result<(), String> {
    if is_office_path(path) {
        return Err("Office 文档处于只读比对模式，禁止写入或覆盖保存".to_string());
    }
    if vfs::is_file(path) {
        if let Ok(header) = vfs::read_header_bytes(path, OLE2_MAGIC.len()) {
            if is_zip_magic(&header) || is_ole2_magic(&header) {
                return Err(
                    "目标文件为二进制容器或 Office 文档，禁止以文本形式覆盖写入".to_string()
                );
            }
        }
    }
    Ok(())
}

/// Loads and extracts an Office document via VFS (`vfs::metadata` + `vfs::read_bytes`).
pub fn load_office_document(path: &str) -> Result<OfficeDocument, OfficeError> {
    let ext = extract_extension(path).unwrap_or_default();
    if ext == "doc" {
        return Err(OfficeError::LegacyDocUnsupported);
    }

    let meta = vfs::metadata(path)?;
    if meta.size > MAX_OFFICE_FILE_BYTES {
        return Err(OfficeError::FileTooLarge {
            size_mb: meta.size as f64 / (1024.0 * 1024.0),
            max_mb: MAX_OFFICE_FILE_BYTES as f64 / (1024.0 * 1024.0),
        });
    }

    let bytes = vfs::read_bytes(path)?;
    if bytes.len() as u64 > MAX_OFFICE_FILE_BYTES {
        return Err(OfficeError::FileTooLarge {
            size_mb: bytes.len() as f64 / (1024.0 * 1024.0),
            max_mb: MAX_OFFICE_FILE_BYTES as f64 / (1024.0 * 1024.0),
        });
    }

    extract_office_bytes(&bytes, &ext)
}

/// Extracts an Office document from in-memory bytes and an extension hint.
pub fn extract_office_bytes(bytes: &[u8], ext: &str) -> Result<OfficeDocument, OfficeError> {
    let ext_lower = ext.to_ascii_lowercase();
    if ext_lower == "doc" {
        return Err(OfficeError::LegacyDocUnsupported);
    }

    let kind = OfficeKind::from_extension(&ext_lower).ok_or_else(|| {
        if is_ole2_magic(bytes) {
            OfficeError::LegacyDocUnsupported
        } else {
            OfficeError::ParseError(format!("不支持的 Office 扩展名: .{ext_lower}"))
        }
    })?;

    if kind == OfficeKind::WordDocx {
        if is_ole2_magic(bytes) {
            return Err(OfficeError::LegacyDocUnsupported);
        }
        return word::extract_docx(bytes);
    }

    match excel::extract_excel(bytes, kind) {
        Ok(doc) => Ok(doc),
        Err(err) => {
            // If an OLE2 file wasn't a valid `.xls` workbook, surface a clear message.
            if is_ole2_magic(bytes) && kind != OfficeKind::ExcelXls {
                Err(OfficeError::LegacyDocUnsupported)
            } else {
                Err(err)
            }
        }
    }
}
