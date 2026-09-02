import 'package:flutter/material.dart';
import 'package:forui/forui.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'state/app_state.dart';
import 'ui/home_page.dart';
import 'ui/login_view.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Compact desktop control surface; close waits for tunnel cleanup before exit.
  await windowManager.ensureInitialized();
  const winOpts = WindowOptions(
    size: Size(560, 780),
    minimumSize: Size(460, 640),
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
    final foruiTheme = FTheme.neutral.dark.desktop;
    final materialTheme = foruiTheme.toApproximateMaterialTheme();
    return MaterialApp(
      title: 'Aura',
      debugShowCheckedModeBanner: false,
      locale: const Locale('en', 'US'),
      localizationsDelegates: FLocalizations.localizationsDelegates,
      supportedLocales: FLocalizations.supportedLocales,
      theme: materialTheme.copyWith(
        colorScheme: materialTheme.colorScheme.copyWith(
          primary: const Color(0xFFD8FF67),
          onPrimary: const Color(0xFF101507),
          surface: const Color(0xFF090B10),
          surfaceContainerLow: const Color(0xFF10141C),
          surfaceContainerHigh: const Color(0xFF181E29),
          tertiary: foruiTheme.colors.mutedForeground,
          onTertiary: foruiTheme.colors.background,
        ),
        scaffoldBackgroundColor: foruiTheme.colors.background,
        cardTheme: const CardThemeData(elevation: 0, margin: EdgeInsets.zero),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xFF0B0E14),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Color(0xFF303745)),
          ),
        ),
      ),
      builder: (context, child) => FTheme(
        data: foruiTheme,
        child: FToaster(child: FTooltipGroup(child: child!)),
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
