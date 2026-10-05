//! Wiring pins for the large-delete prompt's hold state
//! (`sync::mass_delete_hold`).
//!
//! The state's transitions are unit-tested in its module; what those tests
//! cannot see is WHERE the bridge and the lifecycle drive them, and each of
//! these call sites needs a live Tauri app and a real engine cycle to reach.
//! A missing one fails silently: no `begin_cycle` and a hold is never
//! cleared; a `finish` in the completion handler both paths share and a
//! cycle is finished twice; a reviewed sync that does not record its
//! outcome and a restore it applied never puts its folders back; a missing
//! clear and one account's hold shows on another's drive. Pinned by source inspection, the
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
fn each_path_finishes_its_own_cycle_outside_the_shared_completion() {
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
        "handle_sync_completed is shared with the reviewed-conflict path, which finishes its own cycle \
         (report_reviewed_mass_deletes): finishing here too would run it twice"
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

/// The prompt's three commands must be registered, and async: a sync
/// `#[tauri::command]` runs on the OS main thread, and these read a held
/// record that can be megabytes and query the database.
#[test]
fn the_prompt_commands_are_registered_and_async() {
    let main = read("src/main.rs");
    let commands = read("src/sync/drive/mass_delete.rs");
    for name in ["restore_mass_delete", "confirm_mass_delete", "get_mass_delete_holds"] {
        assert!(
            main.contains(&format!("crate::sync::mass_delete::{name},")),
            "{name} must be in generate_handler!"
        );
        assert!(
            commands.contains(&format!("pub async fn {name}(")),
            "{name} must be async (off the main thread)"
        );
    }
}

/// The folder job reads the hold, restores owed folders, and only then runs
/// reconcile and materialize, both gated. Out of order, a restore's
/// forgotten rows would be missed by the run that should act on them, and an
/// ungated half would carry out the folder side of a held delete.
#[test]
fn the_folder_job_gates_both_halves_and_restores_first() {
    let src = read("src/sync/migrate/folder_entries_materialize.rs");
    let body = fn_body(&src, "pub async fn run_folder_entity_sync_for_drive(");

    let gate = body.find("read_folder_hold_gate(").expect("the job reads hcfs's hold record");
    let restore = body
        .find("restore_held_folders(")
        .expect("the job restores the folders of a restored hold");
    let reconcile = body.find("reconcile_with_on_disk(drive, &on_disk, gate)").expect("reconcile is gated");
    let materialize = body
        .find("materialize_with_on_disk(drive, &root, &on_disk, gate)")
        .expect("materialize is gated");
    assert!(gate < restore && restore < reconcile && reconcile < materialize);
}

/// The empty-root check reads the drive folder, which an unplugged network
/// share can stall. It must run on the blocking pool, after the change
/// check, never on hcfs's event thread for every repeated report, and only
/// for a report that starts a settle (not one a running settle covers).
#[test]
fn the_empty_root_check_runs_off_the_event_thread_and_only_on_a_change() {
    let src = bridge_src();
    let body = fn_body(&src, "fn handle_mass_delete_held<");
    let record = body.find("record_held(").expect("the report is recorded first");
    let unchanged = body.find("!= HeldChange::Changed").expect("a report that starts no settle returns early");
    let blocking = body.find("spawn_blocking(").expect("the check runs on the blocking pool");
    let check = body.find("root_looks_empty(").expect("the check is made");
    assert!(record < unchanged && unchanged < blocking && blocking < check);
    assert!(
        body[blocking..].contains("settle_held("),
        "the emit goes through settle_held, which drops a hold that changed or cleared meanwhile"
    );
}

/// An accepted answer is noted on the hold state once the marker is
/// written, and before the sync round starts: the cycle that round starts
/// is the first that can tell whether the answer was applied, and a hold it
/// still reports must reach the UI again (`note_answered`), or the banner
/// says "Restoring…" for good. Noted before the write, a cycle starting in
/// between would re-show a hold whose answer it never read.
#[test]
fn an_accepted_answer_is_noted_between_the_write_and_the_sync_round() {
    let src = read("src/sync/drive/mass_delete.rs");
    let body = fn_body(&src, "async fn answer_hold(");
    let write = body.find("write_answer(").expect("the answer is written");
    let noted = body
        .find("mass_delete_holds.note_answered(")
        .expect("the answer is noted on the hold state");
    let round = body.find("trigger_sync(").expect("a sync round is started");
    assert!(write < noted && noted < round);
}

/// The reviewed-conflict sync runs the same hcfs cycle body as the engine
/// (restores applied, holds found; `mass_delete_reviewed_sync.rs`), but
/// its results arrive on the outcome rather than as events. It must open
/// the cycle before hcfs reads the answers, and record the outcome's
/// restores and holds (closing the cycle) before the shared completion
/// handler, as the engine's `SyncCompleted` arm does.
#[test]
fn a_reviewed_sync_records_its_restores_and_holds() {
    let src = read("src/sync/drive/control.rs");
    let body = fn_body(&src, "pub async fn sync_with_conflict_resolutions(");
    let begin = body.find("mass_delete_holds.begin_cycle(").expect("the reviewed sync opens a hold cycle");
    let sync = body.find(".sync_with_resolutions(").expect("the reviewed sync runs");
    let report = body
        .find("report_reviewed_mass_deletes(")
        .expect("the outcome's restores and holds are recorded");
    let completed = body.find("handle_sync_completed(").expect("completion is shared");
    assert!(begin < sync && sync < report && report < completed);
}

/// Removing a drive drops its holds, and each side that was showing a
/// banner is told to the UI with the same cleared event a cycle sends:
/// nothing else takes the banner down, and its buttons would answer a
/// drive that is gone.
#[test]
fn removing_a_drive_tells_the_ui_its_holds_cleared() {
    let lifecycle = lifecycle_src();
    let body = fn_body(&lifecycle, "pub(crate) async fn remove_drive_for_account(");
    let clear = body.find("mass_delete_holds.clear(&label)").expect("the holds are dropped");
    let emit = body.find("emit_mass_delete_cleared(").expect("each cleared side is emitted");
    assert!(clear < emit);

    let bridge = bridge_src();
    assert!(
        fn_body(&bridge, "fn finish_mass_delete_cycle<").contains("emit_mass_delete_cleared("),
        "one cleared event shape for both"
    );
}
