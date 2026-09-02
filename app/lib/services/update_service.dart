import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Authenticated desktop updater. Windows stages and swaps a zip; macOS
/// launches a detached AppleScript that fetches the DMG, verifies it, installs
/// it with one administrator prompt, relaunches Aura, and posts a notification.
class UpdateService {
  UpdateService({String? apiBase, http.Client? client, String? stageDirectory})
    : _apiBase = apiBase ?? 'https://api.copal.run',
      _client = client ?? http.Client(),
      _stageDirectoryOverride = stageDirectory;

  final String _apiBase;
  final http.Client _client;
  final String? _stageDirectoryOverride;

  /// The version this build ships with (bump per release).
  static const appVersion = 'v26.0.1';

  /// Which release key this platform downloads.
  static String platformKey() => Platform.isMacOS ? 'latest-macos' : 'latest';

  static String _p(String dir, String name) =>
      '$dir${Platform.pathSeparator}$name';

  Future<String> get _stageDir async {
    if (_stageDirectoryOverride != null) return _stageDirectoryOverride;
    final support = await getApplicationSupportDirectory();
    return '${support.path}${Platform.pathSeparator}aura-update';
  }

  /// GET /v1/release/meta — returns the newer version string, or null.
  Future<String?> checkForUpdate() async {
    try {
      final resp = await _client
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
  Future<String> stage(
    String version, {
    required String authToken,
    String? legacyAccountId,
  }) async {
    final dir = await _stageDir;
    if (await Directory(dir).exists()) {
      await Directory(dir).delete(recursive: true);
    }
    await Directory(dir).create(recursive: true);

    final metaResp = await _client
        .get(Uri.parse('$_apiBase/v1/release/meta?key=${platformKey()}'))
        .timeout(const Duration(seconds: 15));
    if (metaResp.statusCode != 200) throw StateError('no release meta');
    final meta = jsonDecode(metaResp.body) as Map<String, dynamic>;
    final wantSha = (meta['sha256'] as String?) ?? '';
    if (wantSha.isEmpty) throw StateError('release meta has no sha256');

    if (Platform.isMacOS) {
      await File(_p(dir, 'mac-update.json')).writeAsString(
        jsonEncode({
          'version': version,
          'sha256': wantSha,
          'auth_token': authToken,
          'legacy_account_id': ?legacyAccountId,
        }),
        flush: true,
      );
      return dir;
    }

    final dl = await _client
        .get(
          Uri.parse('$_apiBase/dl/${platformKey()}'),
          headers: {
            'authorization': 'Bearer $authToken',
            'x-aura-account-id': ?legacyAccountId,
          },
        )
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
    // macOS: all network and install work is owned by osascript after Aura
    // exits, so filtered/slow downloads cannot freeze the Flutter process.
    final bundleDir = Directory(
      Platform.resolvedExecutable,
    ).parent.parent.parent.path;
    final metadata =
        jsonDecode(await File(_p(stageDir, 'mac-update.json')).readAsString())
            as Map<String, dynamic>;
    final script = File(_p(stageDir, 'updater.applescript'));
    await script.writeAsString(
      macUpdaterScript(
        appBundle: bundleDir,
        appPid: pid,
        authToken: metadata['auth_token'] as String,
        legacyAccountId: metadata['legacy_account_id'] as String?,
        version: metadata['version'] as String,
        sha256: metadata['sha256'] as String,
      ),
    );
    await Process.start('osascript', [
      script.path,
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

  static String macUpdaterScript({
    required String appBundle,
    required int appPid,
    required String authToken,
    String? legacyAccountId,
    required String version,
    required String sha256,
  }) {
    final shell =
        '''
set -eu
APP=${_sh(appBundle)}
TMP=\$(mktemp -d /tmp/aura-update.XXXXXX)
MOUNT=
cleanup() {
  if [ -n "\$MOUNT" ]; then hdiutil detach "\$MOUNT" -quiet 2>/dev/null || true; fi
  rm -rf "\$TMP"
}
trap cleanup EXIT INT TERM
deadline=\$(( \$(date +%s) + 60 ))
while kill -0 $appPid 2>/dev/null && [ \$(date +%s) -lt \$deadline ]; do sleep 0.5; done
/usr/bin/curl --fail --location --retry 4 --retry-all-errors \\
  -H ${_sh('Authorization: Bearer $authToken')} \\
  ${legacyAccountId == null ? '' : '-H ${_sh('X-Aura-Account-Id: $legacyAccountId')} \\\n  '}-o "\$TMP/Aura.dmg" ${_sh('$_apiBasePlaceholder/dl/latest-macos')}
actual=\$(/usr/bin/shasum -a 256 "\$TMP/Aura.dmg" | /usr/bin/awk '{print \$1}')
[ "\$actual" = ${_sh(sha256)} ] || { echo 'Aura update checksum mismatch' >&2; exit 9; }
MOUNT=\$(hdiutil attach "\$TMP/Aura.dmg" -nobrowse -readonly | /usr/bin/awk 'END {print \$3}')
NEW_APP=\$(/usr/bin/find "\$MOUNT" -maxdepth 1 -name '*.app' -print -quit)
[ -n "\$NEW_APP" ] || { echo 'Aura.app missing from DMG' >&2; exit 10; }
rm -rf "\$APP"
/usr/bin/ditto "\$NEW_APP" "\$APP"
/usr/bin/xattr -dr com.apple.quarantine "\$APP" 2>/dev/null || true
/usr/bin/open "\$APP"
'''
            .replaceAll(_apiBasePlaceholder, 'https://api.copal.run');
    return '''
set updateCommand to "${_appleScriptQuote(shell)}"
do shell script updateCommand with administrator privileges
display notification "Aura $version is installed and ready." with title "Aura updated"
''';
  }

  static const _apiBasePlaceholder = '__AURA_API_BASE__';

  /// POSIX single-quote for embedding in sh.
  static String _sh(String p) => "'${p.replaceAll("'", "'\\''")}'";

  static String _appleScriptQuote(String value) =>
      value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

  /// 'v0.2.4' > 'v0.2.3'; falls back to plain string compare.
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
