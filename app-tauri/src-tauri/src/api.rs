//! Port of Aura's Dart `SessionService`, `ConfigService` and `UpdateService`
//! networking to async Rust. The unprivileged UI still talks directly to the
//! same api.copal.run endpoints; only the OS-level pieces moved into Rust.
//!
//! NOTE: this experimental port keeps the exact same API contract as the
//! Flutter build. Tunnel establishment is NOT done here — that remains the job
//! of the privileged `aura-core` helper (simulated in `core.rs` for this port).

use std::time::Duration;

use chrono::Utc;
use reqwest::{Client, StatusCode};

use crate::models::{AuthErrorKind, AuthPoll, AuthStart, ServerConfig, SessionInfo, SessionResponse};

/// Default API base, matching the Flutter app.
pub const API_BASE: &str = "https://api.copal.run";
/// The version this build ships with (bump per release).
pub const APP_VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));

/// A transport/session failure carried as a small typed error so the command
/// layer can tell the frontend exactly which Aura error it is.
#[derive(Debug)]
pub struct ApiError {
    pub kind: AuthErrorKind,
    pub message: String,
}

impl ApiError {
    fn new(kind: AuthErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Bridge string for a Tauri command error. Auth kinds stay as their exact
    /// kind so the UI can map them; network errors keep the underlying cause.
    pub fn command_str(&self) -> String {
        if self.kind == AuthErrorKind::Network {
            format!("network: {}", self.message)
        } else {
            self.kind.as_str().to_string()
        }
    }
}

/// One shared client so TLS sessions and connections to api.copal.run are
/// reused instead of re-handshaking on every call.
fn client() -> Result<Client, ApiError> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| ApiError::new(AuthErrorKind::Network, format!("http client: {e}")))?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

fn map_status(status: StatusCode, body: &str) -> AuthErrorKind {
    match status.as_u16() {
        401 => AuthErrorKind::BadCreds,
        403 => {
            if body.contains("no_credit") {
                AuthErrorKind::NoCredit
            } else if body.contains("disabled") {
                AuthErrorKind::AccountDisabled
            } else if body.contains("budget_exceeded") {
                AuthErrorKind::BudgetExceeded
            } else {
                AuthErrorKind::AccountExpired
            }
        }
        503 => AuthErrorKind::PoolExhausted,
        _ => AuthErrorKind::Network,
    }
}

/// POST /v1/auth/discord/start — creates a browser login flow.
pub async fn auth_start() -> Result<AuthStart, ApiError> {
    let resp = client()?
        .post(format!("{API_BASE}/v1/auth/discord/start"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
    if resp.status() != StatusCode::OK {
        return Err(ApiError::new(AuthErrorKind::Network, "start failed"));
    }
    resp.json::<AuthStart>()
        .await
        .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))
}

/// POST /v1/auth/discord/poll — checks whether the browser approval landed.
pub async fn auth_poll(login_id: &str, login_secret: &str) -> Result<AuthPoll, ApiError> {
    let resp = client()?
        .post(format!("{API_BASE}/v1/auth/discord/poll"))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .json(&serde_json::json!({ "login_id": login_id, "login_secret": login_secret }))
        .send()
        .await
        .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;

    match resp.status().as_u16() {
        202 => Ok(AuthPoll {
            approved: false,
            token: None,
            token_expires_at: None,
            account: None,
        }),
        200 => {
            // The approval payload carries the 14-day token directly.
            let value: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
            let token = value["token"].as_str().map(str::to_owned);
            let token_expires_at = value["token_expires_at"].as_i64();
            let account = value["account"].clone();
            let account = if account.is_null() {
                None
            } else {
                serde_json::from_value(account).ok()
            };
            Ok(AuthPoll {
                approved: true,
                token,
                token_expires_at,
                account,
            })
        }
        code => Err(ApiError::new(map_status(resp.status(), ""), format!("poll {code}"))),
    }
}

/// POST /v1/session — checks out fresh rotating pool credentials + account.
pub async fn open_session(token: &str) -> Result<SessionInfo, ApiError> {
    let resp = client()?
        .post(format!("{API_BASE}/v1/session"))
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;

    if resp.status() == StatusCode::OK {
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        let session: SessionResponse = serde_json::from_value(value.clone())
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        if session.config.servers.is_empty() {
            return Err(ApiError::new(AuthErrorKind::PoolExhausted, "empty pool"));
        }
        return Ok(SessionInfo {
            config: session.config,
            session_id: session.session_id,
            expires_at: session.expires_at,
            account: session.account,
        });
    }

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(ApiError::new(map_status(status, &body), body))
}

/// POST /v1/session with a license key — no Discord involved.
pub async fn license_session(key: &str) -> Result<SessionInfo, ApiError> {
    body_session(serde_json::json!({ "license_key": key })).await
}

/// POST /v1/session with legacy account_id + token credentials.
pub async fn legacy_session(account_id: &str, token: &str) -> Result<SessionInfo, ApiError> {
    body_session(serde_json::json!({ "account_id": account_id, "token": token })).await
}

async fn body_session(body: serde_json::Value) -> Result<SessionInfo, ApiError> {
    let resp = client()?
        .post(format!("{API_BASE}/v1/session"))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;

    if resp.status() == StatusCode::OK {
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        let session: SessionResponse = serde_json::from_value(value)
            .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
        if session.config.servers.is_empty() {
            return Err(ApiError::new(AuthErrorKind::PoolExhausted, "empty pool"));
        }
        return Ok(SessionInfo {
            config: session.config,
            session_id: session.session_id,
            expires_at: session.expires_at,
            account: session.account,
        });
    }

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(ApiError::new(map_status(status, &body), body))
}

/// POST /v1/session/{id}/heartbeat — slides session expiry server-side and
/// reports the usage delta (`{ delta }`) so the Worker can enforce the budget.
/// Returns false only on a hard 410 (session gone). Network hiccups stay "alive".
pub async fn heartbeat(session_id: &str, delta: i64) -> Result<bool, ApiError> {
    let mut builder = client()?
        .post(format!("{API_BASE}/v1/session/{session_id}/heartbeat"));
    if delta > 0 {
        builder = builder.json(&serde_json::json!({ "delta": delta }));
    }
    let resp = builder
        .send()
        .await
        .map_err(|_| ApiError::new(AuthErrorKind::Network, "heartbeat unreachable"))?;
    Ok(resp.status() != StatusCode::GONE)
}

/// DELETE /v1/session/{id} — best-effort close.
pub async fn close_session(session_id: &str) {
    if let Ok(c) = client() {
        let _ = c
            .delete(format!("{API_BASE}/v1/session/{session_id}"))
            .send()
            .await;
    }
}

/// Open a URL in the default browser, the same way the Flutter app did.
pub async fn open_browser(url: &str) -> Result<(), ApiError> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        // `open` is macOS-only and `cmd /C start` mangles `&` in OAuth URLs.
        // rundll32 hands the URL to the default handler untouched (as Flutter did).
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(url).status()
    }
    .map_err(|e| ApiError::new(AuthErrorKind::Network, e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(ApiError::new(AuthErrorKind::Network, "could not open browser"))
    }
}

/// Current UTC unix seconds — used for session expiry checks.
pub fn now_secs() -> i64 {
    Utc::now().timestamp()
}
