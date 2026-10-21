//! FreeCompare Backend Commands & Session Dispatcher.
//!
//! Exposes high-speed viewport-sliced commands for 2-Way Text Diff, 3-Way Merge, and Folder Compare.
//! Supports both Tauri v2 Desktop IPC and local RPC HTTP bridge (used by `fc` / `bcompare` CLI launcher).

use freecompare_core::{
    diff::{
        three_way::{ConflictResolution, ThreeWayDiffResult, ThreeWayRow, ThreeWaySession},
        two_way::{DiffOptions, MergeDirection, TwoWayDiffResult, TwoWaySession, ViewportSliceDto},
    },
    folder::{
        apply_folder_item_operation, compare_folders, FolderCompareOptions, FolderDiffResult,
        FolderSyncActionKind,
    },
    SessionKind, SessionManager, SessionRecord, StartupLaunchSession,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenTwoWayResponse {
    pub session_id: String,
    pub left_path: String,
    pub right_path: String,
    pub summary: TwoWayDiffResult,
    pub initial_slice: ViewportSliceDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenThreeWayResponse {
    pub session_id: String,
    pub left_path: String,
    pub base_path: String,
    pub right_path: String,
    pub output_path: Option<String>,
    pub summary: ThreeWayDiffResult,
    pub initial_rows: Vec<ThreeWayRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsListResponse {
    pub current_dir: String,
    pub parent_dir: Option<String>,
    pub entries: Vec<FsEntryDto>,
}

pub struct AppBackend {
    pub manager: SessionManager,
}

impl Default for AppBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AppBackend {
    pub fn new() -> Self {
        Self {
            manager: SessionManager::new(),
        }
    }

    /// Configures initial startup session from CLI arguments (`fc left right` or `fc left base right [out]`).
    pub fn configure_startup_paths(&self, paths: &[PathBuf]) -> Result<StartupLaunchSession, String> {
        if paths.len() == 2 {
            let left = canonical_or_display(&paths[0]);
            let right = canonical_or_display(&paths[1]);
            let left_name = file_name_label(&paths[0]);
            let right_name = file_name_label(&paths[1]);
            let title = format!("{left_name} ↔ {right_name}");

            if paths[0].is_dir() && paths[1].is_dir() {
                self.manager.record_recent(
                    title.clone(),
                    SessionKind::FolderCompare,
                    left.clone(),
                    right.clone(),
                    None,
                    None,
                );
                let launch = StartupLaunchSession {
                    kind: Some(SessionKind::FolderCompare),
                    session_id: None,
                    title,
                    left_path: left,
                    right_path: right,
                    base_path: None,
                    output_path: None,
                };
                *self.manager.startup_session.write() = Some(launch.clone());
                return Ok(launch);
            } else {
                let resp = self.open_two_way_files(&left, &right, DiffOptions::default(), 200)?;
                let launch = StartupLaunchSession {
                    kind: Some(SessionKind::TwoWayText),
                    session_id: Some(resp.session_id),
                    title,
                    left_path: left,
                    right_path: right,
                    base_path: None,
                    output_path: None,
                };
                *self.manager.startup_session.write() = Some(launch.clone());
                return Ok(launch);
            }
        } else if paths.len() >= 3 {
            let left = canonical_or_display(&paths[0]);
            let base = canonical_or_display(&paths[1]);
            let right = canonical_or_display(&paths[2]);
            let out = paths.get(3).map(|p| canonical_or_display(p));
            let title = format!("3-Way: {}", file_name_label(&paths[0]));
            let resp = self.open_three_way_files(&left, &base, &right, out.clone(), 400)?;
            let launch = StartupLaunchSession {
                kind: Some(SessionKind::ThreeWayMerge),
                session_id: Some(resp.session_id),
                title,
                left_path: left,
                right_path: right,
                base_path: Some(base),
                output_path: out,
            };
            *self.manager.startup_session.write() = Some(launch.clone());
            return Ok(launch);
        }

        Ok(StartupLaunchSession::default())
    }

    pub fn get_startup_session(&self) -> Option<StartupLaunchSession> {
        self.manager.startup_session.read().clone()
    }

    pub fn get_recent_sessions(&self) -> Vec<SessionRecord> {
        self.manager.recent_records.read().clone()
    }

    pub fn clear_recent_sessions(&self) {
        self.manager.recent_records.write().clear();
    }

    /// Lists local directory contents for the cross-platform File/Folder Browser Modal.
    pub fn list_local_dir(&self, dir_path: Option<&str>) -> Result<FsListResponse, String> {
        let target = match dir_path.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => std::env::current_dir()
                .or_else(|_| {
                    std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|_| PathBuf::from("/")),
        };

        let resolved = if target.is_file() {
            target
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or(target)
        } else {
            target
        };

        let canonical = resolved
            .canonicalize()
            .unwrap_or_else(|_| resolved.clone());

        let rd = std::fs::read_dir(&canonical)
            .map_err(|e| format!("无法读取目录 {}: {e}", canonical.display()))?;

        let mut entries = Vec::new();
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let path = item.path().to_string_lossy().to_string();
            let meta = item.metadata().ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = meta
                .as_ref()
                .map(|m| if m.is_file() { m.len() } else { 0 })
                .unwrap_or(0);
            entries.push(FsEntryDto {
                name,
                path,
                is_dir,
                size,
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        let parent_dir = canonical
            .parent()
            .map(|p| p.to_string_lossy().to_string());

        Ok(FsListResponse {
            current_dir: canonical.to_string_lossy().to_string(),
            parent_dir,
            entries,
        })
    }

    pub fn write_text_file(&self, path: &str, content: &str) -> Result<(), String> {
        std::fs::write(path, content.as_bytes())
            .map_err(|e| format!("无法保存文件 {path}: {e}"))
    }

    pub fn open_two_way_files(
        &self,
        left_path: &str,
        right_path: &str,
        options: DiffOptions,
        initial_row_count: usize,
    ) -> Result<OpenTwoWayResponse, String> {
        let session = TwoWaySession::from_files(left_path, right_path, options)
            .map_err(|e| format!("无法读取文件 ({left_path} vs {right_path}): {e}"))?;
        let summary = session.summary();
        let initial_slice = session.get_viewport_slice(0, initial_row_count);
        let session_id = self.manager.allocate_id("text");
        self.manager
            .two_way_sessions
            .write()
            .insert(session_id.clone(), session);

        let title = format!(
            "{} ↔ {}",
            file_name_label(Path::new(left_path)),
            file_name_label(Path::new(right_path))
        );
        self.manager.record_recent(
            title,
            SessionKind::TwoWayText,
            left_path.to_string(),
            right_path.to_string(),
            None,
            None,
        );

        Ok(OpenTwoWayResponse {
            session_id,
            left_path: left_path.to_string(),
            right_path: right_path.to_string(),
            summary,
            initial_slice,
        })
    }

    pub fn open_two_way_strings(
        &self,
        left_content: &str,
        right_content: &str,
        options: DiffOptions,
        initial_row_count: usize,
    ) -> OpenTwoWayResponse {
        let mut session = TwoWaySession::from_strings(left_content, right_content, options);
        session.syntax_ext = Some("rs".to_string());
        let summary = session.summary();
        let initial_slice = session.get_viewport_slice(0, initial_row_count);
        let session_id = self.manager.allocate_id("text");
        self.manager
            .two_way_sessions
            .write()
            .insert(session_id.clone(), session);
        OpenTwoWayResponse {
            session_id,
            left_path: "crates/core/src/diff/engine.rs (Left)".to_string(),
            right_path: "crates/core/src/diff/engine.rs (Right)".to_string(),
            summary,
            initial_slice,
        }
    }

    pub fn get_two_way_viewport(
        &self,
        session_id: &str,
        start_row: usize,
        count: usize,
    ) -> Result<ViewportSliceDto, String> {
        let guard = self.manager.two_way_sessions.read();
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.get_viewport_slice(start_row, count))
    }

    pub fn merge_two_way_hunk(
        &self,
        session_id: &str,
        hunk_id: usize,
        direction: MergeDirection,
        viewport_start: usize,
        viewport_count: usize,
    ) -> Result<(TwoWayDiffResult, ViewportSliceDto), String> {
        let mut guard = self.manager.two_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let summary = session
            .merge_hunk(hunk_id, direction)
            .map_err(|e| e.to_string())?;
        let slice = session.get_viewport_slice(viewport_start, viewport_count);
        Ok((summary, slice))
    }

    pub fn update_two_way_options(
        &self,
        session_id: &str,
        options: DiffOptions,
        viewport_start: usize,
        viewport_count: usize,
    ) -> Result<(TwoWayDiffResult, ViewportSliceDto), String> {
        let mut guard = self.manager.two_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session.set_options(options);
        Ok((
            session.summary(),
            session.get_viewport_slice(viewport_start, viewport_count),
        ))
    }

    pub fn edit_two_way_line(
        &self,
        session_id: &str,
        is_left: bool,
        line_idx: usize,
        new_content: String,
        viewport_start: usize,
        viewport_count: usize,
    ) -> Result<(TwoWayDiffResult, ViewportSliceDto), String> {
        let mut guard = self.manager.two_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let summary = session
            .edit_side_line(is_left, line_idx, new_content)
            .map_err(|e| e.to_string())?;
        let slice = session.get_viewport_slice(viewport_start, viewport_count);
        Ok((summary, slice))
    }

    pub fn undo_two_way_side(
        &self,
        session_id: &str,
        is_left: bool,
        viewport_start: usize,
        viewport_count: usize,
    ) -> Result<(TwoWayDiffResult, ViewportSliceDto), String> {
        let mut guard = self.manager.two_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let summary = session.undo(is_left);
        let slice = session.get_viewport_slice(viewport_start, viewport_count);
        Ok((summary, slice))
    }

    pub fn save_two_way_side(
        &self,
        session_id: &str,
        is_left: bool,
        target_path: Option<&str>,
    ) -> Result<TwoWayDiffResult, String> {
        let mut guard = self.manager.two_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let path_ref = target_path.map(Path::new);
        if is_left {
            session.left.save(path_ref).map_err(|e| e.to_string())?;
        } else {
            session.right.save(path_ref).map_err(|e| e.to_string())?;
        }
        Ok(session.summary())
    }

    pub fn open_three_way_files(
        &self,
        left_path: &str,
        base_path: &str,
        right_path: &str,
        output_path: Option<String>,
        initial_row_count: usize,
    ) -> Result<OpenThreeWayResponse, String> {
        let out_buf = output_path.as_ref().map(PathBuf::from);
        let session = ThreeWaySession::from_files(left_path, base_path, right_path, out_buf)
            .map_err(|e| e.to_string())?;
        let summary = session.summary();
        let initial_rows = session.get_viewport_rows(0, initial_row_count);
        let session_id = self.manager.allocate_id("merge");
        self.manager
            .three_way_sessions
            .write()
            .insert(session_id.clone(), session);

        self.manager.record_recent(
            format!("3-Way: {}", file_name_label(Path::new(left_path))),
            SessionKind::ThreeWayMerge,
            left_path.to_string(),
            right_path.to_string(),
            Some(base_path.to_string()),
            output_path.clone(),
        );

        Ok(OpenThreeWayResponse {
            session_id,
            left_path: left_path.to_string(),
            base_path: base_path.to_string(),
            right_path: right_path.to_string(),
            output_path,
            summary,
            initial_rows,
        })
    }

    pub fn resolve_three_way_conflict(
        &self,
        session_id: &str,
        hunk_id: usize,
        resolution: ConflictResolution,
    ) -> Result<ThreeWayDiffResult, String> {
        let mut guard = self.manager.three_way_sessions.write();
        let session = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        Ok(session.resolve_hunk(hunk_id, resolution))
    }

    pub fn save_three_way_merged(
        &self,
        session_id: &str,
        target_path: Option<&str>,
    ) -> Result<(), String> {
        let guard = self.manager.three_way_sessions.read();
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        session
            .save_merged(target_path.map(Path::new))
            .map_err(|e| e.to_string())
    }

    pub fn scan_folder_diff(
        &self,
        left_dir: &str,
        right_dir: &str,
        options: FolderCompareOptions,
    ) -> Result<FolderDiffResult, String> {
        let res = compare_folders(left_dir, right_dir, &options)
            .map_err(|e| format!("无法扫描目录 ({left_dir} vs {right_dir}): {e}"))?;
        self.manager.record_recent(
            format!(
                "{} ↔ {}",
                file_name_label(Path::new(left_dir)),
                file_name_label(Path::new(right_dir))
            ),
            SessionKind::FolderCompare,
            left_dir.to_string(),
            right_dir.to_string(),
            None,
            None,
        );
        Ok(res)
    }

    pub fn sync_folder_item(
        &self,
        left_dir: &str,
        right_dir: &str,
        relative_path: &str,
        action: FolderSyncActionKind,
        options: FolderCompareOptions,
    ) -> Result<FolderDiffResult, String> {
        apply_folder_item_operation(
            &PathBuf::from(left_dir),
            &PathBuf::from(right_dir),
            relative_path,
            action,
        )
        .map_err(|e| e.to_string())?;
        compare_folders(left_dir, right_dir, &options).map_err(|e| e.to_string())
    }

    /// Unified JSON RPC dispatcher used by both Tauri IPC and the `fc` CLI UI Server.
    pub fn dispatch_rpc(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        match cmd {
            "get_startup_session" => Ok(json!(self.get_startup_session())),
            "get_recent_sessions" => Ok(json!(self.get_recent_sessions())),
            "clear_recent_sessions" => {
                self.clear_recent_sessions();
                Ok(json!({ "cleared": true }))
            }
            "list_local_dir" => {
                let dir_path = args["dir_path"].as_str();
                let res = self.list_local_dir(dir_path)?;
                Ok(json!(res))
            }
            "write_text_file" => {
                let path = args["path"].as_str().unwrap_or("");
                let content = args["content"].as_str().unwrap_or("");
                self.write_text_file(path, content)?;
                Ok(json!({ "saved": true }))
            }
            "open_two_way_files" => {
                let left_path = args["left_path"].as_str().unwrap_or("");
                let right_path = args["right_path"].as_str().unwrap_or("");
                let options: DiffOptions = serde_json::from_value(args["options"].clone())
                    .unwrap_or_default();
                let count = args["initial_row_count"].as_u64().unwrap_or(200) as usize;
                let res = self.open_two_way_files(left_path, right_path, options, count)?;
                Ok(json!(res))
            }
            "get_two_way_viewport" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let start_row = args["start_row"].as_u64().unwrap_or(0) as usize;
                let count = args["count"].as_u64().unwrap_or(100) as usize;
                let res = self.get_two_way_viewport(session_id, start_row, count)?;
                Ok(json!(res))
            }
            "merge_two_way_hunk" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let hunk_id = args["hunk_id"].as_u64().unwrap_or(0) as usize;
                let direction: MergeDirection =
                    serde_json::from_value(args["direction"].clone())
                        .map_err(|e| e.to_string())?;
                let vs = args["viewport_start"].as_u64().unwrap_or(0) as usize;
                let vc = args["viewport_count"].as_u64().unwrap_or(200) as usize;
                let (summary, slice) =
                    self.merge_two_way_hunk(session_id, hunk_id, direction, vs, vc)?;
                Ok(json!({ "summary": summary, "slice": slice }))
            }
            "update_two_way_options" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let options: DiffOptions =
                    serde_json::from_value(args["options"].clone()).unwrap_or_default();
                let vs = args["viewport_start"].as_u64().unwrap_or(0) as usize;
                let vc = args["viewport_count"].as_u64().unwrap_or(200) as usize;
                let (summary, slice) = self.update_two_way_options(session_id, options, vs, vc)?;
                Ok(json!({ "summary": summary, "slice": slice }))
            }
            "edit_two_way_line" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let is_left = args["is_left"].as_bool().unwrap_or(true);
                let line_idx = args["line_idx"].as_u64().unwrap_or(0) as usize;
                let new_content = args["new_content"].as_str().unwrap_or("").to_string();
                let vs = args["viewport_start"].as_u64().unwrap_or(0) as usize;
                let vc = args["viewport_count"].as_u64().unwrap_or(200) as usize;
                let (summary, slice) =
                    self.edit_two_way_line(session_id, is_left, line_idx, new_content, vs, vc)?;
                Ok(json!({ "summary": summary, "slice": slice }))
            }
            "undo_two_way_side" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let is_left = args["is_left"].as_bool().unwrap_or(true);
                let vs = args["viewport_start"].as_u64().unwrap_or(0) as usize;
                let vc = args["viewport_count"].as_u64().unwrap_or(200) as usize;
                let (summary, slice) = self.undo_two_way_side(session_id, is_left, vs, vc)?;
                Ok(json!({ "summary": summary, "slice": slice }))
            }
            "save_two_way_side" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let is_left = args["is_left"].as_bool().unwrap_or(true);
                let target_path = args["target_path"].as_str();
                let summary = self.save_two_way_side(session_id, is_left, target_path)?;
                Ok(json!(summary))
            }
            "scan_folder_diff" => {
                let left_dir = args["left_dir"].as_str().unwrap_or("");
                let right_dir = args["right_dir"].as_str().unwrap_or("");
                let options: FolderCompareOptions =
                    serde_json::from_value(args["options"].clone()).unwrap_or_default();
                let res = self.scan_folder_diff(left_dir, right_dir, options)?;
                Ok(json!(res))
            }
            "sync_folder_item" => {
                let left_dir = args["left_dir"].as_str().unwrap_or("");
                let right_dir = args["right_dir"].as_str().unwrap_or("");
                let relative_path = args["relative_path"].as_str().unwrap_or("");
                let action: FolderSyncActionKind =
                    serde_json::from_value(args["action"].clone()).map_err(|e| e.to_string())?;
                let options: FolderCompareOptions =
                    serde_json::from_value(args["options"].clone()).unwrap_or_default();
                let res =
                    self.sync_folder_item(left_dir, right_dir, relative_path, action, options)?;
                Ok(json!(res))
            }
            "open_three_way_files" => {
                let left_path = args["left_path"].as_str().unwrap_or("");
                let base_path = args["base_path"].as_str().unwrap_or("");
                let right_path = args["right_path"].as_str().unwrap_or("");
                let output_path = args["output_path"].as_str().map(|s| s.to_string());
                let count = args["initial_row_count"].as_u64().unwrap_or(400) as usize;
                let res = self.open_three_way_files(
                    left_path,
                    base_path,
                    right_path,
                    output_path,
                    count,
                )?;
                Ok(json!(res))
            }
            "resolve_three_way_conflict" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let hunk_id = args["hunk_id"].as_u64().unwrap_or(0) as usize;
                let resolution: ConflictResolution =
                    serde_json::from_value(args["resolution"].clone())
                        .map_err(|e| e.to_string())?;
                let res = self.resolve_three_way_conflict(session_id, hunk_id, resolution)?;
                Ok(json!(res))
            }
            "save_three_way_merged" => {
                let session_id = args["session_id"].as_str().unwrap_or("");
                let target_path = args["target_path"].as_str();
                self.save_three_way_merged(session_id, target_path)?;
                Ok(json!({ "saved": true }))
            }
            _ => Err(format!("Unknown RPC command: {cmd}")),
        }
    }
}

fn canonical_or_display(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn file_name_label(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}
