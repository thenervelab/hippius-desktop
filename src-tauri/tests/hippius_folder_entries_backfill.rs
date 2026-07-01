//! Regression tests for the desktop folder-entity backfill.
//!
//! Phase 1 Task 1.12 of the first-class-empty-folders plan.
//!
//! # What this suite pins
//!
//! The backfill in `src-tauri/src/sync/migrate/folder_entries_backfill.rs` is a
//! one-shot per-drive pass: every drive created before the server-side
//! `folder_entries` table existed walks its on-disk directory tree exactly once
//! and registers every directory as a server folder entity, so pre-existing
//! empty folders become visible. After a fully-successful sweep the
//! `sync_paths.folder_entries_backfilled_at` timestamp is set so the sweep
//! never runs again for that drive.
//!
//! # Why only the static spawn-reference check lives here
//!
//! The pure directory walk, the NFC idempotence proptest, the cache+flag
//! persistence, the gate, and the chunking math are all hermetic and live as
//! unit tests beside the code. The remaining moving part — the network
//! round-trip through `HcfsClient::register_folder_entries` — is covered by the
//! Task 1.15 real-backend harness (no mock). What an integration test uniquely
//! guards here is the *wiring*: that the init funnel actually spawns the
//! backfill. A mock of the client would violate the no-mock rule and add no
//! contract coverage hcfs-client's own tests don't already provide.

/// Static regression guard: `initialize_sync_inner` MUST reference
/// `spawn_folder_entries_backfill` somewhere in its body. Every public entry
/// point that starts or restarts a drive (`setup_and_init_sync`,
/// `add_local_sync_folder`, `resume_drive`, `initialize_sync`, `auto_init_sync`)
/// funnels through `initialize_sync_inner`, so this single check covers the
/// whole trigger surface. A refactor that silently drops the backfill kick-off
/// — or moves it off the init funnel — fails this test.
#[test]
fn lifecycle_initialize_sync_inner_spawns_folder_entries_backfill() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs");

    // Brace-match the function body so a reference in an unrelated helper
    // elsewhere in the file can't satisfy the assertion (mirrors the
    // relative-path backfill's static guard).
    let sig_idx = src
        .find("async fn initialize_sync_inner(")
        .expect("initialize_sync_inner declaration present");
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    let mut body_end = body_start;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &src[body_start..=body_end];
    assert!(
        body.contains("spawn_folder_entries_backfill"),
        "initialize_sync_inner must call spawn_folder_entries_backfill so every init path triggers the one-shot folder-entity backfill",
    );
}
