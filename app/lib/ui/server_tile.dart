import 'package:flutter/material.dart';

import '../models/server_info.dart';

/// A single server row: name, latency, active badge.
class ServerTile extends StatelessWidget {
  const ServerTile({
    super.key,
    required this.server,
    required this.latencyMs,
    required this.isActive,
    required this.isSelected,
  });

  final ServerInfo server;
  final int? latencyMs;
  final bool isActive;
  final bool isSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final Color tileColor;
    if (isActive) {
      tileColor = theme.colorScheme.primaryContainer.withValues(alpha: 0.55);
    } else if (isSelected) {
      tileColor = theme.colorScheme.surfaceContainerHighest;
    } else {
      tileColor = theme.colorScheme.surfaceContainerLow;
    }

    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      decoration: BoxDecoration(
        color: tileColor,
        borderRadius: BorderRadius.circular(12),
        border: isActive
            ? Border.all(color: theme.colorScheme.primary, width: 1.5)
            : null,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: theme.colorScheme.primary.withValues(alpha: 0.15),
            child: Icon(
              Icons.shield_outlined,
              size: 18,
              color: theme.colorScheme.primary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(server.label, style: theme.textTheme.titleSmall),
                    if (isActive) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.primary,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          'MOGGING',
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onPrimary,
                            fontSize: 9,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  server.host,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
          _LatencyChip(latency: latencyMs, isActive: isActive),
        ],
      ),
    );
  }
}

class _LatencyChip extends StatelessWidget {
  const _LatencyChip({required this.latency, required this.isActive});

  final int? latency;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = latency;
    if (l == null) {
      return Text(
        '---',
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }

    final color = l < 120
        ? Colors.greenAccent
        : l < 250
        ? Colors.amberAccent
        : Colors.redAccent;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.bolt, size: 14, color: color),
        const SizedBox(width: 2),
        Text(
          '${l}ms',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: color,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}
