import 'dart:io';

import 'package:flutter/foundation.dart';

/// Platform elevation glue.
///
/// sing-box needs admin/root for TUN. The app stays unelevated; only the
/// core elevates (UAC on Windows, osascript on macOS). Scripts are written
/// into the writable support dir to dodge shell-quoting hell.
class Elevation {
  Elevation._();

  /// Returns the elevated-start/stop script contents for this platform.
  /// Scripts are written next to the sing-box dir by [SingboxManager].
  static String startScript(String dir) {
    if (Platform.isWindows) {
      // Elevate this script once, then validate the config, retire only our
      // previous PID, start the core, and prove it survived startup. Running
      // sing-box directly with -Verb RunAs returned before early core exits,
      // which made the app misleadingly say it had started.
      return r'''
param([string]$Dir, [switch]$Elevated)

if (-not $Elevated) {
  $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    $PSCommandPath.Replace('"', '""') + '" -Dir "' +
    $Dir.Replace('"', '""') + '" -Elevated'
  try {
    $admin = Start-Process powershell.exe -ArgumentList $argLine `
      -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $admin.ExitCode
  } catch {
    Write-Error "Administrator approval was cancelled or failed: $_"
    exit 2
  }
}

$exe = Join-Path $Dir 'sing-box.exe'
if (-not (Test-Path $exe)) { Write-Error "sing-box.exe not found: $exe"; exit 1 }
$config = Join-Path $Dir 'config.json'
$pidFile = Join-Path $Dir 'sing-box.pid'
$logFile = Join-Path $Dir 'sing-box.log'

# Stop only the process recorded by Aura, and only when its executable path
# matches this installation. Never taskkill every sing-box instance.
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($oldPid -match '^\d+$') {
    $old = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
    if ($old -and $old.Path -eq $exe) { Stop-Process -Id ([int]$oldPid) -Force }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$check = & $exe check -D $Dir -c $config 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "sing-box config check failed: $check"
  exit 3
}

$quotedDir = '"' + $Dir + '"'
$quotedConfig = '"' + $config + '"'
$p = Start-Process -FilePath $exe `
  -ArgumentList @('run','-D',$quotedDir,'-c',$quotedConfig) `
  -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
$p.Id | Out-File -Encoding ascii $pidFile
Start-Sleep -Milliseconds 1200
$p.Refresh()
if ($p.HasExited) {
  $tail = if (Test-Path $logFile) { Get-Content $logFile -Tail 20 } else { 'no log created' }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Error "sing-box exited during startup ($($p.ExitCode)): $tail"
  exit 4
}
Write-Output "started $($p.Id)"
''';
    }
    // macOS: shell scripts written next to the config (real paths baked in at
    // write time); osascript runs them as root. AppleScript does not
    // interpolate shell variables, so paths must never be passed through
    // "do shell script" as $VARS — they die the same way every one of these
    // posts ends up broken.
    return macLaunchScript(dir);
  }

  static String stopScript(String dir) {
    if (Platform.isWindows) {
      return r'''
param([string]$Dir, [switch]$Elevated)

if (-not $Elevated) {
  $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    $PSCommandPath.Replace('"', '""') + '" -Dir "' +
    $Dir.Replace('"', '""') + '" -Elevated'
  try {
    $admin = Start-Process powershell.exe -ArgumentList $argLine `
      -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $admin.ExitCode
  } catch {
    Write-Error "Administrator approval was cancelled or failed: $_"
    exit 2
  }
}

$pidFile = Join-Path $Dir 'sing-box.pid'
$exe = Join-Path $Dir 'sing-box.exe'
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($oldPid -match '^\d+$') {
    $old = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
    if ($old -and $old.Path -eq $exe) { Stop-Process -Id ([int]$oldPid) -Force }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
''';
    }
    return macStopScript(dir);
  }

  /// macOS launch script content (written to the support dir, run as root).
  static String macLaunchScript(String dir) {
    final d = _sh(dir);
    return '''
#!/bin/sh
cd $d || exit 1
./sing-box run -D $d -c $d/config.json </dev/null > $d/sing-box.log 2>&1 &
echo \$! > $d/sing-box.pid
''';
  }

  /// macOS stop script content (written to the support dir, run as root).
  static String macStopScript(String dir) {
    final d = _sh(dir);
    return '''
#!/bin/sh
if [ -f $d/sing-box.pid ]; then
  kill \$(cat $d/sing-box.pid) 2>/dev/null
  rm -f $d/sing-box.pid
fi
''';
  }

  /// POSIX single-quote a path for embedding in sh.
  static String _sh(String p) => "'${p.replaceAll("'", "'\\''")}'";

  /// Run a support-dir shell script as root via osascript.
  static Future<ProcessResult> runMacScript(String scriptPath) async {
    final s = _sh(scriptPath);
    return Process.run(
        'osascript', ['-e', 'do shell script "sh $s" with administrator privileges']);
  }

  static Future<bool> isElevated() async {
    if (Platform.isWindows) {
      final r = await Process.run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        r'([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ]);
      return r.exitCode == 0 && (r.stdout as String).trim() == 'True';
    }
    if (Platform.isMacOS) {
      final r = await Process.run('id', ['-u']);
      return r.exitCode == 0 && (r.stdout as String).trim() == '0';
    }
    return false;
  }

  /// Runs [script] elevated. [scriptPath] is where we wrote it.
  static Future<ProcessResult> runScript(String scriptPath, List<String> args) async {
    debugPrint('Elevation.runScript: $scriptPath $args');
    if (Platform.isWindows) {
      return Process.run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...args,
      ]);
    }
    // macOS: osascript -e with an AppleScript arg; args are baked in at write time.
    return Process.run('osascript', ['-e', args.join(' ')]);
  }
}
