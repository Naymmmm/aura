import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../models/server_info.dart';

/// Reasons a login/session can fail, mapped straight to meme lines in the UI.
enum AuthErrorKind {
  badCreds, // 401 — wrong account id or token
  accountExpired, // 403 — account past its expiry
  accountDisabled, // 403 — admin disabled the account
  noCredit, // 403 no_credit — self-served account, admin hasn't added days yet
  poolExhausted, // 503 — no free cred pairs right now
  sessionGone, // 410 — session no longer alive (expired server-side)
  network, // timeout / unreachable
}

class SessionException implements Exception {
  SessionException(this.kind);
  final AuthErrorKind kind;
  @override
  String toString() => 'SessionException($kind)';
}

/// What an open session gives the app: the config (server list + temp creds)
/// plus the session id used for heartbeat/release.
class SessionInfo {
  final ServerConfig config;
  final String sessionId;
  final DateTime expiresAt;
  const SessionInfo({
    required this.config,
    required this.sessionId,
    required this.expiresAt,
  });
}

/// Talks to the Worker's /v1/session endpoints on behalf of the saved account.
/// Account creds (account_id + token) live in session.json in the support dir;
/// the Worker mints per-connection server creds from the pool.
class SessionService {
  SessionService({String? apiBase}) : _apiBase = apiBase ?? 'https://api.copal.run';

  final String _apiBase;

  Future<File> _credsFile() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}${Platform.pathSeparator}session.json');
  }

  /// True if account creds are saved on disk (and look sane).
  Future<bool> hasSaved() async {
    final f = await _credsFile();
    if (!await f.exists()) return false;
    try {
      final j = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      return j['account_id'] is String && j['token'] is String;
    } catch (_) {
      return false;
    }
  }

  /// Saved account creds, or null when not logged in.
  Future<({String accountId, String token})?> saved() async {
    final f = await _credsFile();
    if (!await f.exists()) return null;
    try {
      final j = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      final id = j['account_id'] as String?;
      final tok = j['token'] as String?;
      if (id == null || id.isEmpty || tok == null || tok.isEmpty) return null;
      return (accountId: id, token: tok);
    } catch (_) {
      return null;
    }
  }

  /// POST /v1/session — check out fresh pool creds for this account.
  /// Throws [SessionException] on auth/state failures.
  Future<SessionInfo> openSession(String accountId, String token,
      {bool remember = true}) async {
    http.Response resp;
    try {
      resp = await http
          .post(
            Uri.parse('$_apiBase/v1/session'),
            headers: {'content-type': 'application/json', 'accept': 'application/json'},
            body: jsonEncode({'account_id': accountId, 'token': token}),
          )
          .timeout(const Duration(seconds: 20));
    } catch (_) {
      throw SessionException(AuthErrorKind.network);
    }
    switch (resp.statusCode) {
      case 200:
        final json = jsonDecode(resp.body) as Map<String, dynamic>;
        final sid = json['session_id'] as String;
        final cfg = ServerConfig.fromJson(json);
        if (cfg.servers.isEmpty) throw SessionException(AuthErrorKind.poolExhausted);
        if (remember) {
          await _credsFile()
              .then((f) => f.writeAsString(jsonEncode({'account_id': accountId, 'token': token})));
        } else {
          // not remembering: wipe anything saved, including an older login
          final f = await _credsFile();
          if (await f.exists()) await f.delete();
        }
        return SessionInfo(
          config: cfg,
          sessionId: sid,
          expiresAt:
              DateTime.fromMillisecondsSinceEpoch((json['expires_at'] as num).toInt() * 1000),
        );
      case 401:
        throw SessionException(AuthErrorKind.badCreds);
      case 403:
        throw SessionException(resp.body.contains('no_credit')
            ? AuthErrorKind.noCredit
            : resp.body.contains('disabled')
                ? AuthErrorKind.accountDisabled
                : AuthErrorKind.accountExpired);
      case 503:
        throw SessionException(AuthErrorKind.poolExhausted);
      default:
        throw SessionException(AuthErrorKind.network);
    }
  }

  /// POST /v1/session/{id}/heartbeat — slide the expiry window.
  /// Returns false when the session is gone (410); a network blip returns
  /// true so the session isn't killed over a transient failure.
  Future<bool> heartbeat(String sessionId) async {
    try {
      final resp = await http
          .post(Uri.parse('$_apiBase/v1/session/$sessionId/heartbeat'))
          .timeout(const Duration(seconds: 15));
      return resp.statusCode == 200;
    } catch (_) {
      return true;
    }
  }

  /// DELETE /v1/session/{id} — release the pool creds. Best effort;
  /// the server-side lazy sweep reclaims anything we never got to close.
  Future<void> close(String sessionId) async {
    try {
      await http
          .delete(Uri.parse('$_apiBase/v1/session/$sessionId'))
          .timeout(const Duration(seconds: 15));
    } catch (_) {}
  }

  /// POST /v1/signup — self-service account creation. The account is created
  /// with zero credit and can't open sessions until an admin adds days.
  /// Returns the id + token (shown once). Throws [SessionException] with
  /// network kind on failure.
  Future<({String accountId, String token})> signup(String name) async {
    http.Response resp;
    try {
      resp = await http
          .post(
            Uri.parse('$_apiBase/v1/signup'),
            headers: {'content-type': 'application/json', 'accept': 'application/json'},
            body: jsonEncode({'name': name}),
          )
          .timeout(const Duration(seconds: 20));
    } catch (_) {
      throw SessionException(AuthErrorKind.network);
    }
    if (resp.statusCode != 200) throw SessionException(AuthErrorKind.network);
    final j = jsonDecode(resp.body) as Map<String, dynamic>;
    final id = j['account_id'] as String?;
    final token = j['token'] as String?;
    if (id == null || token == null) throw SessionException(AuthErrorKind.network);
    return (accountId: id, token: token);
  }

  /// Forget the saved account creds (logout).
  Future<void> forget() async {
    final f = await _credsFile();
    if (await f.exists()) {
      try {
        await f.delete();
      } catch (_) {}
    }
  }
}
