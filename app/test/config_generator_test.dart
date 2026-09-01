import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:aura/models/server_info.dart';
import 'package:aura/services/config_generator.dart';

void main() {
  test('generates the narrow Aura Core 0.3 config', () async {
    final temp = await Directory.systemTemp.createTemp('aura-config-test-');
    addTearDown(() => temp.delete(recursive: true));
    final config = ServerConfig(
      version: 1,
      preferIp: true,
      budgetGb: 100,
      servers: const [
        ServerInfo(
          tag: 'romeo',
          host: 'romeo.example.com',
          ip: '203.0.113.10',
          username: 'user',
          password: 'pass',
        ),
      ],
    );

    final path = await ConfigGenerator.generate(
      serverConfig: config,
      coreDir: temp.path,
    );
    final json =
        jsonDecode(await File(path).readAsString()) as Map<String, dynamic>;

    expect(json.keys, containsAll(<String>['version', 'tun', 'servers']));
    expect(json.keys, isNot(contains('outbounds')));
    final server = (json['servers'] as List).single as Map<String, dynamic>;
    expect(server['host'], 'romeo.example.com');
    expect(server['connect_address'], '203.0.113.10');
  });
}
