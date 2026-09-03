import 'dart:io';

import 'package:flutter/material.dart';

import '../services/session_service.dart';
import '../state/app_state.dart';
import '../ui/aura_lines.dart';
import 'logs_page.dart';
import 'server_tile.dart';
import 'aura_mark.dart';

/// Main screen: big connect button, meme status, server list, live stats.
class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: ColoredBox(
        color: theme.colorScheme.surface,
        child: SafeArea(
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
                            const SizedBox(width: 8),
                            Text(
                              state.phase == VpnPhase.connected
                                  ? 'locked while connected'
                                  : 'choose one',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
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
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
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
                                isSelected: state.selectedServerTag == s.tag,
                                locked:
                                    state.phase == VpnPhase.connected ||
                                    state.phase == VpnPhase.connecting,
                                onTap: () => state.selectServer(s.tag),
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
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: theme.colorScheme.primary,
              borderRadius: BorderRadius.circular(13),
            ),
            child: AuraMark(size: 28, color: theme.colorScheme.onPrimary),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'AURA',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w900,
                  letterSpacing: 3,
                ),
              ),
              Text(
                '(v26.1.0)',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                  letterSpacing: 1.1,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (state.accountStatus case final account?)
                Text(
                  '${account.plan == AccountPlan.freeTrial ? 'FREE TRIAL' : 'STANDARD'} • ${account.budgetGb} GB • ${account.displayName}',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: account.plan == AccountPlan.freeTrial
                        ? theme.colorScheme.tertiary
                        : theme.colorScheme.primary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
            ],
          ),
          const Spacer(),
          // Auto-update: chip → download+verify → install (swap + relaunch).
          if (state.updateVersion != null)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: _UpdateChip(state: state),
            ),
          IconButton(
            tooltip: 'log out',
            onPressed: state.logout,
            icon: const Icon(Icons.logout),
          ),
          IconButton(
            tooltip: 'logs',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => LogsPage(state: state)),
            ),
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
        'starting the local Aura helper',
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
      padding: const EdgeInsets.fromLTRB(22, 24, 22, 20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [phaseColor.withValues(alpha: 0.16), const Color(0xCC111422)],
        ),
        border: Border.all(color: phaseColor.withValues(alpha: 0.42)),
        boxShadow: [
          BoxShadow(
            color: phaseColor.withValues(alpha: 0.09),
            blurRadius: 32,
            spreadRadius: 2,
          ),
        ],
      ),
      child: Column(
        children: [
          _ConnectButton(state: state, color: phaseColor, icon: icon),
          const SizedBox(height: 18),
          Text(
            line,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            sub,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
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
  const _ConnectButton({
    required this.state,
    required this.color,
    required this.icon,
  });
  final AppState state;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final isBusy =
        state.phase == VpnPhase.connecting ||
        state.phase == VpnPhase.fetchingConfig;
    final isConnected = state.phase == VpnPhase.connected;

    return Semantics(
      button: true,
      label: isConnected ? 'Disconnect' : 'Connect',
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: isBusy
            ? null
            : () => isConnected ? state.disconnect() : state.connect(),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 280),
          width: 92,
          height: 92,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: 0.14),
            border: Border.all(color: color.withValues(alpha: 0.75), width: 2),
            boxShadow: [
              BoxShadow(color: color.withValues(alpha: 0.24), blurRadius: 26),
            ],
          ),
          child: isBusy
              ? Padding(
                  padding: const EdgeInsets.all(29),
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: color,
                  ),
                )
              : Icon(
                  isConnected ? Icons.power_settings_new : icon,
                  size: 38,
                  color: color,
                ),
        ),
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
          _statChip(
            theme,
            Icons.wifi_tethering,
            '${state.activeServer} locked in',
          ),
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

/// Auto-update chip: shows when a newer release exists. Tap → download +
/// verify (checksum gate), then a second tap installs (swap + relaunch).
class _UpdateChip extends StatelessWidget {
  const _UpdateChip({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final updating = state.updating;
    final staged = state.updateStaged;
    final label = staged
        ? 'restart to install'
        : updating
        ? 'fetching…'
        : '⬆ ${state.updateVersion}';
    return Material(
      color: theme.colorScheme.primary.withValues(alpha: 0.15),
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () async {
          if (updating) return;
          if (staged) {
            await state.installUpdate();
            // The updater script waits for this process to die, swaps the
            // files and relaunches the new build.
            exit(0);
          } else {
            state.downloadUpdate();
          }
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (updating)
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  Icons.system_update_alt,
                  size: 14,
                  color: theme.colorScheme.primary,
                ),
              const SizedBox(width: 6),
              Text(
                label,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: theme.colorScheme.primary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
