//! Regression pins for the reviewed-conflict sync completion path.
//!
//! Audit 2026-06-05, findings A1 (logic-bug) and A2 (test-gap):
//! `sync_with_conflict_resolutions` used to emit `SYNC_COMPLETED` directly
//! via `app.emit`, forking away from `TauriSyncBridge::on_event`'s
//! `SyncCompleted` arm and thereby skipping every per-label cleanup the
//! bridge performs (preparing-override clear, pending-upload banner clear,
//! per-file failure-counter recompute) and shipping a detail-less completion
//! notification. The fix extracts the cleanup + emit into the shared
//! `tauri_bridge::handle_sync_completed` helper that BOTH the auto-sync loop
//! and the reviewed path call.
//!
//! # Why a source-level (static) pin rather than a runtime one
//!
//! The completion path is `AppHandle`-bound: every cleanup step reaches
//! through `app.state::<AppState>()` and `app.emit`. Per `src-tauri/CLAUDE.md`
//! (project axiom 111) this codebase deliberately avoids the `tauri::test`
//! runtime harness — the bridge's emit arms are exercised at the side-effect
//! level instead (see `hippius_file_failed_event.rs`). The *behaviour* of the
//! shared helper is already covered by the `collect_cycle_files_*` and
//! `update_failure_counts` paths; what a regression would silently break is
//! the *wiring* — a future edit re-introducing a direct emit in `control.rs`.
//! This suite pins exactly that wiring, mirroring the static-trigger pin in
//! `hippius_relative_path_backfill.rs`. The resolution-string validation
//! contract is unit-tested as a pure function in `sync::control::tests`.

/// Source of the reviewed-conflict command, embedded at compile time.
const CONTROL_RS: &str = include_str!("../src/sync/control.rs");

/// The reviewed path MUST route completion through the shared bridge helper.
#[test]
fn reviewed_sync_routes_completion_through_the_bridge_helper() {
    assert!(
        CONTROL_RS.contains("handle_sync_completed"),
        "sync_with_conflict_resolutions must route its success arm through \
         tauri_bridge::handle_sync_completed so the reviewed path runs the same \
         per-label cleanup as the auto-sync loop (audit finding A1)"
    );
}

/// The reviewed path MUST NOT emit `SYNC_COMPLETED` directly — that is the
/// exact bypass finding A1 fixed. `control.rs` still legitimately emits
/// `SYNC_STARTED`/`SYNC_ERROR` directly, so this pin is scoped to the
/// completion event only.
#[test]
fn reviewed_sync_does_not_emit_sync_completed_directly() {
    assert!(
        !CONTROL_RS.contains("SYNC_COMPLETED"),
        "control.rs must not reference SYNC_COMPLETED — completion is owned by \
         tauri_bridge::handle_sync_completed; a direct emit here skips the \
         per-label cleanup the bridge performs (audit finding A1)"
    );
}
