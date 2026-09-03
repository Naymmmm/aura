import 'package:aura/services/aura_core_manager.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Core startup timeout outlasts the ten-second proxy probe', () {
    final startup = AuraCoreManager.requestTimeoutFor('POST', '/v1/start');
    final health = AuraCoreManager.requestTimeoutFor('GET', '/v1/status');

    expect(startup, const Duration(seconds: 20));
    expect(health, const Duration(seconds: 8));
  });

  test(
    'Windows installer stops an orphaned installed Core before replacement',
    () {
      final script = AuraCoreManager.windowsInstallerScript(
        r'C:\bundle\aura-core',
        r'C:\state\aura-core',
      );

      final stop = script.indexOf('Stop-Process -Force');
      final remove = script.indexOf('Remove-Item -Recurse -Force');
      expect(stop, greaterThan(-1));
      expect(remove, greaterThan(stop));
      // 26.2.0: kill every aura-core process, wait for it to exit, retry the swap.
      expect(
        script,
        contains(
          r"Get-Process -Name 'aura-core' -ErrorAction SilentlyContinue | Stop-Process -Force",
        ),
      );
      expect(script, contains(r'$auraStopDeadline'));
      expect(script, contains(r'$auraCleared'));
    },
  );

  test('Windows installer returns elevated setup errors to the app', () {
    final script = AuraCoreManager.windowsInstallerScript(
      r'C:\bundle\aura-core',
      r'C:\state\aura-core',
    );

    expect(script, contains('install-result.log'));
    expect(script, contains('Get-Content -Raw'));
  });

  test('Windows installer waits for the helper API and reports its log', () {
    final script = AuraCoreManager.windowsInstallerScript(
      r'C:\bundle\aura-core',
      r'C:\state\aura-core',
    );

    expect(script, contains('New-Object System.Net.Sockets.TcpClient'));
    expect(script, contains("Connect('127.0.0.1', 45873)"));
    expect(script, contains("Join-Path \$runtime 'helper.log'"));
  });
}
