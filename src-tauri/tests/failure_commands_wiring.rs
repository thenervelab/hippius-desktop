//! Static pins for skip vs permanent-exclude missing-drive behavior.
//!
//! The IPCs need a live `DriveManager` to write exclude patterns. Permanent
//! exclude used to return Ok when the drive was gone, so the FE reported
//! success and the file resurfaced next cycle. Skip is session-scoped and
//! records in-memory even without a drive. A refactor that swaps those two
//! postures would be invisible to unit tests that cannot construct a Tauri
//! `State`. Same pattern as `tests/auth_wiring_pins.rs`.

fn source() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/failure/failure_commands.rs")).expect("read failure_commands.rs")
}

fn slice_between<'a>(src: &'a str, start: &str, end: &str) -> &'a str {
    let begin = src
        .find(start)
        .unwrap_or_else(|| panic!("marker {start:?} not found — update failure_commands_wiring.rs"));
    let tail = &src[begin..];
    match tail.find(end) {
        Some(stop) => &tail[..stop],
        None => tail,
    }
}

#[test]
fn permanent_exclude_fails_closed_when_the_drive_is_missing() {
    let src = source();
    let body = slice_between(&src, "pub async fn sp_exclude_file", "pub async fn sp_retry_file");
    assert!(
        body.contains("DriveNotInitialized"),
        "sp_exclude_file must return NotReady(DriveNotInitialized) when the drive is not loaded"
    );
    assert!(
        body.contains("let Some(arc) = drive_arc else"),
        "sp_exclude_file must fail closed on a missing drive, not `if let Some`"
    );
}

#[test]
fn session_skip_is_tolerant_of_a_missing_drive() {
    let src = source();
    let body = slice_between(&src, "pub async fn sp_skip_file", "pub async fn sp_exclude_file");
    assert!(
        !body.contains("DriveNotInitialized"),
        "sp_skip_file is session-scoped; a missing drive must not fail the IPC"
    );
    assert!(
        body.contains("if let Some(arc) = drive_arc"),
        "sp_skip_file's exclude write is supplementary and must stay optional"
    );
}

/// The path the Sync Issues dialog hands back is a file name, not a glob.
/// Writing it verbatim into `.hippius/exclude` made `[`, `{`, `*` and `?`
/// in a name change what the rule matched (and a leading `#` a comment), so
/// the file was never excluded and the dialog kept returning. Both writers
/// must go through `exclude_path_literally`, which escapes the name.
#[test]
fn exclude_and_skip_write_the_path_as_a_literal_pattern() {
    let src = source();
    let skip = slice_between(&src, "pub async fn sp_skip_file", "pub async fn sp_exclude_file");
    let exclude = slice_between(&src, "pub async fn sp_exclude_file", "pub async fn sp_retry_file");
    for (name, body) in [("sp_skip_file", skip), ("sp_exclude_file", exclude)] {
        assert!(
            body.contains("exclude_path_literally("),
            "{name} must escape the path before writing it as a rule"
        );
        assert!(!body.contains("add_exclude_pattern("), "{name} must not write the raw path as a glob");
    }
}

/// Every path that undoes a skip/exclude must remove the same escaped line
/// the write produced — otherwise Retry reports success and the file stays
/// excluded. `remove_literal_exclusion` owns that symmetry.
#[test]
fn every_retry_path_removes_the_literal_pattern() {
    let src = source();
    assert!(
        !src.contains("remove_exclude_pattern("),
        "failure_commands.rs must not remove raw paths directly"
    );
    for name in [
        "pub async fn sp_retry_file",
        "pub async fn retry_file_failure",
        "pub async fn retry_all_failures",
        "pub async fn cleanup_session_skips",
    ] {
        let body = slice_between(&src, name, "\n}\n");
        assert!(body.contains("remove_literal_exclusion("), "{name} must remove the escaped rule");
    }
}

fn read_src(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

/// Dismiss used to be frontend-only state, so the dialog returned every third
/// failing cycle and after every launch. The prompt decision now lives in
/// `FileFailureState::record_cycle_failures`, which skips dismissed files.
#[test]
fn the_prompt_decision_skips_dismissed_files() {
    let bridge = read_src("src/sync/projection/tauri_bridge.rs");
    let body = slice_between(&bridge, "fn update_failure_counts", "\n}\n");
    assert!(
        body.contains("record_cycle_failures("),
        "the bridge must ask the tracker whether to prompt"
    );
    assert!(
        !body.contains("just_reached_threshold("),
        "the bridge must not re-derive the prompt from raw counts"
    );
}

/// hcfs reports a refusal once per revision, so the cycles after one are
/// clean while the file is still refused. A clean cycle that wiped the
/// drive's rows wholesale would erase the only record of why it is not
/// syncing; the bridge must settle through the refusal-aware clear.
#[test]
fn a_clean_cycle_keeps_refusals() {
    let bridge = read_src("src/sync/projection/tauri_bridge.rs");
    let body = slice_between(&bridge, "fn update_failure_counts", "\n}\n");
    assert!(body.contains("clear_after_clean_cycle("), "the clean arm must keep refusals");
    assert!(!body.contains("clear_failures_for_label("), "no label-wide delete on a clean cycle");

    let commands = source();
    let retry_all = slice_between(&commands, "pub async fn retry_all_failures", "\n}\n");
    assert!(
        retry_all.contains("clear_retryable_failures_for_label("),
        "retry all must not erase a refusal it cannot fix"
    );
}

/// A dismissal is durable: written by the IPC the dialog calls, restored into
/// the in-memory tracker when the drive initializes, and the command is
/// registered so the frontend can reach it.
#[test]
fn dismissals_are_persisted_and_restored_at_drive_init() {
    let src = source();
    let body = slice_between(&src, "pub async fn sp_dismiss_failed_files", "\n}\n");
    assert!(body.contains(".dismiss("), "the in-memory tracker must learn the dismissal immediately");
    assert!(body.contains("mark_dismissed("), "the dismissal must be written durably");

    let lifecycle = read_src("src/sync/drive/lifecycle.rs");
    let init = slice_between(&lifecycle, "async fn initialize_sync_inner", "\n}\n");
    assert!(
        init.contains("spawn_restore_dismissed_failures("),
        "drive init must restore durable dismissals"
    );

    let main = read_src("src/main.rs");
    assert!(main.contains("failure_commands::sp_dismiss_failed_files"), "the IPC must be registered");
}

/// Retry, Skip and Exclude from the dialog must drop the durable row too —
/// otherwise a stale `dismissed_at` on that row is restored at the next
/// launch and silences a file the user explicitly asked to retry.
#[test]
fn dialog_actions_drop_the_durable_row() {
    let src = source();
    for name in ["pub async fn sp_skip_file", "pub async fn sp_exclude_file", "pub async fn sp_retry_file"] {
        let body = slice_between(&src, name, "\n}\n");
        assert!(body.contains("clear_durable_failure("), "{name} must clear the persisted failure row");
    }
}

/// A refused file cannot be retried (hcfs reports a refusal once per
/// revision), so the Drive row offers Dismiss instead: an IPC that drops the
/// saved row and the in-memory counters and does NOT sync or touch the
/// exclude file. Registered so the frontend can reach it.
#[test]
fn dismissing_a_failure_drops_the_row_without_syncing() {
    let src = source();
    let body = slice_between(&src, "pub async fn clear_file_failure", "\n}\n");
    assert!(body.contains("clear_file_failure_inner("), "the command delegates to the testable inner");
    let inner = slice_between(&src, "pub async fn clear_file_failure_inner", "\n}\n");
    assert!(inner.contains("clear_durable_failure("), "the saved row must go");
    assert!(inner.contains(".clear_failure("), "the in-memory counters must go");
    for forbidden in ["trigger_sync", "exclusion", "exclude_path"] {
        assert!(!inner.contains(forbidden), "dismiss must not {forbidden}");
    }

    let main = read_src("src/main.rs");
    assert!(main.contains("failure_commands::clear_file_failure,"), "the IPC must be registered");
}

/// The Sync Issues dialog decides Retry by the failure's KIND: a refusal's
/// text is hcfs's own and cannot be matched. The bridge records the kind
/// where it is known, the FileFailed event.
#[test]
fn the_bridge_records_each_failure_kind_for_the_dialog() {
    let bridge = read_src("src/sync/projection/tauri_bridge.rs");
    let body = slice_between(&bridge, "fn handle_file_failed(", "\n}\n");
    assert!(
        body.contains("file_failures") && body.contains(".note_kind("),
        "the kind must reach the dialog"
    );
}

/// Removing a drive drops its saved failures, refusals and dismissal stamps
/// included, in the account-scoped teardown `remove_sync_path` delegates to,
/// and forgets its in-memory counters. A re-added drive with the same label
/// would otherwise show old refusals and keep old dismissals.
#[test]
fn removing_a_drive_clears_its_failures() {
    let lifecycle = read_src("src/sync/drive/lifecycle.rs");
    let body = slice_between(&lifecycle, "pub(crate) async fn remove_drive_for_account", "\n}\n");
    assert!(body.contains("clear_failures_for_drive("), "the drive's rows must go");
    assert!(body.contains("file_failures.clear_all_for_label("), "its counters and dismissals too");
}
