//! `freecompare-core`: Cross-platform high-performance diff & merge engine.
//!
//! Designed for a virtual-scrolling UI: holds Rope buffers, computes alignment tables,
//! inline character/word diffs on viewport slices, 3-way merges, and concurrent folder diffs.

pub mod buffer;
pub mod cli_args;
pub mod diff;
pub mod folder;
pub mod session;
pub mod syntax;

pub use buffer::{expand_path, EncodingKind, LineEnding, TextBuffer};
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
