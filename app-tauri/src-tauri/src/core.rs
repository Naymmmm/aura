//! Rust `aura-core` client — delegates the whole tunnel lifetime to the REAL
//! privileged `aura-core` daemon over its authenticated loopback API.
//!
//! The shipped Aura app never launches the tunnel itself; the desktop UI sends
//! a config to the already-privileged helper (`http://127.0.0.1:45873`), which
//! runs as root and brings up a real TUN device + NaiveProxy + system routes.
//! This module is a faithful port of that contract: `status`/`start`/`stop`/
//! `stats`/`log`. Connecting here produces a genuine system-wide TUN VPN.
//!
//! To use this the real Aura helper must be installed (it is on macOS at
//! `/Library/PrivilegedHelperTools/com.copal.aura.core/aura-core`). The API
//! bearer token lives in the app-support dir the daemon was launched with.

use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::models::{AuthErrorKind, ServerInfo};

pub const CORE_VERSION: &str = "26.3.1";
const CORE_BASE: &str = "http://127.0.0.1:45873";
const PORT: u16 = 443;

/// This app's data dir, set once at startup. `install` writes the daemon token
/// here, so it's the first place to look on every OS.
static APP_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn set_app_data_dir(dir: std::path::PathBuf) {
    let _ = APP_DATA_DIR.set(dir);
}

fn read_token(path: &Path) -> Option<String> {
    let t = std::fs::read_to_string(path).ok()?.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Locate the aura-core API bearer token. The daemon validates the
/// Authorization header against the file it was started with (`--token-file`).
fn find_token() -> Option<String> {
    if let Some(t) = APP_DATA_DIR.get().and_then(|d| read_token(&d.join("aura-core").join("api.token"))) {
        return Some(t);
    }
    if let Ok(p) = std::env::var("AURA_CORE_TOKEN_FILE") {
        if !p.is_empty() {
            if let Ok(t) = std::fs::read_to_string(&p) {
                let t = t.trim().to_string();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
    }
    // Fall back to where the Flutter build and older Tauri builds kept it.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        if let Ok(home) = std::env::var("HOME") {
            for id in ["dev.copal.aura", "com.copal.aura"] {
                candidates.push(format!("{home}/Library/Application Support/{id}/aura-core/api.token").into());
            }
        }
    } else if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            for id in ["com.copal.aura", "dev.copal.aura"] {
                candidates.push(Path::new(&appdata).join(id).join("aura-core").join("api.token"));
            }
        }
    } else if let Ok(home) = std::env::var("HOME") {
        let data = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{home}/.local/share"));
        for id in ["com.copal.aura", "dev.copal.aura"] {
            candidates.push(format!("{data}/{id}/aura-core/api.token").into());
        }
    }
    candidates.iter().find_map(|p| read_token(p))
}

/// A single authenticated request to the daemon.
fn request(
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<reqwest::blocking::Response, String> {
    let token = find_token().ok_or_else(|| {
        "aura-core daemon token not found — is Aura installed?".to_string()
    })?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "bad method".to_string())?;
    // GEts are polled frequently; keep them snappy so a hung daemon never
    // blocks the UI for long. The start POST is the long one.
    let timeout = if method == reqwest::Method::GET {
        Duration::from_secs(6)
    } else {
        Duration::from_secs(30)
    };
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    let mut req = CLIENT
        .get_or_init(reqwest::blocking::Client::new)
        .request(method, format!("{CORE_BASE}{path}"))
        .header("authorization", format!("Bearer {token}"))
        .timeout(timeout);
    if let Some(b) = body {
        req = req.json(&b);
    }
    req.send().map_err(|e| format!("aura-core unreachable: {e}"))
}

fn body_json(resp: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if status != 200 {
        return Err(format!("aura-core returned {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("invalid aura-core response: {e}"))
}

// ---- probe (used for auto server selection + latency display) ---------------

fn probe(host: &str, timeout: Duration) -> Option<u64> {
    let start = Instant::now();
    let addrs: Vec<SocketAddr> = (host, PORT).to_socket_addrs().ok()?.collect();
    let addr = addrs.into_iter().next()?;
    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => Some(start.elapsed().as_millis() as u64),
        Err(_) => None,
    }
}

pub fn probe_all(servers: &[ServerInfo], prefer_ip: bool) -> HashMap<String, i64> {
    std::thread::scope(|s| {
        let handles: Vec<_> = servers
            .iter()
            .map(|srv| {
                let tag = srv.tag.clone();
                let host = srv.connect_address(prefer_ip);
                s.spawn(move || (tag, probe(&host, Duration::from_millis(1800))))
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| {
                let (tag, ms) = h.join().unwrap_or((String::new(), None));
                ms.map(|m| (tag, m as i64))
            })
            .collect()
    })
}

// ---- response shapes (returned to the UI) -----------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CoreStatus {
    pub version: String,
    pub running: bool,
    pub kill_switch: bool,
    pub blocked: bool,
    pub egress_ip: Option<String>,
    pub proxy_addr: Option<String>,
    pub last_error: Option<String>,
}

impl Default for CoreStatus {
    fn default() -> Self {
        CoreStatus {
            version: CORE_VERSION.to_string(),
            running: false,
            kill_switch: false,
            blocked: false,
            egress_ip: None,
            proxy_addr: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct CoreStats {
    pub running: bool,
    pub active_server: Option<String>,
    pub latencies: HashMap<String, i64>,
    pub upload_total: u64,
    pub download_total: u64,
    pub kill_switch: bool,
    pub blocked: bool,
    pub egress_ip: Option<String>,
    pub proxy_addr: Option<String>,
    pub last_error: Option<String>,
    /// "" (no Tailscale), "ok" or "rerouted" — from aura-core 26.3+.
    pub tailscale: String,
}

fn status_value(v: &serde_json::Value) -> CoreStatus {
    CoreStatus {
        version: v
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or(CORE_VERSION)
            .to_string(),
        running: v.get("running").and_then(|x| x.as_bool()).unwrap_or(false),
        kill_switch: false,
        blocked: false,
        egress_ip: None,
        proxy_addr: None,
        last_error: v.get("last_error").and_then(|x| x.as_str()).map(String::from),
    }
}

fn stats_value(v: &serde_json::Value) -> CoreStats {
    let latencies: HashMap<String, i64> = match v.get("latencies") {
        Some(l) if !l.is_null() => serde_json::from_value(l.clone()).unwrap_or_default(),
        _ => HashMap::new(),
    };
    CoreStats {
        running: v.get("running").and_then(|x| x.as_bool()).unwrap_or(false),
        active_server: v.get("active_server").and_then(|x| x.as_str()).map(String::from),
        upload_total: v.get("upload_total").and_then(|x| x.as_i64()).unwrap_or(0).max(0) as u64,
        download_total: v
            .get("download_total")
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
            .max(0) as u64,
        kill_switch: false,
        blocked: false,
        egress_ip: None,
        proxy_addr: None,
        last_error: v.get("last_error").and_then(|x| x.as_str()).map(String::from),
        tailscale: v.get("tailscale").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        latencies,
    }
}

// ---- lifecycle --------------------------------------------------------------

/// Bring up a real TUN tunnel through the privileged helper. Returns the active
/// server tag once the daemon reports the tunnel is alive.
pub fn start(
    auto: bool,
    selected: &ServerInfo,
    servers: &[ServerInfo],
    prefer_ip: bool,
) -> Result<String, String> {
    if servers.is_empty() {
        return Err("no servers to connect".to_string());
    }
    // Only auto mode needs the probe; a manual pick skips straight to start.
    let chosen = if auto {
        probe_all(servers, prefer_ip)
            .iter()
            .min_by_key(|(_, ms)| **ms)
            .map(|(tag, _)| servers.iter().find(|s| &s.tag == tag).unwrap().clone())
            .unwrap_or_else(|| servers[0].clone())
    } else {
        servers
            .iter()
            .find(|s| s.tag == selected.tag)
            .cloned()
            .unwrap_or_else(|| selected.clone())
    };

    // The daemon's parseConfig uses DisallowUnknownFields: only this schema.
    let config = serde_json::json!({
        "version": 1,
        "tun": { "address": "172.19.0.1/30", "mtu": 1400 },
        "servers": [{
            "tag": chosen.tag,
            "host": chosen.host,
            "connect_address": chosen.connect_address(prefer_ip),
            "port": PORT,
            "username": chosen.username,
            "password": chosen.password,
        }],
    });

    let resp = request("POST", "/v1/start", Some(serde_json::json!({ "config": config })))?;
    if resp.status() != 200 {
        let detail = resp.text().unwrap_or_default();
        return Err(format!("Aura Core failed to start the tunnel: {detail}"));
    }

    // Wait for the helper to report the tunnel alive with an active server.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(j) = request("GET", "/v1/stats", None).and_then(body_json) {
            let stats = stats_value(&j);
            if stats.running {
                if let Some(active) = stats.active_server {
                    if !active.is_empty() {
                        return Ok(active);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Aura Core started but no server came alive".to_string())
}

/// Tear down the real tunnel. The daemon doesn't model a kill switch, so the
/// blocked flag is always false here.
pub fn stop() -> Result<bool, String> {
    let resp = request("POST", "/v1/stop", None)?;
    let _ = body_json(resp)?;
    Ok(false)
}

pub fn status() -> CoreStatus {
    match request("GET", "/v1/status", None).and_then(body_json) {
        Ok(v) => status_value(&v),
        Err(_) => CoreStatus {
            version: CORE_VERSION.to_string(),
            running: false,
            kill_switch: false,
            blocked: false,
            egress_ip: None,
            proxy_addr: None,
            last_error: None,
        },
    }
}

pub fn stats() -> CoreStats {
    match request("GET", "/v1/stats", None).and_then(body_json) {
        Ok(v) => stats_value(&v),
        Err(_) => CoreStats::default(),
    }
}

pub fn recent_log() -> String {
    match request("GET", "/v1/log", None).and_then(body_json) {
        Ok(v) => v.get("log").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        Err(_) => "aura-core is not running".to_string(),
    }
}

#[allow(dead_code)]
pub fn _kind_string(kind: AuthErrorKind) -> &'static str {
    kind.as_str()
}

// ---- aura-core detection, install, uninstall --------------------------------

#[derive(Debug, Serialize, Default)]
pub struct HelperInfo {
    /// The helper answered with our token.
    pub installed: bool,
    /// Version the running helper reports.
    pub version: Option<String>,
    /// Older than the helper bundled with this app — reinstall to get fixes
    /// like Tailscale coexistence.
    pub outdated: bool,
    pub bundled_version: &'static str,
}

/// Probe the privileged helper: installed, and is it current?
pub fn helper_info() -> HelperInfo {
    let mut info = HelperInfo { bundled_version: CORE_VERSION, ..Default::default() };
    if find_token().is_none() {
        return info;
    }
    if let Ok(v) = request("GET", "/v1/status", None).and_then(body_json) {
        info.installed = true;
        let version = v.get("version").and_then(|x| x.as_str()).unwrap_or("0.0.0").to_string();
        info.outdated = version_lt(&version, CORE_VERSION);
        info.version = Some(version);
    }
    info
}

fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
    };
    parse(a) < parse(b)
}

/// The token guards a root-level API, so it must come from the OS CSPRNG.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("random token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn write_token(app_data_dir: &Path) -> Result<std::path::PathBuf, String> {
    let dir = app_data_dir.join("aura-core");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("api.token");
    std::fs::write(&file, random_token()?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        let _ = Command::new("chmod").arg("600").arg(&file).status();
    }
    Ok(file)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Install the privileged helper from the binaries bundled as resources.
pub fn install(app_data_dir: &Path, resource_dir: &Path) -> Result<(), String> {
    let token_file = write_token(app_data_dir)?;
    let (core_name, naive_name) = if cfg!(windows) {
        ("aura-core.exe", "naive.exe")
    } else {
        ("aura-core", "naive")
    };
    let (aura, naive) = find_bundle(resource_dir, core_name, naive_name).ok_or_else(|| {
        "aura-core installation packages can't be found, this build is corrupted, reinstall from website and try again"
            .to_string()
    })?;
    if cfg!(windows) {
        install_windows(&aura, &naive, &token_file)
    } else if cfg!(target_os = "macos") {
        install_macos(&aura, &naive, &token_file)
    } else {
        install_linux(&aura, &naive, &token_file)
    }
}

/// Locate the bundled aura-core + naive binaries, wherever Tauri placed them.
fn find_bundle(resource_dir: &Path, core: &str, naive: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    #[allow(unused_mut)]
    let mut candidates = vec![
        resource_dir.join("aura-core"),
        resource_dir.join("resources").join("aura-core"),
    ];
    // `tauri dev` doesn't reliably copy resources; use the source folder.
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("aura-core"));
    for dir in candidates {
        let a = dir.join(core);
        let n = dir.join(naive);
        if a.is_file() && n.is_file() {
            return Some((a, n));
        }
    }
    find_recursive(resource_dir, core, naive)
}

fn find_recursive(dir: &Path, core: &str, naive: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_recursive(&p, core, naive) {
                return Some(found);
            }
        } else if p.file_name().and_then(|n| n.to_str()) == Some(core) {
            let peer = p.parent()?.join(naive);
            if peer.is_file() {
                return Some((p, peer));
            }
        }
    }
    None
}

fn install_macos(aura: &Path, naive: &Path, token_file: &Path) -> Result<(), String> {
    let install = "/Library/PrivilegedHelperTools/com.copal.aura.core";
    let runtime = "/Library/Application Support/Aura Core";
    let plist = "/Library/LaunchDaemons/com.copal.aura.core.plist";
    let sh = format!(
        "set -eu\n\
         INSTALL={}\nRUNTIME={}\nPLIST={}\nTOKEN={}\nAU={}\nNA={}\n\
         mkdir -p \"$INSTALL\" \"$RUNTIME\"\nrm -rf \"$INSTALL\"\nmkdir -p \"$INSTALL\"\n\
         cp \"$AU\" \"$INSTALL/aura-core\"\ncp \"$NA\" \"$INSTALL/naive\"\n\
         chmod 755 \"$INSTALL/aura-core\" \"$INSTALL/naive\"\nchown -R root:wheel \"$INSTALL\"\n\
         chmod 700 \"$RUNTIME\"; chown root:wheel \"$RUNTIME\"\n\
         launchctl bootout system/com.copal.aura.core 2>/dev/null || true\n\
         cat > \"$PLIST\" <<EOF\n\
<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
  <key>Label</key><string>com.copal.aura.core</string>\n\
  <key>ProgramArguments</key><array>\n\
    <string>$INSTALL/aura-core</string>\n\
    <string>serve</string><string>--state-dir</string><string>$RUNTIME</string>\n\
    <string>--token-file</string><string>$TOKEN</string>\n\
  </array>\n\
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
  <key>ProcessType</key><string>Interactive</string>\n\
  <key>StandardOutPath</key><string>/var/log/aura-core.log</string>\n\
  <key>StandardErrorPath</key><string>/var/log/aura-core.log</string>\n\
</dict></plist>\n\
EOF\n\
         chmod 644 \"$PLIST\"\nchown root:wheel \"$PLIST\"\nlaunchctl bootstrap system \"$PLIST\"\n",
        shell_quote(install),
        shell_quote(runtime),
        shell_quote(plist),
        // These live under "Application Support"; unquoted, the space splits
        // the assignment and `set -e` aborts the install.
        shell_quote(&token_file.display().to_string()),
        shell_quote(&aura.display().to_string()),
        shell_quote(&naive.display().to_string())
    );
    let esc = sh.replace('\\', "\\\\").replace('"', "\\\"");
    let apple = format!("do shell script \"{}\" with administrator privileges", esc);
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("-128") {
        Err("admin install was cancelled".to_string())
    } else {
        Err(format!("admin install failed: {}", stderr.trim()))
    }
}

fn install_linux(aura: &Path, naive: &Path, token_file: &Path) -> Result<(), String> {
    // An AppImage runs from a per-user FUSE mount that root can't read, so
    // stage the binaries somewhere pkexec's root shell can.
    let stage = std::env::temp_dir().join("aura-core-install");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let (aura_staged, naive_staged) = (stage.join("aura-core"), stage.join("naive"));
    std::fs::copy(aura, &aura_staged).map_err(|e| format!("stage aura-core: {e}"))?;
    std::fs::copy(naive, &naive_staged).map_err(|e| format!("stage naive: {e}"))?;
    let (aura, naive) = (aura_staged.as_path(), naive_staged.as_path());
    let sh = format!(
        "set -eu\n\
         INSTALL=/opt/aura-core\nRUNTIME=/var/lib/aura-core\nUNIT=/etc/systemd/system/aura-core.service\n\
         systemctl stop aura-core 2>/dev/null || true\n\
         mkdir -p \"$INSTALL\" \"$RUNTIME\"\nchmod 700 \"$RUNTIME\"\n\
         install -m 755 {aura} \"$INSTALL/aura-core\"\ninstall -m 755 {naive} \"$INSTALL/naive\"\n\
         cat > \"$UNIT\" <<EOF\n\
[Unit]\nDescription=Aura Core VPN helper\nAfter=network-online.target\nWants=network-online.target\n\
[Service]\nExecStart=$INSTALL/aura-core serve --state-dir $RUNTIME --token-file {token}\nRestart=on-failure\nRestartSec=2\n\
[Install]\nWantedBy=multi-user.target\nEOF\n\
         systemctl daemon-reload\nsystemctl enable --now aura-core\n",
        aura = shell_quote(&aura.display().to_string()),
        naive = shell_quote(&naive.display().to_string()),
        token = shell_quote(&token_file.display().to_string()),
    );
    // pkexec shows the desktop's native admin prompt (polkit).
    let status = Command::new("pkexec")
        .args(["/bin/sh", "-c", &sh])
        .status()
        .map_err(|e| format!("pkexec: {e} — install polkit, or run the helper install as root"))?;
    if status.success() {
        Ok(())
    } else {
        Err("admin install was cancelled or failed".to_string())
    }
}

/// PowerShell single-quoted literal; ' is escaped as ''.
fn ps_quote(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', "''"))
}

/// The elevated install script. It writes "ok" or the failure detail to
/// `result_file` and exits non-zero on failure.
fn windows_install_script(result_file: &Path, aura: &Path, naive: &Path, token_file: &Path) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$resultFile = {result}
try {{
$install = Join-Path $env:ProgramFiles 'Aura Core'
$runtime = Join-Path $env:ProgramData 'Aura Core'
$taskName = 'Aura Core Helper'
$installedCore = Join-Path $install 'aura-core.exe'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $install, $runtime | Out-Null
& icacls.exe $runtime /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue | Stop-Process -Force
# Stop-Process returns before Windows releases the exe; wait for it to exit.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {{
  Start-Sleep -Milliseconds 300
}}
# The exe can stay locked briefly after exit; retry the copy before giving up.
$copied = $false
for ($i = 0; $i -lt 10 -and -not $copied; $i++) {{
  try {{
    Copy-Item -LiteralPath {aura} -Destination $installedCore -Force
    Copy-Item -LiteralPath {naive} -Destination (Join-Path $install 'naive.exe') -Force
    # aura-core loads wintun.dll from its own folder to create the TUN adapter.
    $wintun = Join-Path (Split-Path -LiteralPath {naive}) 'wintun.dll'
    if (Test-Path -LiteralPath $wintun) {{ Copy-Item -LiteralPath $wintun -Destination (Join-Path $install 'wintun.dll') -Force }}
    $copied = $true
  }} catch {{
    Start-Sleep -Milliseconds 500
  }}
}}
if (-not $copied) {{ throw "could not replace the Aura helper in $install (is it still running?)" }}
$taskArguments = 'serve --state-dir "' + $runtime + '" --token-file "' + {token} + '"'
$action = New-ScheduledTaskAction -Execute $installedCore -Argument $taskArguments
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
# Only report success once the helper is actually listening.
$online = $false
for ($i = 0; $i -lt 40 -and -not $online; $i++) {{
  try {{
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', 45873)
    $client.Close()
    $online = $true
  }} catch {{
    Start-Sleep -Milliseconds 250
  }}
}}
if (-not $online) {{
  $helperLog = Join-Path $runtime 'helper.log'
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  $detail = "aura-core did not start (task result $($taskInfo.LastTaskResult))."
  if (Test-Path -LiteralPath $helperLog) {{ $detail += "`n" + (Get-Content -Raw -LiteralPath $helperLog) }}
  Set-Content -LiteralPath $resultFile -Value $detail
  exit 1
}}
Set-Content -LiteralPath $resultFile -Value 'ok'
}} catch {{
  Set-Content -LiteralPath $resultFile -Value ($_ | Out-String)
  exit 1
}}
"#,
        result = ps_quote(result_file),
        aura = ps_quote(aura),
        naive = ps_quote(naive),
        token = ps_quote(token_file),
    )
}

/// Elevates `script` via UAC and exits with its exit code (2 when the UAC
/// prompt is declined). Without -PassThru, Start-Process reports success even
/// when the script failed.
fn windows_launch_command(script: &Path) -> String {
    format!(
        "try {{ $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"' + {} + '\"')) }} catch {{ exit 2 }}; exit $p.ExitCode",
        ps_quote(script)
    )
}

fn install_windows(aura: &Path, naive: &Path, token_file: &Path) -> Result<(), String> {
    let stage = std::env::temp_dir().join("aura-core-install");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result_file = stage.join("result.txt");
    let script_path = stage.join("install.ps1");
    let ps = windows_install_script(&result_file, aura, naive, token_file);
    std::fs::write(&script_path, &ps).map_err(|e| e.to_string())?;
    let launch = windows_launch_command(&script_path);
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launch.as_str()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = cmd.status().map_err(|e| format!("elevation: {e}"))?;
    let detail = std::fs::read_to_string(&result_file).unwrap_or_default();
    let detail = detail.trim();
    match status.code() {
        Some(0) if detail == "ok" => Ok(()),
        Some(2) => Err("admin install was cancelled".to_string()),
        _ if !detail.is_empty() && detail != "ok" => Err(format!("helper install failed: {detail}")),
        code => Err(format!("helper install failed (exit code {code:?})")),
    }
}

/// Stop + remove the privileged helper.
pub fn uninstall(app_data_dir: &Path) -> Result<(), String> {
    // Best-effort stop via the daemon API.
    let _ = request("POST", "/v1/stop", None);
    // Remove the token so the app stops talking to (and detecting) the helper.
    let _ = std::fs::remove_file(app_data_dir.join("aura-core/api.token"));
    let _ = std::fs::remove_dir_all(app_data_dir.join("aura-core"));
    if cfg!(target_os = "macos") {
        let _ = Command::new("launchctl").args(["bootout", "system/com.copal.aura.core"]).status();
        let _ = std::fs::remove_file("/Library/LaunchDaemons/com.copal.aura.core.plist");
    } else if cfg!(target_os = "linux") {
        let _ = Command::new("pkexec")
            .args(["/bin/sh", "-c", "systemctl disable --now aura-core; rm -f /etc/systemd/system/aura-core.service; rm -rf /opt/aura-core; systemctl daemon-reload"])
            .status();
    } else if cfg!(windows) {
        let _ = Command::new("powershell.exe").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Stop-ScheduledTask -TaskName 'Aura Core Helper' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'Aura Core Helper' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item 'C:\\Program Files\\Aura Core' -Recurse -Force -ErrorAction SilentlyContinue",
        ])
        .status();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the Windows install scripts for an awkward user path. Set
    /// AURA_PWSH to a PowerShell binary to also parse-check them.
    #[test]
    fn windows_install_scripts_parse() {
        let dir = std::env::temp_dir().join("aura-ps-test");
        std::fs::create_dir_all(&dir).unwrap();
        let user = Path::new(r"C:\Users\O'Brien Smith\AppData\Roaming\com.copal.aura");
        let script = windows_install_script(
            &dir.join("result.txt"),
            &user.join(r"resources\aura-core\aura-core.exe"),
            &user.join(r"resources\aura-core\naive.exe"),
            &user.join(r"aura-core\api.token"),
        );
        assert!(script.contains("O''Brien Smith"));
        assert!(!script.contains("$args"));
        std::fs::write(dir.join("install.ps1"), &script).unwrap();
        std::fs::write(dir.join("launch.ps1"), windows_launch_command(&dir.join("install.ps1"))).unwrap();
        let Ok(pwsh) = std::env::var("AURA_PWSH") else { return };
        for name in ["install.ps1", "launch.ps1"] {
            let check = format!(
                "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{}',[ref]$null,[ref]$e); if ($e.Count) {{ $e | % {{ $_.ToString() }}; exit 1 }}",
                dir.join(name).display()
            );
            let out = Command::new(&pwsh).args(["-NoProfile", "-Command", &check]).output().unwrap();
            assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stdout));
        }
    }
}
