//! Aura — Experimental Tauri (React + Rust) port of the Flutter desktop app.
//!
//! The React UI now owns the live state machine (login → connect → stats) while
//! Rust owns the OS/persistence boundary that previously lived in Dart:
//!   * `api`    — api.copal.run session/config/update networking (was SessionService)
//!   * `core`   — the privileged aura-core helper lifecycle (simulated for this port)
//!   * `usage`  — monthly data budget persistence (was UsageTracker)
//!   * `models` — the serde types mirroring Aura's Dart models

mod api;
mod core;
mod models;
mod usage;

use serde::Serialize;
use tauri::Manager;

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
    api::auth_start().await.map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn auth_poll(login_id: String, login_secret: String) -> Result<AuthPoll, String> {
    api::auth_poll(&login_id, &login_secret)
        .await
        .map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command]
async fn open_browser(url: String) -> Result<(), String> {
    api::open_browser(&url).await.map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command]
async fn open_session(token: String) -> Result<SessionInfo, String> {
    api::open_session(&token).await.map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn legacy_session(account_id: String, token: String) -> Result<SessionInfo, String> {
    api::legacy_session(&account_id, &token)
        .await
        .map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn heartbeat(session_id: String, delta: i64) -> Result<bool, String> {
    api::heartbeat(&session_id, delta)
        .await
        .map_err(|e| e.kind.as_str().to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn close_session(session_id: String) {
    api::close_session(&session_id).await;
}

#[tauri::command]
async fn check_update() -> Result<Option<String>, String> {
    api::check_update(api::platform_key())
        .await
        .map_err(|e| e.kind.as_str().to_string())
}

// ---- Simulated aura-core helper (ports AuraCoreManager) ---------------------

#[tauri::command(rename_all = "snake_case")]
async fn core_start(
    auto: bool,
    selected: ServerInfo,
    servers: Vec<ServerInfo>,
    prefer_ip: bool,
    kill_switch: bool,
    exceptions: Vec<String>,
) -> Result<String, String> {
    // The daemon IPC is blocking (request + probe + poll). Run it off the async
    // runtime thread so reqwest::blocking never deadlocks inside Tauri.
    tauri::async_runtime::spawn_blocking(move || {
        core::start(auto, &selected, &servers, prefer_ip, kill_switch, exceptions)
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
        .invoke_handler(tauri::generate_handler![
            app_meta,
            auth_start,
            auth_poll,
            open_browser,
            open_session,
            legacy_session,
            heartbeat,
            close_session,
            check_update,
            core_start,
            core_stop,
            core_status,
            core_stats,
            core_log,
            usage_month_used,
            usage_add,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
