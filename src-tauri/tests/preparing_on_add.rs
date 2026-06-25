//! Static regression guard for the "show the sync widget immediately when a
//! folder is added" fix.
//!
//! `add_local_sync_folder` marks the new drive's label as "preparing" and emits
//! a snapshot BEFORE the long `initialize_sync_inner` call, so the bottom-left
//! sync widget appears within a tick instead of only after the 20-30s watcher-
//! debounce + `scan_local_files` + `fetch_remote_state` indexing window (the
//! engine otherwise marks preparing at `PlanReady`, which fires *after* that
//! window). Without the immediate mark the user saw nothing for 20-30s after
//! adding a folder.
//!
//! This is a source-text body check (mirrors
//! `hippius_relative_path_backfill::lifecycle_initialize_sync_inner_spawns_backfill`)
//! rather than an end-to-end test: `add_local_sync_folder` is an IPC command
//! that runs a credit check, a recursive byte-sum disk walk, an atomic DB
//! allocation, and a real `initialize_sync_inner` — driving all of that would
//! cost far more than it pins, and the preparing primitives themselves are
//! already unit-tested in `src/sync/preparing.rs`. What can silently regress is
//! the *wiring*: a refactor that drops the immediate `mark_preparing` (leaving
//! the engine's post-indexing `PlanReady` as the only signal) reopens the bug.

/// Brace-match the body of the named function in `lifecycle.rs` and return it.
fn lifecycle_fn_body(signature: &str) -> String {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/lifecycle.rs")).expect("read lifecycle.rs");
    let sig_idx = src.find(signature).unwrap_or_else(|| panic!("{signature} declaration present"));
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
    src[body_start..=body_end].to_string()
}

#[test]
fn add_local_sync_folder_marks_preparing_before_init() {
    let body = lifecycle_fn_body("pub async fn add_local_sync_folder(");

    // Match call-sites (with the open paren) so prose mentions of the same
    // identifiers in the surrounding doc comments don't satisfy / skew the check.
    assert!(
        body.contains("mark_preparing("),
        "add_local_sync_folder must call mark_preparing so the sync widget shows \
         immediately on add, not only after the engine reaches PlanReady \
         (~20-30s of indexing later)",
    );

    // The immediate mark must precede the init call whose indexing window it is
    // meant to cover — marking it after init would be pointless.
    let mark_idx = body.find("mark_preparing(").expect("mark_preparing call present");
    let init_idx = body.find("initialize_sync_inner(").expect("initialize_sync_inner call present");
    assert!(
        mark_idx < init_idx,
        "mark_preparing must run BEFORE initialize_sync_inner so the widget \
         appears during the indexing window, not after it",
    );

    // On a failed init the override must be cleared (init can fail before any
    // terminal sync event fires, otherwise the widget sticks on "Preparing \
    // sync…" for the full watchdog timeout).
    assert!(
        body.contains("preparing.clear") || body.contains(".clear(&label)"),
        "add_local_sync_folder must clear the preparing override on init failure",
    );
}
