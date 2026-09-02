import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:aura/services/session_service.dart';

void main() {
  test(
    'Discord browser approval is saved as a 14-day token and opens a trial session',
    () async {
      final temp = await Directory.systemTemp.createTemp('aura-auth-test-');
      addTearDown(() => temp.delete(recursive: true));
      final credentials = File('${temp.path}/session.json');
      Uri? opened;
      var polls = 0;
      final client = MockClient((request) async {
        if (request.url.path == '/v1/auth/discord/start') {
          return http.Response(
            jsonEncode({
              'login_id': 'login-id',
              'login_secret': 'poll-secret',
              'authorize_url':
                  'https://discord.com/oauth2/authorize?state=state',
              'expires_at': 2000000000,
            }),
            200,
          );
        }
        if (request.url.path == '/v1/auth/discord/poll') {
          polls++;
          if (polls == 1) {
            return http.Response(jsonEncode({'status': 'pending'}), 202);
          }
          return http.Response(
            jsonEncode({
              'token': 'aura_${'a' * 64}',
              'token_expires_at': 2000000000,
              'account': {
                'discord_id': '900000000000000001',
                'username': 'freebie',
                'display_name': 'Free User',
                'expires_at': 1900000000,
                'budget_gb': 1,
                'plan': 'free_trial',
              },
            }),
            200,
          );
        }
        if (request.url.path == '/v1/session') {
          expect(request.headers['authorization'], 'Bearer aura_${'a' * 64}');
          return http.Response(
            jsonEncode({
              'version': 1,
              'session_id': 'vpn-session',
              'expires_at': 1900003600,
              'budget_gb': 1,
              'prefer_ip': false,
              'account': {
                'discord_id': '900000000000000001',
                'username': 'freebie',
                'display_name': 'Free User',
                'expires_at': 1900000000,
                'budget_gb': 1,
                'plan': 'free_trial',
              },
              'servers': [
                {
                  'tag': 'romeo',
                  'host': 'romeo.example',
                  'ip': '1.2.3.4',
                  'username': 'lease',
                  'password': 'secret',
                },
              ],
            }),
            200,
          );
        }
        return http.Response('not found', 404);
      });
      final service = SessionService(
        apiBase: 'https://api.copal.run',
        client: client,
        credentialsFile: credentials,
        openBrowser: (uri) async => opened = uri,
        pollDelay: (_) async {},
      );

      final session = await service.loginWithDiscord();
      final saved =
          jsonDecode(await credentials.readAsString()) as Map<String, dynamic>;

      expect(opened?.host, 'discord.com');
      expect(polls, 2);
      expect(saved['token'], 'aura_${'a' * 64}');
      expect(saved.containsKey('account_id'), isFalse);
      expect(session.account.plan, AccountPlan.freeTrial);
      expect(session.account.budgetGb, 1);
      expect(session.account.displayName, 'Free User');
    },
  );

  test('saved Discord token is rejected after its 14-day expiry', () async {
    final temp = await Directory.systemTemp.createTemp('aura-expired-test-');
    addTearDown(() => temp.delete(recursive: true));
    final credentials = File('${temp.path}/session.json');
    await credentials.writeAsString(
      jsonEncode({'token': 'aura_${'b' * 64}', 'token_expires_at': 1}),
    );
    final service = SessionService(credentialsFile: credentials);

    expect(await service.hasSaved(), isFalse);
    expect(await credentials.exists(), isFalse);
  });

  test('logout revokes the 14-day token before deleting it locally', () async {
    final temp = await Directory.systemTemp.createTemp('aura-logout-test-');
    addTearDown(() => temp.delete(recursive: true));
    final credentials = File('${temp.path}/session.json');
    await credentials.writeAsString(
      jsonEncode({
        'token': 'aura_${'d' * 64}',
        'token_expires_at':
            DateTime.now().millisecondsSinceEpoch ~/ 1000 + 86400,
      }),
    );
    var revoked = false;
    final service = SessionService(
      credentialsFile: credentials,
      client: MockClient((request) async {
        expect(request.method, 'DELETE');
        expect(request.url.path, '/v1/auth/session');
        expect(request.headers['authorization'], 'Bearer aura_${'d' * 64}');
        revoked = true;
        return http.Response(jsonEncode({'ok': true}), 200);
      }),
    );

    await service.forget();

    expect(revoked, isTrue);
    expect(await credentials.exists(), isFalse);
  });

  test(
    'legacy login posts credentials and persists the hidden auth mode',
    () async {
      final temp = await Directory.systemTemp.createTemp('aura-legacy-test-');
      addTearDown(() => temp.delete(recursive: true));
      final credentials = File('${temp.path}/session.json');
      final service = SessionService(
        credentialsFile: credentials,
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/v1/session');
          expect(request.headers['authorization'], isNull);
          expect(jsonDecode(request.body), {
            'account_id': 'legacy01',
            'token': 'legacy-token',
          });
          return http.Response(
            jsonEncode({
              'version': 1,
              'session_id': 'legacy-session',
              'expires_at':
                  DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600,
              'budget_gb': 50,
              'prefer_ip': false,
              'account': {
                'discord_id': 'legacy01',
                'username': 'Legacy User',
                'display_name': 'Legacy User',
                'expires_at':
                    DateTime.now().millisecondsSinceEpoch ~/ 1000 + 86400,
                'budget_gb': 50,
                'plan': 'standard',
              },
              'servers': [
                {
                  'tag': 'romeo',
                  'host': 'romeo.example',
                  'ip': '1.2.3.4',
                  'username': 'lease',
                  'password': 'secret',
                },
              ],
            }),
            200,
          );
        }),
      );

      final session = await service.loginLegacy('legacy01', 'legacy-token');
      final saved =
          jsonDecode(await credentials.readAsString()) as Map<String, dynamic>;

      expect(session.sessionId, 'legacy-session');
      expect(saved['auth_mode'], 'legacy');
      expect(saved['account_id'], 'legacy01');
      expect(saved['token'], 'legacy-token');
    },
  );
}
