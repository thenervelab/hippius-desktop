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
/// wrote it (version, channel, os, arch) — support's first question.
#[test]
fn main_logs_the_build_identity_banner() {
    assert!(
        MAIN_RS.contains("diagnostics::build_identity()"),
        "main must log the build-identity startup banner"
    );
}
