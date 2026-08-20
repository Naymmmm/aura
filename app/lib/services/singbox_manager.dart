import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'elevation.dart';

/// Manages the sing-box core lifecycle: ensures the binary is in the
/// writable support dir, then starts/stops it elevated.
class SingboxManager {
  SingboxManager._();

  static const version = '1.13.15';

  static String? _dir;

  static Future<String> get dir async {
    if (_dir != null) return _dir!;
    final support = await getApplicationSupportDirectory();
    _dir = '${support.path}${Platform.pathSeparator}sing-box';
    return _dir!;
  }

  static String _p(String dir, String name) =>
      '$dir${Platform.pathSeparator}$name';

  /// First run: copy the bundled sing-box (next to the exe) into the support
  /// dir so config/log paths live in a writable location.
  static Future<void> ensureBinary() async {
    final d = await dir;
    final exeName = Platform.isWindows ? 'sing-box.exe' : 'sing-box';
    final installed = File(_p(d, exeName));
    if (installed.existsSync()) {
      if (Platform.isMacOS) await Process.run('chmod', ['755', installed.path]);
      return;
    }

    await Directory(d).create(recursive: true);
    final bundleDir = _bundleDir();
    if (bundleDir == null || !Directory(bundleDir).existsSync()) {
      throw StateError('sing-box not bundled next to the app — run '
          'app/tool/fetch_singbox.ps1 (dev) or use a release zip');
    }
    for (final f in Directory(bundleDir).listSync()) {
      if (f is File) f.copySync(_p(d, f.uri.pathSegments.last));
    }
    if (Platform.isMacOS) {
      // File.copy copies bytes, not the executable bit. Without this, the
      // privileged shell reports success but cannot start the bundled core.
      final chmod = await Process.run('chmod', ['755', _p(d, exeName)]);
      if (chmod.exitCode != 0) {
        throw StateError('could not make sing-box executable: ${chmod.stderr}');
      }
    }
    // Mark the dir with its version so future upgrades re-copy.
    File(_p(d, 'version')).writeAsStringSync(version);
  }

  /// The bundled sing-box dir lives next to the app executable.
  static String? _bundleDir() {
    final exe = Platform.resolvedExecutable;
    final dir = Directory(exe).parent.path;
    final candidate = _p(dir, 'sing-box');
    return Directory(candidate).existsSync() ? candidate : null;
  }

  /// Start sing-box elevated. Returns the command result.
  static Future<ProcessResult> start({required String configDir}) async {
    await ensureBinary();
    final d = configDir;
    final exe = _p(d, Platform.isWindows ? 'sing-box.exe' : 'sing-box');
    final args = ['run', '-D', d, '-c', _p(d, 'config.json')];

    if (await Elevation.isElevated()) {
      // Already elevated: run directly.
      return Process.run(exe, args);
    }
    if (Platform.isWindows) {
      final script = File(_p(d, 'elevate-start.ps1'));
      await script.writeAsString(Elevation.startScript(d));
      return Elevation.runScript(script.path, ['-Dir', d]);
    }
    final osa = Elevation.startScript(d);
    return Process.run('osascript', ['-e', osa]);
  }

  /// Stop sing-box (elevated taskkill).
  static Future<ProcessResult> stop({required String configDir}) async {
    final d = configDir;
    if (Platform.isWindows) {
      if (await Elevation.isElevated()) {
        final pidFile = File(_p(d, 'sing-box.pid'));
        if (await pidFile.exists()) {
          final pid = int.tryParse((await pidFile.readAsString()).trim());
          if (pid != null) await Process.run('taskkill', ['/PID', '$pid', '/T', '/F']);
          await pidFile.delete();
        }
        return ProcessResult(0, 0, '', '');
      }
      final script = File(_p(d, 'elevate-stop.ps1'));
      await script.writeAsString(Elevation.stopScript(d));
      return Elevation.runScript(script.path, ['-Dir', d]);
    }
    final osa = Elevation.stopScript(d);
    return Process.run('osascript', ['-e', osa]);
  }

  static Future<bool> isRunning(String configDir) async {
    final pidFile = File(_p(configDir, 'sing-box.pid'));
    if (!await pidFile.exists()) return false;
    final pid = int.tryParse((await pidFile.readAsString()).trim());
    if (pid == null) return false;
    if (Platform.isWindows) {
      final r = await Process.run('tasklist', ['/FI', 'PID eq $pid', '/NH']);
      return (r.stdout as String).trim().isNotEmpty;
    }
    final r = await Process.run('kill', ['-0', '$pid']);
    return r.exitCode == 0;
  }

  static Future<String> recentLog(String configDir) async {
    final file = File(_p(configDir, 'sing-box.log'));
    if (!await file.exists()) return 'no sing-box log was created';
    final text = await file.readAsString();
    final lines =
        text.split(RegExp(r'\r?\n')).where((line) => line.isNotEmpty).toList();
    return lines.length <= 12
        ? lines.join('\n')
        : lines.sublist(lines.length - 12).join('\n');
  }
}
