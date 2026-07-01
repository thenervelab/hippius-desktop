//! Regression pins for the reviewed-conflict sync completion path.
//!
//! `sync_with_conflict_resolutions` must NOT emit `SYNC_COMPLETED` directly
//! via `app.emit`: doing so forks away from `TauriSyncBridge::on_event`'s
//! `SyncCompleted` arm and skips every per-label cleanup the bridge performs
//! (preparing-override clear, pending-upload banner clear, per-file
//! failure-counter recompute) while shipping a detail-less completion
//! notification. The cleanup + emit lives in the shared
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
const CONTROL_RS: &str = include_str!("../src/sync/drive/control.rs");

/// The reviewed path MUST route completion through the shared bridge helper.
#[test]
fn reviewed_sync_routes_completion_through_the_bridge_helper() {
    assert!(
        CONTROL_RS.contains("handle_sync_completed"),
        "sync_with_conflict_resolutions must route its success arm through \
         tauri_bridge::handle_sync_completed so the reviewed path runs the same \
         per-label cleanup as the auto-sync loop"
    );
}

/// The reviewed path MUST NOT emit `SYNC_COMPLETED` directly — that bypasses
/// the bridge's per-label cleanup. `control.rs` still legitimately emits
/// `SYNC_STARTED` directly (with the full `SyncStartedPayload`), so this pin is
/// scoped to the completion event only.
#[test]
fn reviewed_sync_does_not_emit_sync_completed_directly() {
    assert!(
        !CONTROL_RS.contains("SYNC_COMPLETED"),
        "control.rs must not reference SYNC_COMPLETED — completion is owned by \
         tauri_bridge::handle_sync_completed; a direct emit here skips the \
         per-label cleanup the bridge performs"
    );
}

/// The reviewed path's error/None arms MUST route through the shared
/// `handle_sync_error` helper (so a cancel during a reviewed sync is dropped
/// instead of surfacing a spurious "Sync Failed", and the per-label defensive
/// clears run) and MUST NOT emit the `SYNC_ERROR` event directly.
#[test]
fn reviewed_sync_routes_errors_through_the_bridge_helper() {
    assert!(
        CONTROL_RS.contains("handle_sync_error"),
        "sync_with_conflict_resolutions must route its error/None arms through \
         tauri_bridge::handle_sync_error so cancels are dropped and the defensive \
         clears run, same as the auto-sync path"
    );
    assert!(
        !CONTROL_RS.contains("SYNC_ERROR"),
        "control.rs must not reference the SYNC_ERROR event constant — error \
         emission is owned by tauri_bridge::handle_sync_error; a direct emit here \
         skips the cancel-drop and the per-label defensive clears"
    );
}
