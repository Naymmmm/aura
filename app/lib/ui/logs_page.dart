import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/app_log_entry.dart';
import '../state/app_state.dart';

class LogsPage extends StatefulWidget {
  const LogsPage({super.key, required this.state});

  final AppState state;

  @override
  State<LogsPage> createState() => _LogsPageState();
}

class _LogsPageState extends State<LogsPage> {
  final _query = TextEditingController();
  AppLogLevel? _level;

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Diagnostics'),
        actions: [
          IconButton(
            tooltip: 'copy visible logs',
            onPressed: _copyVisible,
            icon: const Icon(Icons.copy_all_outlined),
          ),
          IconButton(
            tooltip: 'clear logs',
            onPressed: widget.state.clearLogs,
            icon: const Icon(Icons.delete_sweep_outlined),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          final entries = _visible;
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _query,
                        onChanged: (_) => setState(() {}),
                        decoration: const InputDecoration(
                          hintText: 'Search diagnostics',
                          prefixIcon: Icon(Icons.search),
                          isDense: true,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    DropdownButton<AppLogLevel?>(
                      value: _level,
                      hint: const Text('All levels'),
                      items: [
                        const DropdownMenuItem(
                          value: null,
                          child: Text('All levels'),
                        ),
                        for (final level in AppLogLevel.values)
                          DropdownMenuItem(
                            value: level,
                            child: Text(level.name),
                          ),
                      ],
                      onChanged: (value) => setState(() => _level = value),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: entries.isEmpty
                    ? const Center(child: Text('No matching diagnostics'))
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
                        itemCount: entries.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 6),
                        itemBuilder: (context, index) {
                          final entry = entries[index];
                          final color = switch (entry.level) {
                            AppLogLevel.info => theme.colorScheme.primary,
                            AppLogLevel.warning => Colors.amberAccent,
                            AppLogLevel.error => theme.colorScheme.error,
                          };
                          return Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.surfaceContainerLow,
                              borderRadius: BorderRadius.circular(12),
                              border: Border(
                                left: BorderSide(color: color, width: 3),
                              ),
                            ),
                            child: SelectableText(
                              entry.formatted,
                              style: theme.textTheme.bodySmall?.copyWith(
                                fontFamily: 'monospace',
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  List<AppLogEntry> get _visible {
    final query = _query.text.trim().toLowerCase();
    return widget.state.logs.where((entry) {
      return (_level == null || entry.level == _level) &&
          (query.isEmpty || entry.formatted.toLowerCase().contains(query));
    }).toList();
  }

  Future<void> _copyVisible() async {
    await Clipboard.setData(
      ClipboardData(text: _visible.map((entry) => entry.formatted).join('\n')),
    );
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Visible diagnostics copied')));
  }
}
