//! Wiring guard for the tray-popover "shown" refresh signal (F-3 recurrence).
//!
//! The popover webview is prewarmed and REUSED across opens, so its React state
//! persists. The webview's own focus event is unreliable across re-shows, so
//! `toggle_tray_panel` emits an explicit `hippius:tray-panel-shown` event on
//! every show and `useTrayPanelData` refetches its account / credits / uploads
//! on it. If either side drops or renames the event, the popover silently
//! reverts to the stale boot-gap menu it fetched before `restore_session`
//! hydrated the session — credits "—" and an endless loading skeleton.
//!
//! These are source-text guards (the Tauri window show path can't be unit-
//! tested without a running app) that pin the EXACT event string on both sides.

const EVENT: &str = "hippius:tray-panel-shown";

/// Brace-match the body of a `fn` (by signature substring) in the given source.
fn fn_body<'a>(src: &'a str, signature: &str) -> &'a str {
    let sig = src.find(signature).unwrap_or_else(|| panic!("{signature} present"));
    let body_start = src[sig..].find('{').expect("fn body opens") + sig;
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

#[test]
fn toggle_tray_panel_emits_shown_event_on_show() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray/panel.rs")).expect("read panel.rs");
    let body = fn_body(&src, "pub fn toggle_tray_panel(");

    // The literal event string appears in the body ONLY at the real emit call
    // (the surrounding doc comment deliberately doesn't repeat it).
    assert!(
        body.contains(EVENT),
        "toggle_tray_panel must emit `{EVENT}` on show so the reused popover \
         refetches its account/credits/uploads (F-3 recurrence guard)",
    );
    assert!(
        body.contains(".emit("),
        "toggle_tray_panel must actually call .emit(...) — not just mention the event",
    );
}

#[test]
fn frontend_listens_for_shown_event() {
    let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../app/lib/tray/useTrayPanelData.ts")).expect("read useTrayPanelData.ts");
    assert!(
        ts.contains(EVENT),
        "useTrayPanelData must listen for `{EVENT}` — the Rust emit is useless \
         if the frontend event name drifts",
    );
}
