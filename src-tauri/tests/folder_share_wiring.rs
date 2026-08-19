//! Source-text wiring pins for the folder-share guards.
//!
//! The settled-folder check and the size cap are only worth anything if they
//! are actually CALLED. Their logic is unit-tested in isolation
//! (`folder_settlement`, `enforce_folder_share_limits`), and those tests stay
//! green if a refactor drops the call site — which is exactly how a guard dies
//! quietly. This mirrors the convention already used by
//! `tests/keep_awake_wiring.rs` and the `spawn_backfill` pin in
//! `tests/hippius_relative_path_backfill.rs`.
//!
//! Both guards deliberately live in `share_directory_as_zip` rather than in the
//! IPC command, because the file-manager right-click calls that function
//! directly. A guard in the command would leave that path unprotected.

/// Body of `share_directory_as_zip`, from its signature to the end of the
/// function that follows it in the file.
fn share_directory_as_zip_body() -> String {
    let source = include_str!("../src/shares/commands.rs");
    let start = source
        .find("pub(crate) async fn share_directory_as_zip")
        .expect("share_directory_as_zip must exist in shares/commands.rs");
    let rest = &source[start..];
    // The next top-level `#[tauri::command]` or `pub` fn bounds the body well
    // enough for a source pin; we only need to avoid scanning the whole file.
    let end = rest[1..].find("\n/// ").map_or(rest.len(), |i| i + 1);
    rest[..end].to_string()
}

#[test]
fn the_zip_funnel_enforces_the_size_cap() {
    let body = share_directory_as_zip_body();
    assert!(
        body.contains("enforce_folder_share_limits"),
        "share_directory_as_zip must enforce the folder-share size cap; without this call a click on \
         an enormous tree fills the temp disk and starts an unbounded upload"
    );
}

#[test]
fn the_zip_funnel_runs_the_settled_folder_guard() {
    let body = share_directory_as_zip_body();
    assert!(
        body.contains("folder_is_settled"),
        "share_directory_as_zip must resolve the folder's settlement state"
    );
    assert!(
        body.contains("folder_settlement_blocks_share"),
        "share_directory_as_zip must refuse an unsettled folder; without this call a half-downloaded \
         folder is zipped incomplete and published, which is the failure the guard exists to prevent"
    );
}

#[test]
fn the_settled_guard_reads_the_resolved_path_not_the_caller_argument() {
    let body = share_directory_as_zip_body();
    // The guard must be fed the drive/rel-path resolved from `dir_path`, which
    // is canonical. Feeding it a caller-supplied string lets a non-canonical
    // spelling ("a//b", a case variant) match zero synced paths and report
    // Settled having checked nothing.
    assert!(
        body.contains("resolve_share_target(dir_path"),
        "the drive must be resolved from the canonical dir_path, not from a caller-supplied string"
    );
}
