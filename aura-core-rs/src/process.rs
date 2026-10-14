use tokio::process::Command;

#[cfg(unix)]
pub fn configure_child(cmd: &mut Command) {
    cmd.process_group(0);
}

#[cfg(unix)]
pub async fn terminate_child(pid: u32) -> Result<(), String> {
    signal_group(pid, libc::SIGTERM)
}

#[cfg(unix)]
pub fn kill_child(pid: u32) {
    let _ = signal_group(pid, libc::SIGKILL);
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> Result<(), String> {
    if pid == 0 {
        return Err("process has no PID".into());
    }
    // SAFETY: kill(2) with a negative PID signals the child's own process
    // group, created by configure_child.
    if unsafe { libc::kill(-(pid as libc::pid_t), signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn configure_child(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// NaiveProxy is Chromium-based and may own subprocesses. Killing only the
/// parent can strand transport processes after disconnect or app exit.
#[cfg(windows)]
pub async fn terminate_child(pid: u32) -> Result<(), String> {
    let mut cmd = Command::new("taskkill.exe");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    configure_child(&mut cmd);
    let status = cmd.status().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill: {status}"))
    }
}

#[cfg(windows)]
pub fn kill_child(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::naive::ManagedProcess;
    use std::time::Duration;

    #[tokio::test]
    async fn stop_kills_process_group() {
        let dir = std::env::temp_dir().join(format!("aura-core-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let child_file = dir.join("child.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo $! > \"$1\"; wait", "sh"])
            .arg(&child_file);
        configure_child(&mut cmd);
        let process = ManagedProcess::supervise(cmd.spawn().unwrap());

        let mut child_pid = 0;
        for _ in 0..200 {
            if let Ok(raw) = std::fs::read_to_string(&child_file) {
                child_pid = raw.trim().parse().unwrap_or(0);
                if child_pid > 0 {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(child_pid > 0, "child process did not start");
        process.stop().await.unwrap();
        assert!(!process.running());
        // On macOS the orphaned child can linger briefly as a zombie until
        // launchd reaps it.
        for _ in 0..300 {
            if unsafe { libc::kill(child_pid, 0) } != 0 {
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("child process {child_pid} survived process-group shutdown");
    }
}
