import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:aura/models/server_info.dart';
import 'package:aura/services/config_generator.dart';

void main() {
  test(
    'generates a config containing only the explicitly selected server',
    () async {
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
          ServerInfo(
            tag: 'juliet',
            host: 'juliet.example.com',
            ip: '203.0.113.11',
            username: 'user-2',
            password: 'pass-2',
          ),
        ],
      );

      final path = await ConfigGenerator.generate(
        serverConfig: config,
        coreDir: temp.path,
        selectedServerTag: 'juliet',
      );
      final json =
          jsonDecode(await File(path).readAsString()) as Map<String, dynamic>;

      expect(json.keys, containsAll(<String>['version', 'tun', 'servers']));
      expect(json.keys, isNot(contains('outbounds')));
      final server = (json['servers'] as List).single as Map<String, dynamic>;
      expect(server['tag'], 'juliet');
      expect(server['host'], 'juliet.example.com');
      expect(server['connect_address'], '203.0.113.11');
    },
  );

  test('rejects an unavailable selected server', () async {
    final temp = await Directory.systemTemp.createTemp('aura-config-test-');
    addTearDown(() => temp.delete(recursive: true));
    const config = ServerConfig(
      version: 1,
      preferIp: false,
      budgetGb: 100,
      servers: [
        ServerInfo(
          tag: 'romeo',
          host: 'romeo.example.com',
          ip: '203.0.113.10',
          username: 'user',
          password: 'pass',
        ),
      ],
    );

    expect(
      () => ConfigGenerator.generate(
        serverConfig: config,
        coreDir: temp.path,
        selectedServerTag: 'missing',
      ),
      throwsArgumentError,
    );
  });
}
