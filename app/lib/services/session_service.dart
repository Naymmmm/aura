import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../models/server_info.dart';

enum AuthErrorKind {
  badCreds,
  accountExpired,
  accountDisabled,
  noCredit,
  poolExhausted,
  sessionGone,
  network,
}

enum AccountPlan { none, freeTrial, standard }

class SessionException implements Exception {
  SessionException(this.kind);
  final AuthErrorKind kind;
  @override
  String toString() => 'SessionException($kind)';
}

class AccountStatus {
  final String discordId;
  final String username;
  final String displayName;
  final DateTime? expiresAt;
  final int budgetGb;
  final AccountPlan plan;

  const AccountStatus({
    required this.discordId,
    required this.username,
    required this.displayName,
    required this.expiresAt,
    required this.budgetGb,
    required this.plan,
  });

  factory AccountStatus.fromJson(Map<String, dynamic> json) {
    final rawExpiry = (json['expires_at'] as num?)?.toInt() ?? 0;
    final rawPlan = json['plan'] as String? ?? 'none';
    return AccountStatus(
      discordId: json['discord_id'] as String,
      username: json['username'] as String,
      displayName: json['display_name'] as String? ?? json['username'] as String,
      expiresAt: rawExpiry > 0 ? DateTime.fromMillisecondsSinceEpoch(rawExpiry * 1000) : null,
      budgetGb: (json['budget_gb'] as num?)?.toInt() ?? 0,
      plan: switch (rawPlan) {
        'free_trial' => AccountPlan.freeTrial,
        'standard' || 'paid' => AccountPlan.standard,
        _ => AccountPlan.none,
      },
    );
  }
}

class SavedAuth {
  final String token;
  final DateTime expiresAt;
  const SavedAuth({required this.token, required this.expiresAt});
}

class SessionInfo {
  final ServerConfig config;
  final String sessionId;
  final DateTime expiresAt;
  final AccountStatus account;
  const SessionInfo({
    required this.config,
    required this.sessionId,
    required this.expiresAt,
    required this.account,
  });
}

typedef BrowserLauncher = Future<void> Function(Uri uri);
typedef PollDelay = Future<void> Function(Duration duration);

class SessionService {
  SessionService({
    String? apiBase,
    http.Client? client,
    File? credentialsFile,
    BrowserLauncher? openBrowser,
    PollDelay? pollDelay,
  })  : _apiBase = apiBase ?? 'https://api.copal.run',
        _client = client ?? http.Client(),
        _credentialsFileOverride = credentialsFile,
        _openBrowser = openBrowser ?? _launchBrowser,
        _pollDelay = pollDelay ?? Future<void>.delayed;

  final String _apiBase;
  final http.Client _client;
  final File? _credentialsFileOverride;
  final BrowserLauncher _openBrowser;
  final PollDelay _pollDelay;

  Future<File> _credsFile() async {
    if (_credentialsFileOverride != null) return _credentialsFileOverride;
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}${Platform.pathSeparator}session.json');
  }

  Future<bool> hasSaved() async => await saved() != null;

  Future<SavedAuth?> saved() async {
    final file = await _credsFile();
    if (!await file.exists()) return null;
    try {
      final json = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final token = json['token'] as String?;
      final rawExpiry = (json['token_expires_at'] as num?)?.toInt();
      if (token == null || !token.startsWith('aura_') || rawExpiry == null) throw const FormatException();
      final expiry = DateTime.fromMillisecondsSinceEpoch(rawExpiry * 1000);
      if (!expiry.isAfter(DateTime.now())) {
        await file.delete();
        return null;
      }
      return SavedAuth(token: token, expiresAt: expiry);
    } catch (_) {
      try {
        await file.delete();
      } catch (_) {}
      return null;
    }
  }

  Future<SessionInfo> loginWithDiscord() async {
    try {
      final start = await _client
          .post(Uri.parse('$_apiBase/v1/auth/discord/start'), headers: {'accept': 'application/json'})
          .timeout(const Duration(seconds: 20));
      if (start.statusCode != 200) throw SessionException(AuthErrorKind.network);
      final login = jsonDecode(start.body) as Map<String, dynamic>;
      final loginId = login['login_id'] as String;
      final loginSecret = login['login_secret'] as String;
      final authorizeUrl = Uri.parse(login['authorize_url'] as String);
      final expiresAt = (login['expires_at'] as num).toInt();
      await _openBrowser(authorizeUrl);

      while (DateTime.now().millisecondsSinceEpoch ~/ 1000 < expiresAt) {
        final poll = await _client
            .post(
              Uri.parse('$_apiBase/v1/auth/discord/poll'),
              headers: {'content-type': 'application/json', 'accept': 'application/json'},
              body: jsonEncode({'login_id': loginId, 'login_secret': loginSecret}),
            )
            .timeout(const Duration(seconds: 20));
        if (poll.statusCode == 202) {
          await _pollDelay(const Duration(seconds: 2));
          continue;
        }
        if (poll.statusCode != 200) throw SessionException(AuthErrorKind.network);
        final approved = jsonDecode(poll.body) as Map<String, dynamic>;
        final token = approved['token'] as String;
        final tokenExpiry = (approved['token_expires_at'] as num).toInt();
        final file = await _credsFile();
        await file.parent.create(recursive: true);
        await file.writeAsString(jsonEncode({
          'token': token,
          'token_expires_at': tokenExpiry,
          'account': approved['account'],
        }));
        return openSession(token: token);
      }
      throw SessionException(AuthErrorKind.network);
    } on SessionException {
      rethrow;
    } catch (_) {
      throw SessionException(AuthErrorKind.network);
    }
  }

  Future<SessionInfo> openSession({String? token}) async {
    final auth = token == null ? await saved() : SavedAuth(token: token, expiresAt: DateTime.now());
    if (auth == null) throw SessionException(AuthErrorKind.badCreds);
    http.Response response;
    try {
      response = await _client
          .post(
            Uri.parse('$_apiBase/v1/session'),
            headers: {'authorization': 'Bearer ${auth.token}', 'accept': 'application/json'},
          )
          .timeout(const Duration(seconds: 20));
    } catch (_) {
      throw SessionException(AuthErrorKind.network);
    }
    switch (response.statusCode) {
      case 200:
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        final config = ServerConfig.fromJson(json);
        if (config.servers.isEmpty) throw SessionException(AuthErrorKind.poolExhausted);
        return SessionInfo(
          config: config,
          sessionId: json['session_id'] as String,
          expiresAt: DateTime.fromMillisecondsSinceEpoch((json['expires_at'] as num).toInt() * 1000),
          account: AccountStatus.fromJson(json['account'] as Map<String, dynamic>),
        );
      case 401:
        throw SessionException(AuthErrorKind.badCreds);
      case 403:
        throw SessionException(response.body.contains('no_credit')
            ? AuthErrorKind.noCredit
            : response.body.contains('disabled')
                ? AuthErrorKind.accountDisabled
                : AuthErrorKind.accountExpired);
      case 503:
        throw SessionException(AuthErrorKind.poolExhausted);
      default:
        throw SessionException(AuthErrorKind.network);
    }
  }

  Future<bool> heartbeat(String sessionId) async {
    try {
      final response = await _client.post(Uri.parse('$_apiBase/v1/session/$sessionId/heartbeat')).timeout(const Duration(seconds: 15));
      return response.statusCode == 200;
    } catch (_) {
      return true;
    }
  }

  Future<void> close(String sessionId) async {
    try {
      await _client.delete(Uri.parse('$_apiBase/v1/session/$sessionId')).timeout(const Duration(seconds: 15));
    } catch (_) {}
  }

  Future<void> forget() async {
    final file = await _credsFile();
    final auth = await saved();
    if (auth != null) {
      try {
        await _client
            .delete(
              Uri.parse('$_apiBase/v1/auth/session'),
              headers: {'authorization': 'Bearer ${auth.token}'},
            )
            .timeout(const Duration(seconds: 10));
      } catch (_) {}
    }
    if (await file.exists()) {
      try {
        await file.delete();
      } catch (_) {}
    }
  }

  static Future<void> _launchBrowser(Uri uri) async {
    if (Platform.isWindows) {
      await Process.start('rundll32', ['url.dll,FileProtocolHandler', uri.toString()], mode: ProcessStartMode.detached);
    } else if (Platform.isMacOS) {
      await Process.start('open', [uri.toString()], mode: ProcessStartMode.detached);
    } else {
      await Process.start('xdg-open', [uri.toString()], mode: ProcessStartMode.detached);
    }
  }
}
