use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

use log::{Level, LevelFilter, Metadata, Record};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

/// Appends to helper.log. Aura's own messages are kept from info up; the
/// userspace stack and other libraries only log errors, since they would
/// otherwise write per-flow lines into a file nobody rotates.
struct FileLogger(Mutex<File>);

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let max = if metadata.target().starts_with("aura_core") {
            Level::Info
        } else {
            Level::Error
        };
        metadata.level() <= max
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = OffsetDateTime::now_utc()
            .format(format_description!(
                "[year]/[month]/[day] [hour]:[minute]:[second]"
            ))
            .unwrap_or_default();
        if let Ok(mut file) = self.0.lock() {
            let _ = writeln!(file, "{now} {}", record.args());
        }
    }

    fn flush(&self) {}
}

pub fn init(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    log::set_boxed_logger(Box::new(FileLogger(Mutex::new(file))))
        .map(|()| log::set_max_level(LevelFilter::Info))
        .map_err(std::io::Error::other)
}

/// Formats a timestamp as RFC 3339 in UTC with whole seconds.
pub fn rfc3339(at: SystemTime) -> String {
    let at = OffsetDateTime::from(at);
    at.replace_nanosecond(0)
        .unwrap_or(at)
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn formats_rfc3339_without_fraction() {
        let at = UNIX_EPOCH + Duration::from_millis(1_760_400_000_123);
        assert_eq!(rfc3339(at), "2025-10-14T00:00:00Z");
    }
}
