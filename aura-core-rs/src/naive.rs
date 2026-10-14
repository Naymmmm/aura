use std::fs::OpenOptions;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Instant};

use crate::config::ServerConfig;
use crate::proxy::ProxyEndpoint;

#[derive(Serialize)]
struct NaiveFileConfig {
    listen: Vec<String>,
    proxy: Vec<String>,
    #[serde(
        rename = "host-resolver-rules",
        skip_serializing_if = "String::is_empty"
    )]
    host_resolver_rules: String,
    log: String,
}

/// A supervised NaiveProxy child. `done` flips to true once it has exited.
pub struct ManagedProcess {
    pid: u32,
    done: watch::Receiver<bool>,
    err: Arc<Mutex<Option<String>>>,
}

pub async fn start_naive(
    state_dir: &Path,
    executable: &Path,
    servers: &[ServerConfig],
) -> Result<(ManagedProcess, Vec<ProxyEndpoint>), String> {
    if !executable.is_file() {
        return Err(format!(
            "NaiveProxy executable is missing: {}",
            executable.display()
        ));
    }
    let ports = reserve_ports(servers.len()).map_err(|e| e.to_string())?;
    let mut config = NaiveFileConfig {
        listen: Vec::with_capacity(servers.len()),
        proxy: Vec::with_capacity(servers.len()),
        host_resolver_rules: String::new(),
        log: state_dir.join("naive.log").to_string_lossy().into_owned(),
    };
    let mut endpoints = Vec::with_capacity(servers.len());
    let mut resolver_rules = Vec::new();
    for (server, port) in servers.iter().zip(&ports) {
        let address = format!("127.0.0.1:{port}");
        config.listen.push(format!("socks://{address}"));
        config.proxy.push(proxy_url(server));
        endpoints.push(ProxyEndpoint {
            tag: server.tag.clone(),
            addr: address,
        });
        if server.connect_address != server.host {
            resolver_rules.push(format!("MAP {} {}", server.host, server.connect_address));
        }
    }
    config.host_resolver_rules = resolver_rules.join(", ");
    let config_path = state_dir.join("naive.json");
    let raw = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    crate::write_private(&config_path, &raw).map_err(|e| e.to_string())?;

    let core_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(state_dir.join("core.log"))
        .map_err(|e| e.to_string())?;
    let core_log_err = core_log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(executable);
    cmd.arg(&config_path)
        .current_dir(state_dir)
        .stdin(Stdio::null())
        .stdout(core_log)
        .stderr(core_log_err)
        .kill_on_drop(true);
    crate::process::configure_child(&mut cmd);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let process = ManagedProcess::supervise(child);

    let deadline = Instant::now() + Duration::from_secs(8);
    for endpoint in &endpoints {
        loop {
            if let Ok(Ok(_)) = timeout(
                Duration::from_millis(150),
                TcpStream::connect(&endpoint.addr),
            )
            .await
            {
                break;
            }
            if !process.running() {
                return Err(format!(
                    "NaiveProxy exited during startup: {}",
                    process.err().unwrap_or_default()
                ));
            }
            if Instant::now() > deadline {
                let _ = process.stop().await;
                return Err("NaiveProxy did not open its local SOCKS listeners".into());
            }
            sleep(Duration::from_millis(100)).await;
        }
    }
    Ok((process, endpoints))
}

fn proxy_url(server: &ServerConfig) -> String {
    let host = if server.host.contains(':') {
        format!("[{}]", server.host)
    } else {
        server.host.clone()
    };
    format!(
        "https://{}:{}@{}:{}",
        escape_userinfo(&server.username),
        escape_userinfo(&server.password),
        host,
        server.port
    )
}

/// Percent-encodes a URL userinfo component the way Go's url.UserPassword
/// does: unreserved and sub-delims stay, everything else (including ':' and
/// '@') is escaped.
fn escape_userinfo(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~$&+,;=".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn reserve_ports(count: usize) -> std::io::Result<Vec<u16>> {
    // Hold every listener until all ports are picked so none repeat.
    let listeners = (0..count)
        .map(|_| TcpListener::bind("127.0.0.1:0"))
        .collect::<std::io::Result<Vec<_>>>()?;
    listeners
        .iter()
        .map(|l| l.local_addr().map(|a| a.port()))
        .collect()
}

impl ManagedProcess {
    pub fn supervise(mut child: Child) -> ManagedProcess {
        let pid = child.id().unwrap_or(0);
        let (tx, rx) = watch::channel(false);
        let err = Arc::new(Mutex::new(None));
        let err_slot = err.clone();
        tokio::spawn(async move {
            let result = child.wait().await;
            let message = match result {
                Ok(status) if status.success() => None,
                Ok(status) => Some(status.to_string()),
                Err(e) => Some(e.to_string()),
            };
            *err_slot.lock().unwrap() = message;
            let _ = tx.send(true);
        });
        ManagedProcess { pid, done: rx, err }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn err(&self) -> Option<String> {
        self.err.lock().unwrap().clone()
    }

    pub fn running(&self) -> bool {
        !*self.done.borrow()
    }

    /// Resolves once the process has exited.
    pub async fn wait(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d).await;
    }

    pub async fn stop(&self) -> Result<(), String> {
        if !self.running() {
            return Ok(());
        }
        if let Err(e) = crate::process::terminate_child(self.pid).await {
            if self.running() {
                return Err(e);
            }
            return Ok(());
        }
        if timeout(Duration::from_secs(5), self.wait()).await.is_err() {
            crate::process::kill_child(self.pid);
            let _ = timeout(Duration::from_secs(2), self.wait()).await;
        }
        Ok(())
    }
}

pub fn default_naive_path() -> PathBuf {
    let name = if cfg!(windows) { "naive.exe" } else { "naive" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_credentials_like_go() {
        assert_eq!(escape_userinfo("a:b@c/d?e"), "a%3Ab%40c%2Fd%3Fe");
        assert_eq!(escape_userinfo("x-._~$&+,;=y"), "x-._~$&+,;=y");
        assert_eq!(escape_userinfo("p ss%"), "p%20ss%25");
    }

    #[test]
    fn reserves_distinct_ports() {
        let ports = reserve_ports(4).unwrap();
        let unique: std::collections::HashSet<_> = ports.iter().collect();
        assert_eq!(unique.len(), 4);
    }
}
