#[cfg(feature = "desktop")]
#[tauri::command]
fn rpc_invoke(
    state: tauri::State<'_, freecompare_app_lib::AppBackend>,
    cmd: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.dispatch_rpc(&cmd, &args)
}

#[cfg(feature = "desktop")]
fn main() {
    let args: Vec<std::path::PathBuf> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(std::path::PathBuf::from)
        .collect();

    let backend = freecompare_app_lib::AppBackend::new();
    let _ = backend.configure_startup_paths(&args);

    tauri::Builder::default()
        .manage(backend)
        .invoke_handler(tauri::generate_handler![rpc_invoke])
        .run(tauri::generate_context!())
        .expect("error while running FreeCompare Tauri application");
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("FreeCompare Tauri host binary requires `--features desktop` or run `fc` / `bcompare` CLI.");
}
