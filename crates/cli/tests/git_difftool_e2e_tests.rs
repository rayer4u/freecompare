use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn send_http_request(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .expect("Failed to connect to fcompare TCP listener");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).unwrap();

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);

    let status = response
        .lines()
        .next()
        .and_then(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            parts.get(1).and_then(|s| s.parse::<u16>().ok())
        })
        .unwrap_or(0);

    let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

#[test]
fn test_git_difftool_e2e_server_lifecycle_and_clean_exit() {
    let dir = tempdir().unwrap();
    let file_a = dir.path().join("a.txt");
    let file_b = dir.path().join("b.txt");

    fs::write(&file_a, "Hello from A\n").unwrap();
    fs::write(&file_b, "Hello from B\n").unwrap();

    let bin_path = env!("CARGO_BIN_EXE_fcompare");

    // Spawn `fcompare` as Git difftool would
    let mut child = Command::new(bin_path)
        .arg("--no-open-window")
        .arg(&file_a)
        .arg(&file_b)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn fcompare binary");

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let mut reader = BufReader::new(stdout);
    let mut listening_line = String::new();

    // Read the "🚀 FreeCompare UI listening at http://127.0.0.1:<port>" line
    let start_wait = Instant::now();
    let mut port: Option<u16> = None;
    while start_wait.elapsed() < Duration::from_secs(5) {
        listening_line.clear();
        if reader.read_line(&mut listening_line).unwrap_or(0) > 0 {
            if let Some(pos) = listening_line.find("http://127.0.0.1:") {
                let rest = &listening_line[pos + "http://127.0.0.1:".len()..];
                let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(p) = port_str.parse::<u16>() {
                    port = Some(p);
                    break;
                }
            }
        }
    }

    let port = port.expect("Failed to obtain listening port from fcompare stdout");

    // 1. Verify /api/rpc `get_startup_session`
    let (status, body) = send_http_request(
        port,
        "POST",
        "/api/rpc",
        r#"{"cmd":"get_startup_session","args":null}"#,
    );
    assert_eq!(status, 200);
    assert!(body.contains("\"kind\":\"two_way_text\""));
    assert!(body.contains("a.txt"));
    assert!(body.contains("b.txt"));

    // 2. Verify /api/heartbeat keeps server alive
    let (hb_status, hb_body) = send_http_request(port, "POST", "/api/heartbeat", "{}");
    assert_eq!(hb_status, 200);
    assert!(hb_body.contains("\"ok\":true"));

    // Verify child is still running after normal operations
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        child.try_wait().unwrap().is_none(),
        "fcompare process exited prematurely!"
    );

    // 3. Verify clean shutdown and exit code 0
    let (sd_status, sd_body) = send_http_request(
        port,
        "POST",
        "/api/shutdown",
        r#"{"immediate":true}"#,
    );
    assert_eq!(sd_status, 200);
    assert!(sd_body.contains("\"ok\":true"));

    let exit_status = child
        .wait_timeout(Duration::from_secs(3))
        .expect("Wait timeout on child process")
        .expect("Child did not exit after shutdown request");

    assert_eq!(exit_status.code(), Some(0));
}

#[test]
fn test_git_difftool_review_mode_reject_exit_code() {
    let dir = tempdir().unwrap();
    let file_a = dir.path().join("orig.txt");
    let file_b = dir.path().join("prop.txt");

    fs::write(&file_a, "Original content\n").unwrap();
    fs::write(&file_b, "Proposed modification\n").unwrap();

    let bin_path = env!("CARGO_BIN_EXE_fcompare");

    let mut child = Command::new(bin_path)
        .arg("--review")
        .arg("--no-open-window")
        .arg(&file_a)
        .arg(&file_b)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn fcompare in review mode");

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let mut reader = BufReader::new(stdout);
    let mut listening_line = String::new();

    let start_wait = Instant::now();
    let mut port: Option<u16> = None;
    while start_wait.elapsed() < Duration::from_secs(5) {
        listening_line.clear();
        if reader.read_line(&mut listening_line).unwrap_or(0) > 0 {
            if let Some(pos) = listening_line.find("http://127.0.0.1:") {
                let rest = &listening_line[pos + "http://127.0.0.1:".len()..];
                let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(p) = port_str.parse::<u16>() {
                    port = Some(p);
                    break;
                }
            }
        }
    }

    let port = port.expect("Failed to obtain listening port");

    // Reject review via RPC `set_process_exit_code` with code 1
    let (code_status, _) = send_http_request(
        port,
        "POST",
        "/api/rpc",
        r#"{"cmd":"set_process_exit_code","args":{"code":1}}"#,
    );
    assert_eq!(code_status, 200);

    // Shutdown immediately
    let (sd_status, _) = send_http_request(
        port,
        "POST",
        "/api/shutdown",
        r#"{"immediate":true}"#,
    );
    assert_eq!(sd_status, 200);

    let exit_status = child
        .wait_timeout(Duration::from_secs(3))
        .expect("Wait timeout on child process")
        .expect("Child did not exit after shutdown request");

    assert_eq!(exit_status.code(), Some(1));
}

trait WaitTimeoutExt {
    fn wait_timeout(&mut self, timeout: Duration) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl WaitTimeoutExt for std::process::Child {
    fn wait_timeout(&mut self, timeout: Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        let start = Instant::now();
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if start.elapsed() >= timeout {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
