import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../models/server_info.dart';

/// Fetches + caches the server config from the Worker at api.copal.run.
///
/// Cache lives in the support dir (aura.json) with a 6h TTL so the app
/// still works when the Worker is unreachable. Manual refresh bypasses TTL.
class ConfigService {
  ConfigService({String? apiBase, String? secret})
      : _apiBase = apiBase ?? 'https://api.copal.run',
        _secret = secret ?? '';

  final String _apiBase;
  final String _secret;
  static const _ttl = Duration(hours: 6);

  ServerConfig? _cached;
  DateTime? _fetchedAt;

  Future<File> _cacheFile() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}${Platform.pathSeparator}aura.json');
  }

  ServerConfig? get cached => _cached;

  /// Fetch from the Worker. Throws on failure.
  Future<ServerConfig> _fetch() async {
    final uri = Uri.parse('$_apiBase/v1/config');
    final resp = await http
        .get(uri, headers: {'x-copal-secret': _secret, 'accept': 'application/json'})
        .timeout(const Duration(seconds: 15));
    if (resp.statusCode != 200) {
      throw HttpException('Worker returned ${resp.statusCode}');
    }
    final json = jsonDecode(resp.body) as Map<String, dynamic>;
    final cfg = ServerConfig.fromJson(json);
    if (cfg.servers.isEmpty) throw HttpException('Worker returned no servers');
    _cached = cfg;
    _fetchedAt = DateTime.now();
    await _cacheFile().then((f) => f.writeAsString(jsonEncode(json)));
    return cfg;
  }

  /// Get config: cache if fresh, else network, else stale cache, else throw.
  Future<ServerConfig> getConfig({bool forceRefresh = false}) async {
    final fresh = _cached != null &&
        _fetchedAt != null &&
        !forceRefresh &&
        DateTime.now().difference(_fetchedAt!) < _ttl;
    if (fresh) return _cached!;

    try {
      return await _fetch();
    } catch (e) {
      // Fall back to the on-disk cache even if stale.
      final f = await _cacheFile();
      if (await f.exists()) {
        final json = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
        final cfg = ServerConfig.fromJson(json);
        if (cfg.servers.isNotEmpty) {
          _cached = cfg;
          return cfg;
        }
      }
      rethrow;
    }
  }
}
