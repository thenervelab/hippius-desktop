//! Guards on the desktop's half of hcfs's CPU-policy contract.
//!
//! hcfs hashes and encrypts on a rayon pool it owns, and that pool runs at
//! FULL priority on every core unless the embedding app opts out. The default
//! is correct for the CLI, e2e runs and benches — a library must not
//! deprioritise its host's work uninvited — which means the UI protection the
//! pinned rev exists to provide does not exist until `main.rs` asks for it.
//!
//! The failure is SILENT and total: drop the call and everything compiles,
//! every test passes, sync is correct, and adding a large folder pins every
//! core at default priority while the window stops painting. That is the
//! original bug, restored, with nothing anywhere reporting it. So the call is
//! pinned to the source, and the library contract the call's error branch
//! depends on is pinned to hcfs.

use std::fs;

use hcfs_client::cpu_pool::{self, CpuPolicy};

fn repo_file(relative: &str) -> String {
    let path = format!("{}/{relative}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {path}: {err}"))
}

/// `main` must opt into background CPU priority, before Tauri starts.
///
/// Ordering is the load-bearing half. The policy is read the first time the
/// pool is built and the first build wins, so a call that lands after any
/// scan, hash or encrypt is indistinguishable at runtime from never calling
/// it. Placing it ahead of `Builder::default()` keeps it ahead of every path
/// that could touch the pool.
#[test]
fn the_desktop_opts_into_background_cpu_priority() {
    let main_rs = repo_file("src/main.rs");

    let configure = main_rs.find("cpu_pool::configure(").expect(
        "src/main.rs never calls hcfs_client::cpu_pool::configure, so hcfs runs its hash/encrypt \
         pool at full priority on every core and adding a large folder freezes the window",
    );

    assert!(
        main_rs[configure..].starts_with("cpu_pool::configure(hcfs_client::cpu_pool::CpuPolicy::Background)"),
        "src/main.rs calls cpu_pool::configure with something other than CpuPolicy::Background; \
         Full is the batch-caller default and reserves nothing for the UI"
    );

    let builder = main_rs
        .find("Builder::default()")
        .expect("src/main.rs must build the Tauri app with Builder::default()");
    assert!(
        configure < builder,
        "src/main.rs configures the hcfs CPU policy AFTER Builder::default(); the policy is read \
         when the pool is first built, so a later call is silently the same as no call"
    );
}

/// The error branch that call relies on must keep existing.
///
/// `main.rs` logs a warning when `configure` reports the policy was already
/// fixed — that warning is the only signal distinguishing "the cap applied"
/// from "the cap silently did not". If hcfs ever made a late `configure`
/// succeed, or made it idempotent, the branch would go dead and the desktop
/// would be back to an invisible failure with no code change of its own.
///
/// Deliberately the only test in this binary that touches the policy: it is a
/// process-wide `OnceLock`, so a second caller anywhere would race it.
#[test]
fn a_late_configure_reports_the_policy_in_force() {
    cpu_pool::configure(CpuPolicy::Background).expect("the first configure in a fresh process must win");

    assert_eq!(
        cpu_pool::configure(CpuPolicy::Full),
        Err(CpuPolicy::Background),
        "a second configure must report the policy actually in force, not quietly succeed — \
         main.rs's warning is the only thing that would tell us the UI cap never applied"
    );
}
