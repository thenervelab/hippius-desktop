//! Wiring pins for the empty-drive prompt.
//!
//! hcfs refuses every cycle with `SyncError::SuspiciousEmptyRemote` while a
//! drive's server listing is empty and this device still has its files. The
//! bridge routes the refusal to its own prompt instead of the generic
//! failure path, and every edge that ends or pauses an episode takes the
//! prompt down. The handlers need a live Tauri app, so the edges are pinned
//! by source inspection, the same idiom as `root_not_mounted_wiring.rs`; the
//! state transitions themselves are unit-tested in `sync::empty_remote`.

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
    let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// The refusal leaves the generic path before the flaky-endpoint counter and
/// the "Sync Failed" notification see it: nothing failed, and a drive that
/// is waiting on its owner must not read as a repeating sync failure.
#[test]
fn the_refusal_routes_before_the_flaky_counter() {
    let src = read("src/sync/projection/tauri_bridge.rs");

    let classify = fn_body(&src, "pub(crate) fn classify_sync_error(");
    assert!(classify.contains("suspicious_empty_remote_count("), "classified from hcfs's own Display");

    let body = fn_body(&src, "pub(crate) fn handle_sync_error(");
    let routed = body
        .find("handle_empty_remote(")
        .expect("handle_sync_error routes the refusal to its own handler");
    let counted = body.find("error_notify.record_failure(").expect("generic arm counts failures");
    assert!(routed < counted, "the empty-remote arm must return before the flaky counter");

    let handler = fn_body(&src, "fn handle_empty_remote(");
    assert!(handler.contains("empty_remote_prompt::report("), "the prompt hears every refusal");
    assert!(handler.contains("SyncErrorKind::EmptyRemote"), "the payload carries the structured kind");
    assert!(handler.contains("EMPTY_REMOTE_MESSAGE"), "the payload carries the user copy");
    assert!(!handler.contains("SYNC_FAILED_NOTIFY"), "never a \"Sync Failed\" notification");
}

/// Every edge that ends an episode takes the prompt down: a cycle that got
/// past the fetch (the plan callback, and the shared completion), drive
/// removal, logout and an account reset. A stop only hides it.
#[test]
fn every_episode_edge_takes_the_prompt_down() {
    let bridge = read("src/sync/projection/tauri_bridge.rs");
    for (sig, call) in [
        ("pub(crate) fn handle_sync_completed(", "empty_remote_prompt::end_episode("),
        ("fn handle_sync_stopped(", "empty_remote_prompt::hide("),
        ("fn handle_sync_reset<", "empty_remote.clear_all()"),
        ("fn handle_sync_started(", "empty_remote_prompt::begin_cycle("),
    ] {
        assert!(fn_body(&bridge, sig).contains(call), "{sig} must call {call}");
    }

    let callbacks = read("src/sync/drive/lifecycle/callbacks.rs");
    let plan_ready = fn_body(&callbacks, "fn build_plan_ready_callback<");
    assert!(
        plan_ready.contains("empty_remote_prompt::end_episode("),
        "hcfs plans only after accepting the listing, and a no-change cycle emits no SyncCompleted"
    );

    let lifecycle = read("src/sync/drive/lifecycle.rs");
    let remove = fn_body(&lifecycle, "pub(crate) async fn remove_drive_for_account(");
    assert!(remove.contains("empty_remote_prompt::end_episode("), "a removed drive's prompt goes");
    assert!(lifecycle.contains("app_state.empty_remote.clear_all();"), "logout forgets every prompt");
}

/// The answer is checked and written lock-free, and the commands are
/// reachable from the UI.
#[test]
fn the_commands_are_registered_and_check_membership_first() {
    let main = read("src/main.rs");
    for command in [
        "empty_remote_prompt::confirm_empty_remote",
        "empty_remote_prompt::get_empty_remote_drives",
    ] {
        assert!(main.contains(command), "{command} must be registered");
    }

    let prompt = read("src/sync/drive/empty_remote_prompt.rs");
    let confirm = fn_body(&prompt, "pub async fn confirm_empty_remote(");
    let checked = confirm.find("check_confirmable(").expect("membership and state are checked");
    let written = confirm.find(".confirm_empty_remote()").expect("hcfs's confirmation is written");
    assert!(checked < written, "a member's confirmation is refused before any marker is written");
    assert!(confirm.contains("resolve_drive_identity("), "membership comes from sync_paths");
}
