//! Build identity and crash capture for support diagnostics.
//!
//! Everything here exists to make a support-log bundle self-explanatory:
//! the startup banner and the bundle's `system-info.txt` say which build
//! produced the logs, and the panic hook makes a crash leave a trace in
//! the same rolling files the bundle ships. Without the hook a panic
//! prints only to stderr, which goes nowhere in a packaged app — the
//! single event support most needs is the one guaranteed to be missing.

use std::fmt;

use crate::release_channel::{self, ReleaseChannel};

/// The compile-time facts that identify a build: version, release lane,
/// and target platform. One instance feeds both the startup banner and
/// [`bundle_system_info`], so the two can never disagree.
pub struct BuildIdentity {
    pub version: &'static str,
    pub channel: ReleaseChannel,
    pub os: &'static str,
    pub arch: &'static str,
}

impl fmt::Display for BuildIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hippius {} ({}) on {}/{}", self.version, self.channel, self.os, self.arch)
    }
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

/// Routes every panic through `tracing` (payload, location, thread) before
/// chaining to the previously installed hook, so a crash lands in the
/// rolling log files a support bundle ships. Idempotent via `Once` so a
/// second call can never chain the hook to itself and double-log.
pub fn install_panic_hook() {
    static INSTALL: std::sync::Once = std::sync::Once::new();

    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info.location().map(std::string::ToString::to_string);
            let thread = std::thread::current();
            tracing::error!(
                payload = panic_payload_str(info.payload()),
                location = location.as_deref().unwrap_or("<unknown>"),
                thread = thread.name().unwrap_or("<unnamed>"),
                "PANIC: the application panicked"
            );
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::capture_subscriber;

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
    fn identity_line_is_self_describing() {
        let identity = build_identity();
        let line = identity.to_string();
        assert!(line.contains(env!("CARGO_PKG_VERSION")), "version missing: {line}");
        assert!(line.contains(std::env::consts::OS), "os missing: {line}");
        assert!(line.contains(std::env::consts::ARCH), "arch missing: {line}");
        assert!(line.contains(&identity.channel.to_string()), "channel missing: {line}");
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
    fn panic_hook_logs_payload_and_location() {
        install_panic_hook();

        let (subscriber, writer, _capture_guard) = capture_subscriber();
        let panic_result = tracing::subscriber::with_default(subscriber, || std::panic::catch_unwind(|| panic!("boom-for-hook-test")));
        assert!(panic_result.is_err(), "the closure must actually panic");

        let text = writer.text();
        assert!(text.contains("ERROR"), "expected an error-level line: {text}");
        assert!(text.contains("boom-for-hook-test"), "payload missing from log: {text}");
        assert!(text.contains("diagnostics.rs"), "panic location missing from log: {text}");
    }
}
