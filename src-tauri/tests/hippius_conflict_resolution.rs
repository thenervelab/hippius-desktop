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

/// Slice out the body of `sync_with_conflict_resolutions` so pins on lock
/// discipline don't false-match against `stage_changes` (which also uses
/// `try_lock`) or the helpers below it in the file.
fn reviewed_sync_fn_body() -> &'static str {
    let start = CONTROL_RS
        .find("pub async fn sync_with_conflict_resolutions")
        .expect("sync_with_conflict_resolutions must exist in control.rs");
    let rest = &CONTROL_RS[start..];
    let end = rest
        .find("pub async fn cancel_review")
        .expect("cancel_review must follow sync_with_conflict_resolutions");
    &rest[..end]
}

/// The reviewed path MUST `try_lock` the drive manager, never block on it.
///
/// The auto-sync loop holds the per-drive manager lock for an ENTIRE cycle
/// (hcfs-client `run_sync_cycle`), which on a large drive runs for tens of
/// minutes. A blocking `lock().await` here silently queues the user's
/// "Sync Now" click behind that in-flight cycle with the button spinner as
/// the only feedback — the frozen-button bug reported 2026-07-28. Contention
/// must surface immediately as `NotReady(SyncInProgress)`, mirroring
/// `stage_changes`.
#[test]
fn reviewed_sync_try_locks_the_drive_manager() {
    let body = reviewed_sync_fn_body();
    assert!(
        body.contains(".try_lock()"),
        "sync_with_conflict_resolutions must try_lock the drive manager so a \
         contended manager surfaces as NotReady(SyncInProgress) instead of \
         silently queuing behind an in-flight sync cycle"
    );
    assert!(
        body.contains("NotReadyKind::SyncInProgress"),
        "manager-lock contention must map to NotReady(SyncInProgress) so the FE \
         can distinguish 'retry shortly' from a real sync failure"
    );
    assert!(
        body.contains("set_drive_review"),
        "the contended arm must re-arm review mode so the auto-sync loop \
         pauses at the next cycle boundary and the user's retry wins the lock \
         deterministically instead of racing the loop's 5s tick"
    );
    // Exactly ONE blocking `.lock().await` is legitimate in this function: the
    // drives-map lock used to clone out the manager Arc. A second one means a
    // blocking manager lock crept back in.
    let blocking_locks = body.matches(".lock().await").count();
    assert_eq!(
        blocking_locks, 1,
        "expected exactly one blocking .lock().await (the drives map) in \
         sync_with_conflict_resolutions, found {blocking_locks} — the drive \
         manager itself must be acquired via try_lock"
    );
}

/// Side effects (is_syncing, the SYNC_STARTED emit, watcher suppression) MUST
/// come AFTER the manager is acquired. Emitting/mutating before the lock made
/// a merely-queued (or refused) reviewed sync look like a running one to the
/// FE, and the early NotReady return would leave `begin_sync` unbalanced.
#[test]
fn reviewed_sync_defers_side_effects_until_manager_acquired() {
    let body = reviewed_sync_fn_body();
    let lock_at = body.find(".try_lock()").expect("try_lock pin runs first");
    // Match the qualified emit path / the call expression, not the bare
    // names — those also appear in prose comments ABOVE the try_lock.
    let started_at = body
        .find("crate::sync::events::SYNC_STARTED")
        .expect("reviewed sync must emit SYNC_STARTED");
    let begin_at = body.find("sync.begin_sync()").expect("reviewed sync must suppress the watcher");
    assert!(
        lock_at < started_at && lock_at < begin_at,
        "SYNC_STARTED emit and begin_sync must happen only after the drive \
         manager try_lock succeeds — a contended/unavailable drive must return \
         with no side effects applied"
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
