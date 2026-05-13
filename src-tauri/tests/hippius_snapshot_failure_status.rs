//! Defense-in-depth regression test for the snapshot-error contract.
//!
//! Phase 1 / Task 1.3 of `docs/plans/2026-05-13-sync-402-data-integrity.md`.
//!
//! # Why this suite exists
//!
//! The end-to-end chain a 402 (Insufficient balance) upload travels is:
//!
//! ```text
//! hcfs-client per-file upload returns Err
//!   -> finalize_session_for_label runs at end-of-cycle
//!   -> mark_pending_files_as_failed sets FileStatus::Error
//!   -> build_snapshot maps FileStatus::Error -> FileProgressStatus::Error
//!   -> serde renders FileProgressStatus::Error as the JSON string "error"
//!   -> desktop FE enricher (post Task 1.2) maps status === "error" -> "failed"
//!   -> SyncStatusIcon renders the red AlertCircle (no pulse)
//! ```
//!
//! The orchestration (`finalize_session_for_label` invoking
//! `mark_pending_files_as_failed`) lives in `hcfs-client`. Its own tests
//! cover that orchestration there. This file pins the *desktop-visible
//! contract*: given the failure-marking entry point the desktop exposes
//! as `pub fn`, does the resulting `SyncSnapshot.files[].status`
//! reach the Tauri/IPC boundary as `FileProgressStatus::Error`, whose
//! `#[serde(rename_all = "camelCase")]` representation is the string
//! `"error"`?
//!
//! Pinning the contract on the desktop side gives us two independent
//! sentinels: hcfs-client may not break its own contract on its own
//! tests, but it might rename, retype, or rewire the snapshot in a way
//! that breaks the desktop view of the chain. This test fails fast
//! when that happens — *before* the FE's `"error" -> "failed"`
//! enricher silently sees an unknown status and degrades to the
//! benign "Completed" branch (which is exactly the original 402 bug
//! Task 1.2 fixed in the FE renderer).
//!
//! # Vocabulary note
//!
//! The TypeScript `FileProgressStatus` is
//! `"pending" | "inProgress" | "encrypting" | "decrypting" | "completed" | "error"`
//! (see `app/lib/types/syncSnapshot.ts:2`). The user-visible label
//! `"failed"` is purely a frontend rendering choice that lives in
//! `app/components/page-sections/files/files-table/index.tsx` (the
//! Task 1.2 commit). The wire-format string is and remains `"error"`;
//! this test asserts that wire format.
//!
//! # What this suite does NOT do
//!
//! - It does not spin a real hcfs-server, a real HTTP transport, or
//!   any networked endpoint. The 402 condition is simulated by the
//!   public-API equivalent: `actual_uploads < label_expected_uploads`,
//!   which is precisely what `mark_pending_files_as_failed` sees when
//!   an upload's `on_file_synced` callback never fires.
//! - It does not exercise `finalize_session_for_label`. That symbol
//!   is private to hcfs-client. The test reaches the same outcome
//!   through the public IPC funnel the desktop already exposes.

use std::sync::Arc;

use hcfs_client::engine::progress::state::{FileAction, FileStatus, SyncFile, SyncSession};
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};

// Public re-exports the desktop crate exposes for exactly this kind of
// snapshot-shape testing. Going through `tauri_project_lib::sync::progress`
// rather than directly through `hcfs_client::engine::progress::*` ensures
// the test pins the contract at the *desktop's* public surface — a future
// refactor that swaps the re-export source still has to satisfy this
// import.
use tauri_project_lib::sync::progress::{FileProgressStatus, mark_pending_files_as_failed};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/// Build a `SyncRunner` using only the public hcfs-client constructor.
///
/// Identical shape to `make_sync_runner` in `hippius_activity_truth.rs`
/// — duplicated rather than shared because each integration test crate
/// gets its own translation unit, and pulling a shared helper through
/// a `mod common;` re-export was rejected when the activity-truth suite
/// was added (no `#[cfg(test)] pub` shims; integration tests use only
/// the public API). See `src-tauri/CLAUDE.md` and project axiom 111.
fn make_sync_runner() -> Arc<SyncRunner> {
    Arc::new(SyncRunner::new(
        Arc::new(NoopEventHandler),
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ))
}

/// Build a `SyncFile` that mimics a freshly-staged upload — bytes
/// already accounted for but the per-file `on_file_synced` callback
/// has not fired yet (so `status == Pending`).
///
/// The 402 failure mode is exactly this shape at the moment
/// `mark_pending_files_as_failed` runs: the upload was *expected*
/// (counted in `expected_uploads`), it was never *confirmed* (no
/// `on_file_synced`), so `actual_uploads < expected_uploads` and the
/// excess gets demoted.
fn pending_upload(path: &str, label: &str, size: u64) -> SyncFile {
    SyncFile {
        id: Arc::from(path),
        path: Arc::from(path),
        file_name: Arc::from(path.rsplit('/').next().unwrap_or(path)),
        label: Arc::from(label),
        action: FileAction::Upload,
        status: FileStatus::Pending,
        progress: 0,
        bytes_encrypted: 0,
        bytes_transferred: 0,
        total_bytes: size,
        resumed_from_bytes: None,
        started_at: 0,
        completed_at: None,
        error: None,
    }
}

/// Seed the runner's `current_session.files` map with `files` and
/// declare how many uploads / downloads the session expected.
///
/// Reaches into `progress.lock_state()` — a public API used by the
/// in-tree unit tests in `src/sync/progress.rs`. This is the same
/// public ingestion path the production sync engine uses to mutate
/// session state, so a refactor that removes or renames it is a
/// breaking change that this test will catch.
fn seed_session(sync: &SyncRunner, files: Vec<SyncFile>, expected_uploads: u32) {
    let mut state = sync.progress.lock_state();
    let mut file_map = std::collections::HashMap::new();
    for f in files {
        file_map.insert(f.path.to_string(), f);
    }
    state.current_session = Some(SyncSession {
        session_id: Arc::from("test-session"),
        started_at: 0,
        completed_at: None,
        is_active: true,
        expected_uploads,
        expected_downloads: 0,
        expected_local_deletes: 0,
        expected_remote_deletes: 0,
        files: file_map,
    });
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

/// Cross-crate contract pin: an unconfirmed upload (the desktop-visible
/// shape of a 402 response) must surface in the snapshot as
/// `FileProgressStatus::Error`.
///
/// Failure mode this catches: hcfs-client renames `FileStatus::Error`,
/// changes the `build_snapshot` mapping for `Error`, or alters the
/// `mark_pending_files_as_failed` semantics so the unconfirmed file
/// is silently flipped to `Completed` instead of `Error` (which is
/// exactly the bug the FE used to render as "Completed" / green
/// checkmark for 402'd uploads).
#[test]
fn unconfirmed_upload_surfaces_as_error_status_in_snapshot() {
    let sync = make_sync_runner();
    let label = "drive-a";

    // Session expected two uploads. We seed two `Pending` upload rows
    // — neither of which will receive `on_file_synced` in this test —
    // and then call the failure-marker with `actual_uploads = 1`. The
    // resulting `excess_uploads = expected - actual = 1` causes
    // `mark_pending_files_as_failed` to demote exactly one of the two
    // to `FileStatus::Error` and pass the other through as
    // `Completed` (its "the rest must have succeeded silently" branch,
    // unrelated to this test's assertion).
    seed_session(
        &sync,
        vec![pending_upload("a.txt", label, 1024), pending_upload("b.txt", label, 2048)],
        /* expected_uploads */ 2,
    );

    mark_pending_files_as_failed(&sync, /* actual_uploads */ 1, /* actual_downloads */ 0, label)
        .expect("public mark_pending_files_as_failed must not error on a well-formed session");

    let snapshot = sync.progress.build_snapshot();
    let failed: Vec<_> = snapshot.files.iter().filter(|f| f.status == FileProgressStatus::Error).collect();

    // Exactly one Error row, AND it must be one of the two we seeded.
    // The asymmetric `excess = expected - actual = 1` causes the
    // demoter to pick the first matching pending file; we don't pin
    // *which* of the two it picks (that's implementation detail) but
    // we do pin that the one it picked is from our seeded set.
    assert_eq!(
        failed.len(),
        1,
        "exactly one file should be marked Error after one upload silently failed; \
         got {} (snapshot.files = {:#?})",
        failed.len(),
        snapshot.files
    );
    let failed_name = failed[0].file_name.as_ref();
    assert!(
        failed_name == "a.txt" || failed_name == "b.txt",
        "the Error row must be one of the two seeded uploads; got {failed_name:?}"
    );
    assert_eq!(
        snapshot.failed_files, 1,
        "snapshot.failed_files counter must agree with the per-file Error count — \
         the FE reads both and they MUST NOT disagree"
    );
}

/// Wire-format pin: the JSON the IPC boundary delivers to the FE
/// MUST contain `"status":"error"` for the failed file.
///
/// `FileProgressStatus` derives `Serialize` with
/// `#[serde(rename_all = "camelCase")]`. Its `Error` variant renames
/// to the JSON string `"error"`. The FE's discriminated union
/// (`app/lib/types/syncSnapshot.ts:2`) requires that exact string
/// to enter the `"error" -> "failed"` enricher branch the Task 1.2
/// commit added in `files-table/index.tsx`. A serde-attribute drift
/// (e.g. dropping `rename_all` or renaming the variant to `Failed`)
/// would silently break the FE without breaking the Rust enum's
/// `PartialEq` — so the equality assertion above is not enough.
/// This test pins the on-wire string directly.
#[test]
fn failed_file_serializes_status_as_lowercase_error_string() {
    let sync = make_sync_runner();
    let label = "drive-a";

    seed_session(&sync, vec![pending_upload("paid.txt", label, 4096)], /* expected_uploads */ 1);

    // actual_uploads = 0 -> excess = 1 -> the single Pending file is
    // demoted to Error. Mirrors what hcfs-client's
    // `finalize_session_for_label` does at end-of-cycle when the
    // per-file confirmation never arrived.
    mark_pending_files_as_failed(&sync, 0, 0, label).expect("mark_pending_files_as_failed");

    let snapshot = sync.progress.build_snapshot();
    let json = serde_json::to_value(&snapshot).expect("SyncSnapshot must serialize to JSON; it crosses the Tauri IPC boundary");
    let files = json
        .get("files")
        .and_then(|v| v.as_array())
        .expect("snapshot must serialize `files` as a JSON array (camelCase, no rename)");
    let error_row = files
        .iter()
        .find(|f| f.get("status").and_then(|s| s.as_str()) == Some("error"))
        .unwrap_or_else(|| {
            panic!(
                "expected at least one row with `status: \"error\"` after a failed upload; \
                 if this assertion fires because the variant now serializes as something else \
                 (\"failed\", \"Error\", etc.), STOP — the FE enricher in \
                 `app/components/page-sections/files/files-table/index.tsx` keys on the \
                 literal \"error\" string and will silently fall through to the \
                 \"completed\" branch otherwise. See Task 1.2 of the 402 plan. \
                 Snapshot JSON files: {files:#?}"
            )
        });
    // Confirm it is the file we expected (not some other row).
    assert_eq!(
        error_row.get("fileName").and_then(|n| n.as_str()),
        Some("paid.txt"),
        "the error row should be the one upload we seeded as failed"
    );
}

/// Negative-shape pin: when every expected upload IS confirmed (the
/// happy path), no row carries the `Error` status and the FE renderer
/// never enters the "failed" branch.
///
/// Without this complement, the two tests above could pass even if
/// `mark_pending_files_as_failed` always marked everything Error
/// regardless of `actual_uploads`. The asymmetric pair pins the
/// directionality of the contract — Error appears iff there was a
/// shortfall.
#[test]
fn confirmed_uploads_produce_no_error_status_in_snapshot() {
    let sync = make_sync_runner();
    let label = "drive-a";

    seed_session(&sync, vec![pending_upload("ok.txt", label, 1024)], /* expected_uploads */ 1);

    // actual_uploads >= expected_uploads -> no excess -> no demotion.
    // The pending row gets carried into Completed by the
    // "rest must have succeeded silently" branch, which is the
    // canonical happy-path final state.
    mark_pending_files_as_failed(&sync, /* actual_uploads */ 1, 0, label).expect("mark_pending_files_as_failed");

    let snapshot = sync.progress.build_snapshot();
    assert_eq!(
        snapshot.failed_files, 0,
        "happy path must not produce any failed files; \
         snapshot.files = {:#?}",
        snapshot.files
    );
    assert!(
        snapshot.files.iter().all(|f| f.status != FileProgressStatus::Error),
        "no file should carry Error status when all expected uploads were confirmed"
    );
}
