import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Client and one-time installer for the privileged aura-core helper.
///
/// The desktop UI never launches or kills the tunnel engine itself. Once the
/// helper is installed, all lifecycle operations use this authenticated,
/// loopback-only API and therefore never trigger another UAC/password prompt.
class AuraCoreManager {
  AuraCoreManager._();

  static const version = '26.1.0';
  static const _port = 45873;
  static String? _dir;
  static String? _token;

  static Future<String> get dir async {
    if (_dir != null) return _dir!;
    final support = await getApplicationSupportDirectory();
    _dir = '${support.path}${Platform.pathSeparator}aura-core';
    return _dir!;
  }

  static String _p(String parent, String child) =>
      '$parent${Platform.pathSeparator}$child';

  static Future<void> start({required String configDir}) async {
    await _ensureReady();
    final config = await File(_p(configDir, 'config.json')).readAsString();
    final response = await _request(
      'POST',
      '/v1/start',
      body: jsonEncode({'config': jsonDecode(config)}),
    );
    if (response.statusCode != 200) {
      throw StateError(_errorFrom(response, 'aura-core could not start'));
    }
  }

  static Future<void> stop({required String configDir}) async {
    if (!await _healthy()) return;
    final response = await _request('POST', '/v1/stop');
    if (response.statusCode != 200) {
      throw StateError(_errorFrom(response, 'aura-core could not stop'));
    }
  }

  static Future<String> recentLog(String configDir) async {
    if (!await _healthy()) return 'aura-core is not running';
    final response = await _request('GET', '/v1/log');
    if (response.statusCode != 200) {
      return _errorFrom(response, 'log unavailable');
    }
    final value = jsonDecode(response.body) as Map<String, dynamic>;
    return value['log'] as String? ?? '';
  }

  static Future<bool> get isEngineRunning async {
    return (await status)?.running ?? false;
  }

  static Future<AuraCoreStats?> get stats async {
    try {
      final response = await _request(
        'GET',
        '/v1/stats',
      ).timeout(const Duration(seconds: 3));
      if (response.statusCode != 200) return null;
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      final rawLatencies = body['latencies'] as Map<String, dynamic>? ?? {};
      return AuraCoreStats(
        running: body['running'] as bool? ?? false,
        activeServer: body['active_server'] as String?,
        latencies: rawLatencies.map(
          (key, value) => MapEntry(key, (value as num).toInt()),
        ),
        uploadTotal: (body['upload_total'] as num?)?.toInt() ?? 0,
        downloadTotal: (body['download_total'] as num?)?.toInt() ?? 0,
        lastError: body['last_error'] as String?,
      );
    } catch (_) {
      return null;
    }
  }

  static Future<String?> waitForActive(Duration timeout) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      final value = await stats;
      if (value?.running == true && value!.activeServer?.isNotEmpty == true) {
        return value.activeServer;
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    return null;
  }

  static Future<void> _ensureReady() async {
    final d = await dir;
    await Directory(d).create(recursive: true);
    await _ensureToken(d);
    if (await _compatible()) return;
    await _wakeExisting();
    for (var i = 0; i < 8; i++) {
      if (await _compatible()) return;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    if (await _healthy()) {
      // An older helper may still own the engine. Stop it cleanly before the
      // platform installer replaces the supervisor process.
      try {
        await _request('POST', '/v1/stop');
      } catch (_) {}
    }
    await _install(d);
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (DateTime.now().isBefore(deadline)) {
      if (await _compatible()) return;
      await Future<void>.delayed(const Duration(milliseconds: 350));
    }
    String detail;
    try {
      detail = await recentLog(d);
    } catch (_) {
      detail = 'aura-core is not reachable';
    }
    throw StateError(
      'aura-core helper did not come online after setup\n$detail',
    );
  }

  static Future<void> _ensureToken(String d) async {
    final file = File(_p(d, 'api.token'));
    if (await file.exists()) {
      final existing = (await file.readAsString()).trim();
      if (existing.length >= 32) {
        _token = existing;
        return;
      }
    }
    final random = Random.secure();
    final token = List.generate(
      32,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    await file.writeAsString(token, flush: true);
    _token = token;
    if (Platform.isMacOS) await Process.run('chmod', ['600', file.path]);
  }

  static Future<bool> _healthy() async {
    return await status != null;
  }

  static Future<bool> _compatible() async {
    return (await status)?.version == version;
  }

  static Future<AuraCoreStatus?> get status async {
    try {
      final response = await _request(
        'GET',
        '/v1/status',
      ).timeout(const Duration(milliseconds: 900));
      if (response.statusCode != 200) return null;
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      return AuraCoreStatus(
        version: body['version'] as String? ?? '',
        running: body['running'] as bool? ?? false,
        lastError: body['last_error'] as String?,
      );
    } catch (_) {
      return null;
    }
  }

  static Future<http.Response> _request(
    String method,
    String path, {
    String? body,
  }) async {
    final d = await dir;
    final token = _token ??= (await File(
      _p(d, 'api.token'),
    ).readAsString()).trim();
    final request = http.Request(
      method,
      Uri.parse('http://127.0.0.1:$_port$path'),
    );
    request.headers['Authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = body;
    }
    final client = http.Client();
    try {
      final streamed = await client
          .send(request)
          .timeout(requestTimeoutFor(method, path));
      return await http.Response.fromStream(streamed);
    } finally {
      client.close();
    }
  }

  static Duration requestTimeoutFor(String method, String path) {
    if (method == 'POST' && path == '/v1/start') {
      return const Duration(seconds: 20);
    }
    return const Duration(seconds: 8);
  }

  static Future<void> _install(String stateDir) async {
    final bundle = _bundleDir();
    if (!await Directory(bundle).exists()) {
      throw StateError('aura-core is missing from this build — reinstall Aura');
    }
    if (Platform.isWindows) {
      await _installWindows(bundle, stateDir);
    } else if (Platform.isMacOS) {
      await _installMac(bundle, stateDir);
    } else {
      throw UnsupportedError('Aura currently supports Windows and macOS');
    }
  }

  /// A crashed/stopped helper can normally be restarted without elevation.
  /// Installation is only the fallback for first run or a version upgrade.
  static Future<void> _wakeExisting() async {
    try {
      if (Platform.isWindows) {
        await Process.run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Start-ScheduledTask -TaskName 'Aura Core Helper' -ErrorAction Stop",
        ]);
      } else if (Platform.isMacOS) {
        await Process.run('launchctl', [
          'kickstart',
          'system/com.copal.aura.core',
        ]);
      }
    } catch (_) {
      // Missing helper is the expected first-run case; installer handles it.
    }
  }

  static String _bundleDir() =>
      _p(Directory(Platform.resolvedExecutable).parent.path, 'aura-core');

  static Future<void> _installWindows(String bundle, String stateDir) async {
    final script = File(_p(stateDir, 'install-helper.ps1'));
    await script.writeAsString(windowsInstallerScript(bundle, stateDir));
    final result = await Process.run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script.path,
    ]);
    if (result.exitCode != 0) {
      throw StateError(
        'helper setup was cancelled or failed: ${result.stderr}',
      );
    }
  }

  static Future<void> _installMac(String bundle, String stateDir) async {
    final script = File(_p(stateDir, 'install-helper.sh'));
    await script.writeAsString(_macInstaller(bundle, stateDir));
    await Process.run('chmod', ['700', script.path]);
    final command = 'sh ${_sh(script.path)}';
    final appleScript =
        'do shell script "${_appleScriptQuote(command)}" with administrator privileges';
    final result = await Process.run('osascript', ['-e', appleScript]);
    if (result.exitCode != 0) {
      throw StateError(
        'helper setup was cancelled or failed: ${result.stderr}',
      );
    }
  }

  static String windowsInstallerScript(String bundle, String stateDir) {
    final source = _ps(bundle);
    final state = _ps(stateDir);
    return r'''
$resultFile = Join-Path $PSScriptRoot 'install-result.log'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
  try {
    $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'))
  } catch { Write-Error "Administrator approval failed: $_"; exit 2 }
  if ($p.ExitCode -ne 0) {
    $detail = if (Test-Path -LiteralPath $resultFile) { Get-Content -Raw -LiteralPath $resultFile } else { "Elevated helper installer exited with code $($p.ExitCode)" }
    Write-Error $detail
  }
  exit $p.ExitCode
}
$ErrorActionPreference = 'Stop'
try {
$source = @@SOURCE@@
$state = @@STATE@@
$install = Join-Path $env:ProgramFiles 'Aura Core'
$runtime = Join-Path $env:ProgramData 'Aura Core'
$taskName = 'Aura Core Helper'
$installedCore = Join-Path $install 'aura-core.exe'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $install | Out-Null
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
& icacls.exe $runtime /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue | Stop-Process -Force
# Stop-Process returns immediately while Windows may still hold the exe;
# wait for the helper to fully exit before touching the install folder.
$auraStopDeadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $auraStopDeadline) {
  Start-Sleep -Milliseconds 300
}
# The exe can stay briefly locked after exit; retry the removal before giving up.
$auraCleared = $false
for ($i = 0; $i -lt 5 -and -not $auraCleared; $i++) {
  try {
    Get-ChildItem $install -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction Stop
    $auraCleared = $true
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (-not $auraCleared) { throw 'could not clear $install after stopping the Aura helper' }
Copy-Item (Join-Path $source '*') $install -Recurse -Force
$token = Join-Path $state 'api.token'
$arguments = 'serve --state-dir "' + $runtime + '" --token-file "' + $token + '"'
$action = New-ScheduledTaskAction -Execute $installedCore -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$online = $false
for ($i = 0; $i -lt 40 -and -not $online; $i++) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', 45873)
    $client.Close()
    $online = $true
  } catch {
    Start-Sleep -Milliseconds 250
  }
}
if (-not $online) {
  $helperLog = Join-Path $runtime 'helper.log'
  $detail = if (Test-Path -LiteralPath $helperLog) { Get-Content -Raw -LiteralPath $helperLog } else { 'aura-core did not open its API port after install' }
  Set-Content -LiteralPath $resultFile -Value $detail
  exit 1
}
Set-Content -LiteralPath $resultFile -Value 'ok'
} catch {
  Set-Content -LiteralPath $resultFile -Value ($_ | Out-String)
  exit 1
}
'''
        .replaceAll('@@SOURCE@@', source)
        .replaceAll('@@STATE@@', state);
  }

  static String _macInstaller(String bundle, String stateDir) {
    final source = _sh(bundle);
    final token = _xml(_p(stateDir, 'api.token'));
    return r'''
#!/bin/sh
set -eu
SOURCE=@@SOURCE@@
INSTALL=/Library/PrivilegedHelperTools/com.copal.aura.core
RUNTIME='/Library/Application Support/Aura Core'
PLIST=/Library/LaunchDaemons/com.copal.aura.core.plist
launchctl bootout system/com.copal.aura.core 2>/dev/null || true
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
mkdir -p "$RUNTIME"
chown root:wheel "$RUNTIME"
chmod 700 "$RUNTIME"
cp -R "$SOURCE"/. "$INSTALL"/
chmod 755 "$INSTALL/aura-core" "$INSTALL/naive"
chown -R root:wheel "$INSTALL"
xattr -dr com.apple.quarantine "$INSTALL" 2>/dev/null || true
cat > "$PLIST" <<'AURA_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.copal.aura.core</string>
  <key>ProgramArguments</key><array>
    <string>/Library/PrivilegedHelperTools/com.copal.aura.core/aura-core</string>
    <string>serve</string><string>--state-dir</string><string>/Library/Application Support/Aura Core</string>
    <string>--token-file</string><string>@@TOKEN@@</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/var/log/aura-core.log</string>
  <key>StandardErrorPath</key><string>/var/log/aura-core.log</string>
</dict></plist>
AURA_PLIST
chmod 644 "$PLIST"
chown root:wheel "$PLIST"
launchctl bootstrap system "$PLIST"
'''
        .replaceAll('@@SOURCE@@', source)
        .replaceAll('@@TOKEN@@', token);
  }

  static String _errorFrom(http.Response response, String fallback) {
    try {
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      return body['error'] as String? ?? fallback;
    } catch (_) {
      return '$fallback (${response.statusCode})';
    }
  }

  static String _ps(String value) => "'${value.replaceAll("'", "''")}'";
  static String _sh(String value) => "'${value.replaceAll("'", "'\\''")}'";
  static String _xml(String value) => value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  static String _appleScriptQuote(String value) =>
      value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

class AuraCoreStatus {
  const AuraCoreStatus({
    required this.version,
    required this.running,
    this.lastError,
  });

  final String version;
  final bool running;
  final String? lastError;
}

class AuraCoreStats {
  const AuraCoreStats({
    required this.running,
    required this.activeServer,
    required this.latencies,
    required this.uploadTotal,
    required this.downloadTotal,
    this.lastError,
  });

  final bool running;
  final String? activeServer;
  final Map<String, int> latencies;
  final int uploadTotal;
  final int downloadTotal;
  final String? lastError;
}
