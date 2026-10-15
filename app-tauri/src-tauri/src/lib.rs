//! Aura — Experimental Tauri (React + Rust) port of the Flutter desktop app.
//!
//! The React UI now owns the live state machine (login → connect → stats) while
//! Rust owns the OS/persistence boundary that previously lived in Dart:
//!   * `api`    — api.copal.run session/config/update networking (was SessionService)
//!   * `core`   — the privileged aura-core helper lifecycle (simulated for this port)
//!   * `usage`  — monthly data budget persistence (was UsageTracker)
//!   * `models` — the serde types mirroring Aura's Dart models
//!   * `updates` — signed in-app updates through the Tauri updater

mod api;
mod core;
mod models;
mod tray;
mod updates;
mod usage;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

use crate::core::SplitTunnel;
use crate::models::{AuthPoll, AuthStart, ServerInfo, SessionInfo};

#[derive(Serialize)]
struct AppMeta {
    version: &'static str,
    api_base: &'static str,
}

#[tauri::command]
fn app_meta() -> AppMeta {
    AppMeta {
        version: api::APP_VERSION,
        api_base: api::API_BASE,
    }
}

// ---- Discord OAuth + session (ports SessionService) -------------------------

#[tauri::command]
async fn auth_start() -> Result<AuthStart, String> {
    api::auth_start().await.map_err(|e| e.command_str())
}

#[tauri::command(rename_all = "snake_case")]
async fn auth_poll(login_id: String, login_secret: String) -> Result<AuthPoll, String> {
    api::auth_poll(&login_id, &login_secret)
        .await
        .map_err(|e| e.command_str())
}

#[tauri::command]
async fn open_browser(url: String) -> Result<(), String> {
    api::open_browser(&url).await.map_err(|e| e.command_str())
}

#[tauri::command]
async fn open_session(token: String) -> Result<SessionInfo, String> {
    api::open_session(&token).await.map_err(|e| e.command_str())
}

#[tauri::command]
async fn license_session(key: String) -> Result<SessionInfo, String> {
    api::license_session(&key).await.map_err(|e| e.command_str())
}

/// Read a dropped/opened `.auralicense` file. Capped so a wrong file can't
/// flood the UI.
#[tauri::command]
fn read_license_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 4096 {
        return Err("that file is too big to be an Aura license".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn legacy_session(account_id: String, token: String) -> Result<SessionInfo, String> {
    api::legacy_session(&account_id, &token)
        .await
        .map_err(|e| e.command_str())
}

#[tauri::command(rename_all = "snake_case")]
async fn heartbeat(session_id: String, delta: i64) -> Result<bool, String> {
    api::heartbeat(&session_id, delta)
        .await
        .map_err(|e| e.command_str())
}

#[tauri::command(rename_all = "snake_case")]
async fn close_session(session_id: String) {
    api::close_session(&session_id).await;
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    updates::check(&app).await
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    updates::install(&app).await
}

// ---- Launch at login ----------------------------------------------------------

#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

/// True when the OS started Aura at login rather than the user opening it.
fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

const AUTOSTART_ARG: &str = "--autostart";

// ---- Simulated aura-core helper (ports AuraCoreManager) ---------------------

#[tauri::command(rename_all = "snake_case")]
async fn core_start(
    auto: bool,
    selected: ServerInfo,
    servers: Vec<ServerInfo>,
    prefer_ip: bool,
    split: Option<SplitTunnel>,
) -> Result<String, String> {
    // The daemon IPC is blocking (request + probe + poll). Run it off the async
    // runtime thread so reqwest::blocking never deadlocks inside Tauri.
    let split = split.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        core::start(auto, &selected, &servers, prefer_ip, &split)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn core_stop() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(core::stop)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
}

#[tauri::command]
async fn core_status() -> core::CoreStatus {
    tauri::async_runtime::spawn_blocking(core::status)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn core_stats() -> core::CoreStats {
    tauri::async_runtime::spawn_blocking(core::stats)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn core_log() -> String {
    tauri::async_runtime::spawn_blocking(core::recent_log)
        .await
        .unwrap_or_else(|_| "aura-core is not running".to_string())
}

// Async + spawn_blocking: a sync command runs on the main thread, and the
// daemon probe can take seconds — that froze the whole window.
#[tauri::command]
async fn core_helper() -> core::HelperInfo {
    tauri::async_runtime::spawn_blocking(core::helper_info)
        .await
        .unwrap_or_default()
}

/// TCP-probe every server so the list shows latency before connecting.
#[tauri::command]
async fn probe_servers(
    servers: Vec<ServerInfo>,
    prefer_ip: bool,
) -> std::collections::HashMap<String, i64> {
    tauri::async_runtime::spawn_blocking(move || core::probe_all(&servers, prefer_ip))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn core_install(app: tauri::AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().unwrap_or_default();
    let res = app.path().resource_dir().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || core::install(&data, &res))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn core_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || core::uninstall(&data))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Monthly data budget persistence (ports UsageTracker) -------------------

#[tauri::command(rename_all = "snake_case")]
fn usage_month_used(app: tauri::AppHandle, account_id: String) -> i64 {
    let dir = app.path().app_data_dir().unwrap_or_default();
    usage::month_used(&dir, &account_id)
}

#[tauri::command(rename_all = "snake_case")]
fn usage_add(app: tauri::AppHandle, account_id: String, delta: i64) {
    let dir = app.path().app_data_dir().unwrap_or_default();
    usage::add(&dir, &account_id, delta);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .arg(AUTOSTART_ARG)
                .build(),
        )
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                core::set_app_data_dir(dir);
            }
            // Menu bar app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::init(app.handle())?;
            // The window starts hidden; a login launch stays in the tray.
            if !launched_at_login() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        // Closing the window just hides it; Aura keeps running in the tray.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_meta,
            auth_start,
            auth_poll,
            open_browser,
            open_session,
            legacy_session,
            license_session,
            read_license_file,
            heartbeat,
            close_session,
            check_update,
            install_update,
            autostart_enabled,
            set_autostart,
            core_start,
            core_stop,
            core_status,
            core_stats,
            core_log,
            core_helper,
            probe_servers,
            core_install,
            core_uninstall,
            usage_month_used,
            usage_add,
            tray::tray_update,
            tray::app_quit,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| startup_failed(&e.to_string()));
}

/// The portable Windows build can't bundle WebView2, and some Windows 10
/// machines don't have it. Instead of crashing silently, send the user to
/// Microsoft's installer.
fn startup_failed(error: &str) -> ! {
    if cfg!(windows) {
        let _ = std::process::Command::new("rundll32")
            .args([
                "url.dll,FileProtocolHandler",
                "https://developer.microsoft.com/microsoft-edge/webview2/#download",
            ])
            .status();
    }
    panic!("Aura could not start: {error}");
}
