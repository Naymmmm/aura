import 'dart:convert';
import 'dart:io';

import '../models/server_info.dart';

/// Writes the narrow configuration consumed by the privileged Aura Core.
/// Routing, TUN, NaiveProxy, UoT, and telemetry are owned by Aura Core; the
/// unprivileged UI only supplies the checked-out server credentials.
class ConfigGenerator {
  ConfigGenerator._();

  /// Generate config.json into [coreDir]. Returns the config path.
  static Future<String> generate({
    required ServerConfig serverConfig,
    required String coreDir,
  }) async {
    final config = <String, Object>{
      'version': 1,
      'tun': <String, Object>{'address': '172.19.0.1/30', 'mtu': 1400},
      'servers': [
        for (final server in serverConfig.servers)
          <String, Object>{
            'tag': server.tag,
            'host': server.host,
            'connect_address': server.connectAddress(serverConfig.preferIp),
            'port': 443,
            'username': server.username,
            'password': server.password,
          },
      ],
    };
    final file = File('$coreDir${Platform.pathSeparator}config.json');
    await file.writeAsString(jsonEncode(config), flush: true);
    return file.path;
  }
}
