//! Static regression guards for the scan-log throttle wiring.
//!
//! The throttle's own behaviour — suppression, resumption, the burst collapse
//! and the scan-boundary flush — is pinned by the unit tests in
//! `src/sync/drive/lifecycle/callbacks.rs`. What those tests cannot see is
//! whether the scan callback still ROUTES THROUGH it. `LogThrottle` is
//! constructed and matched entirely inside `build_scan_callback`, so a
//! refactor that reinstates an unconditional `info!` there leaves every unit
//! test green while support bundles go back to covering 65 seconds of a day
//! (a 5 MB tail against ~340 lines/second).
//!
//! Same pattern as `tests/keep_awake_wiring.rs` and
//! `tests/hippius_relative_path_backfill.rs`.

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

fn callbacks_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle/callbacks.rs")).expect("read callbacks.rs")
}

/// The scan callback fires once per file walked. Every `info!` it reaches must
/// be behind the throttle's verdict.
#[test]
fn scan_callback_routes_its_log_through_the_throttle() {
    let src = callbacks_src();
    let body = fn_body(&src, "fn build_scan_callback(");

    assert!(
        body.contains("log_throttle.decide("),
        "build_scan_callback must ask the throttle before logging — an \
         unconditional info! here is ~340 lines/second on a large drive",
    );

    assert!(
        body.contains("ScanLog::Nothing") && body.contains("ScanLog::Progress") && body.contains("ScanLog::FinishedPrevious"),
        "the throttle verdict must be matched exhaustively",
    );

    // Counting is the part that actually bites. Asserting only that `decide`
    // is called would still pass if an unconditional `info!` were reinstated
    // alongside it — the exact mutation this pin exists for. Exactly two
    // logging sites are correct: the `Progress` arm and the two-line
    // `FinishedPrevious` arm, which emits the completed total and then the
    // new scan's opening line.
    let logs = body.matches("info!(").count();
    assert_eq!(
        logs, 3,
        "build_scan_callback must log ONLY from its ScanLog match arms \
         (1 in Progress + 2 in FinishedPrevious); found {logs} info! sites, so \
         one is firing per file",
    );
}

/// The per-file Tauri event was removed because nothing listens to it; the
/// scanned counter reaches the UI on the throttled `sync_progress_snapshot`
/// via `note_engine_activity`. Re-adding an emit here would push ~80k
/// payloads per cycle into the webview for no consumer.
#[test]
fn scan_callback_emits_no_per_file_tauri_event() {
    let src = callbacks_src();
    let body = fn_body(&src, "fn build_scan_callback(");

    assert!(
        !body.contains("app.emit("),
        "build_scan_callback must not emit a per-file Tauri event; the counter \
         travels on the throttled snapshot (see note_engine_activity)",
    );
    assert!(
        body.contains("note_engine_activity("),
        "the scanned counter must still reach the preparing state, which is \
         what feeds `preparingScannedFiles` in the UI",
    );
}
