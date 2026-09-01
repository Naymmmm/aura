import 'package:flutter/material.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'state/app_state.dart';
import 'ui/home_page.dart';
import 'ui/login_view.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Compact dashboard window; close waits for tunnel cleanup before exit.
  await windowManager.ensureInitialized();
  const winOpts = WindowOptions(
    size: Size(500, 760),
    minimumSize: Size(420, 620),
    center: true,
    title: 'Aura',
    titleBarStyle: TitleBarStyle.normal,
  );
  await windowManager.waitUntilReadyToShow(winOpts, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  final state = AppState();
  await state.init(); // restore a saved login, or land on the login gate
  await windowManager.setPreventClose(true);
  windowManager.addListener(_AppWindowListener(state));

  runApp(AuraApp(state: state));
  _initTray(state);
}

void _initTray(AppState state) async {
  await trayManager.setIcon('assets/tray/tray.ico');
  await trayManager.setToolTip('Aura — network with aura');
  trayManager.addListener(_TrayListener(state));
  _updateTrayMenu(state);
}

void _updateTrayMenu(AppState state) async {
  final connected = state.phase == VpnPhase.connected;
  final loggedOut = state.phase == VpnPhase.loggedOut;
  await trayManager.setContextMenu(
    Menu(
      items: [
        MenuItem(key: 'show', label: 'Show Aura'),
        if (!loggedOut)
          MenuItem(key: 'connect', label: connected ? 'Reconnect' : 'Connect'),
        if (!loggedOut && connected)
          MenuItem(key: 'disconnect', label: 'Disconnect'),
        MenuItem.separator(),
        MenuItem(key: 'quit', label: 'Quit'),
      ],
    ),
  );
}

class _TrayListener with TrayListener {
  _TrayListener(this.state);

  final AppState state;

  @override
  void onTrayIconMouseDown() {
    windowManager.show();
  }

  @override
  void onTrayIconRightMouseDown() {
    _updateTrayMenu(state);
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    switch (menuItem.key) {
      case 'show':
        await windowManager.show();
        await windowManager.focus();
      case 'connect':
        if (state.phase == VpnPhase.loggedOut) {
          // logged out — the tray connect means "show me the login"
          await windowManager.show();
          await windowManager.focus();
        } else if (state.phase != VpnPhase.connected) {
          await state.connect();
        }
      case 'disconnect':
        if (state.phase == VpnPhase.connected) await state.disconnect();
      case 'quit':
        await state.shutdown();
        await windowManager.setPreventClose(false);
        await windowManager.destroy();
    }
  }
}

class _AppWindowListener with WindowListener {
  _AppWindowListener(this.state);

  final AppState state;
  bool _closing = false;

  @override
  void onWindowClose() async {
    if (_closing) return;
    _closing = true;
    try {
      await state.shutdown();
      await windowManager.setPreventClose(false);
      await windowManager.destroy();
    } finally {
      _closing = false;
    }
  }
}

class AuraApp extends StatelessWidget {
  const AuraApp({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: const Color(0xFF8B7CFF),
          brightness: Brightness.dark,
          surface: const Color(0xFF0B0D18),
        ).copyWith(
          primary: const Color(0xFF9D8CFF),
          secondary: const Color(0xFF62E6FF),
          tertiary: const Color(0xFFFFC56E),
        );
    return MaterialApp(
      title: 'Aura',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF070914),
        cardTheme: CardThemeData(
          elevation: 0,
          color: const Color(0xB3161928),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(22),
            side: const BorderSide(color: Color(0x1FFFFFFF)),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0x99161928),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Color(0x24FFFFFF)),
          ),
        ),
      ),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) => state.phase == VpnPhase.loggedOut
            ? LoginView(state: state)
            : HomePage(state: state),
      ),
    );
  }
}
