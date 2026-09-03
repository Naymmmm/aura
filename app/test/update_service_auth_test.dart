import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:archive/archive_io.dart';
import 'package:aura/services/update_service.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('uses the year.minor.hotfix release version', () {
    expect(UpdateService.appVersion, 'v26.1.0');
  });

  test(
    'macOS updater is AppleScript that fetches, verifies, mounts, and notifies',
    () {
      final script = UpdateService.macUpdaterScript(
        appBundle: '/Applications/Aura.app',
        appPid: 42,
        authToken: 'aura_token',
        legacyAccountId: 'legacy01',
        version: 'v26.1.0',
        sha256: 'abc123',
      );

      expect(script, contains('curl'));
      expect(script, contains('/dl/latest-macos'));
      expect(script, contains('shasum -a 256'));
      expect(script, contains('hdiutil attach'));
      expect(script, contains('display notification'));
      expect(script, contains('v26.1.0'));
      expect(script, contains('X-Aura-Account-Id: legacy01'));
      expect(script, isNot(contains('\n+')));
    },
  );

  test('gated updater sends the saved Discord app token', () async {
    final temp = await Directory.systemTemp.createTemp('aura-update-auth-');
    addTearDown(() => temp.delete(recursive: true));
    final archive = Archive()..addFile(ArchiveFile('aura.exe', 3, [1, 2, 3]));
    final zip = ZipEncoder().encode(archive);
    final hash = sha256.convert(zip).toString();
    final client = MockClient((request) async {
      if (request.url.path == '/v1/release/meta') {
        return http.Response(
          jsonEncode({'version': 'v9.9.9', 'sha256': hash}),
          200,
        );
      }
      if (request.url.path == '/dl/${UpdateService.platformKey()}') {
        expect(request.headers['authorization'], 'Bearer aura_saved_token');
        return http.Response.bytes(zip, 200);
      }
      return http.Response('not found', 404);
    });
    final service = UpdateService(
      apiBase: 'https://api.copal.run',
      client: client,
      stageDirectory: temp.path,
    );

    await service.stage('v9.9.9', authToken: 'aura_saved_token');

    if (Platform.isMacOS) {
      final metadata = jsonDecode(
        await File('${temp.path}${Platform.pathSeparator}mac-update.json')
            .readAsString(),
      ) as Map<String, dynamic>;
      expect(metadata['auth_token'], 'aura_saved_token');
      return;
    }

    expect(
      await File('${temp.path}${Platform.pathSeparator}aura.exe').readAsBytes(),
      [1, 2, 3],
    );
  });
}
