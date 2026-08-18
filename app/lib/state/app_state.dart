import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/server_info.dart';
import '../services/clash_api.dart';
import '../services/config_generator.dart';
import '../services/config_service.dart';
import '../services/singbox_manager.dart';
import '../services/usage_tracker.dart';

enum VpnPhase { disconnected, fetchingConfig, connecting, connected, error }

/// Central app state: connect/disconnect flow, live stats, log sink.
class AppState extends ChangeNotifier {
  AppState({ConfigService? configService}) : _configService = configService ?? ConfigService();

  final ConfigService _configService;
  final ClashApi _clash = ClashApi();

  VpnPhase _phase = VpnPhase.disconnected;
  VpnPhase get phase => _phase;

  ServerConfig? _serverConfig;
  ServerConfig? get serverConfig => _serverConfig;

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

  Future<void> refreshConfig() async {
    setPhase(VpnPhase.fetchingConfig);
    try {
      _serverConfig = await _configService.getConfig(forceRefresh: true);
      _budgetBytes = _serverConfig!.budgetGb * (1024 * 1024 * 1024);
      _monthUsed = await _usage.monthUsed();
      _log('config refreshed: ${_serverConfig!.servers.length} servers');
      setPhase(_phase == VpnPhase.connected ? VpnPhase.connected : VpnPhase.disconnected);
    } catch (e) {
      _statusLine = 'could not summon the config: $e';
      setPhase(VpnPhase.error);
    }
  }

  Future<bool> connect() async {
    if (_phase == VpnPhase.connected || _phase == VpnPhase.connecting) return false;
    setPhase(VpnPhase.connecting);
    _statusLine = null;
    try {
      _serverConfig ??= await _configService.getConfig();
      _budgetBytes = _serverConfig!.budgetGb * (1024 * 1024 * 1024);
      _monthUsed = await _usage.monthUsed();
      if (overBudget) {
        _statusLine =
            'monthly budget (${_serverConfig!.budgetGb}GB) used up — the aura is tapped out until next month';
        setPhase(VpnPhase.error);
        return false;
      }
      final dir = await SingboxManager.dir;
      await Directory(dir).create(recursive: true);
      _clashSecret = _randomSecret();
      await ConfigGenerator.generate(
        serverConfig: _serverConfig!,
        singBoxDir: dir,
        clashSecret: _clashSecret!,
      );
      _clash.setSecret(_clashSecret!);
      await SingboxManager.start(configDir: dir);

      final active = await _clash.waitForActive(const Duration(seconds: 20));
      if (active == null) {
        throw StateError('sing-box started but no server came alive');
      }
      _activeServer = active;
      setPhase(VpnPhase.connected);
      _log('connected via $active');
      _startStatsPolling();
      return true;
    } catch (e) {
      _statusLine = 'connect failed: $e';
      _log('ERROR $e');
      setPhase(VpnPhase.error);
      return false;
    }
  }

  Future<void> disconnect() async {
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

  void _startStatsPolling() {
    _statsTimer?.cancel();
    _prevUp = 0;
    _prevDown = 0;
    _pollTick = 0;
    _statsTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (_phase != VpnPhase.connected) return;
      final tags = _serverConfig?.servers.map((s) => s.tag).toList() ?? [];
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

  static String _randomSecret() {
    final rnd = Random.secure();
    return List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }
}
