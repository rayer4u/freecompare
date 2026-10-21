use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderCompareMode {
    FastMetadata,
    ContentHash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderCompareOptions {
    pub mode: FolderCompareMode,
    pub ignore_case_names: bool,
    pub exclude_globs: Vec<String>,
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

pub fn compare_folders(
    left_root: impl AsRef<Path>,
    right_root: impl AsRef<Path>,
    options: &FolderCompareOptions,
) -> std::io::Result<FolderDiffResult> {
    let left_base = left_root.as_ref();
    let right_base = right_root.as_ref();
    let glob_set = build_exclude_globset(&options.exclude_globs);

    let mut entries = Vec::new();
    let mut stats = FolderDiffStats::default();

    compare_dir_recursive(
        left_base,
        right_base,
        Path::new(""),
        0,
        options,
        &glob_set,
        &mut entries,
        &mut stats,
    )?;

    Ok(FolderDiffResult {
        left_root: left_base.to_string_lossy().to_string(),
        right_root: right_base.to_string_lossy().to_string(),
        entries,
        stats,
    })
}

#[derive(Clone)]
struct LocalMeta {
    name: String,
    path: PathBuf,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

#[allow(clippy::too_many_arguments)]
fn compare_dir_recursive(
    left_root: &Path,
    right_root: &Path,
    rel_dir: &Path,
    depth: usize,
    options: &FolderCompareOptions,
    glob_set: &GlobSet,
    out: &mut Vec<FolderEntryDto>,
    stats: &mut FolderDiffStats,
) -> std::io::Result<()> {
    let left_dir = left_root.join(rel_dir);
    let right_dir = right_root.join(rel_dir);

    let left_map = read_dir_entries(&left_dir, rel_dir, options.ignore_case_names, glob_set);
    let right_map = read_dir_entries(&right_dir, rel_dir, options.ignore_case_names, glob_set);

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

    for key in all_keys {
        let l_meta = left_map.get(&key);
        let r_meta = right_map.get(&key);

        let display_name = l_meta
            .map(|m| m.name.clone())
            .or_else(|| r_meta.map(|m| m.name.clone()))
            .unwrap_or_else(|| key.clone());

        let child_rel = if rel_dir.as_os_str().is_empty() {
            PathBuf::from(&display_name)
        } else {
            rel_dir.join(&display_name)
        };
        let normalized_rel = child_rel.to_string_lossy().replace('\\', "/");

        let is_dir = l_meta
            .map(|m| m.is_dir)
            .or_else(|| r_meta.map(|m| m.is_dir))
            .unwrap_or(false);

        if is_dir {
            let dir_idx = out.len();
            let initial_status = match (l_meta.is_some(), r_meta.is_some()) {
                (true, true) => FolderItemStatus::Equal,
                (true, false) => FolderItemStatus::LeftOnly,
                (false, true) => FolderItemStatus::RightOnly,
                (false, false) => FolderItemStatus::Equal,
            };

            out.push(FolderEntryDto {
                relative_path: normalized_rel,
                name: display_name,
                is_dir: true,
                depth,
                status: initial_status,
                left_size: None,
                right_size: None,
                left_modified_ms: l_meta.map(|m| m.modified_ms),
                right_modified_ms: r_meta.map(|m| m.modified_ms),
            });

            let child_start = out.len();
            compare_dir_recursive(
                left_root,
                right_root,
                &child_rel,
                depth + 1,
                options,
                glob_set,
                out,
                stats,
            )?;

            // Propagate child differences upward to parent directory status
            if initial_status == FolderItemStatus::Equal {
                let has_diff_child = out[child_start..]
                    .iter()
                    .any(|c| c.status != FolderItemStatus::Equal);
                if has_diff_child {
                    out[dir_idx].status = FolderItemStatus::Modified;
                }
            }
        } else {
            let status = match (l_meta, r_meta) {
                (Some(l), Some(r)) => {
                    if files_equal(&l.path, l.size, l.modified_ms, &r.path, r.size, r.modified_ms, options.mode) {
                        stats.equal_items += 1;
                        FolderItemStatus::Equal
                    } else {
                        stats.modified_items += 1;
                        FolderItemStatus::Modified
                    }
                }
                (Some(_), None) => {
                    stats.left_only_items += 1;
                    FolderItemStatus::LeftOnly
                }
                (None, Some(_)) => {
                    stats.right_only_items += 1;
                    FolderItemStatus::RightOnly
                }
                (None, None) => FolderItemStatus::Equal,
            };
            stats.total_items += 1;

            out.push(FolderEntryDto {
                relative_path: normalized_rel,
                name: display_name,
                is_dir: false,
                depth,
                status,
                left_size: l_meta.map(|m| m.size),
                right_size: r_meta.map(|m| m.size),
                left_modified_ms: l_meta.map(|m| m.modified_ms),
                right_modified_ms: r_meta.map(|m| m.modified_ms),
            });
        }
    }

    Ok(())
}

fn read_dir_entries(
    dir: &Path,
    rel_dir: &Path,
    ignore_case: bool,
    glob_set: &GlobSet,
) -> BTreeMap<String, LocalMeta> {
    let mut map = BTreeMap::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return map;
    };

    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = if rel_dir.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            rel_dir.join(&name)
        };
        if glob_set.is_match(&name) || glob_set.is_match(&rel_path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let key = if ignore_case {
            name.to_lowercase()
        } else {
            name.clone()
        };

        map.insert(
            key,
            LocalMeta {
                name,
                path: entry.path(),
                is_dir: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
                modified_ms,
            },
        );
    }

    map
}

fn files_equal(
    left_path: &Path,
    left_size: u64,
    left_mtime: u64,
    right_path: &Path,
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
    match (hash_file(left_path), hash_file(right_path)) {
        (Ok(h1), Ok(h2)) => h1 == h2,
        _ => false,
    }
}

fn hash_file(path: &Path) -> std::io::Result<blake3::Hash> {
    let bytes = fs::read(path)?;
    Ok(blake3::hash(&bytes))
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

/// Copies or deletes an entry between left and right folder roots.
pub fn apply_folder_item_operation(
    left_root: &Path,
    right_root: &Path,
    relative_path: &str,
    action: FolderSyncActionKind,
) -> std::io::Result<()> {
    let rel = Path::new(relative_path);
    let left_target = left_root.join(rel);
    let right_target = right_root.join(rel);

    match action {
        FolderSyncActionKind::CopyLeftToRight => copy_path_recursive(&left_target, &right_target),
        FolderSyncActionKind::CopyRightToLeft => copy_path_recursive(&right_target, &left_target),
        FolderSyncActionKind::DeleteLeft => remove_path_any(&left_target),
        FolderSyncActionKind::DeleteRight => remove_path_any(&right_target),
    }
}

fn copy_path_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = fs::metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_path_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

fn remove_path_any(target: &Path) -> std::io::Result<()> {
    if !target.exists() {
        return Ok(());
    }
    if target.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    }
}
