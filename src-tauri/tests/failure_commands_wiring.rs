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
