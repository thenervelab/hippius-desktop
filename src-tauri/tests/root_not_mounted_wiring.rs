//! Wiring pins for the "Hippius folder looks disconnected" path.
//!
//! hcfs refuses every cycle with `SyncError::RootNotMounted` until the drive
//! folder's disk is back. The bridge gives it its own copy and lets one
//! notification through per episode. The handlers need a live Tauri app, so
//! the episode edges are pinned by source inspection, the same idiom as
//! `folder_restore_notify_wiring.rs`.

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

fn bridge_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/tauri_bridge.rs")).expect("read tauri_bridge.rs")
}

/// The refusal must leave the generic path before the flaky-endpoint counter
/// sees it: an unplugged disk is not a flaky server, and the 3-strike gate
/// would both delay the message and spend the outage notification.
#[test]
fn the_refusal_routes_before_the_flaky_counter() {
    let src = bridge_src();
    let body = fn_body(&src, "pub(crate) fn handle_sync_error(");

    let routed = body
        .find("handle_root_not_mounted(")
        .expect("handle_sync_error must route RootNotMounted to its own handler");
    let counted = body.find("error_notify.record_failure(").expect("generic arm counts failures");
    assert!(routed < counted, "the unmounted-root arm must return before the flaky counter");
}

/// One notification per episode: the handler gates on its own latch, and
/// every edge that ends an episode re-arms it.
#[test]
fn the_latch_gates_the_notification_and_every_episode_edge_rearms_it() {
    let src = bridge_src();

    let handler = fn_body(&src, "fn handle_root_not_mounted(");
    assert!(handler.contains("root_not_mounted_notify"), "the notification is latched per label");
    assert!(
        handler.contains("SyncErrorKind::RootNotMounted"),
        "the payload carries the structured kind"
    );
    assert!(handler.contains("ROOT_NOT_MOUNTED_MESSAGE"), "the payload carries the user copy");

    for (sig, call) in [
        ("fn handle_sync_completed(", "root_not_mounted_notify.clear("),
        ("fn handle_sync_stopped(", "root_not_mounted_notify.clear("),
        ("fn handle_sync_reset(", "root_not_mounted_notify.clear_all()"),
    ] {
        assert!(fn_body(&src, sig).contains(call), "{sig} must re-arm the latch with {call}");
    }
}

fn callbacks_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle/callbacks.rs")).expect("read callbacks.rs")
}

/// The disk coming back is itself the end of an episode. hcfs emits
/// `SyncStarted` BEFORE its mount check (`run_sync_cycle` precedes
/// `check_root_mounted` in `sync_flow`), so it cannot say the disk is back;
/// the plan-ready callback runs only after the check passed, on every such
/// cycle, empty plans included. Re-arming there means a disk that comes back
/// and is unplugged again before any cycle completes still notifies.
#[test]
fn a_plan_after_the_mount_check_rearms_the_latch() {
    let src = callbacks_src();
    let body = fn_body(&src, "fn build_plan_ready_callback<");
    let rearm = body
        .find("root_not_mounted_notify.clear(")
        .expect("the plan-ready callback must re-arm the unmounted-root latch");
    let empty_return = body.find("if total == 0").expect("empty-plan early return");
    assert!(
        rearm < empty_return,
        "re-arm before the empty-plan return: an empty plan also passed the check"
    );

    let bridge = bridge_src();
    let started = fn_body(&bridge, "fn handle_sync_started(");
    assert!(
        !started.contains("root_not_mounted_notify"),
        "SyncStarted precedes the mount check and must not re-arm the latch"
    );
}
