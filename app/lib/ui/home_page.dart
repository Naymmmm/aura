import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../ui/aura_lines.dart';
import 'logs_page.dart';
import 'server_tile.dart';

/// Main screen: big connect button, meme status, server list, live stats.
class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: state,
          builder: (context, _) {
            final cfg = state.serverConfig;
            final servers = cfg?.servers ?? const [];

            return Column(
              children: [
                _Header(state: state),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    children: [
                      _StatusCard(state: state),
                      const SizedBox(height: 16),
                      _StatsRow(state: state),
                      const SizedBox(height: 16),
                      _BudgetBar(state: state),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Text('servers', style: theme.textTheme.titleMedium),
                          const Spacer(),
                          IconButton(
                            tooltip: 'refresh config (bypasses cache)',
                            onPressed: state.refreshConfig,
                            icon: const Icon(Icons.refresh, size: 18),
                          ),
                        ],
                      ),
                      if (servers.isEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 24),
                          child: Center(
                            child: Text(
                              state.phase == VpnPhase.error
                                  ? 'no config loaded — tap refresh. blame the cloud, not me fr'
                                  : 'no servers yet — press the big button',
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                            ),
                          ),
                        )
                      else
                        ...servers.map(
                          (s) => Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: ServerTile(
                              server: s,
                              latencyMs: state.latencies[s.tag],
                              isActive: state.activeServer == s.tag,
                              isSelected: state.activeServer == null,
                            ),
                          ),
                        ),
                      const SizedBox(height: 24),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(Icons.auto_awesome, color: theme.colorScheme.primary),
          ),
          const SizedBox(width: 10),
          Text('AURA', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900, letterSpacing: 2)),
          const Spacer(),
          IconButton(
            tooltip: 'log out',
            onPressed: state.logout,
            icon: const Icon(Icons.logout),
          ),
          IconButton(
            tooltip: 'logs',
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => LogsPage(state: state))),
            icon: const Icon(Icons.terminal),
          ),
        ],
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final (phaseColor, icon, line, sub) = switch (state.phase) {
      VpnPhase.loggedOut => (
          theme.colorScheme.onSurfaceVariant,
          Icons.lock_outline,
          AuraLines.pick(AuraLines.loggedOut),
          'log in to unlock the aura',
        ),
      VpnPhase.disconnected => (
          theme.colorScheme.onSurfaceVariant,
          Icons.power_settings_new,
          AuraLines.pick(AuraLines.disconnected),
          'tap to ascend',
        ),
      VpnPhase.fetchingConfig => (
          theme.colorScheme.tertiary,
          Icons.cloud_download,
          'fetching the config...',
          'checking in with api.copal.run',
        ),
      VpnPhase.connecting => (
          theme.colorScheme.tertiary,
          Icons.hourglass_top,
          AuraLines.pick(AuraLines.connecting),
          'elevated core is spawning',
        ),
      VpnPhase.connected => (
          theme.colorScheme.primary,
          Icons.verified_user,
          AuraLines.pick(AuraLines.connected, state.activeServer?.hashCode),
          'via ${state.activeServer ?? '?'} — ${_fmtBytes(state.downBytes)} down',
        ),
      VpnPhase.error => (
          theme.colorScheme.error,
          Icons.error_outline,
          AuraLines.pick(AuraLines.error),
          state.statusLine ?? 'something broke fr',
        ),
    };

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          colors: [
            theme.colorScheme.surfaceContainerHigh,
            theme.colorScheme.surfaceContainerLow,
          ],
        ),
        border: Border.all(color: phaseColor.withValues(alpha: 0.35)),
      ),
      child: Column(
        children: [
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            child: Icon(icon, key: ValueKey(icon), size: 44, color: phaseColor),
          ),
          const SizedBox(height: 12),
          Text(
            line,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 4),
          Text(
            sub,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 16),
          _ConnectButton(state: state),
        ],
      ),
    );
  }
}

/// Shared monthly budget meter: usage vs budgetGb from the Worker config.
class _BudgetBar extends StatelessWidget {
  const _BudgetBar({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (state.budgetBytes == 0) return const SizedBox.shrink();
    final frac = state.budgetFraction.clamp(0.0, 1.0).toDouble();
    final color = state.overBudget
        ? theme.colorScheme.error
        : state.budgetWarn
            ? theme.colorScheme.tertiary
            : theme.colorScheme.primary;
    final line = state.overBudget
        ? AuraLines.pick(AuraLines.budgetOver)
        : state.budgetWarn
            ? AuraLines.pick(AuraLines.budgetLow)
            : AuraLines.pick(AuraLines.budget);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.data_usage, size: 14, color: color),
            const SizedBox(width: 6),
            Text(
              '${_fmtBytes(state.monthUsed)} / ${_fmtBytes(state.budgetBytes)} this month',
              style: theme.textTheme.labelMedium,
            ),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: frac,
            minHeight: 6,
            color: color,
            backgroundColor: theme.colorScheme.surfaceContainerHighest,
          ),
        ),
        const SizedBox(height: 6),
        Text(line, style: theme.textTheme.labelSmall?.copyWith(color: color)),
      ],
    );
  }
}

class _ConnectButton extends StatelessWidget {
  const _ConnectButton({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isBusy = state.phase == VpnPhase.connecting || state.phase == VpnPhase.fetchingConfig;
    final isConnected = state.phase == VpnPhase.connected;

    return FilledButton.icon(
      style: FilledButton.styleFrom(
        minimumSize: const Size(double.infinity, 52),
        backgroundColor: isConnected
            ? theme.colorScheme.errorContainer
            : theme.colorScheme.primary,
        foregroundColor: isConnected
            ? theme.colorScheme.onErrorContainer
            : theme.colorScheme.onPrimary,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      onPressed: isBusy
          ? null
          : () => isConnected ? state.disconnect() : state.connect(),
      icon: isBusy
          ? const SizedBox(
              width: 18, height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(isConnected ? Icons.stop_circle : Icons.play_arrow),
      label: Text(
        isBusy ? '...' : isConnected ? 'DISCONNECT' : 'CONNECT',
        style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2),
      ),
    );
  }
}

class _StatsRow extends StatelessWidget {
  const _StatsRow({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        _statChip(theme, Icons.arrow_upward, _fmtBytes(state.upBytes)),
        const SizedBox(width: 8),
        _statChip(theme, Icons.arrow_downward, _fmtBytes(state.downBytes)),
        const Spacer(),
        if (state.activeServer != null)
          _statChip(theme, Icons.wifi_tethering, '${state.activeServer} locked in'),
      ],
    );
  }

  Widget _statChip(ThemeData theme, IconData icon, String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 4),
          Text(text, style: theme.textTheme.labelMedium),
        ],
      ),
    );
  }
}

String _fmtBytes(int n) {
  if (n >= 1 << 30) return '${(n / (1 << 30)).toStringAsFixed(1)} GB';
  if (n >= 1 << 20) return '${(n / (1 << 20)).toStringAsFixed(1)} MB';
  if (n >= 1 << 10) return '${(n / (1 << 10)).toStringAsFixed(0)} KB';
  return '$n B';
}
