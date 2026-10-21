use freecompare_core::{
    diff::{
        three_way::{ConflictResolution, ThreeWaySession, ThreeWayStatus},
        two_way::{
            compute_inline_diff, DiffOptions, DiffStatus, InlineTag, MergeDirection, TwoWaySession,
        },
    },
    folder::{
        apply_folder_item_operation, compare_folders, FolderCompareMode, FolderCompareOptions,
        FolderItemStatus, FolderSyncActionKind,
    },
    EncodingKind, LineEnding, TextBuffer,
};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_buffer_encoding_and_line_endings() {
    let dir = tempdir().unwrap();
    let crlf_path = dir.path().join("win.txt");
    fs::write(&crlf_path, b"alpha\r\nbeta\r\ngamma\r\n").unwrap();

    let mut buf = TextBuffer::from_file(&crlf_path).unwrap();
    assert_eq!(buf.encoding(), EncodingKind::Utf8);
    assert_eq!(buf.line_ending(), LineEnding::CrLf);
    assert_eq!(buf.line_count(), 3);
    assert_eq!(buf.line_text(1).as_deref(), Some("beta"));

    buf.edit_line(1, "BETA_MODIFIED".to_string()).unwrap();
    assert!(buf.is_dirty());
    assert!(buf.can_undo());

    buf.undo();
    assert_eq!(buf.line_text(1).as_deref(), Some("beta"));
    buf.redo();
    assert_eq!(buf.line_text(1).as_deref(), Some("BETA_MODIFIED"));

    buf.save(None).unwrap();
    let saved_bytes = fs::read(&crlf_path).unwrap();
    assert_eq!(saved_bytes, b"alpha\r\nBETA_MODIFIED\r\ngamma\r\n");
}

#[test]
fn test_two_way_diff_alignment_and_merge() {
    let left = "line1\nline2_old\nline3_deleted\nline4\n";
    let right = "line1\nline2_new\nline4\nline5_inserted\n";

    let mut session = TwoWaySession::from_strings(left, right, DiffOptions::default());
    let summary = session.summary();

    assert_eq!(summary.left_line_count, 4);
    assert_eq!(summary.right_line_count, 4);
    assert_eq!(summary.hunks.len(), 2);
    assert_eq!(summary.hunks[0].status, DiffStatus::Modified);
    assert_eq!(summary.hunks[1].status, DiffStatus::Inserted);

    // Check viewport slice and inline lexical diff
    let slice = session.get_viewport_slice(0, 10);
    assert_eq!(slice.rows[0].status, DiffStatus::Equal);
    assert_eq!(slice.rows[1].status, DiffStatus::Modified);
    assert!(slice.rows[1]
        .left_inline
        .iter()
        .any(|seg| seg.tag == InlineTag::Delete && seg.text == "line2_old"));
    assert!(slice.rows[1]
        .right_inline
        .iter()
        .any(|seg| seg.tag == InlineTag::Insert && seg.text == "line2_new"));

    // Row 2 in hunk 0 is the deleted line on left, gap on right
    assert_eq!(slice.rows[2].status, DiffStatus::Deleted);
    assert_eq!(slice.rows[2].left_text.as_deref(), Some("line3_deleted"));
    assert_eq!(slice.rows[2].right_text, None);

    // Merge hunk 0 from Left to Right
    let after_merge = session.merge_hunk(0, MergeDirection::LeftToRight).unwrap();
    assert_eq!(after_merge.hunks.len(), 1);
    assert_eq!(after_merge.hunks[0].status, DiffStatus::Inserted);
}

#[test]
fn test_intra_hunk_smart_line_alignment_when_lines_inserted_before_modified_line() {
    // Classic failure case in naive index-based alignment:
    // Left has a single function call that was slightly modified on Right,
    // AND Right also prepended a comment and a logging line inside the same hunk.
    let left = "\
fn process() {
    let result = compute_value(10, false);
}
";
    let right = "\
fn process() {
    // Added explanatory comment at start of block
    tracing::debug!(\"starting compute\");
    let result = compute_value(20, true);
}
";

    let session = TwoWaySession::from_strings(left, right, DiffOptions::default());
    let slice = session.get_viewport_slice(0, 10);

    // Row 0: `fn process() {` -> Equal
    assert_eq!(slice.rows[0].status, DiffStatus::Equal);

    // Row 1 & Row 2: The newly inserted comment and debug log on the right MUST be aligned
    // against Gap (`None`) on the left, NOT paired with `let result = compute_value(...)`!
    assert_eq!(slice.rows[1].status, DiffStatus::Inserted);
    assert_eq!(slice.rows[1].left_text, None);
    assert_eq!(
        slice.rows[1].right_text.as_deref(),
        Some("    // Added explanatory comment at start of block")
    );

    assert_eq!(slice.rows[2].status, DiffStatus::Inserted);
    assert_eq!(slice.rows[2].left_text, None);
    assert_eq!(
        slice.rows[2].right_text.as_deref(),
        Some("    tracing::debug!(\"starting compute\");")
    );

    // Row 3: `let result = compute_value(10, false);` MUST be paired with
    // `let result = compute_value(20, true);` as `Modified`!
    assert_eq!(slice.rows[3].status, DiffStatus::Modified);
    assert_eq!(
        slice.rows[3].left_text.as_deref(),
        Some("    let result = compute_value(10, false);")
    );
    assert_eq!(
        slice.rows[3].right_text.as_deref(),
        Some("    let result = compute_value(20, true);")
    );

    // And inside Row 3, only `10` -> `20` and `false` -> `true` should be marked Delete/Insert,
    // while `let result = compute_value(` remains Equal!
    assert!(slice.rows[3]
        .left_inline
        .iter()
        .any(|s| s.tag == InlineTag::Equal && s.text.contains("let result = compute_value(")));
    assert!(slice.rows[3]
        .left_inline
        .iter()
        .any(|s| s.tag == InlineTag::Delete && s.text == "10"));
    assert!(slice.rows[3]
        .right_inline
        .iter()
        .any(|s| s.tag == InlineTag::Insert && s.text == "20"));
}

#[test]
fn test_function_brace_slider_heuristic_prevents_misaligned_sections() {
    // Classic brace misalignment scenario:
    // A new function ` fn second()` is inserted between `fn first()` and `fn third()`,
    // where all functions end with `}` followed by an empty line.
    // Without slider optimization, diff often splits inside `fn first()`'s closing `}`!
    let left = "\
fn first() {
    do_a();
}

fn third() {
    do_c();
}
";

    let right = "\
fn first() {
    do_a();
}

fn second() {
    do_b();
}

fn third() {
    do_c();
}
";

    let session = TwoWaySession::from_strings(left, right, DiffOptions::default());
    let summary = session.summary();
    assert_eq!(summary.hunks.len(), 1);
    assert_eq!(summary.hunks[0].status, DiffStatus::Inserted);

    // Verify that `fn first()` and its closing `}` remain completely intact (Equal) before the inserted hunk
    let slice = session.get_viewport_slice(0, 20);
    assert_eq!(slice.rows[0].status, DiffStatus::Equal);
    assert_eq!(slice.rows[0].left_text.as_deref(), Some("fn first() {"));
    assert_eq!(slice.rows[1].status, DiffStatus::Equal);
    assert_eq!(slice.rows[1].left_text.as_deref(), Some("    do_a();"));
    assert_eq!(slice.rows[2].status, DiffStatus::Equal);
    assert_eq!(slice.rows[2].left_text.as_deref(), Some("}"));
}

#[test]
fn test_word_aware_inline_diff_avoids_spaghetti_character_fragmentation() {
    // In character-by-character diff, changing `status_code` to `response_state`
    // would match coincidental letters 's', 't', 'a', 'e' as Equal, producing 9 unreadable fragments.
    // With word-aware lexical inline diff, the entire identifier `status_code` is cleanly deleted
    // and `response_state` is cleanly inserted.
    let (left_segs, right_segs) = compute_inline_diff(
        "let status_code = fetch_http_status(url);",
        "let response_state = fetch_http_status(endpoint);",
    );

    assert_eq!(
        left_segs,
        vec![
            freecompare_core::InlineSegment {
                text: "let ".to_string(),
                tag: InlineTag::Equal
            },
            freecompare_core::InlineSegment {
                text: "status_code".to_string(),
                tag: InlineTag::Delete
            },
            freecompare_core::InlineSegment {
                text: " = fetch_http_status(".to_string(),
                tag: InlineTag::Equal
            },
            freecompare_core::InlineSegment {
                text: "url".to_string(),
                tag: InlineTag::Delete
            },
            freecompare_core::InlineSegment {
                text: ");".to_string(),
                tag: InlineTag::Equal
            },
        ]
    );

    assert_eq!(
        right_segs,
        vec![
            freecompare_core::InlineSegment {
                text: "let ".to_string(),
                tag: InlineTag::Equal
            },
            freecompare_core::InlineSegment {
                text: "response_state".to_string(),
                tag: InlineTag::Insert
            },
            freecompare_core::InlineSegment {
                text: " = fetch_http_status(".to_string(),
                tag: InlineTag::Equal
            },
            freecompare_core::InlineSegment {
                text: "endpoint".to_string(),
                tag: InlineTag::Insert
            },
            freecompare_core::InlineSegment {
                text: ");".to_string(),
                tag: InlineTag::Equal
            },
        ]
    );
}

#[test]
fn test_three_way_merge_auto_and_conflict() {
    let base = "a\nb\nc\nd\n";
    let left = "a_left_conflict\nb\nc_left_auto\nd\n";
    let right = "a_right_conflict\nb\nc\nd_right_auto\n";

    let mut session = ThreeWaySession::from_strings(left, base, right);
    let summary = session.summary();

    assert_eq!(summary.unresolved_conflicts, 1);
    assert_eq!(summary.hunks[0].status, ThreeWayStatus::Conflict);

    let resolved = session.resolve_hunk(0, ConflictResolution::UseBothLeftFirst);
    assert_eq!(resolved.unresolved_conflicts, 0);
    assert_eq!(
        resolved.merged_lines,
        vec![
            "a_left_conflict",
            "a_right_conflict",
            "b",
            "c_left_auto",
            "d_right_auto"
        ]
    );
}

#[test]
fn test_folder_compare_and_sync() {
    let left_dir = tempdir().unwrap();
    let right_dir = tempdir().unwrap();

    fs::write(left_dir.path().join("same.txt"), b"hello").unwrap();
    fs::write(right_dir.path().join("same.txt"), b"hello").unwrap();

    fs::write(left_dir.path().join("diff.txt"), b"v1").unwrap();
    fs::write(right_dir.path().join("diff.txt"), b"v2_longer").unwrap();

    fs::write(left_dir.path().join("left_only.txt"), b"only_in_left").unwrap();

    let opts = FolderCompareOptions {
        mode: FolderCompareMode::ContentHash,
        ignore_case_names: false,
        exclude_globs: vec![],
    };

    let res = compare_folders(left_dir.path(), right_dir.path(), &opts).unwrap();
    assert_eq!(res.stats.total_items, 3);
    assert_eq!(res.stats.equal_items, 1);
    assert_eq!(res.stats.modified_items, 1);
    assert_eq!(res.stats.left_only_items, 1);

    apply_folder_item_operation(
        left_dir.path(),
        right_dir.path(),
        "left_only.txt",
        FolderSyncActionKind::CopyLeftToRight,
    )
    .unwrap();

    let res_after = compare_folders(left_dir.path(), right_dir.path(), &opts).unwrap();
    assert_eq!(res_after.stats.left_only_items, 0);
    assert_eq!(res_after.stats.equal_items, 2);
    assert_eq!(
        res_after
            .entries
            .iter()
            .find(|e| e.name == "diff.txt")
            .unwrap()
            .status,
        FolderItemStatus::Modified
    );
}
