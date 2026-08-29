//! Wiring pins for the "Folder Restored" notification gate.
//!
//! The gate's whole job is to tell a genuine restore (folder deleted from the
//! web console while this device still synced it) apart from a brand-new
//! folder whose detached `spawn_folder_registration` has not reached the
//! server yet — both of which make hcfs-client's per-cycle folder check report
//! `Recovered`. Its discriminator is "did this drive already have a
//! `sync_state.json` baseline", and that answer is only obtainable BEFORE the
//! sync loop runs, because the recovery deletes the baseline as part of the
//! work it is reporting.
//!
//! Neither ordering constraint is expressible in the type system, and the
//! paths involved need a live Tauri app + a real server, so they are pinned by
//! source inspection — the same idiom as `hippius_relative_path_backfill.rs`
//! and the ordering guards in `sync/fileops/folders.rs`.

/// Extract the brace-matched `{ ... }` body of the first fn whose declaration
/// contains `sig`.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("{sig} declaration present"));
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
    &src[body_start..=body_end]
}

fn lifecycle_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs")
}

/// `initialize_sync_inner` must arm the gate, and must do it BEFORE
/// `register_drive` puts the drive on the runner's map.
///
/// Once the drive is registered the sync loop can run a cycle, and that
/// cycle's `check_and_recover_remote_folder` deletes `sync_state.json` — the
/// exact file the arming samples. Arming after registration is therefore a
/// race whose losing side reads "no baseline" for a drive that had one, and
/// silently swallows the notification this feature exists to produce.
#[test]
fn init_arms_the_restore_gate_before_registering_the_drive() {
    let src = lifecycle_src();
    let body = fn_body(&src, "pub(crate) async fn initialize_sync_inner(");

    let arm_idx = body.find("folder_restore_notify.arm(").expect(
        "initialize_sync_inner must arm the folder-restore gate — without it every FolderRecovered is ungated and a brand-new folder notifies that it 'was missing on the server'",
    );
    let register_idx = body.find("register_drive(").expect("initialize_sync_inner registers the drive");

    assert!(
        arm_idx < register_idx,
        "the gate must be armed BEFORE register_drive: once the drive is on the map a sync cycle can delete the sync_state.json baseline the arming samples",
    );
}

/// The gate must be consumed in the bridge's `FolderRecovered` path, and the
/// RAW event must still be emitted unconditionally.
///
/// Mirrors the `SYNC_ERROR` / `SYNC_FAILED_NOTIFY` split: live consumers need
/// every recovery, only the persisted notification is gated. Collapsing the
/// two — gating the raw event, or notifying straight off it — loses one side
/// or the other.
#[test]
fn bridge_gates_only_the_notification_channel() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/tauri_bridge.rs")).expect("read tauri_bridge.rs");
    let body = fn_body(&src, "fn handle_folder_recovered(");

    assert!(
        body.contains("folder_restore_notify.take("),
        "handle_folder_recovered must consume the gate rather than notifying on every raw event",
    );
    assert!(
        body.contains("events::FOLDER_RESTORED_NOTIFY"),
        "handle_folder_recovered must emit the gated notification channel",
    );

    // The raw emit must not sit inside the `if should_notify` block. Locate it
    // and assert it is not preceded by an unclosed conditional.
    let raw_idx = body
        .find("events::FOLDER_RECOVERED")
        .expect("handle_folder_recovered must still emit the raw FOLDER_RECOVERED event for live consumers");
    let gated_idx = body.find("events::FOLDER_RESTORED_NOTIFY").expect("gated emit present");
    let between = &body[gated_idx..raw_idx];
    assert!(
        between.contains('}'),
        "the raw FOLDER_RECOVERED emit must sit OUTSIDE the should_notify block so live consumers see every recovery: {between}",
    );
}

/// Every account-scoped notification latch is cleared on `SyncReset`
/// (logout / account switch). The restore gate holds per-label flags derived
/// from one account's on-disk drives, so a label reused by the next account
/// must be re-armed from its OWN baseline rather than inheriting this one's.
#[test]
fn sync_reset_clears_the_restore_gate() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/tauri_bridge.rs")).expect("read tauri_bridge.rs");
    let body = fn_body(&src, "fn handle_sync_reset(");

    assert!(
        body.contains("folder_restore_notify.clear_all()"),
        "handle_sync_reset must clear the folder-restore gate alongside the sibling error_notify / revoked_notify latches",
    );
}
