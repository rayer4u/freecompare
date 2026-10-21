use freecompare_app_lib::AppBackend;
use freecompare_core::SessionKind;
use serde_json::json;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_bcompare_cli_folder_launch_and_rpc_flow() {
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();

    fs::write(dir_a.path().join("config.toml"), "port = 8080\nhost = '127.0.0.1'\n").unwrap();
    fs::write(dir_b.path().join("config.toml"), "port = 9090\nhost = '127.0.0.1'\n").unwrap();
    fs::write(dir_a.path().join("only_a.txt"), "hello").unwrap();

    // Simulate `bcompare dir_a/ dir_b/`
    let backend = AppBackend::new();
    let launch = backend
        .configure_startup_paths(&[dir_a.path().to_path_buf(), dir_b.path().to_path_buf()])
        .unwrap();

    assert_eq!(launch.kind, Some(SessionKind::FolderCompare));

    // UI queries `get_startup_session` on mount
    let startup_val = backend.dispatch_rpc("get_startup_session", &json!({})).unwrap();
    assert_eq!(startup_val["kind"], "folder_compare");

    // UI scans the two folders via `scan_folder_diff`
    let scan_val = backend
        .dispatch_rpc(
            "scan_folder_diff",
            &json!({
                "left_dir": launch.left_path,
                "right_dir": launch.right_path,
                "options": {
                    "mode": "content_hash",
                    "ignore_case_names": false,
                    "exclude_globs": []
                }
            }),
        )
        .unwrap();

    assert_eq!(scan_val["stats"]["total_items"], 2);
    assert_eq!(scan_val["stats"]["modified_items"], 1);
    assert_eq!(scan_val["stats"]["left_only_items"], 1);

    // User double-clicks `config.toml` in Folder View to open 2-Way Text Diff Tab
    let left_file = dir_a.path().join("config.toml");
    let right_file = dir_b.path().join("config.toml");
    let open_val = backend
        .dispatch_rpc(
            "open_two_way_files",
            &json!({
                "left_path": left_file.to_string_lossy(),
                "right_path": right_file.to_string_lossy(),
                "options": {
                    "ignore_whitespace": false,
                    "ignore_case": false,
                    "show_only_diffs": false,
                    "context_lines": 3
                },
                "initial_row_count": 50
            }),
        )
        .unwrap();

    let session_id = open_val["session_id"].as_str().unwrap();
    assert_eq!(open_val["summary"]["hunks"].as_array().unwrap().len(), 1);

    // User merges hunk 0 from Left to Right and saves right file to disk
    backend
        .dispatch_rpc(
            "merge_two_way_hunk",
            &json!({
                "session_id": session_id,
                "hunk_id": 0,
                "direction": "left_to_right",
                "viewport_start": 0,
                "viewport_count": 50
            }),
        )
        .unwrap();

    backend
        .dispatch_rpc(
            "save_two_way_side",
            &json!({
                "session_id": session_id,
                "is_left": false
            }),
        )
        .unwrap();

    let saved_right = fs::read_to_string(&right_file).unwrap();
    assert_eq!(saved_right, "port = 8080\nhost = '127.0.0.1'\n");

    // Verify local filesystem browser (`list_local_dir`) returns entries for FileBrowserModal
    let fs_list = backend
        .dispatch_rpc(
            "list_local_dir",
            &json!({ "dir_path": dir_a.path().to_string_lossy() }),
        )
        .unwrap();
    let entries = fs_list["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);

    // Verify `-qc` / `-quickcompare` BC standard exit codes
    let inv_qc_same = freecompare_core::CliInvocation::parse([
        "-qc",
        left_file.to_str().unwrap(),
        right_file.to_str().unwrap(),
    ])
    .unwrap();
    assert_eq!(
        backend.execute_quick_compare(&inv_qc_same),
        freecompare_core::exit_codes::BINARY_SAME
    );

    // Verify `get_user_preferences` and `update_user_preferences` persistence RPC (including window geometry & typography)
    let updated_prefs = backend
        .dispatch_rpc(
            "update_user_preferences",
            &json!({
                "theme": "light",
                "ignore_whitespace": true,
                "text_row_filter": "diffs",
                "window_width": 1680,
                "window_height": 1020,
                "window_x": 1920,
                "window_y": 40,
                "window_maximized": false,
                "editor_font_size": 15,
                "show_whitespace_glyphs": true,
                "show_line_inspector": false
            }),
        )
        .unwrap();
    assert_eq!(updated_prefs["theme"], "light");
    assert_eq!(updated_prefs["ignore_whitespace"], true);
    assert_eq!(updated_prefs["text_row_filter"], "diffs");
    assert_eq!(updated_prefs["window_width"], 1680);
    assert_eq!(updated_prefs["window_height"], 1020);
    assert_eq!(updated_prefs["window_x"], 1920);
    assert_eq!(updated_prefs["window_y"], 40);
    assert_eq!(updated_prefs["editor_font_size"], 15);
    assert_eq!(updated_prefs["show_whitespace_glyphs"], true);
    assert_eq!(updated_prefs["show_line_inspector"], false);
}

#[test]
fn test_git_builtin_bc_difftool_and_mergetool_drop_in_replacement() {
    let dir = tempdir().unwrap();
    let local_file = dir.path().join("app_LOCAL.rs");
    let remote_file = dir.path().join("app_REMOTE.rs");
    let base_file = dir.path().join("app_BASE.rs");
    let merged_file = dir.path().join("app.rs");

    fs::write(
        &base_file,
        "fn main() {\n    let port = 8000;\n    let mode = \"dev\";\n}\n",
    )
    .unwrap();
    // LOCAL modified line 2 (`port = 8080`)
    fs::write(
        &local_file,
        "fn main() {\n    let port = 8080;\n    let mode = \"dev\";\n}\n",
    )
    .unwrap();
    // REMOTE modified line 3 (`mode = "prod"`)
    fs::write(
        &remote_file,
        "fn main() {\n    let port = 8000;\n    let mode = \"prod\";\n}\n",
    )
    .unwrap();
    // MERGED initially contains Git conflict markers
    fs::write(&merged_file, "<<<<<<< HEAD\n=======\n>>>>>>> branch\n").unwrap();

    // 1. Simulate Git's built-in `mergetools/bc` invocation:
    // `"$merge_tool_path" "$LOCAL" "$REMOTE" "$BASE" -mergeoutput="$MERGED"`
    let bc_mergetool_args = [
        local_file.to_str().unwrap(),
        remote_file.to_str().unwrap(),
        base_file.to_str().unwrap(),
        &format!("-mergeoutput={}", merged_file.to_str().unwrap()),
    ];
    let inv = freecompare_core::CliInvocation::parse(bc_mergetool_args).unwrap();
    let backend = AppBackend::new();
    let launch = backend.configure_from_cli(&inv).unwrap();

    assert_eq!(launch.kind, Some(SessionKind::ThreeWayMerge));
    assert_eq!(
        launch.output_path.as_deref(),
        Some(merged_file.canonicalize().unwrap().to_str().unwrap())
    );
    // Before user saves, exit_code defaults to 1 (MERGE_CONFLICT_OR_ABORTED) so closing window aborts git mergetool
    assert_eq!(
        backend
            .exit_code
            .load(std::sync::atomic::Ordering::SeqCst),
        freecompare_core::exit_codes::MERGE_CONFLICT_OR_ABORTED
    );

    // Save merged output via RPC (simulating clicking "Save / Complete Merge")
    let sid = launch.session_id.as_deref().unwrap();
    backend
        .dispatch_rpc(
            "save_three_way_merged",
            &json!({
                "session_id": sid,
                "target_path": launch.output_path,
            }),
        )
        .unwrap();

    // Exit code automatically flips to 0 (`SAME` / success for `mergetool.bc.trustExitCode = true`)
    assert_eq!(
        backend
            .exit_code
            .load(std::sync::atomic::Ordering::SeqCst),
        freecompare_core::exit_codes::SAME
    );
    let final_merged = fs::read_to_string(&merged_file).unwrap();
    assert_eq!(
        final_merged,
        "fn main() {\n    let port = 8080;\n    let mode = \"prod\";\n}\n"
    );

    // 2. Verify `git difftool --dir-diff` symlink handling in folder comparison
    #[cfg(unix)]
    {
        let left_dir = dir.path().join("git_left");
        let right_dir = dir.path().join("git_right");
        let worktree_dir = dir.path().join("worktree");
        fs::create_dir_all(&left_dir).unwrap();
        fs::create_dir_all(&right_dir).unwrap();
        fs::create_dir_all(&worktree_dir).unwrap();

        let real_worktree_file = worktree_dir.join("lib.rs");
        fs::write(&real_worktree_file, "pub fn v() -> u32 { 2 }\n").unwrap();
        fs::write(left_dir.join("lib.rs"), "pub fn v() -> u32 { 1 }\n").unwrap();
        // Git `--dir-diff` creates a symlink in `$REMOTE/lib.rs` -> `worktree/lib.rs`
        std::os::unix::fs::symlink(&real_worktree_file, right_dir.join("lib.rs")).unwrap();

        let scan_res = backend
            .dispatch_rpc(
                "scan_folder_diff",
                &json!({
                    "left_dir": left_dir.to_string_lossy(),
                    "right_dir": right_dir.to_string_lossy(),
                    "options": {
                        "mode": "content_hash",
                        "ignore_case_names": false,
                        "exclude_globs": []
                    }
                }),
            )
            .unwrap();
        assert_eq!(scan_res["stats"]["total_items"], 1);
        assert_eq!(scan_res["stats"]["modified_items"], 1);
        let entry = &scan_res["entries"].as_array().unwrap()[0];
        assert!(entry["right_size"].as_u64().unwrap() > 0);
    }
}
