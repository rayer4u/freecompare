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
}
