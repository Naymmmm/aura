import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Auto-updater: checks the Worker's release meta, downloads the new zip,
/// verifies its sha256 (computed by the worker at upload time), extracts
/// into a staging dir, then swaps on quit via a detached script that
/// relaunches the new build.
class UpdateService {
  UpdateService({String? apiBase})
    : _apiBase = apiBase ?? 'https://api.copal.run';

  final String _apiBase;

  /// The version this build ships with (bump per release).
  static const appVersion = 'v0.3.0';

  /// Which release key this platform downloads.
  static String platformKey() => Platform.isMacOS ? 'latest-macos' : 'latest';

  static String _p(String dir, String name) =>
      '$dir${Platform.pathSeparator}$name';

  static Future<String> get _stageDir async {
    final support = await getApplicationSupportDirectory();
    return '${support.path}${Platform.pathSeparator}aura-update';
  }

  /// GET /v1/release/meta — returns the newer version string, or null.
  Future<String?> checkForUpdate() async {
    try {
      final resp = await http
          .get(Uri.parse('$_apiBase/v1/release/meta?key=${platformKey()}'))
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) return null;
      final j = jsonDecode(resp.body) as Map<String, dynamic>;
      final v = j['version'] as String?;
      if (v == null || v == appVersion) return null;
      return _newer(v, appVersion) ? v : null;
    } catch (_) {
      return null; // update checks must never break the app
    }
  }

  /// Downloads the release zip into the staging dir, verifies sha256
  /// against the worker's meta, extracts it. Returns the staging dir.
  Future<String> stage(String version) async {
    final dir = await _stageDir;
    if (await Directory(dir).exists()) {
      await Directory(dir).delete(recursive: true);
    }
    await Directory(dir).create(recursive: true);

    final metaResp = await http
        .get(Uri.parse('$_apiBase/v1/release/meta?key=${platformKey()}'))
        .timeout(const Duration(seconds: 15));
    if (metaResp.statusCode != 200) throw StateError('no release meta');
    final meta = jsonDecode(metaResp.body) as Map<String, dynamic>;
    final wantSha = (meta['sha256'] as String?) ?? '';
    if (wantSha.isEmpty) throw StateError('release meta has no sha256');

    final dl = await http
        .get(Uri.parse('$_apiBase/dl/${platformKey()}'))
        .timeout(const Duration(minutes: 5));
    if (dl.statusCode != 200) {
      throw StateError('download failed (${dl.statusCode})');
    }

    final gotSha = sha256.convert(dl.bodyBytes).toString();
    if (gotSha != wantSha) {
      await Directory(dir).delete(recursive: true);
      throw StateError('checksum mismatch — update refused');
    }

    // Extract the zip root (aura.exe+data+aura-core on Windows, aura.app on
    // macOS) into the staging dir; the swap happens on quit.
    final archive = ZipDecoder().decodeBytes(dl.bodyBytes);
    for (final f in archive) {
      if (!f.isFile) continue;
      final out = File('$dir${Platform.pathSeparator}${f.name}');
      await out.parent.create(recursive: true);
      await out.writeAsBytes(f.content as List<int>, flush: true);
    }
    return dir;
  }

  /// Spawns the swap-on-quit updater, then the app should exit itself.
  /// Windows: powershell waits for the exe to die, swaps, relaunches.
  /// macOS: root shell (osascript) waits for the pid, swaps the .app, relaunches.
  Future<void> applyAndRestart(String stageDir) async {
    if (Platform.isWindows) {
      final appDir = File(Platform.resolvedExecutable).parent.path;
      final script = File(_p(stageDir, 'updater.ps1'));
      await script.writeAsString(_winUpdater());
      await Process.start('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script.path,
        stageDir,
        appDir,
        Platform.resolvedExecutable,
      ], mode: ProcessStartMode.detachedWithStdio);
      return;
    }
    // macOS
    final bundleDir = Directory(
      Platform.resolvedExecutable,
    ).parent.parent.parent.path;
    final stagedApp = _p(stageDir, 'aura.app');
    final script = File(_p(stageDir, 'updater.sh'));
    await script.writeAsString(_macUpdater(bundleDir, stagedApp, pid));
    await Process.run('chmod', ['+x', script.path]);
    // run as root; the swap may target /Applications
    final osa =
        "do shell script \"sh ${_sh(script.path)}\" with administrator privileges";
    await Process.start('osascript', [
      '-e',
      osa,
    ], mode: ProcessStartMode.detachedWithStdio);
  }

  static String _winUpdater() {
    return r'''
param([string]$stage, [string]$appDir, [string]$exe)
$name = [IO.Path]::GetFileNameWithoutExtension($exe)
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Process -Name $name -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
# swap app dir contents (staging lives in the support dir, outside appDir)
Get-ChildItem $appDir | Remove-Item -Recurse -Force
Copy-Item (Join-Path $stage '*') $appDir -Recurse -Force
Start-Process $exe
''';
  }

  static String _macUpdater(String app, String stagedApp, int appPid) {
    return '''
#!/bin/sh
APP=${_sh(app)}
STAGE=${_sh(stagedApp)}
deadline=\$(( \$(date +%s) + 45 ))
while kill -0 $appPid 2>/dev/null && [ \$(date +%s) -lt \$deadline ]; do sleep 0.5; done
rm -rf "\$APP"
cp -R "\$STAGE" "\$APP"
rm -rf "\$(dirname "\$STAGE")"
open "\$APP" 2>/dev/null &
''';
  }

  /// POSIX single-quote for embedding in sh.
  static String _sh(String p) => "'${p.replaceAll("'", "'\\''")}'";

  /// 'v0.2.6' > 'v0.2.5'; falls back to plain string compare.
  static bool _newer(String a, String b) {
    final va = _parts(a);
    final vb = _parts(b);
    if (va == null || vb == null) return a.compareTo(b) > 0;
    for (var i = 0; i < 3; i++) {
      if (va[i] != vb[i]) return va[i] > vb[i];
    }
    return false;
  }

  static List<int>? _parts(String v) {
    final m = RegExp(r'^v?(\d+)\.(\d+)\.(\d+)').firstMatch(v);
    if (m == null) return null;
    return [for (var i = 1; i <= 3; i++) int.tryParse(m.group(i)!) ?? 0];
  }
}
