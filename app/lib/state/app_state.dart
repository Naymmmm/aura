import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../models/server_info.dart';
import '../services/config_generator.dart';
import '../services/session_service.dart';
import '../services/aura_core_manager.dart';
import '../services/update_service.dart';
import '../services/usage_tracker.dart';

enum VpnPhase {
  loggedOut,
  disconnected,
  fetchingConfig,
  connecting,
  connected,
  error,
}

/// Central app state: login → connect/disconnect flow, live stats, log sink.
class AppState extends ChangeNotifier {
  AppState({SessionService? sessionService})
    : _sessionService = sessionService ?? SessionService();

  final SessionService _sessionService;

  // ---- auto-update state (checked on launch, downloaded on demand) ----
  String? _updateVersion; // non-null = newer release available
  String? get updateVersion => _updateVersion;
  bool _updating = false; // download/extract in flight
  bool get updating => _updating;
  bool _updateStaged = false; // verified + extracted, waiting for install
  bool get updateStaged => _updateStaged;

  VpnPhase _phase = VpnPhase.loggedOut;
  VpnPhase get phase => _phase;

  SessionInfo? _session; // last open session (config + temp creds)
  bool _sessionOpen = false; // false once we closed/expired it server-side
  Timer? _heartbeatTimer;

  AuthErrorKind? _authError;
  AuthErrorKind? get authError => _authError;

  ServerConfig? get serverConfig => _session?.config;
  AccountStatus? get accountStatus => _session?.account;

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
  int _coreMisses = 0;
  bool _statsPollInFlight = false;

  /// Bytes used this calendar month (persisted across sessions).
  int get monthUsed => _monthUsed;

  /// Monthly budget in bytes (0 = not configured).
  int get budgetBytes => _budgetBytes;

  /// 0.0 → 1.0 share of the monthly budget used.
  double get budgetFraction => _budgetBytes > 0 ? _monthUsed / _budgetBytes : 0;

  bool get budgetWarn =>
      _budgetBytes > 0 && budgetFraction >= 0.8 && !overBudget;
  bool get overBudget => _budgetBytes > 0 && _monthUsed >= _budgetBytes;

  Timer? _statsTimer;
  bool _shutdownRequested = false;
  Completer<void>? _connectDone;

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

  /// Restore a saved login, if any. Call once before runApp.
  Future<void> init({bool checkForUpdates = true}) async {
    if (await _sessionService.hasSaved()) {
      try {
        _session = await _sessionService.openSession();
        _sessionOpen = true;
        _budgetBytes = _session!.config.budgetGb * (1024 * 1024 * 1024);
        setPhase(VpnPhase.disconnected);
        _log('welcome back, ${_session!.account.displayName}');
      } on SessionException catch (error) {
        _authError = error.kind;
        await _sessionService.forget();
        setPhase(VpnPhase.loggedOut);
      }
    } else {
      setPhase(VpnPhase.loggedOut);
    }
    // A previous hard crash can leave the privileged engine alive. We cannot
    // safely claim it as this process's connection, so reconcile reality by
    // stopping it before showing a disconnected state.
    if (await AuraCoreManager.isEngineRunning) {
      try {
        await AuraCoreManager.stop(configDir: await AuraCoreManager.dir);
        _log('cleaned up a tunnel left behind by an earlier app exit');
      } catch (e) {
        _statusLine =
            'a tunnel is still running but Aura could not stop it: $e';
        setPhase(VpnPhase.error);
      }
    }
    if (checkForUpdates) {
      unawaited(checkForUpdate()); // silent; never blocks startup
    }
  }

  /// Quietly asks the worker whether a newer release exists. Failures are
  /// logged and ignored — the app must work offline.
  Future<void> checkForUpdate() async {
    try {
      final v = await UpdateService().checkForUpdate();
      if (v != null && v != _updateVersion) {
        _updateVersion = v;
        _log('update available: $v — installing is one click away');
        notifyListeners();
      }
    } catch (e) {
      _log('update check failed: $e');
    }
  }

  /// Downloads + verifies + extracts the new release. [UpdateService.stage]
  /// refuses on checksum mismatch, so a failed install can never run.
  Future<bool> downloadUpdate() async {
    final v = _updateVersion;
    if (v == null || _updating) return false;
    _updating = true;
    notifyListeners();
    try {
      final saved = await _sessionService.saved();
      if (saved == null) throw StateError('Discord login expired');
      await UpdateService().stage(v, authToken: saved.token);
      _updateStaged = true;
      _log('update $v staged — restart to install');
      return true;
    } catch (e) {
      _log('update failed: $e');
      return false;
    } finally {
      _updating = false;
      notifyListeners();
    }
  }

  /// Swaps the staged release in and relaunches; the caller should exit
  /// immediately after (the updater waits for this process to die).
  Future<void> installUpdate() async {
    final stageDir =
        '${(await getApplicationSupportDirectory()).path}${Platform.pathSeparator}aura-update';
    try {
      await UpdateService().applyAndRestart(stageDir);
    } catch (e) {
      _log('install failed: $e');
      notifyListeners();
    }
  }

  /// Opens Discord in the browser and exchanges approval for a 14-day app token.
  Future<bool> loginWithDiscord() async {
    _authError = null;
    try {
      _session = await _sessionService.loginWithDiscord();
      _sessionOpen = true;
      _budgetBytes = _session!.config.budgetGb * (1024 * 1024 * 1024);
      _log('Discord session opened for ${_session!.account.displayName}');
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
    if (_shutdownRequested) return false;
    if (_phase == VpnPhase.connected || _phase == VpnPhase.connecting) {
      return false;
    }
    if (_session == null && !_sessionOpen) {
      setPhase(VpnPhase.loggedOut);
      return false;
    }
    final connectDone = Completer<void>();
    _connectDone = connectDone;
    setPhase(VpnPhase.connecting);
    _statusLine = null;
    try {
      // Reuse the open session while it's fresh; otherwise re-checkout.
      if (!_sessionOpen ||
          _session == null ||
          _session!.expiresAt.difference(DateTime.now()) <
              const Duration(hours: 1)) {
        final saved = await _sessionService.saved();
        if (saved == null) {
          _session = null;
          _sessionOpen = false;
          setPhase(VpnPhase.loggedOut);
          return false;
        }
        _session = await _sessionService.openSession();
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
      final dir = await AuraCoreManager.dir;
      await Directory(dir).create(recursive: true);
      await ConfigGenerator.generate(serverConfig: cfg, coreDir: dir);
      if (_shutdownRequested) return false;
      await AuraCoreManager.start(configDir: dir);
      if (_shutdownRequested) {
        await AuraCoreManager.stop(configDir: dir);
        return false;
      }

      final active = await AuraCoreManager.waitForActive(
        const Duration(seconds: 20),
      );
      if (active == null) {
        // Verbose failure: surface what the core actually wrote.
        final log = await AuraCoreManager.recentLog(dir);
        await AuraCoreManager.stop(configDir: dir);
        throw StateError('aura-core started but no server came alive\n$log');
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
          e.kind == AuthErrorKind.noCredit ||
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
      // Never show "disconnected" while the privileged helper says the
      // engine is still carrying traffic. Live telemetry may fail without the
      // tunnel itself having failed.
      if (await AuraCoreManager.isEngineRunning) {
        _statusLine = 'tunnel connected — live status is recovering';
        _log('status warning: $e');
        setPhase(VpnPhase.connected);
        _startHeartbeat();
        _startStatsPolling();
        return true;
      }
      try {
        final dir = await AuraCoreManager.dir;
        await AuraCoreManager.stop(configDir: dir);
      } catch (_) {
        // Preserve the original connection failure below.
      }
      _statusLine = 'connect failed: $e';
      _log('ERROR $e');
      setPhase(VpnPhase.error);
      return false;
    } finally {
      if (!connectDone.isCompleted) connectDone.complete();
      if (identical(_connectDone, connectDone)) _connectDone = null;
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
    final dir = await AuraCoreManager.dir;
    try {
      await AuraCoreManager.stop(configDir: dir);
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

  /// Final app shutdown. Unlike an ordinary disconnect this latches, so a
  /// connection already waiting on helper setup cannot start after the window
  /// has disappeared.
  Future<void> shutdown() async {
    _shutdownRequested = true;
    await _connectDone?.future;
    await disconnect();
  }

  /// Re-checkout fresh pool creds (refresh button). Also refreshes the
  /// per-account budget while it's at it.
  Future<void> refreshConfig() async {
    final wasConnected = _phase == VpnPhase.connected;
    setPhase(VpnPhase.fetchingConfig);
    try {
      final saved = await _sessionService.saved();
      if (saved == null) {
        _session = null;
        _sessionOpen = false;
        setPhase(VpnPhase.loggedOut);
        return;
      }
      _session = await _sessionService.openSession();
      _sessionOpen = true;
      _budgetBytes = _session!.config.budgetGb * (1024 * 1024 * 1024);
      _monthUsed = await _usage.monthUsed();
      _log('config refreshed: ${_session!.config.servers.length} servers');
      setPhase(wasConnected ? VpnPhase.connected : VpnPhase.disconnected);
    } on SessionException catch (e) {
      if (e.kind == AuthErrorKind.badCreds ||
          e.kind == AuthErrorKind.accountExpired ||
          e.kind == AuthErrorKind.accountDisabled ||
          e.kind == AuthErrorKind.noCredit ||
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
    _coreMisses = 0;
    _statsPollInFlight = false;
    _statsTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      unawaited(_pollStats());
    });
    unawaited(_pollStats());
  }

  Future<void> _pollStats() async {
    if (_statsPollInFlight || _phase != VpnPhase.connected) return;
    _statsPollInFlight = true;
    try {
      final stats = await AuraCoreManager.stats;
      final active = stats?.activeServer;
      if (stats == null || !stats.running) {
        _coreMisses++;
        if (_coreMisses >= 3) {
          if (!await AuraCoreManager.isEngineRunning) {
            _statsTimer?.cancel();
            _statusLine =
                'the tunnel engine stopped unexpectedly — tap connect to repair';
            _log('aura-core reports that the tunnel engine exited');
            setPhase(VpnPhase.error);
            return;
          }
          _statusLine =
              'tunnel connected — live status temporarily unavailable';
        }
      } else {
        _coreMisses = 0;
        if (_statusLine?.startsWith('tunnel connected — live status') ??
            false) {
          _statusLine = null;
        }
      }
      if (active != null && active != _activeServer) {
        final prev = _activeServer;
        _activeServer = active;
        _log('server switch: ${prev ?? '?'} -> $active');
      }
      _latencies
        ..clear()
        ..addAll(stats?.latencies ?? const {});
      final up = stats?.uploadTotal ?? _upBytes;
      final down = stats?.downloadTotal ?? _downBytes;
      _upBytes = up;
      _downBytes = down;

      // Aura Core totals are cumulative since the engine starts, so the delta
      // from the previous poll is what actually flowed through the tunnel.
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
        _log(
          'budget exhausted (${_monthUsed ~/ (1024 * 1024)} MB) — hard stop',
        );
        _statusLine =
            'budget blown. disconnecting. we’ll be so back next month.';
        await disconnect();
        return;
      }

      notifyListeners();
    } finally {
      _statsPollInFlight = false;
    }
  }
}
