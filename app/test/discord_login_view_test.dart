import 'package:aura/main.dart';
import 'package:aura/models/server_info.dart';
import 'package:aura/services/session_service.dart';
import 'package:aura/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeSessionService extends SessionService {
  @override
  Future<bool> hasSaved() async => false;

  @override
  Future<SessionInfo> loginWithDiscord() async => SessionInfo(
    config: const ServerConfig(
      version: 1,
      preferIp: false,
      budgetGb: 1,
      servers: [
        ServerInfo(
          tag: 'romeo',
          host: 'romeo.example',
          ip: '1.2.3.4',
          username: 'lease-1',
          password: 'secret-1',
        ),
        ServerInfo(
          tag: 'juliet',
          host: 'juliet.example',
          ip: '1.2.3.5',
          username: 'lease-2',
          password: 'secret-2',
        ),
      ],
    ),
    sessionId: 'vpn-session',
    expiresAt: DateTime.now().add(const Duration(hours: 24)),
    account: AccountStatus(
      discordId: '900000000000000001',
      username: 'freebie',
      displayName: 'Free User',
      expiresAt: DateTime.now().add(const Duration(days: 7)),
      budgetGb: 1,
      plan: AccountPlan.freeTrial,
    ),
  );

  @override
  Future<SessionInfo> loginLegacy(String accountId, String token) async =>
      loginWithDiscord();
}

void main() {
  testWidgets(
    'legacy credentials stay hidden until secondary sign-in is opened',
    (tester) async {
      final state = AppState(sessionService: FakeSessionService());
      await state.init(checkForUpdates: false, reconcileEngine: false);
      await tester.pumpWidget(AuraApp(state: state));

      expect(find.text('CONTINUE WITH DISCORD'), findsOneWidget);
      expect(find.text('account id'), findsNothing);
      expect(find.text('api token'), findsNothing);

      await tester.tap(find.text('More sign-in options'));
      await tester.pumpAndSettle();

      expect(find.text('Legacy access'), findsOneWidget);
      expect(find.text('account id'), findsOneWidget);
      expect(find.text('api token'), findsOneWidget);
    },
  );

  testWidgets('Discord login exposes an unfiltered-device handoff', (
    tester,
  ) async {
    final state = AppState(sessionService: FakeSessionService());
    await state.init(checkForUpdates: false, reconcileEngine: false);
    await tester.pumpWidget(AuraApp(state: state));

    await tester.tap(find.text('More sign-in options'));
    await tester.pumpAndSettle();

    expect(find.text('Use another device'), findsOneWidget);
    expect(find.textContaining('filtered'), findsOneWidget);
  });

  testWidgets('successful Discord login shows account status', (tester) async {
    final state = AppState(sessionService: FakeSessionService());
    await state.init(checkForUpdates: false, reconcileEngine: false);
    await tester.pumpWidget(AuraApp(state: state));

    expect(await state.loginWithDiscord(), isTrue);
    await tester.pump();

    expect(find.textContaining('FREE TRIAL'), findsOneWidget);
    expect(find.textContaining('1 GB'), findsWidgets);
    expect(find.textContaining('Free User'), findsOneWidget);
  });

  test('server selection stays pinned while connected', () async {
    final state = AppState(sessionService: FakeSessionService());
    await state.init(checkForUpdates: false, reconcileEngine: false);
    expect(await state.loginWithDiscord(), isTrue);

    expect(state.selectedServerTag, 'romeo');
    expect(state.selectServer('juliet'), isTrue);
    state.setPhase(VpnPhase.connected);

    expect(state.selectServer('romeo'), isFalse);
    expect(state.selectedServerTag, 'juliet');
  });
}
