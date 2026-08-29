//! `--version` / `-V` must exit before the Tauri app boots.
//!
//! `/usr/bin/Hippius --version` used to run dotenv, tracing (creating
//! `~/.hippius/logs`), the CPU pool, the builder, DB init and the tray
//! prewarm — the full desktop. The only CLI early-exit was `--finder-share`.
//! A source pin, not a process spawn: booting the binary is the bug.

/// Brace-matched body of the item whose signature contains `sig`.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[body_start..=body_start + i];
                }
            }
            _ => {}
        }
    }
    panic!("`{sig}` body never closes");
}

fn main_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).expect("read main.rs")
}

/// `--version` / `-V` must be handled inside `main` *before* `load_env` or
/// `Builder::default()`, or the flag still starts the full app (H-013).
/// The flag strings live in `cli.rs`; `main` must call that helper, not a
/// later comment.
#[test]
fn version_flag_exits_before_the_app_boots() {
    let src = main_src();
    let body = fn_body(&src, "fn main(");

    let version_at = body
        .find("argv_requests_version")
        .expect("main delegates --version to cli::argv_requests_version");
    let write_at = body.find("write_version(").expect("main writes the version via cli::write_version");
    let load_env_at = body.find("load_env(").expect("load_env in main");
    let logging_at = body.find("init_logging(").expect("init_logging in main");
    let cpu_at = body.find("cpu_pool::configure(").expect("cpu_pool::configure in main");
    let builder_at = body.find("Builder::default()").expect("Tauri builder in main");

    assert!(
        body[version_at..write_at + "write_version(".len()].contains("skip(1)"),
        "version argv must skip argv[0]; otherwise a binary named -V would always exit",
    );
    assert!(version_at < load_env_at && write_at < load_env_at, "--version must run before load_env()");
    assert!(
        version_at < logging_at && write_at < logging_at,
        "--version must run before init_logging(), which creates ~/.hippius/logs",
    );
    assert!(
        version_at < cpu_at && write_at < cpu_at,
        "--version must run before cpu_pool::configure()",
    );
    assert!(
        version_at < builder_at && write_at < builder_at,
        "--version must run before Builder::default(), or the flag still \
         starts the desktop",
    );
    assert!(
        body[write_at..load_env_at].contains("return;"),
        "version path must return from main, not process::exit, so a piped stdout flush lands",
    );

    let cli = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/cli.rs")).expect("read cli.rs");
    assert!(cli.contains("\"--version\""), "cli.rs must match the --version flag");
    assert!(cli.contains("\"-V\""), "cli.rs must match the -V flag");
    assert!(
        cli.contains("CARGO_PKG_VERSION"),
        "version output must come from CARGO_PKG_VERSION (kept in sync with tauri.conf by release_lane_pins)",
    );
    assert!(
        cli.contains("writeln!"),
        "version output must use writeln! — the crate denies println!/print_stdout",
    );
    assert!(
        cli.contains("out.flush()"),
        "write_version must flush; process::exit would drop a piped buffer",
    );
}

/// `--finder-share` is a file-manager action that must still win when both
/// flags appear. The version check therefore sits *after* that block.
#[test]
fn finder_share_still_wins_over_version() {
    let src = main_src();
    let body = fn_body(&src, "fn main(");

    let finder_at = body.find("\"--finder-share\"").expect("--finder-share still handled in main");
    let version_at = body
        .find("argv_requests_version")
        .expect("main delegates --version to cli::argv_requests_version");

    assert!(
        finder_at < version_at,
        "--finder-share must be inspected before --version so a share click \
         is never turned into a version print",
    );
}
