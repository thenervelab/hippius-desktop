//! Pins the `main.rs` diagnostics wiring: the panic hook and the identity
//! banner. Both are single call sites that nothing else exercises — losing
//! either is silent until the next crash or support ticket, so the wiring
//! itself is pinned the same way `cli_version_wiring.rs` pins `--version`.

const MAIN_RS: &str = include_str!("../src/main.rs");

/// The panic hook must be installed right after logging comes up: earlier
/// and the `error!` it emits has no subscriber; missing entirely and a crash
/// leaves no trace in the rolling files a support bundle ships.
#[test]
fn main_installs_the_panic_hook_after_logging_init() {
    let logging = MAIN_RS.find("let _log_guard = init_logging();").expect("main must initialize logging");
    let hook = MAIN_RS
        .find("diagnostics::install_panic_hook();")
        .expect("main must install the panic hook");

    assert!(
        hook > logging,
        "the panic hook must be installed after logging init, so its error! has a subscriber"
    );
}

/// The startup banner is what makes a fresh log file name the build that
/// wrote it (version, channel, os, arch) — support's first question. The
/// pin must see the identity actually LOGGED at `info!`: a refactor that
/// keeps the `build_identity()` call but drops or demotes the log line
/// (debug! is filtered out by the default `warn,…,Hippius=info`) loses the
/// invariant silently.
#[test]
fn main_logs_the_build_identity_banner_at_info() {
    let identity = MAIN_RS
        .find("diagnostics::build_identity()")
        .expect("main must resolve the build identity");

    let banner = &MAIN_RS[identity..identity + 600.min(MAIN_RS.len() - identity)];
    assert!(banner.contains("info!"), "the identity must be logged at info!, got: {banner}");
    assert!(
        banner.contains("\"Application starting\""),
        "the banner message literal must survive: {banner}"
    );
    for field in ["version", "channel", "os", "arch"] {
        assert!(banner.contains(field), "banner must carry the {field} field: {banner}");
    }
}
