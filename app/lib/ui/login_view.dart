import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../state/app_state.dart';
import 'aura_lines.dart';

/// Discord is the only account gate. The Worker exchanges browser approval for
/// an opaque Aura token that remains valid for 14 days.
class LoginView extends StatefulWidget {
  const LoginView({super.key, required this.state});

  final AppState state;

  @override
  State<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends State<LoginView> {
  bool _busy = false;
  String? _errorLine;

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _errorLine = null;
    });
    final ok = await widget.state.loginWithDiscord();
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _errorLine = AuraLines.authError(widget.state.authError);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.asset(
                        'assets/tray/tray.png',
                        width: 64,
                        height: 64,
                        fit: BoxFit.fill,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'AURA',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w900,
                      letterSpacing: 4,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'sign in with Discord to unlock Aura VPN',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 28),
                  FButton(
                    size: FButtonSizeVariant.lg,
                    onPress: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text(
                            'CONTINUE WITH DISCORD',
                            style: TextStyle(
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.2,
                            ),
                          ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'A browser window will open. Your Aura session lasts 14 days.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _errorLine ?? '',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                  const SizedBox(height: 24),
                  const _RulesCard(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RulesCard extends StatelessWidget {
  const _RulesCard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FCard(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'THE RULES',
              style: theme.textTheme.labelSmall?.copyWith(
                letterSpacing: 2,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            for (var i = 0; i < AuraLines.rules.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  '${i + 1}. ${AuraLines.rules[i]}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
