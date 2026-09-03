//! Data models mirroring Aura's Flutter `models/` and the Worker API contract.
//! JSON keys stay snake_case to exactly match the wire format of api.copal.run.

use serde::{Deserialize, Serialize};

/// A single NaiveProxy server entry from the Worker config API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub tag: String,
    pub host: String,
    pub ip: String,
    pub username: String,
    pub password: String,
}

impl ServerInfo {
    /// Connect address: the domain by default, the raw IP when `prefer_ip`
    /// is on (escape hatch for DNS poisoning — tls.server_name stays the host).
    pub fn connect_address(&self, prefer_ip: bool) -> String {
        if prefer_ip {
            self.ip.clone()
        } else {
            self.host.clone()
        }
    }
}

/// The whole config payload served by the Worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub version: i64,
    #[serde(default)]
    pub prefer_ip: bool,
    #[serde(default = "default_budget_gb")]
    pub budget_gb: i64,
    pub servers: Vec<ServerInfo>,
}

fn default_budget_gb() -> i64 {
    100
}

/// Account state returned inside a /v1/session response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountStatus {
    #[serde(rename = "discord_id")]
    pub discord_id: String,
    pub username: String,
    #[serde(rename = "display_name")]
    pub display_name: String,
    #[serde(rename = "expires_at")]
    pub expires_at: Option<i64>,
    #[serde(rename = "budget_gb")]
    pub budget_gb: i64,
    pub plan: String,
}

impl AccountStatus {
    /// Aura plans, mapped from the Worker's `plan` string.
    pub fn plan_label(&self) -> &'static str {
        match self.plan.as_str() {
            "free_trial" => "FREE TRIAL",
            "standard" | "paid" => "STANDARD",
            _ => "NONE",
        }
    }
}

/// The whole session: config + short-lived pool credentials + account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub config: ServerConfig,
    #[serde(rename = "session_id")]
    pub session_id: String,
    #[serde(rename = "expires_at")]
    pub expires_at: i64,
    pub account: AccountStatus,
}

/// Raw /v1/session wire response (config fields appear at the top level).
#[derive(Debug, Deserialize)]
pub struct SessionResponse {
    #[serde(flatten)]
    pub config: ServerConfig,
    #[serde(rename = "session_id")]
    pub session_id: String,
    #[serde(rename = "expires_at")]
    pub expires_at: i64,
    pub account: AccountStatus,
}

/// Discord OAuth start response from POST /v1/auth/discord/start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStart {
    #[serde(rename = "login_id")]
    pub login_id: String,
    #[serde(rename = "login_secret")]
    pub login_secret: String,
    #[serde(rename = "authorize_url")]
    pub authorize_url: String,
    #[serde(rename = "handoff_url")]
    pub handoff_url: String,
    #[serde(rename = "expires_at")]
    pub expires_at: i64,
}

/// The result of POST /v1/auth/discord/poll. While pending the worker returns
/// 202; approving turns into a 200 with the 14-day app token.
#[derive(Debug, Clone, Serialize)]
pub struct AuthPoll {
    pub approved: bool,
    pub token: Option<String>,
    #[serde(rename = "token_expires_at")]
    pub token_expires_at: Option<i64>,
    pub account: Option<AccountStatus>,
}

/// Auth error kinds, mapped from API response codes. The frontend maps these
/// to Aura's meme copy (see `lines.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorKind {
    BadCreds,
    AccountExpired,
    AccountDisabled,
    NoCredit,
    BudgetExceeded,
    PoolExhausted,
    SessionGone,
    Network,
}

impl AuthErrorKind {
    /// Wire string used across the JS bridge and the frontend error mapping.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BadCreds => "badCreds",
            Self::AccountExpired => "accountExpired",
            Self::AccountDisabled => "accountDisabled",
            Self::NoCredit => "noCredit",
            Self::BudgetExceeded => "budgetExceeded",
            Self::PoolExhausted => "poolExhausted",
            Self::SessionGone => "sessionGone",
            Self::Network => "network",
        }
    }
}
