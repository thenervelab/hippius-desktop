//! Static pins: the desktop's blocking drive-lock sites go through
//! `hcfs_client::engine::lock_drive`.
//!
//! `lock_drive` logs every wait of one second or more with the drive and a
//! waiter name. hcfs issue #1130 decides whether drives move to an owner task
//! from a week of those lines, so a site that locks the manager directly is a
//! wait that decision never sees (hippius-desktop #722). The `try_lock` sites
//! (`synced_state.rs`, `recent.rs`, `control.rs`) never wait and stay as they
//! are. Same idiom as `tests/failure_commands_wiring.rs`.
//!
//! The pin covers the files listed below and nothing else: a new drive-lock
//! site in another file needs adding here.

/// The file's source with all whitespace removed, so a lock chain rustfmt
/// splits across lines (`arc\n    .lock()\n    .await`) still matches.
fn compact_source(path: &str) -> String {
    let full = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    let src = std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("read {full}: {e}"));
    src.split_whitespace().collect()
}

#[test]
fn drive_manager_locks_are_counted_by_lock_drive() {
    // Every `.lock().await` these files had was a drive-manager lock.
    for path in [
        "src/sync/drive/selective.rs",
        "src/sync/failure/failure_commands.rs",
        "src/sync/migrate/relative_path_backfill.rs",
        "src/sync/shared/mnemonic.rs",
    ] {
        let src = compact_source(path);
        assert_eq!(src.matches(".lock().await").count(), 0, "{path} locks a drive manager without lock_drive");
        assert!(src.contains("lock_drive("), "{path} no longer calls lock_drive; update this pin");
    }

    // lifecycle.rs also takes the commit lock and test-only locks directly,
    // so only the reconcile task's manager lock is pinned there.
    let lifecycle = compact_source("src/sync/drive/lifecycle.rs");
    assert!(
        !lifecycle.contains("manager_arc.lock()"),
        "the reconcile task locks the drive manager without lock_drive"
    );
    assert!(
        lifecycle.contains("lock_drive(&manager_arc"),
        "the reconcile task no longer calls lock_drive; update this pin"
    );
}
