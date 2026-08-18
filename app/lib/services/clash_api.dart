import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Polls sing-box's embedded Clash API (external_controller 127.0.0.1:9090)
/// for live stats: active server (urltest `now`), per-server latency history,
/// and cumulative up/down traffic.
class ClashApi {
  ClashApi({this.port = 9090});

  final int port;
  String _secret = '';

  void setSecret(String secret) => _secret = secret;

  Uri _uri(String path) => Uri.parse('http://127.0.0.1:$port$path');

  Future<Map<String, dynamic>?> _get(String path) async {
    try {
      final resp = await http
          .get(_uri(path), headers: {'Authorization': 'Bearer $_secret'})
          .timeout(const Duration(seconds: 3));
      if (resp.statusCode != 200) return null;
      return jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      return null; // core not up yet / just starting
    }
  }

  /// Active outbound of the `auto` urltest group, e.g. "juliet".
  Future<String?> activeServer() async {
    final data = await _get('/proxies/auto');
    if (data == null) return null;
    return data['now'] as String?;
  }

  /// Per-tag latest latency in ms (from each outbound's history).
  Future<Map<String, int>> latencies(List<String> tags) async {
    final out = <String, int>{};
    for (final tag in tags) {
      final data = await _get('/proxies/$tag');
      if (data == null) continue;
      final hist = data['history'] as List?;
      if (hist != null && hist.isNotEmpty) {
        final last = hist.last as Map<String, dynamic>;
        final d = last['delay'] as int?;
        if (d != null && d > 0) out[tag] = d;
      }
    }
    return out;
  }

  /// Cumulative up/down bytes.
  Future<(int, int)> traffic() async {
    final data = await _get('/traffic');
    if (data == null) return (0, 0);
    return ((data['up'] as int?) ?? 0, (data['down'] as int?) ?? 0);
  }

  /// True when the Clash API answers (core is running and healthy).
  Future<bool> isHealthy() async {
    final data = await _get('/proxies/auto');
    return data != null;
  }

  /// Polls until the urltest group picks a live server.
  Future<String?> waitForActive(Duration timeout) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      final a = await activeServer();
      if (a != null && a.isNotEmpty) return a;
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    return null;
  }
}
