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
