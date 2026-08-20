import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;

import '../models/server_info.dart';

/// Fills the sing-box template with real server/credential values and
/// writes it to the sing-box dir. All {{PLACEHOLDERS}} are replaced.
class ConfigGenerator {
  ConfigGenerator._();

  static const _templateAsset = 'assets/singbox.template.json';

  /// Generate config.json into [singBoxDir]. Returns the config path.
  static Future<String> generate({
    required ServerConfig serverConfig,
    required String singBoxDir,
    required String clashSecret,
  }) async {
    final raw = await rootBundle.loadString(_templateAsset);
    final s = raw
        .replaceAll(
          '{{ROMEO_SERVER}}',
          _jsonStringContent(_serverFor(serverConfig, 'romeo')),
        )
        .replaceAll(
          '{{ROMEO_USER}}',
          _jsonStringContent(_userFor(serverConfig, 'romeo')),
        )
        .replaceAll(
          '{{ROMEO_PASS}}',
          _jsonStringContent(_passFor(serverConfig, 'romeo')),
        )
        .replaceAll(
          '{{JULIET_SERVER}}',
          _jsonStringContent(_serverFor(serverConfig, 'juliet')),
        )
        .replaceAll(
          '{{JULIET_USER}}',
          _jsonStringContent(_userFor(serverConfig, 'juliet')),
        )
        .replaceAll(
          '{{JULIET_PASS}}',
          _jsonStringContent(_passFor(serverConfig, 'juliet')),
        )
        .replaceAll(
          '{{MERCUTIO_SERVER}}',
          _jsonStringContent(_serverFor(serverConfig, 'mercutio')),
        )
        .replaceAll(
          '{{MERCUTIO_USER}}',
          _jsonStringContent(_userFor(serverConfig, 'mercutio')),
        )
        .replaceAll(
          '{{MERCUTIO_PASS}}',
          _jsonStringContent(_passFor(serverConfig, 'mercutio')),
        )
        .replaceAll('{{CLASH_SECRET}}', _jsonStringContent(clashSecret));

    // Validate it still parses as JSON before writing (template drift guard).
    jsonDecode(s);

    final file = File('$singBoxDir${Platform.pathSeparator}config.json');
    await file.writeAsString(s);
    return file.path;
  }

  static String _serverFor(ServerConfig cfg, String tag) =>
      cfg.byTag(tag)?.connectAddress(cfg.preferIp) ?? tag;

  static String _userFor(ServerConfig cfg, String tag) =>
      cfg.byTag(tag)?.username ?? '';

  static String _passFor(ServerConfig cfg, String tag) =>
      cfg.byTag(tag)?.password ?? '';

  /// Template placeholders live inside JSON quotes, so retain only the
  /// escaped JSON string contents rather than adding a second quote pair.
  static String _jsonStringContent(String value) {
    final encoded = jsonEncode(value);
    return encoded.substring(1, encoded.length - 1);
  }
}
