import 'package:flutter/material.dart';

import '../state/app_state.dart';

/// Tail of the app's event log (connect switches, errors, config refreshes).
class LogsPage extends StatelessWidget {
  const LogsPage({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('logs — no cap detected'), backgroundColor: theme.colorScheme.surface),
      body: ListenableBuilder(
        listenable: state,
        builder: (context, _) {
          final logs = state.logs;
          if (logs.isEmpty) {
            return const Center(child: Text('nothing logged yet. silence is aura'));
          }
          return ListView.builder(
            padding: const EdgeInsets.all(16),
            itemCount: logs.length,
            itemBuilder: (context, i) => Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                logs[i],
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
