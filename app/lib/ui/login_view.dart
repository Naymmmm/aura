import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/app_state.dart';
import 'aura_lines.dart';

/// Login gate: account id + API token (the creds the admin gave you).
/// No emails, no passwords, no external auth — just the token.
/// Also: self-service signup (account starts with zero credit) and the rules.
class LoginView extends StatefulWidget {
  const LoginView({super.key, required this.state});

  final AppState state;

  @override
  State<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends State<LoginView> {
  final _idCtrl = TextEditingController();
  final _tokCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  bool _obscure = true;
  bool _remember = true;
  bool _busy = false;
  String? _errorLine;

  bool _signupMode = false; // toggles login ⇄ self-service signup
  bool _signupBusy = false;
  String? _signupErr;
  ({String accountId, String token})? _signedUp; // shown once

  @override
  void initState() {
    super.initState();
    // Prefill anything still on disk (e.g. after a failed logout flow).
    widget.state.savedCreds().then((c) {
      if (c != null && mounted) {
        _idCtrl.text = c.accountId;
        _tokCtrl.text = c.token;
      }
    });
  }

  @override
  void dispose() {
    _idCtrl.dispose();
    _tokCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final id = _idCtrl.text.trim();
    final tok = _tokCtrl.text.trim();
    if (id.isEmpty || tok.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _errorLine = null;
    });
    final ok = await widget.state.login(id, tok, remember: _remember);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _errorLine = AuraLines.authError(widget.state.authError);
    });
  }

  Future<void> _signup() async {
    if (_signupBusy) return;
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _signupErr = 'pick a name for the account first');
      return;
    }
    setState(() {
      _signupBusy = true;
      _signupErr = null;
    });
    final creds = await widget.state.signup(name);
    if (!mounted) return;
    setState(() {
      _signupBusy = false;
      if (creds != null) {
        _signedUp = creds;
        // prefill the login form so it's one tap back
        _idCtrl.text = creds.accountId;
        _tokCtrl.text = creds.token;
      } else {
        final err = AuraLines.authError(widget.state.authError);
        _signupErr = err.isEmpty
            ? 'signup failed — check your connection'
            : err;
      }
    });
  }

  void _copyToClipboard(String text, String what) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('$what copied'),
        duration: const Duration(seconds: 2),
      ),
    );
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
                  Icon(
                    Icons.auto_awesome,
                    size: 48,
                    color: theme.colorScheme.primary,
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
                    _signupMode
                        ? 'create an account — the admin unlocks it'
                        : 'log in to unlock the network with aura',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 28),

                  if (_signupMode) ...[
                    if (_signedUp == null) ...[
                      TextField(
                        controller: _nameCtrl,
                        enabled: !_signupBusy,
                        autocorrect: false,
                        decoration: InputDecoration(
                          labelText: 'your name (who is this account for?)',
                          hintText: 'e.g. mateo',
                          prefixIcon: const Icon(
                            Icons.person_outline,
                            size: 20,
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        onSubmitted: (_) => _signup(),
                      ),
                      const SizedBox(height: 14),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(double.infinity, 52),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                        onPressed: _signupBusy ? null : _signup,
                        child: _signupBusy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text(
                                'CREATE ACCOUNT',
                                style: TextStyle(
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 1.2,
                                ),
                              ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        _signupErr ?? '',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.error,
                        ),
                      ),
                    ] else ...[
                      // token shown once — copy it before leaving this screen
                      Card(
                        color: theme.colorScheme.surfaceContainerHigh,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text(
                                'account created — token shown ONCE',
                                textAlign: TextAlign.center,
                                style: theme.textTheme.titleSmall?.copyWith(
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              const SizedBox(height: 12),
                              _credRow(
                                theme,
                                'account id',
                                _signedUp!.accountId,
                              ),
                              const SizedBox(height: 8),
                              _credRow(theme, 'api token', _signedUp!.token),
                              const SizedBox(height: 12),
                              Text(
                                'this account is dead until the admin adds credit (days) to it. log in below — you\'ll be told when it\'s live.',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 14),
                    ],
                    TextButton(
                      onPressed: _signupBusy
                          ? null
                          : () => setState(() {
                              _signupMode = false;
                              _signupErr = null;
                            }),
                      child: const Text('back to login'),
                    ),
                  ] else ...[
                    TextField(
                      controller: _idCtrl,
                      autofocus: true,
                      enabled: !_busy,
                      autocorrect: false,
                      decoration: InputDecoration(
                        labelText: 'account id',
                        hintText: 'e.g. testme01',
                        prefixIcon: const Icon(Icons.badge_outlined, size: 20),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      onSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _tokCtrl,
                      enabled: !_busy,
                      autocorrect: false,
                      obscureText: _obscure,
                      enableSuggestions: false,
                      decoration: InputDecoration(
                        labelText: 'api token',
                        prefixIcon: const Icon(Icons.key_outlined, size: 20),
                        suffixIcon: IconButton(
                          tooltip: _obscure ? 'show token' : 'hide token',
                          icon: Icon(
                            _obscure ? Icons.visibility_off : Icons.visibility,
                            size: 20,
                          ),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      onSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Checkbox(
                          value: _remember,
                          onChanged: _busy
                              ? null
                              : (v) => setState(() => _remember = v ?? true),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          'remember me on this machine',
                          style: theme.textTheme.bodySmall,
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    FilledButton(
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(double.infinity, 52),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text(
                              'ASCEND',
                              style: TextStyle(
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.2,
                              ),
                            ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      _errorLine ?? '',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                    ),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() {
                              _signupMode = true;
                              _signedUp = null;
                              _signupErr = null;
                            }),
                      child: const Text('no account yet? create one'),
                    ),
                  ],

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

  Widget _credRow(ThemeData theme, String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                Text(
                  value,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'copy $label',
            icon: const Icon(Icons.copy, size: 18),
            onPressed: () => _copyToClipboard(value, label),
          ),
        ],
      ),
    );
  }
}

/// The Rules — the owner's law. Non-negotiable.
class _RulesCard extends StatelessWidget {
  const _RulesCard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
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
