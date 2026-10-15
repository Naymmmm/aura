//! In-app updates through the Tauri updater.
//!
//! The Worker answers `/v1/update/{target}/{arch}/{current_version}` with the
//! newest promoted release for this platform (or 204 when current). Every
//! payload is minisign-signed in CI with Aura's updater key, and the plugin
//! refuses anything that doesn't verify against the public key baked into
//! tauri.conf.json, so a tampered download is never installed. This is
//! independent of Apple/Microsoft code signing.

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    app.updater_builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// The newer version available for this install, if any.
pub async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(find(app).await?.map(|update| update.version))
}

/// Downloads, verifies and installs the update, then restarts into it. On
/// Windows the NSIS installer takes over and the process exits on its own.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let mut update = find(app)
        .await?
        .ok_or_else(|| "Aura is already up to date".to_string())?;
    // The check's short timeout would also cap the download.
    update.timeout = Some(Duration::from_secs(15 * 60));
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("update {}: {e}", update.version))?;
    app.restart();
}
