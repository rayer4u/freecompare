//! `freecompare-core`: Cross-platform high-performance diff & merge engine.
//!
//! Designed for a virtual-scrolling UI: holds Rope buffers, computes alignment tables,
//! inline character/word diffs on viewport slices, 3-way merges, and concurrent folder diffs.

pub mod buffer;
pub mod cli_args;
pub mod diff;
pub mod folder;
pub mod session;
pub mod sftp;
pub mod syntax;
pub mod vfs;

pub use buffer::{
    detect_file_format, detect_line_ending, detect_line_ending_opt, encode_string, expand_path,
    normalize_line_endings, EncodingKind, LineEnding, TextBuffer,
};
pub use sftp::{
    is_sftp_uri, list_ssh_config_hosts, test_sftp_connection, SftpConnectOptions,
    SftpConnectionTestResult, SftpLocation, SshHostEntry,
};
pub use cli_args::{
    exit_codes, CliInvocation, FavorSide, ForcedViewerKind, QuickCompareMode,
};
pub use diff::{
    three_way::{ConflictResolution, ThreeWayDiffResult, ThreeWayHunk, ThreeWayRow, ThreeWaySession},
    two_way::{
        AlignmentRow, DiffOptions, DiffStatus, InlineSegment, InlineTag, MergeDirection,
        TwoWayDiffResult, TwoWayHunk, TwoWaySession, ViewportRowDto, ViewportSliceDto,
    },
};
pub use folder::{
    compare_folders, compare_subfolder, FolderCompareMode, FolderCompareOptions, FolderDiffResult,
    FolderEntryDto, FolderItemStatus, FolderSubtreeResult, FolderSyncAction, FolderSyncActionKind,
    FolderSyncPlan,
};
pub use session::{
    SessionKind, SessionManager, SessionRecord, StartupLaunchSession, UserPreferences,
};
