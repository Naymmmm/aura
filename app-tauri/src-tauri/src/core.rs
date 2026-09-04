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

pub const CORE_VERSION: &str = "26.1.0";
const CORE_BASE: &str = "http://127.0.0.1:45873";
const PORT: u16 = 443;

/// Locate the aura-core API bearer token. The daemon validates the
/// Authorization header against the file it was started with (`--token-file`).
fn find_token() -> Option<String> {
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
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        format!("{home}/Library/Application Support/dev.copal.aura/aura-core/api.token"),
        format!("{home}/Library/Application Support/com.copal.aura/aura-core/api.token"),
    ];
    for path in candidates {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let t = raw.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
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
    let mut req = reqwest::blocking::Client::new()
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

fn probe_all(servers: &[ServerInfo], prefer_ip: bool) -> HashMap<String, i64> {
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
    _kill_switch: bool,
    _exceptions: Vec<String>,
) -> Result<String, String> {
    if servers.is_empty() {
        return Err("no servers to connect".to_string());
    }
    let latencies = probe_all(servers, prefer_ip);
    let chosen = if auto {
        latencies
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
        std::thread::sleep(Duration::from_millis(500));
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

/// True when the privileged aura-core helper is installed and reachable.
pub fn detected() -> bool {
    if find_token().is_none() {
        return false;
    }
    matches!(
        request("GET", "/v1/status", None).map(|r| r.status().as_u16()),
        Ok(200)
    )
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut h = nanos ^ ((std::process::id() as u128) << 64);
    let mut out = String::with_capacity(64);
    for _ in 0..32 {
        h = h
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        out.push_str(&format!("{:02x}", (h >> 64) as u8));
    }
    out
}

fn write_token(app_data_dir: &Path) -> Result<std::path::PathBuf, String> {
    let dir = app_data_dir.join("aura-core");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("api.token");
    std::fs::write(&file, random_token()).map_err(|e| e.to_string())?;
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
    let bundle = resource_dir.join("aura-core");
    let (core_name, naive_name) = if cfg!(windows) {
        ("aura-core.exe", "naive.exe")
    } else {
        ("aura-core", "naive")
    };
    let aura = bundle.join(core_name);
    let naive = bundle.join(naive_name);
    if !aura.is_file() || !naive.is_file() {
        return Err("aura-core binaries are not bundled in this build".to_string());
    }
    if cfg!(windows) {
        install_windows(&aura, &naive, &token_file)
    } else if cfg!(target_os = "macos") {
        install_macos(&aura, &naive, &token_file)
    } else {
        Err("unsupported platform".to_string())
    }
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
        token_file.display(),
        aura.display(),
        naive.display()
    );
    let esc = sh.replace('\\', "\\\\").replace('"', "\\\"");
    let apple = format!("do shell script \"{}\" with administrator privileges", esc);
    let status = Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .status()
        .map_err(|e| format!("osascript: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("admin install was cancelled or failed".to_string())
    }
}

fn install_windows(aura: &Path, naive: &Path, token_file: &Path) -> Result<(), String> {
    let install = r"C:\Program Files\Aura Core";
    let runtime = r"C:\ProgramData\Aura Core";
    let task = "Aura Core Helper";
    let ps = format!(
        r#"
$ErrorActionPreference='Stop'
$install = '{install}'
$runtime = '{runtime}'
$taskName = '{task}'
$tokenFile = '{token}'
New-Item -ItemType Directory -Force -Path $install,$runtime | Out-Null
& icacls.exe $runtime /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
Copy-Item '{aura}' $install\aura-core.exe -Force
Copy-Item '{naive}' $install\naive.exe -Force
$args = 'serve --state-dir "' + $runtime + '" --token-file "' + $tokenFile + '"'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$install\aura-core.exe" -Argument $args
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
"#,
        install = install,
        runtime = runtime,
        task = task,
        token = token_file.display(),
        aura = aura.display(),
        naive = naive.display()
    );
    // Re-launch elevated via Start-Process -Verb RunAs.
    let inner = format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{}\"",
        ps.replace('"', "\\\"")
    );
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process powershell.exe -Wait -Verb RunAs -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',('\"' + \"\" \"\" + $inner + \"\" \"\" + '\"'))",
        ])
        .status()
        .map_err(|e| format!("elevation: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("admin install was cancelled or failed".to_string())
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
