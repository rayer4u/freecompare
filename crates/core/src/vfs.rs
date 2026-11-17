//! Unified Virtual File System (VFS) over local paths and `sftp://` URIs.
//!
//! Ensures `buffer`, `two_way`, `three_way`, `folder`, and RPC layers handle
//! Local <-> Local, Local <-> SFTP, and SFTP <-> SFTP identically.

use crate::buffer::expand_path;
use crate::sftp::{
    is_sftp_uri, prime_location_credentials, sftp_create_dir_all, sftp_exists,
    sftp_hash_file_blake3, sftp_is_dir, sftp_list_dir, sftp_metadata, sftp_read_bytes,
    sftp_remove_any, sftp_write_bytes, SftpLocation,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub enum VfsPath {
    Local(PathBuf),
    Sftp(SftpLocation),
}

#[derive(Debug, Clone)]
pub struct VfsMetadata {
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone)]
pub struct VfsDirEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

impl VfsPath {
    pub fn parse(raw: &str) -> io::Result<Self> {
        let trimmed = raw.trim();
        if is_sftp_uri(trimmed) {
            let loc = SftpLocation::parse(trimmed)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            prime_location_credentials(&loc);
            Ok(Self::Sftp(loc))
        } else {
            Ok(Self::Local(expand_path(trimmed)))
        }
    }

    pub fn is_sftp(&self) -> bool {
        matches!(self, Self::Sftp(_))
    }

    pub fn display_string(&self) -> String {
        match self {
            Self::Local(p) => p.to_string_lossy().to_string(),
            Self::Sftp(loc) => loc.to_uri(),
        }
    }

    pub fn file_name(&self) -> String {
        match self {
            Self::Local(p) => p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.to_string_lossy().to_string()),
            Self::Sftp(loc) => loc.file_name(),
        }
    }

    pub fn extension(&self) -> Option<String> {
        let name = self.file_name();
        Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
    }

    pub fn join_rel(&self, rel: &str) -> Self {
        match self {
            Self::Local(p) => {
                let mut out = p.clone();
                for comp in rel.split(['/', '\\']).filter(|c| !c.is_empty() && *c != ".") {
                    out.push(comp);
                }
                Self::Local(out)
            }
            Self::Sftp(loc) => Self::Sftp(loc.join_rel(rel)),
        }
    }
}

pub fn read_bytes(path: &str) -> io::Result<Vec<u8>> {
    if is_sftp_uri(path) {
        sftp_read_bytes(path)
    } else {
        fs::read(expand_path(path))
    }
}

pub fn write_bytes(path: &str, bytes: &[u8]) -> io::Result<()> {
    if is_sftp_uri(path) {
        sftp_write_bytes(path, bytes)
    } else {
        let expanded = expand_path(path);
        if let Some(parent) = expanded.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(&expanded, bytes)
    }
}

pub fn metadata(path: &str) -> io::Result<VfsMetadata> {
    if is_sftp_uri(path) {
        let m = sftp_metadata(path)?;
        Ok(VfsMetadata {
            is_dir: m.is_dir,
            is_file: m.is_file,
            size: m.size,
            modified_ms: m.modified_ms,
        })
    } else {
        let expanded = expand_path(path);
        let m = fs::metadata(&expanded)?;
        let modified_ms = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(VfsMetadata {
            is_dir: m.is_dir(),
            is_file: m.is_file(),
            size: if m.is_file() { m.len() } else { 0 },
            modified_ms,
        })
    }
}

pub fn exists(path: &str) -> bool {
    if is_sftp_uri(path) {
        sftp_exists(path)
    } else {
        expand_path(path).exists()
    }
}

pub fn is_dir(path: &str) -> bool {
    if is_sftp_uri(path) {
        sftp_is_dir(path)
    } else {
        expand_path(path).is_dir()
    }
}

pub fn is_file(path: &str) -> bool {
    if is_sftp_uri(path) {
        sftp_metadata(path).map(|m| m.is_file).unwrap_or(false)
    } else {
        expand_path(path).is_file()
    }
}

pub fn read_dir(path: &str) -> io::Result<Vec<VfsDirEntry>> {
    if is_sftp_uri(path) {
        let listing = sftp_list_dir(path, None)?;
        Ok(listing
            .entries
            .into_iter()
            .map(|e| VfsDirEntry {
                name: e.name,
                full_path: e.uri,
                is_dir: e.is_dir,
                size: e.size,
                modified_ms: e.modified_ms,
            })
            .collect())
    } else {
        let dir = expand_path(path);
        let rd = fs::read_dir(&dir)?;
        let mut out = Vec::new();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Follow symlinks so `git difftool --dir-diff` works transparently
            let Ok(meta) = fs::metadata(entry.path()).or_else(|_| entry.metadata()) else {
                continue;
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(VfsDirEntry {
                name,
                full_path: entry.path().to_string_lossy().to_string(),
                is_dir: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
                modified_ms,
            });
        }
        Ok(out)
    }
}

pub fn create_dir_all(path: &str) -> io::Result<()> {
    if is_sftp_uri(path) {
        sftp_create_dir_all(path)
    } else {
        fs::create_dir_all(expand_path(path))
    }
}

pub fn remove_any(path: &str) -> io::Result<()> {
    if is_sftp_uri(path) {
        sftp_remove_any(path)
    } else {
        let target = expand_path(path);
        if !target.exists() {
            return Ok(());
        }
        if target.is_dir() {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        }
    }
}

pub fn copy_recursive(src: &str, dst: &str) -> io::Result<()> {
    if !is_sftp_uri(src) && !is_sftp_uri(dst) {
        return copy_local_recursive(&expand_path(src), &expand_path(dst));
    }

    let meta = metadata(src)?;
    if meta.is_dir {
        create_dir_all(dst)?;
        let src_vfs = VfsPath::parse(src)?;
        let dst_vfs = VfsPath::parse(dst)?;
        for entry in read_dir(src)? {
            let child_src = src_vfs.join_rel(&entry.name).display_string();
            let child_dst = dst_vfs.join_rel(&entry.name).display_string();
            copy_recursive(&child_src, &child_dst)?;
        }
    } else {
        let bytes = read_bytes(src)?;
        write_bytes(dst, &bytes)?;
    }
    Ok(())
}

fn copy_local_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = fs::metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_local_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

pub fn hash_file_blake3(path: &str) -> io::Result<blake3::Hash> {
    if is_sftp_uri(path) {
        sftp_hash_file_blake3(path)
    } else {
        let mut file = fs::File::open(expand_path(path))?;
        let mut hasher = blake3::Hasher::new();
        io::copy(&mut file, &mut hasher)?;
        Ok(hasher.finalize())
    }
}
