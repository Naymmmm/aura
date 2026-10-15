//! aura-core: Aura's privileged, cross-platform tunnel supervisor.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod config;
mod logger;
mod naive;
mod process;
mod proxy;
mod routes;
mod tailscale;
mod udp;
mod vpn;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use vpn::{start_vpn, RuntimeStats, VpnRuntime};

/// The version reported to the apps, which reinstall the helper on mismatch.
/// `AURA_CORE_VERSION` at build time overrides the crate version.
pub const VERSION: &str = match option_env!("AURA_CORE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const DEFAULT_LISTEN: &str = "127.0.0.1:45873";

struct Core {
    state_dir: PathBuf,
    naive_path: PathBuf,
    runtime: Mutex<Option<Arc<VpnRuntime>>>,
    last_error: Mutex<String>,
    /// Serializes start/stop so two requests can't race over the TUN device.
    op: tokio::sync::Mutex<()>,
}

#[derive(Debug, Serialize)]
struct Status {
    version: &'static str,
    running: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pid: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    started_at: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    last_error: String,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Deserialize)]
struct StartRequest {
    config: Box<RawValue>,
}

struct Options {
    listen: String,
    state_dir: PathBuf,
    token_file: PathBuf,
    naive: Option<PathBuf>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("serve") {
        eprintln!("usage: aura-core serve [options]");
        std::process::exit(2);
    }
    let options = parse_options(&args[1..]).unwrap_or_else(|e| fatal(&e));
    if let Err(e) = create_private_dir(&options.state_dir) {
        fatal(&e.to_string());
    }
    if let Err(e) = logger::init(&options.state_dir.join("helper.log")) {
        fatal(&e.to_string());
    }
    let token = std::fs::read_to_string(&options.token_file)
        .map(|t| t.trim().to_string())
        .unwrap_or_default();
    if token.is_empty() {
        log_fatal(&format!(
            "read token: {} is missing or empty",
            options.token_file.display()
        ));
    }
    let core = Arc::new(Core {
        state_dir: options.state_dir,
        naive_path: options.naive.unwrap_or_else(naive::default_naive_path),
        runtime: Mutex::new(None),
        last_error: Mutex::new(String::new()),
        op: tokio::sync::Mutex::new(()),
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap_or_else(|e| log_fatal(&e.to_string()));
    runtime.block_on(serve(core, options.listen, token));
}

async fn serve(core: Arc<Core>, listen: String, token: String) {
    let addr: SocketAddr = listen
        .parse()
        .unwrap_or_else(|_| log_fatal(&format!("invalid --listen address {listen}")));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| log_fatal(&e.to_string()));
    log::info!("aura-core {VERSION} listening on {addr}");
    let token = Arc::new(token);
    let app = Router::new()
        .route("/v1/status", get(status_handler))
        .route("/v1/stats", get(stats_handler))
        .route("/v1/start", post(start_handler))
        .route("/v1/stop", post(stop_handler))
        .route("/v1/log", get(log_handler))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(token, authenticate))
        .with_state(core.clone());
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    let _ = core.stop().await;
    if let Err(e) = result {
        log_fatal(&e.to_string());
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn authenticate(State(token): State<Arc<String>>, request: Request, next: Next) -> Response {
    let got = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v))
        .unwrap_or("");
    if !constant_time_eq(got.as_bytes(), token.as_bytes()) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    next.run(request).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn error(code: StatusCode, message: &str) -> Response {
    (code, Json(serde_json::json!({ "error": message }))).into_response()
}

async fn status_handler(State(core): State<Arc<Core>>) -> Json<Status> {
    Json(core.snapshot())
}

async fn stats_handler(State(core): State<Arc<Core>>) -> Json<RuntimeStats> {
    let runtime = core.runtime.lock().unwrap().clone();
    let last_error = core.last_error.lock().unwrap().clone();
    let mut stats = runtime.map(|rt| rt.stats()).unwrap_or_default();
    if stats.last_error.is_empty() {
        stats.last_error = last_error;
    }
    Json(stats)
}

async fn start_handler(State(core): State<Arc<Core>>, body: Bytes) -> Response {
    let Ok(request) = serde_json::from_slice::<StartRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid start request");
    };
    let raw = request.config.get();
    let cfg = match config::parse_config(raw) {
        Ok(cfg) => cfg,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    if let Err(e) = write_private(&core.state_dir.join("config.json"), raw.as_bytes()) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    if let Err(e) = core.start(cfg).await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    Json(core.snapshot()).into_response()
}

async fn stop_handler(State(core): State<Arc<Core>>) -> Response {
    if let Err(e) = core.stop().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    Json(core.snapshot()).into_response()
}

async fn log_handler(State(core): State<Arc<Core>>) -> Response {
    const MAX: usize = 32 * 1024;
    let mut combined = Vec::new();
    for name in ["helper.log", "core.log", "naive.log"] {
        match std::fs::read(core.state_dir.join(name)) {
            Ok(part) if !part.is_empty() => {
                combined.extend_from_slice(format!("\n--- {name} ---\n").as_bytes());
                combined.extend_from_slice(&part);
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }
    if combined.len() > MAX {
        combined.drain(..combined.len() - MAX);
    }
    Json(serde_json::json!({ "log": String::from_utf8_lossy(&combined) })).into_response()
}

impl Core {
    fn snapshot(&self) -> Status {
        let mut status = Status {
            version: VERSION,
            running: false,
            pid: 0,
            started_at: String::new(),
            last_error: self.last_error.lock().unwrap().clone(),
        };
        if let Some(rt) = self.runtime.lock().unwrap().as_ref() {
            status.running = rt.running();
            status.pid = rt.pid();
            status.started_at = logger::rfc3339(rt.started_at);
            let err = rt.last_error();
            if !err.is_empty() {
                status.last_error = err;
            }
        }
        status
    }

    async fn start(&self, cfg: config::AuraConfig) -> Result<(), String> {
        let _op = self.op.lock().await;
        self.stop_locked()
            .await
            .map_err(|e| format!("stop previous tunnel: {e}"))?;
        match start_vpn(&self.state_dir, &self.naive_path, cfg).await {
            Ok(rt) => {
                *self.runtime.lock().unwrap() = Some(rt);
                self.last_error.lock().unwrap().clear();
                log::info!("tunnel started");
                Ok(())
            }
            Err(e) => {
                log::error!("start tunnel: {e}");
                *self.last_error.lock().unwrap() = e.clone();
                Err(e)
            }
        }
    }

    async fn stop(&self) -> Result<(), String> {
        let _op = self.op.lock().await;
        self.stop_locked().await
    }

    async fn stop_locked(&self) -> Result<(), String> {
        let Some(rt) = self.runtime.lock().unwrap().take() else {
            return Ok(());
        };
        let result = rt.stop().await;
        if let Err(e) = &result {
            log::error!("stop tunnel: {e}");
            *self.last_error.lock().unwrap() = e.clone();
        }
        result
    }
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut listen = DEFAULT_LISTEN.to_string();
    let (mut state_dir, mut token_file, mut naive) = (None, None, None);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        // Accept Go flag syntax: -name value, --name value, --name=value.
        let flag = arg.trim_start_matches('-');
        if flag.len() == arg.len() {
            return Err(format!("unexpected argument {arg:?}"));
        }
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (flag, None),
        };
        let value = match inline {
            Some(value) => value,
            None => iter
                .next()
                .cloned()
                .ok_or_else(|| format!("flag needs an argument: -{name}"))?,
        };
        match name {
            "listen" => listen = value,
            "state-dir" => state_dir = Some(PathBuf::from(value)),
            "token-file" => token_file = Some(PathBuf::from(value)),
            "naive" if !value.is_empty() => naive = Some(PathBuf::from(value)),
            "naive" => {}
            _ => return Err(format!("flag provided but not defined: -{name}")),
        }
    }
    match (state_dir, token_file) {
        (Some(state_dir), Some(token_file)) => Ok(Options {
            listen,
            state_dir,
            token_file,
            naive,
        }),
        _ => Err("--state-dir and --token-file are required".into()),
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(path)
}

/// Writes a file readable only by the helper's own user (root/SYSTEM).
pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(path)?, data)
}

fn fatal(message: &str) -> ! {
    eprintln!("aura-core: {message}");
    std::process::exit(1);
}

fn log_fatal(message: &str) -> ! {
    log::error!("{message}");
    fatal(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    fn test_core() -> Arc<Core> {
        Arc::new(Core {
            state_dir: std::env::temp_dir(),
            naive_path: PathBuf::from("/nonexistent/naive"),
            runtime: Mutex::new(None),
            last_error: Mutex::new(String::new()),
            op: tokio::sync::Mutex::new(()),
        })
    }

    fn app() -> Router {
        Router::new()
            .route("/v1/status", get(status_handler))
            .layer(middleware::from_fn_with_state(
                Arc::new("correct-token".to_string()),
                authenticate,
            ))
            .with_state(test_core())
    }

    #[tokio::test]
    async fn authenticates_requests() {
        for (token, want) in [
            (None, 401),
            (Some("wrong"), 401),
            (Some("correct-token"), 200),
        ] {
            let mut request = Request::get("/v1/status");
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let response = app()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), want, "token {token:?}");
        }
    }

    #[test]
    fn snapshot_starts_stopped() {
        let status = test_core().snapshot();
        assert!(!status.running);
        assert_eq!(status.version, VERSION);
        let json = serde_json::to_value(&status).unwrap();
        assert!(json.get("pid").is_none() && json.get("started_at").is_none());
    }

    #[test]
    fn stats_default_has_empty_latencies() {
        let json = serde_json::to_value(RuntimeStats::default()).unwrap();
        assert_eq!(json["latencies"], serde_json::json!({}));
        assert!(json.get("active_server").is_none());
    }

    #[test]
    fn parses_go_style_flags() {
        let args: Vec<String> = [
            "-state-dir",
            "/s",
            "--token-file=/t",
            "--listen",
            "127.0.0.1:1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let options = parse_options(&args).unwrap();
        assert_eq!(options.state_dir, PathBuf::from("/s"));
        assert_eq!(options.token_file, PathBuf::from("/t"));
        assert_eq!(options.listen, "127.0.0.1:1");
        assert!(parse_options(&args[..2]).is_err());
    }

    #[tokio::test]
    async fn start_with_missing_naive_reports_error() {
        let core = test_core();
        let cfg = config::parse_config(
            r#"{"version":1,"tun":{"address":"172.19.0.1/30","mtu":1400},"servers":[{"tag":"a","host":"a.example","connect_address":"192.0.2.1","port":443,"username":"u","password":"p"}]}"#,
        )
        .unwrap();
        let err = core.start(cfg).await.unwrap_err();
        assert!(err.contains("NaiveProxy executable is missing"), "{err}");
        assert_eq!(core.snapshot().last_error, err);
    }
}
