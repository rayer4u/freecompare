use crate::diff::{
    three_way::ThreeWaySession,
    two_way::{DiffOptions, TwoWaySession},
};
use crate::folder::{FolderCompareOptions, FolderDiffResult};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    TwoWayText,
    ThreeWayMerge,
    FolderCompare,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub kind: SessionKind,
    pub left_path: String,
    pub right_path: String,
    pub base_path: Option<String>,
    pub output_path: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StartupLaunchSession {
    pub kind: Option<SessionKind>,
    pub session_id: Option<String>,
    pub title: String,
    pub left_path: String,
    pub right_path: String,
    pub base_path: Option<String>,
    pub output_path: Option<String>,
    pub titles: [Option<String>; 4],
    pub readonly: [bool; 3],
    pub expand_all: bool,
    pub filters: Vec<String>,
    pub review_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UserPreferences {
    pub theme: String,
    pub ignore_whitespace: bool,
    pub ignore_case: bool,
    pub text_row_filter: String,
    pub folder_compare_mode: String,
    pub folder_filter_status: String,
    pub folder_exclude_globs: Vec<String>,
    pub show_files_sidebar: bool,
    pub last_browsed_dir: Option<String>,
    // Window geometry persistence (BCState.xml equivalent)
    pub window_width: u32,
    pub window_height: u32,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub window_maximized: bool,
    // Layout & Editor typography persistence (BCPreferences.xml equivalent)
    pub show_line_inspector: bool,
    pub editor_font_size: u32,
    pub tab_width: u32,
    pub show_whitespace_glyphs: bool,
    pub syntax_highlighting: bool,
    // Navigation & safety behavior
    pub auto_jump_first_diff: bool,
    pub wrap_around_navigation: bool,
    pub confirm_before_exit_dirty: bool,
    // MRU path history for quick input autocomplete
    pub recent_left_paths: Vec<String>,
    pub recent_right_paths: Vec<String>,
    pub recent_folder_paths: Vec<String>,
}

impl Default for UserPreferences {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            ignore_whitespace: false,
            ignore_case: false,
            text_row_filter: "all".to_string(),
            folder_compare_mode: "hash".to_string(),
            folder_filter_status: "all".to_string(),
            folder_exclude_globs: vec![
                ".git".to_string(),
                "node_modules".to_string(),
                "target".to_string(),
                ".DS_Store".to_string(),
            ],
            show_files_sidebar: true,
            last_browsed_dir: None,
            window_width: 1440,
            window_height: 900,
            window_x: None,
            window_y: None,
            window_maximized: false,
            show_line_inspector: true,
            editor_font_size: 13,
            tab_width: 4,
            show_whitespace_glyphs: false,
            syntax_highlighting: true,
            auto_jump_first_diff: true,
            wrap_around_navigation: true,
            confirm_before_exit_dirty: true,
            recent_left_paths: Vec::new(),
            recent_right_paths: Vec::new(),
            recent_folder_paths: Vec::new(),
        }
    }
}

pub struct SessionManager {
    next_id: AtomicU64,
    pub two_way_sessions: RwLock<HashMap<String, TwoWaySession>>,
    pub three_way_sessions: RwLock<HashMap<String, ThreeWaySession>>,
    pub folder_sessions: RwLock<HashMap<String, (FolderDiffResult, FolderCompareOptions)>>,
    pub recent_records: RwLock<Vec<SessionRecord>>,
    pub preferences: RwLock<UserPreferences>,
    pub startup_session: RwLock<Option<StartupLaunchSession>>,
    persistence_path: Option<PathBuf>,
    preferences_path: Option<PathBuf>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        let persistence_path = default_config_file_path("sessions.json");
        let preferences_path = default_config_file_path("settings.json");

        let initial_records = persistence_path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<SessionRecord>>(&s).ok())
            .unwrap_or_default();

        let initial_prefs = preferences_path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<UserPreferences>(&s).ok())
            .unwrap_or_default();

        Self {
            next_id: AtomicU64::new(1),
            two_way_sessions: RwLock::new(HashMap::new()),
            three_way_sessions: RwLock::new(HashMap::new()),
            folder_sessions: RwLock::new(HashMap::new()),
            recent_records: RwLock::new(initial_records),
            preferences: RwLock::new(initial_prefs),
            startup_session: RwLock::new(None),
            persistence_path,
            preferences_path,
        }
    }

    pub fn allocate_id(&self, prefix: &str) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{id}")
    }

    pub fn record_recent(
        &self,
        title: String,
        kind: SessionKind,
        left_path: String,
        right_path: String,
        base_path: Option<String>,
        output_path: Option<String>,
    ) {
        // Skip recording ephemeral Git difftool/mergetool temporary files in `/tmp/` or `Temp`
        if is_ephemeral_git_temp_path(&left_path) || is_ephemeral_git_temp_path(&right_path) {
            return;
        }

        // Also record MRU paths in UserPreferences for quick input autocomplete
        {
            let mut prefs = self.preferences.write();
            if kind == SessionKind::FolderCompare {
                push_mru_path(&mut prefs.recent_folder_paths, &left_path);
                push_mru_path(&mut prefs.recent_folder_paths, &right_path);
            } else {
                push_mru_path(&mut prefs.recent_left_paths, &left_path);
                push_mru_path(&mut prefs.recent_right_paths, &right_path);
            }
            if let Some(ref path) = self.preferences_path {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(json) = serde_json::to_string_pretty(&*prefs) {
                    let _ = fs::write(path, json);
                }
            }
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let mut list = self.recent_records.write();
        list.retain(|r| !(r.kind == kind && r.left_path == left_path && r.right_path == right_path));
        list.insert(
            0,
            SessionRecord {
                id: self.allocate_id("rec"),
                title,
                kind,
                left_path,
                right_path,
                base_path,
                output_path,
                updated_at_ms: now_ms,
            },
        );
        if list.len() > 20 {
            list.truncate(20);
        }

        self.save_recent_list(&list);
    }

    pub fn clear_recent(&self) {
        let mut list = self.recent_records.write();
        list.clear();
        self.save_recent_list(&list);
    }

    fn save_recent_list(&self, list: &[SessionRecord]) {
        if let Some(ref path) = self.persistence_path {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(list) {
                let _ = fs::write(path, json);
            }
        }
    }

    pub fn get_preferences(&self) -> UserPreferences {
        self.preferences.read().clone()
    }

    pub fn update_preferences(&self, next: UserPreferences) -> UserPreferences {
        *self.preferences.write() = next.clone();
        if let Some(ref path) = self.preferences_path {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&next) {
                let _ = fs::write(path, json);
            }
        }
        next
    }

    pub fn create_demo_two_way(&self) -> String {
        let left_demo = r#"// freecompare-core/src/engine.rs
use std::path::Path;
use crate::buffer::TextBuffer;

pub struct CompareConfig {
    pub ignore_whitespace: bool,
    pub ignore_case: bool,
    pub context_lines: usize,
}

pub fn run_compare(left: &Path, right: &Path, cfg: &CompareConfig) -> Result<usize, String> {
    let left_buf = TextBuffer::from_file(left).map_err(|e| e.to_string())?;
    let right_buf = TextBuffer::from_file(right).map_err(|e| e.to_string())?;
    // Legacy O(ND) diff implementation
    let total = left_buf.line_count() + right_buf.line_count();
    println!("Comparing {} total lines...", total);
    Ok(total)
}
"#;

        let right_demo = r#"// freecompare-core/src/engine.rs
use std::path::Path;
use crate::buffer::TextBuffer;
use crate::diff::TwoWaySession;

#[derive(Debug, Clone)]
pub struct CompareConfig {
    pub ignore_whitespace: bool,
    pub ignore_case: bool,
    pub show_only_diffs: bool,
    pub context_lines: usize,
}

pub fn run_compare(left: &Path, right: &Path, cfg: &CompareConfig) -> Result<usize, String> {
    // Added explanatory comment before call
    let session = TwoWaySession::from_files(left, right, Default::default())
        .map_err(|e| e.to_string())?;
    let summary = session.summary();
    println!("Compared {} virtual rows ({} hunks)!", summary.total_virtual_rows, summary.hunks.len());
    Ok(summary.total_virtual_rows)
}
"#;

        let id = self.allocate_id("text");
        let mut session = TwoWaySession::from_strings(left_demo, right_demo, DiffOptions::default());
        session.syntax_ext = Some("rs".to_string());
        self.two_way_sessions.write().insert(id.clone(), session);
        id
    }

    pub fn create_demo_three_way(&self) -> String {
        let base_demo = r#"fn compute_timeout(retries: u32) -> u64 {
    let base_ms = 250;
    base_ms * (retries as u64 + 1)
}

fn max_connections() -> usize {
    64
}
"#;
        let left_demo = r#"fn compute_timeout(retries: u32) -> u64 {
    let base_ms = 500; // Left increased base timeout for WAN
    base_ms * (retries as u64 + 1)
}

fn max_connections() -> usize {
    128
}
"#;
        let right_demo = r#"fn compute_timeout(retries: u32) -> u64 {
    let base_ms = 300; // Right tuned base timeout with cap
    (base_ms * (retries as u64 + 1)).min(5000)
}

fn max_connections() -> usize {
    64
}
"#;
        let id = self.allocate_id("merge");
        let session = ThreeWaySession::from_strings(left_demo, base_demo, right_demo);
        self.three_way_sessions.write().insert(id.clone(), session);
        id
    }
}

fn default_config_file_path(filename: &str) -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Some(
            PathBuf::from(home)
                .join(".config")
                .join("freecompare")
                .join(filename),
        )
    } else {
        None
    }
}

fn is_ephemeral_git_temp_path(p: &str) -> bool {
    let normalized = p.replace('\\', "/");
    normalized.contains("/git-blob-")
        || normalized.contains("/git-difftool.")
        || normalized.contains("_LOCAL_")
        || normalized.contains("_REMOTE_")
        || normalized.contains("_BASE_")
}

fn push_mru_path(list: &mut Vec<String>, path: &str) {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.starts_with('(') {
        return;
    }
    list.retain(|item| item != trimmed);
    list.insert(0, trimmed.to_string());
    if list.len() > 12 {
        list.truncate(12);
    }
}
