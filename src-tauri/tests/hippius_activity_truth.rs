//! Activity-log truth invariants for sync.
//!
//! Phase 1 / Task 1.1 of `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # Why this suite exists
//!
//! The desktop used to enqueue `SyncActivityItem { action: Uploaded, .. }`
//! from inside the byte-progress callback's completion-tick branch
//! (`bytes == total`). That callback fires when the request body's last
//! chunk has left the local TCP socket — *before* the HTTP response
//! status (200 / 402 / 5xx) is parsed by `hcfs_client::client::upload`.
//!
//! Symptom: a 402 (Insufficient balance) response would still leave a
//! "(uploaded)" row in the recent-activity log because the enqueue had
//! already happened. The activity log lied to the user.
//!
//! Fix: the enqueue moved to `build_file_synced_callback`, which
//! hcfs-client invokes *only* after the per-file upload (or
//! download + AEAD-verifying decrypt) returns `Ok`. The two tests below
//! pin both halves of that invariant from outside the crate so a future
//! refactor cannot quietly regress either half.
//!
//! # What each test pins
//!
//! 1. `byte_progress_does_not_enqueue_pending_activity`: a *static-shape*
//!    test that reads `src/sync/lifecycle.rs` and asserts the body of
//!    `handle_transfer_progress` (the byte-progress site) contains zero
//!    `add_pending_activity` calls. Static-shape tests are the
//!    established pattern in this repo for cross-module invariants that
//!    are easier to spot at the source level than to reproduce at
//!    runtime — see `lifecycle_initialize_sync_inner_spawns_backfill`
//!    in `hippius_relative_path_backfill.rs` for the canonical example.
//!
//! 2. `on_file_synced_enqueues_uploaded_activity`: drives the real
//!    `build_file_synced_callback` closure end-to-end (no test-only
//!    helpers, no `#[cfg(test)] pub`). Constructs a `SyncRunner` via
//!    the public `hcfs_client::engine::SyncRunner::new(...)` API,
//!    invokes the closure with realistic args, then inspects the
//!    public `pending_activity` mutex.
//!
//! No live server, no real `DriveManager`, no Tauri `AppHandle`. The
//! point is to assert the *enqueue location*, not to exercise the
//! whole sync cycle (which hcfs-client's own tests already cover).

use std::sync::Arc;

use hcfs_client::engine::types::SyncActivityAction;
use hcfs_client::engine::{NoopCallbacks, NoopEventHandler, SyncRunner};
use tauri_project_lib::sync::lifecycle::build_file_synced_callback;

// ─────────────────────────────────────────────────────────────────────
// Helpers (test-local; nothing crosses back into the crate under test)
// ─────────────────────────────────────────────────────────────────────

/// Build a `SyncRunner` using only the public hcfs-client constructor.
///
/// Mirrors the in-module `test_sync_runner` helper in
/// `src/sync/lifecycle.rs`, but defined here so this integration test
/// does not depend on any `#[cfg(test)]`-only re-export.
fn make_sync_runner() -> Arc<SyncRunner> {
    Arc::new(SyncRunner::new(
        Arc::new(NoopEventHandler),
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ))
}

/// Read `src/sync/lifecycle.rs` and return its full source.
///
/// Pinned via `CARGO_MANIFEST_DIR` so the test stays runnable from any
/// cwd (CI, `cargo test --workspace`, IDE runners, etc.).
fn lifecycle_source() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/lifecycle.rs");
    std::fs::read_to_string(path).expect("read src/sync/lifecycle.rs")
}

/// Extract the balanced `{ ... }` body of a function whose signature
/// starts with `sig_marker`. Returns `None` if the signature is
/// absent (the caller asserts this); panics if the brace structure is
/// malformed (a corrupt source file is a developer error, not a
/// runtime condition this test should tolerate).
///
/// Naïve brace matching is sufficient for the two function bodies this
/// test inspects — neither contains char-literal braces (`'{'`, `'}'`),
/// raw-string braces (`r#"...{..."#`), or commented-out braces today.
/// If this test starts failing after a refactor that introduces such
/// tokens, swap to `syn` (or `proc-macro2`'s tokenizer) — but do not
/// preemptively add the dependency. The precedent
/// `lifecycle_initialize_sync_inner_spawns_backfill` in
/// `hippius_relative_path_backfill.rs` makes the same tradeoff for the
/// same reason: matching brace depth on real-world function bodies in
/// this file has been load-bearing in test suites without incident, and
/// the failure mode (a brace inside a string / comment that unbalances
/// the count) is obvious from the resulting `panic!("unbalanced …")`.
fn extract_fn_body<'src>(src: &'src str, sig_marker: &str) -> Option<&'src str> {
    let sig_idx = src.find(sig_marker)?;
    let body_start = src[sig_idx..].find('{')? + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[body_start..=body_start + i]);
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces while scanning for `{sig_marker}` body");
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

/// Static-shape invariant: the byte-progress site (`handle_transfer_progress`)
/// MUST NOT enqueue activity items. The byte-progress callback fires when
/// the upload request body has finished sending — before the server's
/// HTTP response status is parsed — so an enqueue here would surface
/// 402/5xx-rejected uploads as "Uploaded" in the activity log.
///
/// A symmetric assertion confirms the enqueue lives where it belongs:
/// inside `build_file_synced_callback`, which hcfs-client invokes only
/// on server-confirmed per-file success.
#[test]
fn byte_progress_does_not_enqueue_pending_activity() {
    let src = lifecycle_source();

    let transfer_body = extract_fn_body(&src, "fn handle_transfer_progress(").expect("handle_transfer_progress declaration present");
    assert!(
        !transfer_body.contains("add_pending_activity"),
        "handle_transfer_progress MUST NOT call add_pending_activity — \
         byte-progress is pre-server-confirmation and would lie about \
         402/5xx-rejected uploads. The enqueue belongs in \
         build_file_synced_callback. See \
         docs/plans/2026-05-13-sync-402-data-integrity.md Task 1.1."
    );

    let synced_body = extract_fn_body(&src, "fn build_file_synced_callback(").expect("build_file_synced_callback declaration present");
    assert!(
        synced_body.contains("add_pending_activity"),
        "build_file_synced_callback MUST call add_pending_activity — \
         this is the server-confirmed enqueue site after the move."
    );
}

/// Runtime invariant: invoking the real `build_file_synced_callback`
/// closure with a `Uploaded`-shaped server confirmation produces exactly
/// one `SyncActivityItem` with `action = Uploaded`, the correct
/// `file_name`, and the correct `label`. Uses the public hcfs-client
/// `SyncRunner::new` constructor — no test-only helpers, no
/// `#[cfg(test)] pub` shims.
#[test]
fn on_file_synced_enqueues_uploaded_activity() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-a");
    let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

    // 32-byte path hash keyed by 'a' so the hex decode in the callback
    // succeeds — otherwise the callback short-circuits before the
    // `upsert_synced_path` call and the test stops being meaningful as
    // a regression check on the enqueue path.
    let fid = [0xAAu8; 32];
    let fid_hex = hex::encode(fid);

    callback("folder/file.txt", &fid_hex, "cid-1", "uploaded", None);

    let pending = sync.pending_activity.lock().expect("pending_activity mutex is uncontended in this test");
    let items: Vec<_> = pending.iter().collect();

    assert_eq!(items.len(), 1, "exactly one activity item expected after one server-confirmed upload");
    let item = items[0];
    assert_eq!(item.action, SyncActivityAction::Uploaded);
    assert_eq!(&*item.file_name, "folder/file.txt");
    assert_eq!(&*item.label, "drive-a");
}

/// Runtime invariant: a `Downloaded`-shaped server confirmation
/// enqueues with `action = Downloaded`. The byte-progress site
/// previously branched on `TransferDirection` to pick the right action;
/// after the move, the action must come from the `action` parameter
/// hcfs-client passes to `FileSyncedFn`.
#[test]
fn on_file_synced_enqueues_downloaded_activity_for_download_action() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-b");
    let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

    let fid = [0xBBu8; 32];
    callback("doc.txt", &hex::encode(fid), "cid-2", "downloaded", None);

    let pending = sync.pending_activity.lock().expect("mutex");
    let items: Vec<_> = pending.iter().collect();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].action, SyncActivityAction::Downloaded);
    assert_eq!(&*items[0].file_name, "doc.txt");
    assert_eq!(&*items[0].label, "drive-b");
}

/// Truth invariant: an `action` string that hcfs-client may introduce
/// in the future (Phase 2 may add `"failed"`) MUST NOT produce a
/// fabricated `Uploaded` row. The match arm for unknown action values
/// maps to `None`, which skips the `add_pending_activity` call
/// entirely. The `warn!` log still fires so the unknown variant is
/// observable in operator logs, but the activity log itself stays
/// truthful.
///
/// Pins issue I-3 from the Task 1.1 code review.
#[test]
fn on_file_synced_with_unknown_action_does_not_enqueue() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-test");
    let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

    // Realistic-shape inputs: 32-byte hex path hash so the callback's
    // subsequent `upsert_synced_path` decode path also succeeds. The
    // assertion below is about the activity enqueue, but if the
    // callback aborted earlier we would be silently testing a no-op.
    let fid = [0xCCu8; 32];
    callback("future/path.bin", &hex::encode(fid), "cid-future", "future-variant", None);

    let pending = sync.pending_activity.lock().expect("mutex");
    assert!(
        pending.is_empty(),
        "unknown action must skip the enqueue — recording nothing is the truthful choice when we cannot categorize the event; got {} item(s)",
        pending.len()
    );
}
