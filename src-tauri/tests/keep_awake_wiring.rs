//! Static regression guards for the keep-awake wiring.
//!
//! The behavior itself (pure resolver + edge-triggered acquire/release with
//! a fake blocker, including the missed-terminal-event fallback) is pinned by
//! the unit tests in `src/power.rs`. What those tests cannot see is whether
//! the bridge still CALLS the feature — a refactor of
//! `sync/projection/tauri_bridge.rs` could silently drop the hook and every
//! unit test would stay green while machines resume sleeping mid-upload.
//! Same pattern as `tests/hippius_relative_path_backfill.rs`'s
//! `spawn_backfill` pin.

/// Extract the brace-matched body of the function whose signature contains
/// `sig` — more precise than a whole-file substring match, which would pass
/// if the call lived in an unrelated helper.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[body_start..=body_start + i];
                }
            }
            _ => {}
        }
    }
    panic!("`{sig}` body never closes");
}

fn bridge_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/tauri_bridge.rs")).expect("read tauri_bridge.rs")
}

/// The `ProgressSnapshot` funnel is the PRIMARY driver and the safety net
/// (every live frame re-evaluates, so a missed terminal event is corrected by
/// the next idle frame). It must feed the pure resolver's verdict into the
/// edge-triggered `apply`.
#[test]
fn progress_snapshot_funnel_drives_keep_awake() {
    let src = bridge_src();
    let body = fn_body(&src, "fn handle_progress_snapshot(");
    assert!(
        body.contains("keep_awake") && body.contains("should_hold_keep_awake"),
        "handle_progress_snapshot must apply the keep-awake resolver on every frame \
         (the acquire trigger AND the missed-terminal-event safety net)",
    );
}

/// The terminal/reset arms are the belt-and-braces release paths for teardown
/// orderings where no further snapshot follows (pause / remove / logout /
/// account switch / failed cycle).
#[test]
fn terminal_event_arms_reevaluate_keep_awake() {
    let src = bridge_src();
    for sig in ["fn handle_sync_stopped(", "fn handle_sync_reset(", "fn handle_sync_error("] {
        let body = fn_body(&src, sig);
        assert!(
            body.contains("reevaluate_keep_awake"),
            "{sig}..) must re-evaluate keep-awake so the sleep assertion cannot outlive the transfers",
        );
    }
}
