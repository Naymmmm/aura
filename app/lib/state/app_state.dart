import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/server_info.dart';
import '../services/clash_api.dart';
import '../services/config_generator.dart';
import '../services/session_service.dart';
import '../services/singbox_manager.dart';
import '../services/usage_tracker.dart';

enum VpnPhase { loggedOut, disconnected, fetchingConfig, connecting, connected, error }

/// Central app state: login → connect/disconnect flow, live stats, log sink.
class AppState extends ChangeNotifier {
  AppState({SessionService? sessionService})
      : _sessionService = sessionService ?? SessionService();

  final SessionService _sessionService;
  final ClashApi _clash = ClashApi();

  VpnPhase _phase = VpnPhase.loggedOut;
  VpnPhase get phase => _phase;

  SessionInfo? _session; // last open session (config + temp creds)
  bool _sessionOpen = false; // false once we closed/expired it server-side
  Timer? _heartbeatTimer;

  AuthErrorKind? _authError;
  AuthErrorKind? get authError => _authError;

  ServerConfig? get serverConfig => _session?.config;

  String? _activeServer;
  String? get activeServer => _activeServer;

  final Map<String, int> _latencies = {};
  Map<String, int> get latencies => Map.unmodifiable(_latencies);

  int _upBytes = 0;
  int _downBytes = 0;
  int get upBytes => _upBytes;
  int get downBytes => _downBytes;

  String? _statusLine;
  String? get statusLine => _statusLine;

  final List<String> _logs = [];
  List<String> get logs => List.unmodifiable(_logs);

  final UsageTracker _usage = UsageTracker();
  int _budgetBytes = 0; // 0 = no budget configured (config not loaded yet)
  int _monthUsed = 0;
  int _pendingUsage = 0;
  int _pollTick = 0;
  int _prevUp = 0;
  int _prevDown = 0;

  /// Bytes used this calendar month (persisted across sessions).
  int get monthUsed => _monthUsed;

  /// Monthly budget in bytes (0 = not configured).
  int get budgetBytes => _budgetBytes;

  /// 0.0 → 1.0 share of the monthly budget used.
  double get budgetFraction => _budgetBytes > 0 ? _monthUsed / _budgetBytes : 0;

  bool get budgetWarn => _budgetBytes > 0 && budgetFraction >= 0.8 && !overBudget;
  bool get overBudget => _budgetBytes > 0 && _monthUsed >= _budgetBytes;

  Timer? _statsTimer;
  String? _clashSecret;

  static String _ts() => DateTime.now().toIso8601String().substring(11, 19);

  void _log(String line) {
    _logs.insert(0, '${_ts()} $line');
    if (_logs.length > 500) _logs.removeLast();
    notifyListeners();
  }

  void setPhase(VpnPhase p) {
    _phase = p;
    notifyListeners();
  }

  /// Saved account creds from disk (for login-view prefill).
  Future<({String accountId, String token})?> savedCreds() => _sessionService.saved();

  /// Restore a saved login, if any. Call once before runApp.
  Future<void> init() async {
    if (await _sessionService.hasSaved()) {
      setPhase(VpnPhase.disconnected);
      _log('welcome back — account found on disk');
    } else {
      setPhase(VpnPhase.loggedOut);
    }
  }

  /// Opens a session with account creds; on success the app is ready to
  /// connect. remember=false skips persisting the creds (and wipes any
  /// saved ones). Failures land in [authError] for the login view.
  Future<bool> login(String accountId, String token, {bool remember = true}) async {
    _authError = null;
    try {
      _session = await _sessionService.openSession(accountId, token, remember: remember);
      _sessionOpen = true;
      _log('session opened for $accountId');
      setPhase(VpnPhase.disconnected);
      return true;
    } on SessionException catch (e) {
      _authError = e.kind;
      _session = null;
      _sessionOpen = false;
      setPhase(VpnPhase.loggedOut);
      return false;
    }
  }

  /// Forget the account and go back to the login gate.
  Future<void> logout() async {
    await disconnect();
    await _sessionService.forget();
    _session = null;
    _sessionOpen = false;
    _authError = null;
    setPhase(VpnPhase.loggedOut);
    _log('logged out');
  }

  Future<bool> connect() async {
    if (_phase == VpnPhase.connected || _phase == VpnPhase.connecting) return false;
    if (_session == null && !_sessionOpen) {
      setPhase(VpnPhase.loggedOut);
      return false;
    }
    setPhase(VpnPhase.connecting);
    _statusLine = null;
    try {
      // Reuse the open session while it's fresh; otherwise re-checkout.
      if (!_sessionOpen ||
          _session == null ||
          _session!.expiresAt.difference(DateTime.now()) < const Duration(hours: 1)) {
        final saved = await _sessionService.saved();
        if (saved == null) {
          _session = null;
          _sessionOpen = false;
          setPhase(VpnPhase.loggedOut);
          return false;
        }
        _session = await _sessionService.openSession(saved.accountId, saved.token);
        _sessionOpen = true;
      }
      final cfg = _session!.config;
      _budgetBytes = cfg.budgetGb * (1024 * 1024 * 1024);
      _monthUsed = await _usage.monthUsed();
      if (overBudget) {
        _statusLine =
            'monthly budget (${cfg.budgetGb}GB) used up — the aura is tapped out until next month';
        setPhase(VpnPhase.error);
        return false;
      }
      final dir = await SingboxManager.dir;
      await Directory(dir).create(recursive: true);
      _clashSecret = _randomSecret();
      await ConfigGenerator.generate(
        serverConfig: cfg,
        singBoxDir: dir,
        clashSecret: _clashSecret!,
      );
      _clash.setSecret(_clashSecret!);
      final startResult = await SingboxManager.start(configDir: dir);
      if (startResult.stderr.toString().trim().isNotEmpty) {
        _log('core: ${startResult.stderr.toString().trim()}');
      }

      final active = await _clash.waitForActive(const Duration(seconds: 20));
      if (active == null) {
        // Verbose failure: surface what the core actually wrote.
        throw StateError('sing-box started but no server came alive\n${await _coreLogTail(dir)}');
      }
      _activeServer = active;
      setPhase(VpnPhase.connected);
      _log('connected via $active');
      _startHeartbeat();
      _startStatsPolling();
      return true;
    } on SessionException catch (e) {
      // Auth-flavoured failures kick the user back to the login gate.
      if (e.kind == AuthErrorKind.badCreds ||
          e.kind == AuthErrorKind.accountExpired ||
          e.kind == AuthErrorKind.accountDisabled ||
          e.kind == AuthErrorKind.sessionGone) {
        _authError = e.kind;
        _session = null;
        _sessionOpen = false;
        await _sessionService.forget();
        setPhase(VpnPhase.loggedOut);
      } else {
        _statusLine = 'session failed: ${e.kind.name}';
        setPhase(VpnPhase.error);
      }
      return false;
    } catch (e) {
      _statusLine = 'connect failed: $e';
      _log('ERROR $e');
      setPhase(VpnPhase.error);
      return false;
    }
  }

  Future<void> disconnect() async {
    _heartbeatTimer?.cancel();
    if (_session != null && _sessionOpen) {
      final sid = _session!.sessionId;
      _sessionOpen = false;
      unawaited(_sessionService.close(sid)); // best-effort, don't block the UI
    }
    _statsTimer?.cancel();
    if (_pendingUsage > 0) {
      try {
        await _usage.add(_pendingUsage);
      } catch (_) {} // persistence must never break a disconnect
      _pendingUsage = 0;
    }
    final dir = await SingboxManager.dir;
    try {
      await SingboxManager.stop(configDir: dir);
    } catch (e) {
      _log('disconnect warning: $e');
    }
    _activeServer = null;
    _upBytes = 0;
    _downBytes = 0;
    _latencies.clear();
    setPhase(VpnPhase.disconnected);
    _log('disconnected');
  }

  /// Re-checkout fresh pool creds (refresh button). Also refreshes the
  /// per-account budget while it's at it.
  Future<void> refreshConfig() async {
    setPhase(VpnPhase.fetchingConfig);
    try {
      final saved = await _sessionService.saved();
      if (saved == null) {
        _session = null;
        _sessionOpen = false;
        setPhase(VpnPhase.loggedOut);
        return;
      }
      _session = await _sessionService.openSession(saved.accountId, saved.token);
      _sessionOpen = true;
      _budgetBytes = _session!.config.budgetGb * (1024 * 1024 * 1024);
      _monthUsed = await _usage.monthUsed();
      _log('config refreshed: ${_session!.config.servers.length} servers');
      setPhase(_phase == VpnPhase.connected ? VpnPhase.connected : VpnPhase.disconnected);
    } on SessionException catch (e) {
      if (e.kind == AuthErrorKind.badCreds ||
          e.kind == AuthErrorKind.accountExpired ||
          e.kind == AuthErrorKind.accountDisabled ||
          e.kind == AuthErrorKind.sessionGone) {
        _authError = e.kind;
        _session = null;
        _sessionOpen = false;
        await _sessionService.forget();
        setPhase(VpnPhase.loggedOut);
      } else {
        _statusLine = 'could not summon the config: ${e.kind.name}';
        setPhase(VpnPhase.error);
      }
    } catch (e) {
      _statusLine = 'could not summon the config: $e';
      setPhase(VpnPhase.error);
    }
  }

  /// Slides the session expiry server-side every 10 min (KV write budget
  /// friendly). A 410 means the account/session is gone → force logout.
  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    final sid = _session!.sessionId;
    _heartbeatTimer = Timer.periodic(const Duration(minutes: 10), (_) async {
      final ok = await _sessionService.heartbeat(sid);
      if (!ok) {
        _log('session expired server-side — logging out');
        await disconnect();
        _authError = AuthErrorKind.sessionGone;
        _session = null;
        _sessionOpen = false;
        await _sessionService.forget();
        setPhase(VpnPhase.loggedOut);
      }
    });
  }

  void _startStatsPolling() {
    _statsTimer?.cancel();
    _prevUp = 0;
    _prevDown = 0;
    _pollTick = 0;
    _statsTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (_phase != VpnPhase.connected) return;
      final tags = _session?.config.servers.map((s) => s.tag).toList() ?? [];
      final active = await _clash.activeServer();
      if (active != null && active != _activeServer) {
        final prev = _activeServer;
        _activeServer = active;
        _log('server switch: ${prev ?? '?'} -> $active');
      }
      _latencies
        ..clear()
        ..addAll(await _clash.latencies(tags));
      final (up, down) = await _clash.traffic();
      _upBytes = up;
      _downBytes = down;

      // Budget accounting: /traffic is cumulative since sing-box start,
      // so the delta vs last poll is what actually flowed through the tunnel.
      final total = up + down;
      final prev = _prevUp + _prevDown;
      _prevUp = up;
      _prevDown = down;
      if (total >= prev) {
        _monthUsed += total - prev;
        _pendingUsage += total - prev;
      }
      if (++_pollTick % 5 == 0 && _pendingUsage > 0) {
        await _usage.add(_pendingUsage); // persist ~every 10s
        _pendingUsage = 0;
      }

      if (overBudget) {
        _log('budget exhausted (${_monthUsed ~/ (1024 * 1024)} MB) — hard stop');
        _statusLine = 'budget blown. disconnecting. we’ll be so back next month.';
        await disconnect();
        return;
      }

      notifyListeners();
    });
  }

  /// Tail of sing-box.log (bounded read; log can grow large) for error
  /// surfacing — the "it wasn't verbose" fix.
  static Future<String> _coreLogTail(String dir) async {
    final f = File('$dir${Platform.pathSeparator}sing-box.log');
    if (!await f.exists()) return '(no sing-box.log yet)';
    const maxBytes = 8192;
    try {
      final len = await f.length();
      final raf = await f.open();
      try {
        final skip = len > maxBytes ? len - maxBytes : 0;
        await raf.setPosition(skip);
        final bytes = await raf.read(len > maxBytes ? maxBytes : len);
        return utf8.decode(bytes, allowMalformed: true);
      } finally {
        await raf.close();
      }
    } catch (e) {
      return '(could not read sing-box.log: $e)';
    }
  }

  static String _randomSecret() {
    final rnd = Random.secure();
    return List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }
}
