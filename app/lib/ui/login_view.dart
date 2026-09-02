import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../state/app_state.dart';
import 'aura_lines.dart';
import 'aura_mark.dart';

/// Discord is the only account gate. The Worker exchanges browser approval for
/// an opaque Aura token that remains valid for 14 days.
class LoginView extends StatefulWidget {
  const LoginView({super.key, required this.state});

  final AppState state;

  @override
  State<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends State<LoginView> {
  final _accountIdController = TextEditingController();
  final _tokenController = TextEditingController();
  bool _busy = false;
  bool _showMore = false;
  bool _obscureToken = true;
  String? _errorLine;

  @override
  void dispose() {
    _accountIdController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

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

  Future<void> _submitRemote() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _errorLine = null;
    });
    final ok = await widget.state.loginWithDiscordViaHandoff();
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _errorLine = AuraLines.authError(widget.state.authError);
    });
  }

  Future<void> _submitLegacy() async {
    if (_busy) return;
    final accountId = _accountIdController.text.trim();
    final token = _tokenController.text.trim();
    if (accountId.isEmpty || token.isEmpty) {
      setState(() => _errorLine = 'enter both legacy credentials');
      return;
    }
    setState(() {
      _busy = true;
      _errorLine = null;
    });
    final ok = await widget.state.loginLegacy(accountId, token);
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
              child: Container(
                padding: const EdgeInsets.all(28),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x55000000),
                      blurRadius: 48,
                      offset: Offset(0, 20),
                    ),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Center(
                      child: Container(
                        width: 64,
                        height: 64,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.primary,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: AuraMark(
                          size: 42,
                          color: theme.colorScheme.onPrimary,
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
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() => _showMore = !_showMore),
                      child: const Text('More sign-in options'),
                    ),
                    if (_showMore) ...[
                      const Divider(height: 28),
                      Text(
                        'Filtered network?',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        'Open a temporary handoff and approve Discord from another, unfiltered device.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 10),
                      OutlinedButton.icon(
                        onPressed: _busy ? null : _submitRemote,
                        icon: const Icon(Icons.devices_outlined, size: 18),
                        label: const Text('Use another device'),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          const Icon(Icons.key_outlined, size: 16),
                          const SizedBox(width: 8),
                          Text(
                            'Legacy access',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _accountIdController,
                        enabled: !_busy,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'account id',
                          prefixIcon: Icon(Icons.badge_outlined, size: 18),
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _tokenController,
                        enabled: !_busy,
                        autocorrect: false,
                        enableSuggestions: false,
                        obscureText: _obscureToken,
                        decoration: InputDecoration(
                          labelText: 'api token',
                          prefixIcon: const Icon(
                            Icons.password_outlined,
                            size: 18,
                          ),
                          suffixIcon: IconButton(
                            tooltip: _obscureToken
                                ? 'show token'
                                : 'hide token',
                            onPressed: () =>
                                setState(() => _obscureToken = !_obscureToken),
                            icon: Icon(
                              _obscureToken
                                  ? Icons.visibility_off
                                  : Icons.visibility,
                            ),
                          ),
                        ),
                        onSubmitted: (_) => _submitLegacy(),
                      ),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _busy ? null : _submitLegacy,
                        child: const Text('SIGN IN WITH LEGACY ACCESS'),
                      ),
                    ],
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
