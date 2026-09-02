enum AppLogLevel { info, warning, error }

class AppLogEntry {
  const AppLogEntry({
    required this.timestamp,
    required this.level,
    required this.message,
  });

  factory AppLogEntry.fromMessage(String message, {DateTime? timestamp}) {
    final normalized = message.toLowerCase();
    final level =
        normalized.contains('error') ||
            normalized.contains('failed') ||
            normalized.contains('exhausted') ||
            normalized.contains('stopped unexpectedly')
        ? AppLogLevel.error
        : normalized.contains('warning') ||
              normalized.contains('ignored') ||
              normalized.contains('recovering')
        ? AppLogLevel.warning
        : AppLogLevel.info;
    return AppLogEntry(
      timestamp: timestamp ?? DateTime.now(),
      level: level,
      message: message,
    );
  }

  final DateTime timestamp;
  final AppLogLevel level;
  final String message;

  String get formatted =>
      '${timestamp.toUtc().toIso8601String()} ${level.name.toUpperCase()} $message';
}
