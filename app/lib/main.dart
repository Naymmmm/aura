import 'package:flutter/material.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'state/app_state.dart';
import 'ui/home_page.dart';
import 'ui/login_view.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Desktop niceties: small window, close hides to tray.
  await windowManager.ensureInitialized();
  const winOpts = WindowOptions(
    size: Size(440, 720),
    minimumSize: Size(380, 560),
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
  await trayManager.setContextMenu(Menu(
    items: [
      MenuItem(key: 'show', label: 'Show Aura'),
      if (!loggedOut) MenuItem(key: 'connect', label: connected ? 'Reconnect' : 'Connect'),
      if (!loggedOut && connected) MenuItem(key: 'disconnect', label: 'Disconnect'),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: 'Quit'),
    ],
  ));
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
        await windowManager.destroy();
    }
  }
}

class AuraApp extends StatelessWidget {
  const AuraApp({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF8B5CF6), // aura purple
      brightness: Brightness.dark,
    );
    return MaterialApp(
      title: 'Aura',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        scaffoldBackgroundColor: scheme.surface,
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
