//! Persists monthly data usage (bytes) **per account** so the shared 100GB
//! budget follows the account when you sign out/in. Port of Aura's
//! `UsageTracker` (Dart), but keyed by account id → month.
//!
//! File layout (in the Tauri app-data dir): `usage.json` →
//! `{ "<account_id>": { "2026-08": 123456789, "2026-09": ... }, ... }`

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::Datelike;

/// `YYYY-MM` — the key of the current calendar month.
pub fn month_key(now: &chrono::NaiveDate) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

fn usage_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join("usage.json")
}

fn load(app_dir: &PathBuf) -> BTreeMap<String, BTreeMap<String, i64>> {
    let path = usage_path(app_dir);
    if !path.exists() {
        return BTreeMap::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(app_dir: &PathBuf, data: &BTreeMap<String, BTreeMap<String, i64>>) {
    if let Some(parent) = usage_path(app_dir).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(data) {
        let _ = fs::write(usage_path(app_dir), json);
    }
}

/// Bytes used so far this month for a given account.
pub fn month_used(app_dir: &PathBuf, account_id: &str) -> i64 {
    let now = chrono::Local::now().date_naive();
    let key = month_key(&now);
    load(app_dir)
        .get(account_id)
        .and_then(|m| m.get(&key))
        .copied()
        .unwrap_or(0)
}

/// Add `delta` bytes to the current month for a given account and persist.
/// Prunes months older than the last 3 so the file stays tiny.
pub fn add(app_dir: &PathBuf, account_id: &str, delta: i64) {
    if delta <= 0 {
        return;
    }
    let now = chrono::Local::now().date_naive();
    let key = month_key(&now);
    let mut data = load(app_dir);
    let account = data.entry(account_id.to_string()).or_default();

    // Drop months older than the last 3 (keys sort chronologically).
    let months: Vec<String> = account.keys().cloned().collect();
    let keep_from = months.len().saturating_sub(3);
    for m in &months[..keep_from] {
        account.remove(m);
    }
    *account.entry(key).or_insert(0) += delta;
    save(app_dir, &data);
}
