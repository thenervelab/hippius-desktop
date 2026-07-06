//! Activity-log truth invariants for sync.
//!
//! # Why this suite exists
//!
//! Activity rows must be enqueued only after a per-file upload (or
//! download + AEAD-verifying decrypt) is server-confirmed. The
//! byte-progress callback fires when the request body's last chunk has
//! left the local TCP socket — *before* the HTTP response status
//! (200 / 402 / 5xx) is parsed by `hcfs_client::client::upload` — so an
//! enqueue there would surface a 402 (Insufficient balance) rejection as
//! an "(uploaded)" row, making the activity log lie to the user.
//!
//! The enqueue therefore lives in `build_file_synced_callback`, which
//! hcfs-client invokes *only* after the per-file transfer returns `Ok`.
//! The two tests below pin both halves of that invariant from outside the
//! crate so a future refactor cannot quietly regress either half.
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

use std::collections::HashMap;
use std::sync::Arc;

use hcfs_client::engine::progress::state::{FileAction, FileStatus, SyncFile, SyncSession};
use hcfs_client::engine::types::SyncActivityAction;
use hcfs_client::engine::{NoopCallbacks, NoopEventHandler, SyncRunner};
use tauri_project_lib::sync::lifecycle::build_file_synced_callback;

/// Build a `MockRuntime` `AppHandle` so the per-fire `app.clone()` and
/// the fire-and-forget intent-mark spawn inside the callback compile
/// and run without a real Tauri runtime. The spawn falls through the
/// "no `AppState` managed" branch silently — exactly the fire-and-
/// forget contract — leaving these tests focused on the activity
/// enqueue and cache write, the behavior they were written to pin.
/// The `test` feature on `tauri` is enabled only via dev-deps so this
/// helper is unavailable in production builds.
fn mock_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
    tauri::test::mock_app().handle().clone()
}

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

/// Seed `current_session.files` with a single `Uploading` entry whose
/// `total_bytes` matches the value `mark_file_synced` is expected to
/// return when the callback fires for `path`.
///
/// Mirrors the in-module `seed_session` helper in
/// `src/sync/progress.rs`, but defined here so this integration test
/// does not depend on any `#[cfg(test)]`-only re-export.
fn seed_one_file_session(sync: &SyncRunner, path: &str, label: &str, total_bytes: u64, action: FileAction) {
    let file = SyncFile {
        id: Arc::from(path),
        path: Arc::from(path),
        file_name: Arc::from(path.rsplit('/').next().unwrap_or(path)),
        label: Arc::from(label),
        action,
        // Non-terminal status so `mark_file_synced`'s already-Completed
        // short-circuit doesn't trigger and the callback sees the
        // pre-transition `total_bytes`.
        status: FileStatus::Uploading,
        progress: 0,
        bytes_encrypted: 0,
        bytes_transferred: 0,
        total_bytes,
        resumed_from_bytes: None,
        started_at: 0,
        completed_at: None,
        error: None,
    };
    let mut state = sync.progress.lock_state();
    let mut files: HashMap<String, SyncFile> = HashMap::with_capacity(1);
    files.insert(path.to_string(), file);
    state.current_session = Some(SyncSession {
        session_id: Arc::from("test-session"),
        started_at: 0,
        completed_at: None,
        is_active: true,
        expected_uploads: 0,
        expected_downloads: 0,
        expected_local_deletes: 0,
        expected_remote_deletes: 0,
        files,
    });
}

/// Read the lifecycle module source and return it concatenated.
///
/// The module is split across `lifecycle.rs` and its `callbacks` submodule;
/// the byte-progress and file-synced callbacks live in the latter. Both are
/// concatenated so the static-shape checks below find the function bodies
/// wherever they live. Pinned via `CARGO_MANIFEST_DIR` so the test stays
/// runnable from any cwd.
fn lifecycle_source() -> String {
    let base = concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs");
    let callbacks = concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle/callbacks.rs");
    // callbacks first: the real `build_file_synced_callback` / `handle_transfer_progress`
    // definitions live there, and `lifecycle.rs`'s test module contains functions
    // named `build_file_synced_callback_*` that would otherwise be matched first by
    // the substring `find` in `extract_fn_body`.
    let mut src = std::fs::read_to_string(callbacks).expect("read src/sync/lifecycle/callbacks.rs");
    src.push_str(&std::fs::read_to_string(base).expect("read src/sync/lifecycle.rs"));
    src
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
         build_file_synced_callback."
    );

    // Marker omits the `(` so the substring match tolerates the
    // signature's `<R: tauri::Runtime>` generic parameter. The brace
    // scanner below jumps from the marker to the first `{`, so the
    // runtime generic between the name and `(` doesn't affect body
    // extraction.
    let synced_body = extract_fn_body(&src, "fn build_file_synced_callback").expect("build_file_synced_callback declaration present");
    assert!(
        synced_body.contains("add_pending_activity"),
        "build_file_synced_callback MUST call add_pending_activity — \
         this is the server-confirmed enqueue site."
    );
}

/// Runtime invariant: invoking the real `build_file_synced_callback`
/// closure with a `Uploaded`-shaped server confirmation produces exactly
/// one `SyncActivityItem` with `action = Uploaded`, the correct
/// `file_name`, and the correct `label`. Uses the public hcfs-client
/// `SyncRunner::new` constructor — no test-only helpers, no
/// `#[cfg(test)] pub` shims.
///
/// Runs under `#[tokio::test]` because the closure fires a fire-and-forget
/// `tokio::spawn` (`mark_intent_completed`) on the `uploaded` action;
/// without a Tokio reactor that spawn panics. The spawn falls through the
/// "no `AppState` managed" branch silently, so it doesn't affect the
/// assertions below.
#[tokio::test]
async fn on_file_synced_enqueues_uploaded_activity() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-a");

    // Seed the progress tracker BEFORE building the callback so that
    // `mark_file_synced` (called inside the closure) returns the file's
    // `total_bytes`. Without the seed the helper returns 0 — which is
    // technically a valid edge case, but it doesn't pin the size-
    // propagation contract this test exists to enforce.
    const EXPECTED_SIZE: u64 = 4_096;
    seed_one_file_session(&sync, "folder/file.txt", "drive-a", EXPECTED_SIZE, FileAction::Upload);

    let app = mock_app_handle();
    let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

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
    assert_eq!(
        item.size_bytes, EXPECTED_SIZE,
        "size_bytes must come from the progress tracker's total_bytes so the Recent Files view doesn't show 'unknown'"
    );
}

/// Runtime invariant: a `Downloaded`-shaped server confirmation
/// enqueues with `action = Downloaded`. The action must come from the
/// `action` parameter hcfs-client passes to `FileSyncedFn`.
#[test]
fn on_file_synced_enqueues_downloaded_activity_for_download_action() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-b");

    // Downloads also have a `total_bytes` in the progress tracker
    // (populated during chunked decryption); pin that the same wiring
    // works for the download path.
    const EXPECTED_SIZE: u64 = 12_345;
    seed_one_file_session(&sync, "doc.txt", "drive-b", EXPECTED_SIZE, FileAction::Download);

    let app = mock_app_handle();
    let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

    let fid = [0xBBu8; 32];
    callback("doc.txt", &hex::encode(fid), "cid-2", "downloaded", None);

    let pending = sync.pending_activity.lock().expect("mutex");
    let items: Vec<_> = pending.iter().collect();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].action, SyncActivityAction::Downloaded);
    assert_eq!(&*items[0].file_name, "doc.txt");
    assert_eq!(&*items[0].label, "drive-b");
    assert_eq!(items[0].size_bytes, EXPECTED_SIZE);
}

/// Truth invariant: an `action` string that hcfs-client may introduce
/// in the future (e.g. `"failed"`) MUST NOT produce a fabricated
/// `Uploaded` row. The match arm for unknown action values maps to
/// `None`, which skips the `add_pending_activity` call entirely. The
/// `warn!` log still fires so the unknown variant is observable in
/// operator logs, but the activity log itself stays truthful.
///
/// Edge case: when the progress tracker has no entry for `rel_path`
/// (no session seeded, or a race where the file vanished from the
/// session between the per-chunk callback and `on_file_synced`),
/// `mark_file_synced` returns 0 and the activity row's `size_bytes`
/// falls back to 0. This is the truthful sentinel for "size unknown"
/// — the Recent-Files view renders it as the existing
/// "unknown"/"--" placeholder rather than fabricating a fake count.
/// Pins the contract that the helper never panics on a missing entry.
///
/// Runs under `#[tokio::test]` because the "uploaded" branch spawns a
/// fire-and-forget `mark_intent_completed` and a Tokio reactor is
/// required for `tokio::spawn` not to panic. The spawn falls through
/// silently — no `AppState` managed in this test.
#[tokio::test]
async fn on_file_synced_without_progress_entry_falls_back_to_zero_size() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-c");
    let app = mock_app_handle();
    let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

    // Deliberately do NOT seed `current_session`. `mark_file_synced`
    // hits the `None` branch on `current_session.as_mut()` and returns
    // `Ok(0)`; the callback uses that for `size_bytes`.
    let fid = [0xEEu8; 32];
    callback("ghost.bin", &hex::encode(fid), "cid-ghost", "uploaded", None);

    let pending = sync.pending_activity.lock().expect("mutex");
    let items: Vec<_> = pending.iter().collect();
    assert_eq!(items.len(), 1, "row is still enqueued — the upload succeeded; only the size is unknown");
    assert_eq!(items[0].size_bytes, 0, "no progress entry → size_bytes is the 0 sentinel, not a panic");
    assert_eq!(items[0].action, SyncActivityAction::Uploaded);
}

#[test]
fn on_file_synced_with_unknown_action_does_not_enqueue() {
    let sync = make_sync_runner();
    let label: Arc<str> = Arc::from("drive-test");
    let app = mock_app_handle();
    let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

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
