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
      // -Verb RunAs triggers the UAC prompt; -PassThru gives us the elevated PID.
      return r'''
param([string]$Dir)
$exe = Join-Path $Dir 'sing-box.exe'
if (-not (Test-Path $exe)) { Write-Error "sing-box.exe not found: $exe"; exit 1 }
$p = Start-Process -FilePath $exe `
  -ArgumentList @('run','-D',"$Dir",'-c',(Join-Path $Dir 'config.json')) `
  -WorkingDirectory $Dir -Verb RunAs -WindowStyle Hidden -PassThru
if ($null -eq $p) { Write-Error 'UAC cancelled or failed'; exit 2 }
# -Verb RunAs can hand back the shell's pid, not sing-box's — resolve the real one.
Start-Sleep -Milliseconds 500
$real = Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue |
  Sort-Object StartTime -Descending | Select-Object -First 1
$pidToWrite = if ($real) { $real.Id } else { $p.Id }
$pidToWrite | Out-File -Encoding ascii (Join-Path $Dir 'sing-box.pid')
Write-Output "started $pidToWrite"
''';
    }
    // macOS: use a fully-expanded, quoted command. The previous script was
    // copied from the PowerShell path and left `$Dir` literal in AppleScript,
    // so macOS tried to launch from a directory named "$Dir".
    final q = _shellQuote(dir);
    final command =
        'cd $q && nohup ./sing-box run -D $q -c $q/config.json '
        '> $q/sing-box.log 2>&1 & echo \$! > $q/sing-box.pid';
    return 'do shell script ${_appleScriptString(command)} '
        'with administrator privileges';
  }

  static String stopScript(String dir) {
    if (Platform.isWindows) {
      return r'''
param([string]$Dir)
$pidFile = Join-Path $Dir 'sing-box.pid'
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
# Kill by image name: pid bookkeeping can miss the real (child) process.
Start-Process taskkill -ArgumentList @('/IM','sing-box.exe','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait
''';
    }
    final q = _shellQuote(dir);
    final command =
        'if [ -f $q/sing-box.pid ]; then kill "\$(cat $q/sing-box.pid)" '
        '2>/dev/null || true; fi; rm -f $q/sing-box.pid';
    return 'do shell script ${_appleScriptString(command)} '
        'with administrator privileges';
  }

  /// A POSIX shell word, safe for a path controlled by the app sandbox.
  static String _shellQuote(String value) =>
      "'${value.replaceAll("'", "'\"'\"'")}'";

  /// A double-quoted AppleScript string literal.
  static String _appleScriptString(String value) =>
      '"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"';

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
