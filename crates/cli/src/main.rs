use anyhow::Result;
use freecompare_app_lib::AppBackend;
use freecompare_core::{
    cli_args::{exit_codes, CliInvocation},
    expand_path,
    folder::{compare_folders, FolderCompareOptions},
    DiffOptions, ThreeWaySession, TwoWaySession, UserPreferences,
};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

include!(concat!(env!("OUT_DIR"), "/embedded_ui.rs"));

struct LifecycleTracker {
    client_connected: AtomicBool,
    last_heartbeat_ms: AtomicU64,
    shutdown_requested: AtomicBool,
}

impl LifecycleTracker {
    fn new() -> Self {
        Self {
            client_connected: AtomicBool::new(false),
            last_heartbeat_ms: AtomicU64::new(now_ms()),
            shutdown_requested: AtomicBool::new(false),
        }
    }

    fn touch(&self) {
        self.client_connected.store(true, Ordering::SeqCst);
        self.last_heartbeat_ms.store(now_ms(), Ordering::SeqCst);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn main() -> Result<()> {
    let raw_args: Vec<String> = env::args().skip(1).collect();

    // Built-in Antigravity CLI lifecycle guard for cross-platform visual review
    if raw_args.first().map(|s| s.as_str()) == Some("guard")
        || raw_args.first().map(|s| s.as_str()) == Some("agy-guard")
        || raw_args.iter().any(|s| s == "--guard" || s == "-guard")
    {
        return execute_guard_mode();
    }

    let inv = match CliInvocation::parse(&raw_args) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("Error: {err}\nRun `fcompare --help` for usage.");
            std::process::exit(exit_codes::ERROR_OR_MISSING_ARGS);
        }
    };

    if inv.show_help {
        print_help();
        return Ok(());
    }

    if inv.print_git_config || inv.install_git_config {
        return handle_git_integration(inv.install_git_config);
    }

    let backend = Arc::new(AppBackend::new());

    // 1. Handle `-qc` / `-quickcompare[=<mode>]` headless comparison with BC standard exit codes
    if inv.quick_compare.is_some() {
        let code = backend.execute_quick_compare(&inv);
        if !inv.silent {
            println!("QuickCompare exit code: {code}");
        }
        std::process::exit(code);
    }

    // 2. Handle `--cli` / `--summary` terminal summary mode
    if inv.cli_summary {
        return run_cli_summary(&inv);
    }

    // 3. Configure startup session from CLI paths & flags
    let launch = match backend.configure_from_cli(&inv) {
        Ok(l) => l,
        Err(err) => {
            if !inv.silent {
                eprintln!("⚠️ Warning: {err}");
            }
            if inv.automerge || inv.silent {
                std::process::exit(exit_codes::ERROR_OR_MISSING_ARGS);
            }
            Default::default()
        }
    };

    // 4. Handle `-automerge` (and `-force` / `-reviewconflicts`) for 3-way merge
    if inv.automerge {
        if let Some(ref sid) = launch.session_id {
            let guard = backend.manager.three_way_sessions.read();
            if let Some(session) = guard.get(sid) {
                let summary = session.summary();
                if summary.unresolved_conflicts == 0 || inv.force {
                    let target = launch.output_path.as_deref().map(Path::new);
                    if let Err(e) = session.save_merged(target) {
                        if !inv.silent {
                            eprintln!("Failed to write automerge output: {e}");
                        }
                        std::process::exit(exit_codes::ERROR_OR_MISSING_ARGS);
                    }
                    let code = if summary.unresolved_conflicts == 0 {
                        exit_codes::SAME
                    } else {
                        exit_codes::MERGE_CONFLICT_OR_ABORTED
                    };
                    std::process::exit(code);
                } else if !inv.review_conflicts && inv.silent {
                    // Unresolved conflicts and silent mode requested -> exit with conflict code
                    std::process::exit(exit_codes::MERGE_CONFLICT_OR_ABORTED);
                }
            }
        }
    }

    let bind_addr = format!("127.0.0.1:{}", inv.port_override.unwrap_or(0));
    let listener = TcpListener::bind(&bind_addr)?;
    let local_port = listener.local_addr()?.port();
    let ui_url = format!("http://127.0.0.1:{local_port}");
    let ui_dist = locate_ui_dist();
    let tracker = Arc::new(LifecycleTracker::new());

    if !inv.silent {
        println!("🚀 FreeCompare UI listening at {ui_url}");
    }

    if !inv.no_open_window {
        let initial_prefs = backend.get_user_preferences();
        spawn_native_app_window(&ui_url, &initial_prefs);
        let tracker_watchdog = Arc::clone(&tracker);
        let backend_watchdog = Arc::clone(&backend);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(500));
                if tracker_watchdog.shutdown_requested.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(400));
                    if now_ms()
                        .saturating_sub(tracker_watchdog.last_heartbeat_ms.load(Ordering::SeqCst))
                        >= 350
                    {
                        std::process::exit(backend_watchdog.exit_code.load(Ordering::SeqCst));
                    } else {
                        tracker_watchdog
                            .shutdown_requested
                            .store(false, Ordering::SeqCst);
                    }
                }
                if tracker_watchdog.client_connected.load(Ordering::SeqCst) {
                    let idle_ms = now_ms().saturating_sub(
                        tracker_watchdog.last_heartbeat_ms.load(Ordering::SeqCst),
                    );
                    if idle_ms > 4500 {
                        std::process::exit(backend_watchdog.exit_code.load(Ordering::SeqCst));
                    }
                }
            }
        });
    }

    for stream in listener.incoming().flatten() {
        let backend_ref = Arc::clone(&backend);
        let dist_ref = ui_dist.clone();
        let tracker_ref = Arc::clone(&tracker);
        std::thread::spawn(move || {
            let _ = handle_http_connection(
                stream,
                &backend_ref,
                dist_ref.as_deref(),
                &tracker_ref,
            );
        });
    }

    Ok(())
}

fn print_help() {
    println!(
        "FreeCompare (fcompare) v{} — Beyond Compare & Git Compatible Diff/Merge Tool",
        env!("CARGO_PKG_VERSION")
    );
    println!();
    println!("USAGE:");
    println!("  fcompare [options] [<left> [<right> [<center/base> [<output>]]]]");
    println!();
    println!("POSITIONAL ARGUMENTS (All Optional):");
    println!("  0 paths : Launch New Session Home UI");
    println!("  1 path  : Open Text or Folder Compare with Left side pre-loaded");
    println!("  2 paths : Open 2-Way Text Compare or Folder Compare");
    println!("  3 paths : Open 3-Way Merge (<left> <right> <center/base>)");
    println!("  4 paths : Open 3-Way Merge (<left> <right> <center/base> <merged_output>)");
    println!();
    println!("BEYOND COMPARE & GIT COMPATIBLE OPTIONS:");
    println!("  -title1=<text>, -lefttitle=<text>      Custom title for Left pane");
    println!("  -title2=<text>, -righttitle=<text>     Custom title for Right pane");
    println!("  -title3=<text>, -centertitle=<text>    Custom title for Center/Base pane");
    println!("  -title4=<text>, -outputtitle=<text>    Custom title for Output pane");
    println!("  -ro, -ro1, -ro2, -ro3                  Read-only mode (all, left, right, or center)");
    println!("  -automerge                             Automatically merge non-conflicting changes");
    println!("  -reviewconflicts                       Open UI if -automerge finds conflicts");
    println!("  -force                                 Write conflict markers when automerging");
    println!("  -favorleft / -favorright               Auto-resolve conflicts favoring Left or Right");
    println!("  -mergeoutput=<path>                    Explicit output path for merged result");
    println!("  -qc[=<mode>], -quickcompare[=<mode>]   Silent comparison (rules, binary, crc, size)");
    println!("  -fv=<type>, -fileviewer=<type>         Force viewer (Text Compare, Folder Compare, Text Merge)");
    println!("  -expandall                             Expand all subfolders initially");
    println!("  -filters=<globs>                       Semicolon-separated filter rules");
    println!("  -solo, -wait / -nowait                 Wait for UI window closure (default: wait)");
    println!("  -review                                Enable Review Mode (Approve/Reject actions & exit codes)");
    println!("  --git-config / --install-git           Print or install global Git difftool/mergetool config");
    println!("  guard                                  Act as Antigravity CLI lifecycle guard for diff review");
}

fn is_guard_disabled_in_hooks_json() -> bool {
    let mut cur = env::current_dir().ok();
    while let Some(dir) = cur {
        let hook_file = dir.join(".agents").join("hooks.json");
        if hook_file.is_file() {
            if let Ok(content) = fs::read_to_string(&hook_file) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if let Some(guard_obj) = val.get("fcompare-guard") {
                        if guard_obj.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    false
}

/// Natively executes cross-platform Antigravity (agy) PreToolUse code change review.
/// Eliminates all Bash / jq / cmp shell dependencies for 100% native execution on Windows, macOS, and Linux.
fn execute_guard_mode() -> Result<()> {
    if env::var("FCOMPARE_GUARD_DISABLED").map(|v| v == "1" || v == "true").unwrap_or(false)
        || is_guard_disabled_in_hooks_json()
    {
        println!("{}", json!({ "decision": "allow" }));
        return Ok(());
    }

    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);

    if input.trim().is_empty() {
        println!("{}", json!({ "decision": "allow" }));
        return Ok(());
    }

    let payload: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => {
            println!("{}", json!({ "decision": "allow" }));
            return Ok(());
        }
    };

    let tool_name = payload["toolCall"]["name"].as_str().unwrap_or("");
    let target_path_str = payload["toolCall"]["args"]["Path"].as_str().unwrap_or("");

    if target_path_str.is_empty() {
        println!("{}", json!({ "decision": "allow" }));
        return Ok(());
    }

    // Skip internal system logs, git internals, transcripts, and agent configs
    let norm = target_path_str.replace('\\', "/");
    if norm.contains(".system_generated")
        || norm.contains(".gemini")
        || norm.contains("/tmp/")
        || norm.contains(".git/")
        || norm.contains(".agents/")
    {
        println!("{}", json!({ "decision": "allow" }));
        return Ok(());
    }

    let target_path = expand_path(target_path_str);

    let old_content = if target_path.is_file() {
        fs::read_to_string(&target_path).unwrap_or_default()
    } else {
        String::new()
    };

    let new_content = match tool_name {
        "write_file" => {
            let content = payload["toolCall"]["args"]["Content"]
                .as_str()
                .unwrap_or("");
            let append = payload["toolCall"]["args"]["Append"]
                .as_bool()
                .unwrap_or(false);
            if append && target_path.is_file() {
                format!("{}{}", old_content, content)
            } else {
                content.to_string()
            }
        }
        "edit_file" => {
            let target = payload["toolCall"]["args"]["Target"].as_str().unwrap_or("");
            let replacement = payload["toolCall"]["args"]["Replacement"]
                .as_str()
                .unwrap_or("");
            if target.is_empty() {
                old_content.clone()
            } else {
                old_content.replace(target, replacement)
            }
        }
        _ => {
            println!("{}", json!({ "decision": "allow" }));
            return Ok(());
        }
    };

    if old_content == new_content {
        println!("{}", json!({ "decision": "allow" }));
        return Ok(());
    }

    let temp_dir = std::env::temp_dir().join(format!("fcompare-guard-{}", std::process::id()));
    let _ = fs::create_dir_all(&temp_dir);

    let file_name = target_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    let old_file = temp_dir.join(format!("CURRENT_{}", file_name));
    let new_file = temp_dir.join(format!("PROPOSED_{}", file_name));

    let _ = fs::write(&old_file, old_content.as_bytes());
    let _ = fs::write(&new_file, new_content.as_bytes());

    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("fcompare"));
    let title1 = format!("当前文件 (Current): {}", file_name);
    let title2 = format!("AI 拟修改 (Proposed): {}", file_name);

    let status = Command::new(&exe)
        .arg("-review")
        .arg("-ro1")
        .arg(format!("-title1={}", title1))
        .arg(format!("-title2={}", title2))
        .arg(&old_file)
        .arg(&new_file)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .status();

    let _ = fs::remove_dir_all(&temp_dir);

    match status {
        Ok(s) if s.success() => {
            println!(
                "{}",
                json!({
                    "decision": "allow",
                    "reason": "已在 FreeCompare 中通过差异审查"
                })
            );
        }
        _ => {
            println!(
                "{}",
                json!({
                    "decision": "deny",
                    "reason": "用户在 FreeCompare 中取消或拒绝了该文件的修改审查"
                })
            );
        }
    }

    Ok(())
}

/// Resolves the current executable path normalized for cross-platform Git configuration
/// (strips Windows `\\?\` extended-length UNC prefix and converts `\` to `/` for Git MSYS2 sh compatibility).
fn resolve_git_compatible_exe_path() -> String {
    let raw_path = env::current_exe()
        .ok()
        .and_then(|p| {
            if p.is_absolute() {
                Some(p)
            } else {
                env::current_dir().ok().map(|cwd| cwd.join(p))
            }
        })
        .unwrap_or_else(|| PathBuf::from("fcompare"));

    let mut path_str = raw_path.to_string_lossy().to_string();
    // Strip Windows extended-length path prefix (`\\?\`) which breaks Git for Windows sh.exe
    if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        path_str = stripped.to_string();
    }
    path_str.replace('\\', "/")
}

fn handle_git_integration(install: bool) -> Result<()> {
    let exe_path = resolve_git_compatible_exe_path();

    let diff_cmd = format!(
        "\"{exe_path}\" -ro1 -title1=\"$LOCAL (HEAD)\" -title2=\"$REMOTE (Working Tree)\" \"$LOCAL\" \"$REMOTE\""
    );
    let merge_cmd = format!(
        "\"{exe_path}\" -automerge -reviewconflicts -title1=\"LOCAL\" -title2=\"REMOTE\" -title3=\"BASE\" -title4=\"MERGED\" \"$LOCAL\" \"$REMOTE\" \"$BASE\" \"$MERGED\""
    );

    if !install {
        println!("# ============================================================================");
        println!("# 方案 A: 直接接管 Git 内置的 Beyond Compare (`bc`) 驱动 (零脚本侵入，推荐)");
        println!("# ============================================================================");
        println!("git config --global diff.tool bc");
        println!("git config --global difftool.prompt false");
        println!("git config --global difftool.bc.path \"{exe_path}\"");
        println!("git config --global merge.tool bc");
        println!("git config --global mergetool.prompt false");
        println!("git config --global mergetool.bc.path \"{exe_path}\"");
        println!("git config --global mergetool.bc.trustExitCode true");
        println!();
        println!("# ============================================================================");
        println!("# 方案 B: 注册独立的 `freecompare` 驱动 (自动携带自定义标题栏与 -automerge)");
        println!("# ============================================================================");
        println!("git config --global diff.tool freecompare");
        println!("git config --global difftool.freecompare.cmd '{diff_cmd}'");
        println!("git config --global merge.tool freecompare");
        println!("git config --global mergetool.freecompare.cmd '{merge_cmd}'");
        println!("git config --global mergetool.freecompare.trustExitCode true");
        return Ok(());
    }

    // 1. Pre-flight check: verify `git` is installed and accessible in PATH
    match Command::new("git").arg("--version").output() {
        Ok(out) if out.status.success() => {}
        _ => {
            anyhow::bail!(
                "未检测到 `git` 命令。请先安装 Git 并确保 `git` 在系统的 PATH 环境变量中。"
            );
        }
    }

    let commands: &[(&str, &str)] = &[
        ("diff.tool", "bc"),
        ("difftool.prompt", "false"),
        ("difftool.bc.path", &exe_path),
        ("difftool.bc3.path", &exe_path),
        ("difftool.bc4.path", &exe_path),
        ("difftool.freecompare.cmd", &diff_cmd),
        ("merge.tool", "bc"),
        ("mergetool.prompt", "false"),
        ("mergetool.bc.path", &exe_path),
        ("mergetool.bc.trustExitCode", "true"),
        ("mergetool.bc3.path", &exe_path),
        ("mergetool.bc3.trustExitCode", "true"),
        ("mergetool.bc4.path", &exe_path),
        ("mergetool.bc4.trustExitCode", "true"),
        ("mergetool.freecompare.cmd", &merge_cmd),
        ("mergetool.freecompare.trustExitCode", "true"),
    ];

    // Prefer `--global`, fallback to local repository config if `--global` fails (e.g. read-only HOME)
    let mut scope = "--global";
    if Command::new("git")
        .args(["config", "--global", "diff.tool", "bc"])
        .status()
        .map(|s| !s.success())
        .unwrap_or(true)
    {
        scope = "--local";
    }

    for (k, v) in commands {
        let status = Command::new("git")
            .args(["config", scope, k, v])
            .status()?;
        if !status.success() {
            anyhow::bail!("无法写入 Git 配置项 `{k}` (scope: {scope})");
        }
    }

    // Read-back verification to confirm Git recorded the exact binary path
    let verified_diff = Command::new("git")
        .args(["config", scope, "--get", "difftool.bc.path"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    println!("✅ 已成功将 FreeCompare 配置为 Git ({scope}) 的默认 difftool 与 mergetool！");
    println!("   可执行文件绑定路径 : {verified_diff}");
    println!("   已接管驱动         : bc / bc3 / bc4 / freecompare (内置单文件 UI，零外部目录依赖)");
    println!("   现在可在任意仓库运行: `git difftool`、`git difftool --dir-diff` 或 `git mergetool`");
    Ok(())
}

fn run_cli_summary(inv: &CliInvocation) -> Result<()> {
    let paths = &inv.paths;
    match paths.len() {
        2 => {
            let left = &paths[0];
            let right = &paths[1];
            if left.is_dir() && right.is_dir() {
                let mut opts = FolderCompareOptions::default();
                opts.recursive = true;
                let res = compare_folders(left, right, &opts)?;
                println!(
                    "Folder Compare: {} vs {}\nTotal: {}, Equal: {}, Modified: {}, Left Only: {}, Right Only: {}",
                    res.left_root,
                    res.right_root,
                    res.stats.total_items,
                    res.stats.equal_items,
                    res.stats.modified_items,
                    res.stats.left_only_items,
                    res.stats.right_only_items
                );
            } else {
                let session = TwoWaySession::from_files(left, right, DiffOptions::default())?;
                let sum = session.summary();
                println!(
                    "Text Compare: {} ({} lines) vs {} ({} lines)\nHunks: {} (Modified: {}, Inserted: {}, Deleted: {})",
                    left.display(),
                    sum.left_line_count,
                    right.display(),
                    sum.right_line_count,
                    sum.hunks.len(),
                    sum.stats.modified_hunks,
                    sum.stats.inserted_hunks,
                    sum.stats.deleted_hunks
                );
            }
        }
        3 | 4 => {
            // BC order: [0]=Left, [1]=Right, [2]=Center/Base, [3]=Output
            let left = &paths[0];
            let right = &paths[1];
            let base = &paths[2];
            let out = inv.resolved_merge_output_path();
            let session = ThreeWaySession::from_files(left, base, right, out)?;
            let sum = session.summary();
            println!(
                "3-Way Merge: {} hunks ({} unresolved conflicts)",
                sum.hunks.len(),
                sum.unresolved_conflicts
            );
            if sum.unresolved_conflicts > 0 {
                std::process::exit(exit_codes::MERGE_CONFLICT_OR_ABORTED);
            }
        }
        _ => {
            print_help();
        }
    }
    Ok(())
}

fn handle_http_connection(
    mut stream: std::net::TcpStream,
    backend: &AppBackend,
    ui_dist: Option<&Path>,
    tracker: &LifecycleTracker,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }

    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let method = parts[0];
    let raw_path = parts[1];
    let path = raw_path.split('?').next().unwrap_or("/");

    let mut content_length = 0usize;
    loop {
        let mut header_line = String::new();
        if reader.read_line(&mut header_line)? == 0 || header_line == "\r\n" || header_line == "\n"
        {
            break;
        }
        let lower = header_line.to_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse::<usize>().unwrap_or(0);
        }
    }

    if method == "OPTIONS" {
        return write_json_response(&mut stream, 200, &json!({ "ok": true }));
    }

    if path == "/api/heartbeat" {
        tracker.touch();
        return write_json_response(&mut stream, 200, &json!({ "ok": true }));
    }

    if path == "/api/shutdown" {
        let mut body = vec![0u8; content_length];
        let _ = reader.read_exact(&mut body);
        let mut immediate = body == b"immediate";
        if let Ok(payload) = serde_json::from_slice::<Value>(&body) {
            if payload["immediate"].as_bool() == Some(true) {
                immediate = true;
            }
            if payload.get("window_width").is_some() || payload.get("window_x").is_some() {
                let _ = backend.dispatch_rpc("update_user_preferences", &payload);
            }
        }
        if immediate {
            let _ = write_json_response(&mut stream, 200, &json!({ "ok": true }));
            let code = backend.exit_code.load(Ordering::SeqCst);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(80));
                std::process::exit(code);
            });
            return Ok(());
        }
        tracker.shutdown_requested.store(true, Ordering::SeqCst);
        return write_json_response(&mut stream, 200, &json!({ "ok": true }));
    }

    if method == "POST" && path == "/api/rpc" {
        tracker.touch();
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body)?;
        let payload: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let cmd = payload["cmd"].as_str().unwrap_or("");
        let args = &payload["args"];

        return match backend.dispatch_rpc(cmd, args) {
            Ok(data) => write_json_response(&mut stream, 200, &json!({ "ok": true, "data": data })),
            Err(err) => {
                write_json_response(&mut stream, 400, &json!({ "ok": false, "error": err }))
            }
        };
    }

    let rel = path.trim_start_matches('/');
    let rel_target = if rel.is_empty() { "index.html" } else { rel };

    // 1. Try disk `ui/dist` directory first (allows hot-reloading during local UI development)
    if let Some(dist_dir) = ui_dist {
        tracker.touch();
        let file_path = dist_dir.join(rel_target);
        let resolved = if file_path.is_file() {
            file_path
        } else {
            dist_dir.join("index.html")
        };

        if let Ok(mut bytes) = fs::read(&resolved) {
            let mime = guess_mime(&resolved);
            if resolved.extension().and_then(|e| e.to_str()) == Some("html") {
                if let Ok(html_str) = String::from_utf8(bytes.clone()) {
                    let now = now_ms();
                    let busted = html_str
                        .replace(".js\"", &format!(".js?v={now}\""))
                        .replace(".css\"", &format!(".css?v={now}\""));
                    bytes = busted.into_bytes();
                }
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store, no-cache, must-revalidate, max-age=0\r\nPragma: no-cache\r\nExpires: 0\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            stream.write_all(header.as_bytes())?;
            stream.write_all(&bytes)?;
            return Ok(());
        }
    }

    // 2. Fallback to compile-time embedded UI assets (enables standalone single-binary distribution!)
    if let Some((asset_rel, mut bytes_vec)) = get_embedded_ui_asset(rel_target)
        .map(|b| (rel_target, b.to_vec()))
        .or_else(|| get_embedded_ui_asset("index.html").map(|b| ("index.html", b.to_vec())))
    {
        tracker.touch();
        let mime = guess_mime(Path::new(asset_rel));
        if asset_rel.ends_with(".html") {
            if let Ok(html_str) = String::from_utf8(bytes_vec.clone()) {
                let now = now_ms();
                let busted = html_str
                    .replace(".js\"", &format!(".js?v={now}\""))
                    .replace(".css\"", &format!(".css?v={now}\""));
                bytes_vec = busted.into_bytes();
            }
        }
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store, no-cache, must-revalidate, max-age=0\r\nPragma: no-cache\r\nExpires: 0\r\nConnection: close\r\n\r\n",
            bytes_vec.len()
        );
        stream.write_all(header.as_bytes())?;
        stream.write_all(&bytes_vec)?;
        return Ok(());
    }

    let fallback = b"FreeCompare UI assets not found. Please build UI first (`cd ui && npm run build`).";
    let header = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        fallback.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(fallback)?;
    Ok(())
}

fn write_json_response(
    stream: &mut std::net::TcpStream,
    status: u16,
    value: &Value,
) -> std::io::Result<()> {
    let status_text = if status == 200 { "OK" } else { "Bad Request" };
    let body = serde_json::to_vec(value).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(&body)?;
    Ok(())
}

fn guess_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn locate_ui_dist() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(custom) = env::var("FREECOMPARE_UI_DIST") {
        candidates.push(PathBuf::from(custom));
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("ui").join("dist"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("ui").join("dist"));
            candidates.push(parent.join("..").join("share").join("freecompare").join("ui").join("dist"));
            candidates.push(parent.join("..").join("..").join("ui").join("dist"));
        }
    }
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        candidates.push(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("freecompare")
                .join("ui")
                .join("dist"),
        );
    }
    candidates.push(PathBuf::from("/usr/local/share/freecompare/ui/dist"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist"));
    candidates.into_iter().find(|p| p.join("index.html").is_file())
}

fn spawn_native_app_window(url: &str, prefs: &UserPreferences) {
    let app_arg = format!("--app={url}");
    let width = prefs.window_width.max(640);
    let height = prefs.window_height.max(480);
    let size_arg = format!("--window-size={width},{height}");
    let pos_arg = prefs
        .window_x
        .zip(prefs.window_y)
        .map(|(x, y)| format!("--window-position={x},{y}"));

    let build_chromium_args = || {
        let mut args = vec![app_arg.clone(), "--new-window".to_string()];
        if prefs.window_maximized {
            args.push("--start-maximized".to_string());
        } else {
            args.push(size_arg.clone());
        }
        if let Some(ref p) = pos_arg {
            args.push(p.clone());
        }
        args
    };

    #[cfg(target_os = "linux")]
    {
        let args = build_chromium_args();
        for bin in [
            "google-chrome",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "brave-browser",
        ] {
            if Command::new(bin).args(&args).spawn().is_ok() {
                return;
            }
        }
        let _ = Command::new("xdg-open").arg(url).spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let args = build_chromium_args();
        for app_bin in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            if Path::new(app_bin).is_file()
                && Command::new(app_bin).args(&args).spawn().is_ok()
            {
                return;
            }
        }
        let _ = Command::new("open").arg(url).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let args = build_chromium_args();
        let mut candidates = vec![
            PathBuf::from("msedge.exe"),
            PathBuf::from("chrome.exe"),
        ];
        for env_key in ["ProgramFiles(x86)", "ProgramFiles", "LocalAppData"] {
            if let Ok(base) = env::var(env_key) {
                let base_path = PathBuf::from(base);
                candidates.push(base_path.join(r"Microsoft\Edge\Application\msedge.exe"));
                candidates.push(base_path.join(r"Google\Chrome\Application\chrome.exe"));
            }
        }
        for bin in candidates {
            if Command::new(&bin).args(&args).spawn().is_ok() {
                return;
            }
        }
        let _ = Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
}
