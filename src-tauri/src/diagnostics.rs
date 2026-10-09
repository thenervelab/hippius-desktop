//! Build identity and crash capture for support diagnostics.
//!
//! Everything here exists to make a support-log bundle self-explanatory:
//! the startup banner and the bundle's `system-info.txt` say which build
//! produced the logs, and the panic hook makes a crash leave a trace in
//! the same rolling files the bundle ships. Without the hook a panic
//! prints only to stderr, which goes nowhere in a packaged app — the
//! single event support most needs is the one guaranteed to be missing.

use crate::release_channel::{self, ReleaseChannel};

/// The compile-time facts that identify a build: version, release lane,
/// and target platform. Both renderings — the `main.rs` banner's structured
/// fields and [`bundle_system_info`]'s `key: value` lines — read from one
/// instance, and each rendering is pinned by its own test
/// (`tests/diagnostics_wiring.rs` and `system_info_names_every_fact...`).
pub struct BuildIdentity {
    pub version: &'static str,
    pub channel: ReleaseChannel,
    pub os: &'static str,
    pub arch: &'static str,
}

/// The identity of the running binary.
pub fn build_identity() -> BuildIdentity {
    BuildIdentity {
        version: env!("CARGO_PKG_VERSION"),
        channel: release_channel::current(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// The `system-info.txt` body shipped inside every support-log bundle:
/// one `key: value` line per fact. Exists because the startup banner
/// rotates out of the seven-day log window on long-running installs, and
/// `bundled_at` lets support spot a skewed system clock against the
/// ticket's own timestamp.
pub fn bundle_system_info() -> String {
    let identity = build_identity();
    format!(
        "version: {}\nchannel: {}\nos: {}\narch: {}\nbundled_at: {}\n",
        identity.version,
        identity.channel,
        identity.os,
        identity.arch,
        chrono::Utc::now().to_rfc3339(),
    )
}

/// Best-effort text of a panic payload (`&'static str` or `String` — the
/// two shapes `panic!` produces; anything else gets a fixed marker).
pub fn panic_payload_str(payload: &(dyn std::any::Any + Send)) -> &str {
    if let Some(text) = payload.downcast_ref::<&'static str>() {
        text
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.as_str()
    } else {
        "<non-string panic payload>"
    }
}

/// The file a crash is written to at once, beside the rolling logs (so a
/// support bundle carries it): `~/.hippius/logs/crash.log`.
pub const CRASH_LOG_NAME: &str = "crash.log";
/// Past this size the crash file starts again, so it never grows unbounded.
pub const CRASH_LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Append `record` to the crash file at `path`, synchronously, starting the
/// file again once it is past [`CRASH_LOG_MAX_BYTES`]. Best effort: a crash
/// that cannot be written must not become a second one.
pub fn append_crash_record(path: &std::path::Path, record: &str) {
    use std::io::Write;

    let too_big = std::fs::metadata(path).is_ok_and(|m| m.len() > CRASH_LOG_MAX_BYTES);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!too_big)
        .truncate(too_big)
        .open(path);
    if let Ok(mut file) = file {
        let _ = file.write_all(record.as_bytes());
        let _ = file.sync_all();
    }
}

/// One crash record: when, which build, what, where, and the stack.
pub fn crash_record(what: &str, detail: &str, location: &str, thread: &str, backtrace: &str) -> String {
    let identity = build_identity();
    format!(
        "==== {} {} (version {}, {}, {} {})\n{detail}\nat {location} on thread {thread}\n{backtrace}\n",
        chrono::Utc::now().to_rfc3339(),
        what,
        identity.version,
        identity.channel,
        identity.os,
        identity.arch,
    )
}

/// Where the crash file goes: beside the rolling logs. `None` in tests (they
/// must not write to the real home) and without a home folder.
fn crash_log_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
    dirs::home_dir().map(|home| home.join(".hippius").join("logs").join(CRASH_LOG_NAME))
}

/// Routes every panic through `tracing` (payload, location, thread) before
/// chaining to the previously installed hook, so a crash lands in the
/// rolling log files a support bundle ships. Idempotent via `Once` so a
/// second call can never chain the hook to itself and double-log.
///
/// The `tracing` line rides the non-blocking file writer, which flushes
/// when `main`'s `WorkerGuard` drops during unwind. An abort-style death (a
/// panic inside a GTK or other C callback, which cannot unwind, or a double
/// panic in a `Drop`) skips destructors and loses that queued line. So the
/// hook ALSO appends the panic, with its backtrace, straight to
/// `~/.hippius/logs/crash.log` before anything else happens: the one record
/// that survives the process aborting right after.
pub fn install_panic_hook() {
    static INSTALL: std::sync::Once = std::sync::Once::new();

    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        let crash_file = crash_log_path();
        std::panic::set_hook(Box::new(move |info| {
            let location = info.location().map(std::string::ToString::to_string);
            let thread = std::thread::current();
            let payload = panic_payload_str(info.payload());
            let location = location.as_deref().unwrap_or("<unknown>");
            let thread_name = thread.name().unwrap_or("<unnamed>");
            if let Some(path) = &crash_file {
                let backtrace = std::backtrace::Backtrace::force_capture().to_string();
                append_crash_record(path, &crash_record("PANIC", payload, location, thread_name, &backtrace));
            }
            tracing::error!(
                payload = payload,
                location = location,
                thread = thread_name,
                "PANIC: the application panicked"
            );
            previous(info);
        }));
    });
}

/// How many GLib messages a minute reach the log; the rest are counted and
/// summed up in the next minute's first line. GTK can repeat a warning every
/// frame, which would crowd everything else out of the support bundle.
pub const GLIB_LINES_PER_MINUTE: u32 = 40;

/// The GLib message throttle: lines logged and dropped in the current minute.
#[derive(Debug, Default)]
pub struct GlibThrottle {
    minute: std::sync::atomic::AtomicU64,
    logged: std::sync::atomic::AtomicU32,
    dropped: std::sync::atomic::AtomicU32,
}

impl GlibThrottle {
    /// Whether a message in minute `minute` is logged; with it, how many were
    /// dropped in the minute before (to say so once).
    pub fn admit(&self, minute: u64) -> (bool, u32) {
        use std::sync::atomic::Ordering;

        let mut dropped_before = 0;
        if self.minute.swap(minute, Ordering::SeqCst) != minute {
            self.logged.store(0, Ordering::SeqCst);
            dropped_before = self.dropped.swap(0, Ordering::SeqCst);
        }
        if self.logged.fetch_add(1, Ordering::SeqCst) < GLIB_LINES_PER_MINUTE {
            (true, dropped_before)
        } else {
            self.dropped.fetch_add(1, Ordering::SeqCst);
            (false, dropped_before)
        }
    }
}

/// Linux: send GLib's own messages (GTK, GDK, GLib, GStreamer's GLib side)
/// into the app log instead of only stderr, which a desktop launch sends to
/// the journal at best. GTK reports a fatal X error or a misuse as a GLib
/// `ERROR` or `CRITICAL` and then aborts; the line before the abort is the
/// only explanation of an app that vanished, so those levels are also
/// written straight to the crash file. Installed once, after logging.
#[cfg(target_os = "linux")]
pub fn install_glib_log_bridge() {
    use gtk::glib::LogLevel;

    static INSTALL: std::sync::Once = std::sync::Once::new();
    static THROTTLE: std::sync::LazyLock<GlibThrottle> = std::sync::LazyLock::new(GlibThrottle::default);

    INSTALL.call_once(|| {
        let crash_file = crash_log_path();
        gtk::glib::log_set_default_handler(move |domain, level, message| {
            let domain = domain.unwrap_or("GLib");
            let fatal = matches!(level, LogLevel::Error | LogLevel::Critical);
            if fatal && let Some(path) = &crash_file {
                let thread = std::thread::current();
                append_crash_record(
                    path,
                    &crash_record(&format!("{domain}-{level:?}"), message, "GLib", thread.name().unwrap_or("<unnamed>"), ""),
                );
            }
            let minute = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs() / 60);
            let (admit, dropped) = THROTTLE.admit(minute);
            if dropped > 0 {
                tracing::warn!(dropped, "glib: messages dropped in the last minute");
            }
            if !admit && !fatal {
                return;
            }
            match level {
                LogLevel::Error | LogLevel::Critical => tracing::error!(domain, "glib: {message}"),
                LogLevel::Warning => tracing::warn!(domain, "glib: {message}"),
                LogLevel::Message | LogLevel::Info => tracing::info!(domain, "glib: {message}"),
                LogLevel::Debug => tracing::debug!(domain, "glib: {message}"),
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::capture_logs;

    #[test]
    fn payload_str_extracts_a_static_str() {
        let payload: Box<dyn std::any::Any + Send> = Box::new("boom-static");
        assert_eq!(panic_payload_str(payload.as_ref()), "boom-static");
    }

    #[test]
    fn payload_str_extracts_a_string() {
        // `panic!` with formatting args boxes a `String`, not a `&str`.
        let payload: Box<dyn std::any::Any + Send> = Box::new(format!("boom-{}", 42));
        assert_eq!(panic_payload_str(payload.as_ref()), "boom-42");
    }

    #[test]
    fn payload_str_names_a_non_string_payload() {
        let payload: Box<dyn std::any::Any + Send> = Box::new(7_u32);
        assert_eq!(panic_payload_str(payload.as_ref()), "<non-string panic payload>");
    }

    #[test]
    fn identity_carries_the_compiled_facts() {
        let identity = build_identity();
        assert_eq!(identity.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(identity.os, std::env::consts::OS);
        assert_eq!(identity.arch, std::env::consts::ARCH);
    }

    #[test]
    fn system_info_names_every_fact_on_its_own_line() {
        let info = bundle_system_info();
        for key in ["version:", "channel:", "os:", "arch:", "bundled_at:"] {
            assert!(info.lines().any(|line| line.starts_with(key)), "missing {key} line in: {info}");
        }
        assert!(info.contains(env!("CARGO_PKG_VERSION")), "version value missing: {info}");
    }

    #[test]
    fn a_crash_record_is_appended_at_once_and_the_file_starts_again_when_big() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join(CRASH_LOG_NAME);
        append_crash_record(&path, &crash_record("PANIC", "boom-one", "src/x.rs:1:1", "main", "frame 0"));
        append_crash_record(&path, &crash_record("Gdk-Error", "boom-two", "GLib", "main", ""));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("boom-one") && text.contains("boom-two"), "{text}");
        assert!(text.contains("src/x.rs:1:1") && text.contains("frame 0"), "{text}");
        assert!(text.contains(env!("CARGO_PKG_VERSION")), "the build is named: {text}");
        std::fs::write(&path, vec![b'x'; usize::try_from(CRASH_LOG_MAX_BYTES).unwrap() + 1]).unwrap();
        append_crash_record(&path, "fresh\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh\n");
    }

    #[test]
    fn glib_messages_are_capped_a_minute_and_the_drop_is_counted() {
        let throttle = GlibThrottle::default();
        for _ in 0..GLIB_LINES_PER_MINUTE {
            assert_eq!(throttle.admit(7), (true, 0));
        }
        assert_eq!(throttle.admit(7), (false, 0));
        assert_eq!(throttle.admit(7), (false, 0));
        assert_eq!(throttle.admit(8), (true, 2), "the next minute says how many were dropped");
    }

    #[test]
    fn tests_never_write_a_crash_file_in_the_real_home() {
        assert_eq!(crash_log_path(), None);
    }

    #[test]
    fn panic_hook_logs_payload_and_location() {
        install_panic_hook();

        let capture = capture_logs();
        let panic_result = std::panic::catch_unwind(|| panic!("boom-for-hook-test"));
        assert!(panic_result.is_err(), "the closure must actually panic");

        let text = capture.text();
        assert!(text.contains("ERROR"), "expected an error-level line: {text}");
        assert!(text.contains("boom-for-hook-test"), "payload missing from log: {text}");
        assert!(text.contains("diagnostics.rs"), "panic location missing from log: {text}");
    }
}
