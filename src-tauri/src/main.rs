#![cfg_attr(
    all(not(debug_assertions), feature = "desktop"),
    windows_subsystem = "windows"
)]

#[cfg(feature = "desktop")]
#[tauri::command]
async fn rpc_invoke(
    app_handle: tauri::AppHandle,
    cmd: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<freecompare_app_lib::AppBackend>();
        state.dispatch_rpc(&cmd, &args)
    })
    .await
    .map_err(|e| format!("RPC task failed: {e}"))?
}

#[cfg(feature = "desktop")]
fn main() {
    use tauri::{Emitter, Manager};

    let args: Vec<std::path::PathBuf> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(std::path::PathBuf::from)
        .collect();

    let backend = freecompare_app_lib::AppBackend::new();
    let _ = backend.configure_startup_paths(&args);

    tauri::Builder::default()
        .manage(backend)
        .setup(|app| {
            let handle = app.handle().clone();
            let rx = app
                .state::<freecompare_app_lib::AppBackend>()
                .subscribe_scan_progress();
            std::thread::spawn(move || {
                while let Ok(ev) = rx.recv() {
                    let _ = handle.emit("folder_scan_progress", &ev);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc_invoke])
        .run(tauri::generate_context!())
        .expect("error while running FreeCompare Tauri application");
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("FreeCompare Tauri host binary requires `--features desktop` or run `fc` / `bcompare` CLI.");
}
