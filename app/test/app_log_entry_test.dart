import 'package:aura/models/app_log_entry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'classifies error and warning messages for structured log filtering',
    () {
      expect(
        AppLogEntry.fromMessage('ERROR helper stopped').level,
        AppLogLevel.error,
      );
      expect(
        AppLogEntry.fromMessage('disconnect warning: timeout').level,
        AppLogLevel.warning,
      );
      expect(
        AppLogEntry.fromMessage('connected via romeo').level,
        AppLogLevel.info,
      );
    },
  );

  test('formats a copyable timestamped log line', () {
    final entry = AppLogEntry(
      timestamp: DateTime.utc(2026, 9, 2, 6, 7, 8, 9),
      level: AppLogLevel.info,
      message: 'connected via romeo',
    );

    expect(
      entry.formatted,
      '2026-09-02T06:07:08.009Z INFO connected via romeo',
    );
  });
}
