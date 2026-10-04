//! Wiring pins for the large-delete prompt's hold state
//! (`sync::mass_delete_hold`).
//!
//! The state's transitions are unit-tested in its module; what those tests
//! cannot see is WHERE the bridge and the lifecycle drive them, and each of
//! these call sites needs a live Tauri app and a real engine cycle to reach.
//! A missing one fails silently: no `begin_cycle` and a hold is never
//! cleared; a `finish` on the reviewed-conflict path and a hold that cycle
//! never re-reported is cleared while it stands; a missing clear and one
//! account's hold shows on another's drive. Pinned by source inspection, the
//! idiom `folder_restore_notify_wiring.rs` uses.

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

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

fn bridge_src() -> String {
    read("src/sync/projection/tauri_bridge.rs")
}

fn lifecycle_src() -> String {
    read("src/sync/drive/lifecycle.rs")
}

#[test]
fn every_engine_cycle_start_resets_what_it_has_seen() {
    let src = bridge_src();
    let body = fn_body(&src, "fn handle_sync_started(");
    assert!(
        body.contains("mass_delete_holds.begin_cycle("),
        "without begin_cycle a side once seen stays seen, and a hold that ended is never cleared"
    );
}

#[test]
fn only_an_engine_completion_clears_holds_it_did_not_report() {
    let src = bridge_src();
    let on_event = fn_body(&src, "fn on_event(&self, event: SyncEvent)");
    let finish = on_event
        .find("finish_mass_delete_cycle(")
        .expect("the engine's SyncCompleted arm must finish the hold bookkeeping");
    let completed = on_event.find("handle_sync_completed(").expect("SyncCompleted arm delegates");
    assert!(
        finish < completed,
        "finish the cycle's holds in the SyncCompleted arm, before the shared completion handler"
    );

    let shared = fn_body(&src, "pub(crate) fn handle_sync_completed(");
    assert!(
        !shared.contains("finish_mass_delete_cycle"),
        "handle_sync_completed is shared with the reviewed-conflict path, which carries no hold events: \
         finishing there would clear a hold that still stands"
    );
}

#[test]
fn the_logging_stop_gap_is_gone() {
    let src = bridge_src();
    assert!(
        !src.contains("MASS_DELETE_LOGGED"),
        "the hold is tracked on AppState now; the static stop-gap must not come back"
    );
    assert!(
        src.contains("handle_mass_delete_event(&app, event)"),
        "mass-delete events reach the state"
    );
}

#[test]
fn init_seeds_the_hold_before_registering_the_drive() {
    let src = lifecycle_src();
    let body = fn_body(&src, "pub(crate) async fn initialize_sync_inner(");
    let arm = body
        .find("mass_delete_holds")
        .expect("init arms the hold state (member flag, sync root, seed)");
    let register = body.find("register_drive(").expect("init registers the drive");
    assert!(
        arm < register,
        "arm before the loop can run a cycle, or the first cycle's hold is recorded against an unarmed label"
    );
}

#[test]
fn teardown_paths_forget_the_holds() {
    let lifecycle = lifecycle_src();
    assert!(
        fn_body(&lifecycle, "pub async fn stop_sync(").contains("mass_delete_holds.clear_all()"),
        "logout must drop the signed-out account's holds"
    );
    assert!(
        fn_body(&lifecycle, "pub(crate) async fn remove_drive_for_account(").contains("mass_delete_holds.clear(&label)"),
        "a removed drive's hold must not linger"
    );

    let bridge = bridge_src();
    assert!(
        fn_body(&bridge, "fn handle_sync_reset(").contains("mass_delete_holds.clear_all()"),
        "an account switch must not inherit the previous account's holds"
    );
}
