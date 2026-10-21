use anyhow::Result;
use freecompare_app_lib::AppBackend;
use freecompare_core::{
    folder::{compare_folders, FolderCompareOptions},
    DiffOptions, ThreeWaySession, TwoWaySession,
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

    if raw_args.iter().any(|a| a == "-h" || a == "--help") {
        print_help();
        return Ok(());
    }

    let cli_only = raw_args.iter().any(|a| a == "--cli" || a == "--summary");
    let no_open = raw_args.iter().any(|a| a == "--no-open" || a == "--headless");
    let port_override = raw_args
        .windows(2)
        .find(|w| w[0] == "--port")
        .and_then(|w| w[1].parse::<u16>().ok());

    let positional: Vec<PathBuf> = raw_args
        .iter()
        .enumerate()
        .filter(|(idx, a)| {
            if a.starts_with('-') {
                return false;
            }
            if *idx > 0 && raw_args[*idx - 1] == "--port" {
                return false;
            }
            true
        })
        .map(|(_, a)| PathBuf::from(a))
        .collect();

    if cli_only {
        return run_cli_summary(&positional);
    }

    let backend = Arc::new(AppBackend::new());
    if !positional.is_empty() {
        match backend.configure_startup_paths(&positional) {
            Ok(launch) => {
                println!(
                    "⚡ FreeCompare: Prepared {:?} session for {} ↔ {}",
                    launch.kind, launch.left_path, launch.right_path
                );
            }
            Err(err) => {
                eprintln!("⚠️ Warning: {err}");
            }
        }
    }

    let bind_addr = format!("127.0.0.1:{}", port_override.unwrap_or(0));
    let listener = TcpListener::bind(&bind_addr)?;
    let local_port = listener.local_addr()?.port();
    let ui_url = format!("http://127.0.0.1:{local_port}");
    let ui_dist = locate_ui_dist();
    let tracker = Arc::new(LifecycleTracker::new());

    println!("🚀 FreeCompare UI listening at {ui_url}");
    if !no_open {
        spawn_native_app_window(&ui_url);
        let tracker_watchdog = Arc::clone(&tracker);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(500));
                if tracker_watchdog.shutdown_requested.load(Ordering::SeqCst) {
                    // Grace period of 400ms in case user merely refreshed the page
                    std::thread::sleep(Duration::from_millis(400));
                    if now_ms().saturating_sub(tracker_watchdog.last_heartbeat_ms.load(Ordering::SeqCst))
                        >= 350
                    {
                        std::process::exit(0);
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
                        std::process::exit(0);
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
    println!("FreeCompare (fcompare / fc) v0.1.0 — Cross-Platform Diff & Merge Tool");
    println!();
    println!("USAGE:");
    println!("  fcompare                                     # Launch UI (Text / Folder / 3-Way)");
    println!("  fcompare <left_dir> <right_dir>              # Launch Folder Compare UI");
    println!("  fcompare <left_file> <right_file>            # Launch Text Compare UI");
    println!("  fcompare <left> <base> <right> [output]      # Launch 3-Way Merge UI (git mergetool)");
    println!("  fcompare <left> <right> --cli                # Print terminal summary without UI");
}

fn run_cli_summary(paths: &[PathBuf]) -> Result<()> {
    match paths.len() {
        2 => {
            let left = &paths[0];
            let right = &paths[1];
            if left.is_dir() && right.is_dir() {
                let res = compare_folders(left, right, &FolderCompareOptions::default())?;
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
            let left = &paths[0];
            let base = &paths[1];
            let right = &paths[2];
            let out = paths.get(3).cloned();
            let session = ThreeWaySession::from_files(left, base, right, out)?;
            let sum = session.summary();
            println!(
                "3-Way Merge: {} hunks ({} unresolved conflicts)",
                sum.hunks.len(),
                sum.unresolved_conflicts
            );
            if sum.unresolved_conflicts > 0 {
                std::process::exit(1);
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

    if let Some(dist_dir) = ui_dist {
        tracker.touch();
        let rel = path.trim_start_matches('/');
        let file_path = if rel.is_empty() {
            dist_dir.join("index.html")
        } else {
            dist_dir.join(rel)
        };
        let resolved = if file_path.is_file() {
            file_path
        } else {
            dist_dir.join("index.html")
        };

        if let Ok(bytes) = fs::read(&resolved) {
            let mime = guess_mime(&resolved);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            stream.write_all(header.as_bytes())?;
            stream.write_all(&bytes)?;
            return Ok(());
        }
    }

    let fallback = b"FreeCompare UI dist not found. Please run `cd ui && npm run build`.";
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
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("ui").join("dist"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("ui").join("dist"));
            candidates.push(parent.join("..").join("..").join("ui").join("dist"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist"));
    candidates.into_iter().find(|p| p.join("index.html").is_file())
}

fn spawn_native_app_window(url: &str) {
    let app_arg = format!("--app={url}");

    #[cfg(target_os = "linux")]
    {
        for bin in ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"] {
            if Command::new(bin)
                .arg(&app_arg)
                .arg("--new-window")
                .arg("--window-size=1440,900")
                .spawn()
                .is_ok()
            {
                return;
            }
        }
        let _ = Command::new("xdg-open").arg(url).spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("cmd").args(["/C", "start", url]).spawn();
    }
}
