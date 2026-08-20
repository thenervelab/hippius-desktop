//! Regression guard: the `tray-panel` capability MUST be registered in
//! `tauri.conf.json`'s `security.capabilities` list.
//!
//! Tauri v2 treats `security.capabilities` as an explicit allow-list: when it is
//! present, ONLY the listed capabilities are loaded. The least-privilege tray
//! capability lives in `capabilities/tray-panel.json` (audit H-13), but a
//! capability file on disk is INERT unless it's also named here. When it was
//! missing, the popover webview could `invoke` app commands (not capability-
//! gated) but could NOT `event.listen` (gated by `core:event:allow-listen`,
//! granted only to `main` via the `default` capability) — so the popover
//! received no `block_number_updated` / `sync_progress_snapshot` /
//! `hippius:tray-panel-shown` events, never refreshed on open, and sat on its
//! stale boot-gap menu (credits "—", endless skeleton). This pins the wiring so
//! a config edit can't silently re-break it.

use serde_json::Value;

#[test]
fn tauri_conf_registers_tray_panel_capability() {
    let conf: Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).expect("read tauri.conf.json"))
            .expect("tauri.conf.json is valid JSON");

    let caps = conf["app"]["security"]["capabilities"]
        .as_array()
        .expect("app.security.capabilities is an array");

    let names: Vec<&str> = caps.iter().filter_map(|c| c.as_str()).collect();

    assert!(
        names.contains(&"tray-panel"),
        "tauri.conf.json security.capabilities must include \"tray-panel\" or the \
         popover webview cannot event.listen (no live updates / stale boot menu). \
         Found: {names:?}",
    );
    assert!(
        names.contains(&"default"),
        "the main-window \"default\" capability must remain registered. Found: {names:?}",
    );
}

#[test]
fn tray_panel_capability_grants_event_listen() {
    // The capability file itself must still carry the event-listen grant the
    // popover depends on (a refactor could strip it even while it stays listed).
    let cap: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities/tray-panel.json")).expect("read capabilities/tray-panel.json"),
    )
    .expect("tray-panel.json is valid JSON");

    let perms: Vec<&str> = cap["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert_eq!(
        cap["windows"].as_array().and_then(|w| w.first()).and_then(|w| w.as_str()),
        Some("tray-panel"),
        "tray-panel capability must target the tray-panel window",
    );
    assert!(
        perms.contains(&"core:event:allow-listen"),
        "tray-panel capability must grant core:event:allow-listen. Found: {perms:?}",
    );
    // The popover's revealMain() un-minimizes the main window when the user
    // clicks Open Hippius / the bell / search while main is minimized. This op
    // is NOT in core:window:default, so it must be granted explicitly or those
    // buttons silently throw (and never run show()/the navigation emit).
    assert!(
        perms.contains(&"core:window:allow-unminimize"),
        "tray-panel capability must grant core:window:allow-unminimize so the \
         popover can reveal a minimized main window. Found: {perms:?}",
    );
}
