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
}

pub struct SessionManager {
    next_id: AtomicU64,
    pub two_way_sessions: RwLock<HashMap<String, TwoWaySession>>,
    pub three_way_sessions: RwLock<HashMap<String, ThreeWaySession>>,
    pub folder_sessions: RwLock<HashMap<String, (FolderDiffResult, FolderCompareOptions)>>,
    pub recent_records: RwLock<Vec<SessionRecord>>,
    pub startup_session: RwLock<Option<StartupLaunchSession>>,
    persistence_path: Option<PathBuf>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        let persistence_path = default_sessions_file_path();
        let initial_records = persistence_path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<SessionRecord>>(&s).ok())
            .unwrap_or_default();

        Self {
            next_id: AtomicU64::new(1),
            two_way_sessions: RwLock::new(HashMap::new()),
            three_way_sessions: RwLock::new(HashMap::new()),
            folder_sessions: RwLock::new(HashMap::new()),
            recent_records: RwLock::new(initial_records),
            startup_session: RwLock::new(None),
            persistence_path,
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

        if let Some(ref path) = self.persistence_path {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&*list) {
                let _ = fs::write(path, json);
            }
        }
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

fn default_sessions_file_path() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Some(PathBuf::from(home).join(".config").join("freecompare").join("sessions.json"))
    } else {
        None
    }
}
