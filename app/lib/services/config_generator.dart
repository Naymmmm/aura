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
    required String selectedServerTag,
  }) async {
    final selected = serverConfig.byTag(selectedServerTag);
    if (selected == null) {
      throw ArgumentError.value(
        selectedServerTag,
        'selectedServerTag',
        'server is not present in the current session',
      );
    }
    final config = <String, Object>{
      'version': 1,
      'tun': <String, Object>{'address': '172.19.0.1/30', 'mtu': 1400},
      'servers': [
        <String, Object>{
          'tag': selected.tag,
          'host': selected.host,
          'connect_address': selected.connectAddress(serverConfig.preferIp),
          'port': 443,
          'username': selected.username,
          'password': selected.password,
        },
      ],
    };
    final file = File('$coreDir${Platform.pathSeparator}config.json');
    await file.writeAsString(jsonEncode(config), flush: true);
    return file.path;
  }
}
