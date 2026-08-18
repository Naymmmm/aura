import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Persists monthly data usage (bytes) in the support dir so the
/// shared 100GB budget is tracked across sessions, per calendar month.
///
/// File layout: `usage.json` → `{ "2026-08": 123456789, "2026-09": ... }`
class UsageTracker {
  Future<File> _file() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}${Platform.pathSeparator}usage.json');
  }

  /// "2026-08" — the key of the current calendar month.
  String get monthKey => DateTime.now().toIso8601String().substring(0, 7);

  Future<Map<String, int>> _load() async {
    final f = await _file();
    if (!await f.exists()) return {};
    try {
      final raw = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      return raw.map((k, v) => MapEntry(k, (v as num).toInt()));
    } catch (_) {
      return {}; // corrupt file — start fresh
    }
  }

  Future<void> _save(Map<String, int> data) async {
    final f = await _file();
    await f.writeAsString(jsonEncode(data));
  }

  /// Bytes used so far this month.
  Future<int> monthUsed() async {
    final data = await _load();
    return data[monthKey] ?? 0;
  }

  /// Add [delta] bytes to the current month and persist.
  Future<void> add(int delta) async {
    if (delta <= 0) return;
    final data = await _load();
    // prune anything older than 3 months so the file stays tiny
    final keys = data.keys.toList()..sort();
    while (keys.length > 3) {
      data.remove(keys.removeAt(0));
    }
    data[monthKey] = (data[monthKey] ?? 0) + delta;
    await _save(data);
  }
}
