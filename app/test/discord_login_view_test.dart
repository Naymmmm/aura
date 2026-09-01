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
        config: const ServerConfig(version: 1, preferIp: false, budgetGb: 1, servers: []),
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
}

void main() {
  testWidgets('legacy account fields are replaced by Discord login and free-trial status', (tester) async {
    final state = AppState(sessionService: FakeSessionService());
    await state.init();
    await tester.pumpWidget(AuraApp(state: state));

    expect(find.text('CONTINUE WITH DISCORD'), findsOneWidget);
    expect(find.text('account id'), findsNothing);
    expect(find.text('api token'), findsNothing);

    await tester.tap(find.text('CONTINUE WITH DISCORD'));
    await tester.pumpAndSettle();

    expect(find.text('FREE TRIAL'), findsOneWidget);
    expect(find.textContaining('1 GB'), findsWidgets);
    expect(find.textContaining('Free User'), findsOneWidget);
  });
}
