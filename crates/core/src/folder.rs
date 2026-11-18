use crate::vfs::{self, VfsPath};
use globset::{Glob, GlobSet, GlobSetBuilder};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_FOLDER_ENTRIES: usize = 30000;
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderCompareMode {
    FastMetadata,
    ContentHash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderCompareOptions {
    pub mode: FolderCompareMode,
    #[serde(default)]
    pub ignore_case_names: bool,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub max_depth: Option<usize>,
}

impl Default for FolderCompareOptions {
    fn default() -> Self {
        Self {
            mode: FolderCompareMode::ContentHash,
            ignore_case_names: cfg!(any(target_os = "windows", target_os = "macos")),
            exclude_globs: vec![
                ".git".to_string(),
                "node_modules".to_string(),
                "target".to_string(),
                ".DS_Store".to_string(),
            ],
            recursive: false,
            max_depth: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderItemStatus {
    Equal,
    Modified,
    LeftOnly,
    RightOnly,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSubtreeResult {
    pub relative_path: String,
    pub entries: Vec<FolderEntryDto>,
    pub status: FolderItemStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderEntryDto {
    pub relative_path: String,
    pub name: String,
    pub is_dir: bool,
    pub depth: usize,
    pub status: FolderItemStatus,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    pub left_modified_ms: Option<u64>,
    pub right_modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FolderDiffStats {
    pub total_items: usize,
    pub equal_items: usize,
    pub modified_items: usize,
    pub left_only_items: usize,
    pub right_only_items: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDiffResult {
    pub left_root: String,
    pub right_root: String,
    pub entries: Vec<FolderEntryDto>,
    pub stats: FolderDiffStats,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderSyncActionKind {
    CopyLeftToRight,
    CopyRightToLeft,
    DeleteLeft,
    DeleteRight,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSyncAction {
    pub relative_path: String,
    pub is_dir: bool,
    pub action: FolderSyncActionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSyncPlan {
    pub actions: Vec<FolderSyncAction>,
}

struct ScanProgressTracker<'a> {
    dirs_scanned: usize,
    last_emit: Option<Instant>,
    on_progress: Option<&'a (dyn Fn(usize, usize) + Send + Sync)>,
}

impl<'a> ScanProgressTracker<'a> {
    fn new(on_progress: Option<&'a (dyn Fn(usize, usize) + Send + Sync)>) -> Self {
        Self {
            dirs_scanned: 0,
            last_emit: None,
            on_progress,
        }
    }

    fn record_dir(&mut self, items_found: usize) {
        self.dirs_scanned += 1;
        self.maybe_emit(items_found);
    }

    fn maybe_emit(&mut self, items_found: usize) {
        let Some(cb) = self.on_progress else {
            return;
        };
        let now = Instant::now();
        let should_emit = match self.last_emit {
            None => true,
            Some(prev) => now.duration_since(prev) >= PROGRESS_THROTTLE,
        };
        if should_emit {
            self.last_emit = Some(now);
            cb(self.dirs_scanned, items_found);
        }
    }
}

#[inline]
fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::Relaxed))
}

#[inline]
fn cancelled_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "SCAN_CANCELLED")
}

pub fn compare_folders(
    left_root: impl AsRef<Path>,
    right_root: impl AsRef<Path>,
    options: &FolderCompareOptions,
) -> std::io::Result<FolderDiffResult> {
    compare_folders_with_control(left_root, right_root, options, None, None)
}

pub fn compare_folders_with_control(
    left_root: impl AsRef<Path>,
    right_root: impl AsRef<Path>,
    options: &FolderCompareOptions,
    cancel: Option<&AtomicBool>,
    on_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> std::io::Result<FolderDiffResult> {
    let left_vfs = VfsPath::parse(&left_root.as_ref().to_string_lossy())?;
    let right_vfs = VfsPath::parse(&right_root.as_ref().to_string_lossy())?;
    let glob_set = build_exclude_globset(&options.exclude_globs);

    let mut entries = Vec::new();
    let mut stats = FolderDiffStats::default();
    let mut truncated = false;
    let mut tracker = ScanProgressTracker::new(on_progress);

    compare_dir_recursive(
        &left_vfs,
        &right_vfs,
        "",
        0,
        options,
        &glob_set,
        &mut entries,
        &mut stats,
        &mut truncated,
        cancel,
        &mut tracker,
    )?;

    Ok(FolderDiffResult {
        left_root: left_vfs.display_string(),
        right_root: right_vfs.display_string(),
        entries,
        stats,
        truncated,
    })
}

pub fn compare_subfolder(
    left_root: impl AsRef<Path>,
    right_root: impl AsRef<Path>,
    sub_rel: &str,
    options: &FolderCompareOptions,
) -> std::io::Result<FolderSubtreeResult> {
    compare_subfolder_with_control(left_root, right_root, sub_rel, options, None, None)
}

pub fn compare_subfolder_with_control(
    left_root: impl AsRef<Path>,
    right_root: impl AsRef<Path>,
    sub_rel: &str,
    options: &FolderCompareOptions,
    cancel: Option<&AtomicBool>,
    on_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> std::io::Result<FolderSubtreeResult> {
    if is_cancelled(cancel) {
        return Err(cancelled_error());
    }
    let left_vfs = VfsPath::parse(&left_root.as_ref().to_string_lossy())?;
    let right_vfs = VfsPath::parse(&right_root.as_ref().to_string_lossy())?;
    let glob_set = build_exclude_globset(&options.exclude_globs);

    let clean_rel = sub_rel.trim_matches('/').replace('\\', "/");
    let base_depth = clean_rel.split('/').filter(|s| !s.is_empty()).count();

    let mut entries = Vec::new();
    let mut stats = FolderDiffStats::default();
    let mut truncated = false;
    let mut tracker = ScanProgressTracker::new(on_progress);

    let mut sub_opts = options.clone();
    if !options.recursive {
        sub_opts.recursive = false;
        sub_opts.max_depth = Some(base_depth);
    }

    compare_dir_recursive(
        &left_vfs,
        &right_vfs,
        &clean_rel,
        base_depth,
        &sub_opts,
        &glob_set,
        &mut entries,
        &mut stats,
        &mut truncated,
        cancel,
        &mut tracker,
    )?;

    if is_cancelled(cancel) {
        return Err(cancelled_error());
    }

    let has_diff = entries
        .iter()
        .any(|e| e.status != FolderItemStatus::Equal && e.status != FolderItemStatus::Unknown);
    let l_exists = vfs::exists(&left_vfs.join_rel(&clean_rel).display_string());
    let r_exists = vfs::exists(&right_vfs.join_rel(&clean_rel).display_string());

    let status = match (l_exists, r_exists) {
        (true, true) => {
            if has_diff {
                FolderItemStatus::Modified
            } else {
                FolderItemStatus::Equal
            }
        }
        (true, false) => FolderItemStatus::LeftOnly,
        (false, true) => FolderItemStatus::RightOnly,
        (false, false) => FolderItemStatus::Equal,
    };

    Ok(FolderSubtreeResult {
        relative_path: clean_rel,
        entries,
        status,
    })
}

#[derive(Clone)]
struct LocalMeta {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

#[allow(clippy::too_many_arguments)]
fn compare_dir_recursive(
    left_root: &VfsPath,
    right_root: &VfsPath,
    rel_dir: &str,
    depth: usize,
    options: &FolderCompareOptions,
    glob_set: &GlobSet,
    out: &mut Vec<FolderEntryDto>,
    stats: &mut FolderDiffStats,
    truncated: &mut bool,
    cancel: Option<&AtomicBool>,
    tracker: &mut ScanProgressTracker<'_>,
) -> std::io::Result<()> {
    if is_cancelled(cancel) {
        return Err(cancelled_error());
    }
    if out.len() >= MAX_FOLDER_ENTRIES {
        *truncated = true;
        return Ok(());
    }

    tracker.record_dir(out.len());

    let left_dir = left_root.join_rel(rel_dir).display_string();
    let right_dir = right_root.join_rel(rel_dir).display_string();

    let (left_map, right_map) = if left_root.is_sftp() || right_root.is_sftp() {
        rayon::join(
            || read_dir_entries(&left_dir, rel_dir, options.ignore_case_names, glob_set),
            || read_dir_entries(&right_dir, rel_dir, options.ignore_case_names, glob_set),
        )
    } else {
        (
            read_dir_entries(&left_dir, rel_dir, options.ignore_case_names, glob_set),
            read_dir_entries(&right_dir, rel_dir, options.ignore_case_names, glob_set),
        )
    };

    let mut all_keys: Vec<String> = left_map
        .keys()
        .chain(right_map.keys())
        .cloned()
        .collect();
    all_keys.sort();
    all_keys.dedup();

    // Sort directories before files
    all_keys.sort_by(|a, b| {
        let a_dir = left_map
            .get(a)
            .map(|m| m.is_dir)
            .or_else(|| right_map.get(a).map(|m| m.is_dir))
            .unwrap_or(false);
        let b_dir = left_map
            .get(b)
            .map(|m| m.is_dir)
            .or_else(|| right_map.get(b).map(|m| m.is_dir))
            .unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| a.cmp(b))
    });

    let mut dir_keys = Vec::new();
    let mut file_keys = Vec::new();
    for key in all_keys {
        let is_dir = left_map
            .get(&key)
            .map(|m| m.is_dir)
            .or_else(|| right_map.get(&key).map(|m| m.is_dir))
            .unwrap_or(false);
        if is_dir {
            dir_keys.push(key);
        } else {
            file_keys.push(key);
        }
    }

    for key in dir_keys {
        if is_cancelled(cancel) {
            return Err(cancelled_error());
        }
        if out.len() >= MAX_FOLDER_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let l_meta = left_map.get(&key);
        let r_meta = right_map.get(&key);

        let display_name = l_meta
            .map(|m| m.name.clone())
            .or_else(|| r_meta.map(|m| m.name.clone()))
            .unwrap_or_else(|| key.clone());

        let normalized_rel = if rel_dir.is_empty() {
            display_name.clone()
        } else {
            format!("{}/{}", rel_dir.trim_end_matches('/'), display_name)
        };

        let dir_idx = out.len();
        let should_recurse =
            options.recursive || options.max_depth.map_or(false, |md| depth < md);

        let initial_status = match (l_meta.is_some(), r_meta.is_some()) {
            (true, true) => {
                if should_recurse {
                    FolderItemStatus::Equal
                } else {
                    FolderItemStatus::Unknown
                }
            }
            (true, false) => FolderItemStatus::LeftOnly,
            (false, true) => FolderItemStatus::RightOnly,
            (false, false) => FolderItemStatus::Equal,
        };

        out.push(FolderEntryDto {
            relative_path: normalized_rel.clone(),
            name: display_name,
            is_dir: true,
            depth,
            status: initial_status,
            left_size: None,
            right_size: None,
            left_modified_ms: l_meta.map(|m| m.modified_ms),
            right_modified_ms: r_meta.map(|m| m.modified_ms),
        });

        if should_recurse {
            let child_start = out.len();
            compare_dir_recursive(
                left_root,
                right_root,
                &normalized_rel,
                depth + 1,
                options,
                glob_set,
                out,
                stats,
                truncated,
                cancel,
                tracker,
            )?;

            // Propagate child differences upward to parent directory status
            if initial_status == FolderItemStatus::Equal {
                let has_diff_child = out[child_start..]
                    .iter()
                    .any(|c| c.status != FolderItemStatus::Equal && c.status != FolderItemStatus::Unknown);
                if has_diff_child {
                    out[dir_idx].status = FolderItemStatus::Modified;
                }
            }
        }
    }

    if is_cancelled(cancel) {
        return Err(cancelled_error());
    }

    // Compare same-level files in parallel using rayon so BLAKE3 streaming hashes scale across cores
    let file_entries: Vec<FolderEntryDto> = file_keys
        .par_iter()
        .map(|key| {
            if is_cancelled(cancel) {
                return Err(cancelled_error());
            }
            let l_meta = left_map.get(key);
            let r_meta = right_map.get(key);

            let display_name = l_meta
                .map(|m| m.name.clone())
                .or_else(|| r_meta.map(|m| m.name.clone()))
                .unwrap_or_else(|| key.clone());

            let normalized_rel = if rel_dir.is_empty() {
                display_name.clone()
            } else {
                format!("{}/{}", rel_dir.trim_end_matches('/'), display_name)
            };

            let status = match (l_meta, r_meta) {
                (Some(l), Some(r)) => {
                    if files_equal(
                        &l.path,
                        l.size,
                        l.modified_ms,
                        &r.path,
                        r.size,
                        r.modified_ms,
                        options.mode,
                    ) {
                        FolderItemStatus::Equal
                    } else {
                        FolderItemStatus::Modified
                    }
                }
                (Some(_), None) => FolderItemStatus::LeftOnly,
                (None, Some(_)) => FolderItemStatus::RightOnly,
                (None, None) => FolderItemStatus::Equal,
            };

            Ok(FolderEntryDto {
                relative_path: normalized_rel,
                name: display_name,
                is_dir: false,
                depth,
                status,
                left_size: l_meta.map(|m| m.size),
                right_size: r_meta.map(|m| m.size),
                left_modified_ms: l_meta.map(|m| m.modified_ms),
                right_modified_ms: r_meta.map(|m| m.modified_ms),
            })
        })
        .collect::<std::io::Result<Vec<_>>>()?;

    for entry in file_entries {
        if out.len() >= MAX_FOLDER_ENTRIES {
            *truncated = true;
            break;
        }
        match entry.status {
            FolderItemStatus::Equal => stats.equal_items += 1,
            FolderItemStatus::Modified => stats.modified_items += 1,
            FolderItemStatus::LeftOnly => stats.left_only_items += 1,
            FolderItemStatus::RightOnly => stats.right_only_items += 1,
            FolderItemStatus::Unknown => {}
        }
        stats.total_items += 1;
        out.push(entry);
    }

    tracker.maybe_emit(out.len());

    Ok(())
}

fn read_dir_entries(
    dir: &str,
    rel_dir: &str,
    ignore_case: bool,
    glob_set: &GlobSet,
) -> BTreeMap<String, LocalMeta> {
    let mut map = BTreeMap::new();
    let Ok(entries) = vfs::read_dir(dir) else {
        return map;
    };

    for entry in entries {
        let rel_path = if rel_dir.is_empty() {
            entry.name.clone()
        } else {
            format!("{}/{}", rel_dir.trim_end_matches('/'), entry.name)
        };
        if glob_set.is_match(&entry.name) || glob_set.is_match(&rel_path) {
            continue;
        }

        let key = if ignore_case {
            entry.name.to_lowercase()
        } else {
            entry.name.clone()
        };

        map.insert(
            key,
            LocalMeta {
                name: entry.name,
                path: entry.full_path,
                is_dir: entry.is_dir,
                size: entry.size,
                modified_ms: entry.modified_ms,
            },
        );
    }

    map
}

fn files_equal(
    left_path: &str,
    left_size: u64,
    left_mtime: u64,
    right_path: &str,
    right_size: u64,
    right_mtime: u64,
    mode: FolderCompareMode,
) -> bool {
    if left_size != right_size {
        return false;
    }
    if mode == FolderCompareMode::FastMetadata {
        return left_mtime.abs_diff(right_mtime) < 2000;
    }
    match rayon::join(|| vfs::hash_file_blake3(left_path), || vfs::hash_file_blake3(right_path)) {
        (Ok(h1), Ok(h2)) => h1 == h2,
        _ => false,
    }
}

fn build_exclude_globset(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pat in patterns {
        if let Ok(g) = Glob::new(pat) {
            builder.add(g);
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

/// Copies or deletes an entry between left and right folder roots (supports Local and SFTP).
pub fn apply_folder_item_operation(
    left_root: &Path,
    right_root: &Path,
    relative_path: &str,
    action: FolderSyncActionKind,
) -> std::io::Result<()> {
    let left_vfs = VfsPath::parse(&left_root.to_string_lossy())?;
    let right_vfs = VfsPath::parse(&right_root.to_string_lossy())?;
    let left_target = left_vfs.join_rel(relative_path).display_string();
    let right_target = right_vfs.join_rel(relative_path).display_string();

    match action {
        FolderSyncActionKind::CopyLeftToRight => vfs::copy_recursive(&left_target, &right_target),
        FolderSyncActionKind::CopyRightToLeft => vfs::copy_recursive(&right_target, &left_target),
        FolderSyncActionKind::DeleteLeft => vfs::remove_any(&left_target),
        FolderSyncActionKind::DeleteRight => vfs::remove_any(&right_target),
    }
}
