import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'aura_lines.dart';

/// Login gate: account id + API token (the creds the admin gave you).
/// No emails, no passwords, no external auth — just the token.
class LoginView extends StatefulWidget {
  const LoginView({super.key, required this.state});

  final AppState state;

  @override
  State<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends State<LoginView> {
  final _idCtrl = TextEditingController();
  final _tokCtrl = TextEditingController();
  bool _obscure = true;
  bool _remember = true;
  bool _busy = false;
  String? _errorLine;

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
                  Icon(Icons.auto_awesome, size: 48, color: theme.colorScheme.primary),
                  const SizedBox(height: 12),
                  Text(
                    'AURA',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineMedium
                        ?.copyWith(fontWeight: FontWeight.w900, letterSpacing: 4),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'log in to unlock the network with aura',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: 28),
                  TextField(
                    controller: _idCtrl,
                    autofocus: true,
                    enabled: !_busy,
                    autocorrect: false,
                    decoration: InputDecoration(
                      labelText: 'account id',
                      hintText: 'e.g. testme01',
                      prefixIcon: const Icon(Icons.badge_outlined, size: 20),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
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
                        icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility,
                            size: 20),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Checkbox(
                        value: _remember,
                        onChanged: _busy ? null : (v) => setState(() => _remember = v ?? true),
                      ),
                      const SizedBox(width: 4),
                      Text('remember me on this machine',
                          style: theme.textTheme.bodySmall),
                    ],
                  ),
                  const SizedBox(height: 14),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(double.infinity, 52),
                      shape:
                          RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('ASCEND',
                            style: TextStyle(
                                fontWeight: FontWeight.w800, letterSpacing: 1.2)),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    _errorLine ?? '',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.error),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
