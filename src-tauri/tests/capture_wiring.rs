//! Source pins for screen capture: the wiring whose failure is silent.
//!
//! Each rule here breaks without an error. A capture of an unprotected overlay
//! is a screenshot of the dimmed selection UI; a capability that does not
//! match the overlay labels leaves the overlay unable to hear the session end;
//! a delivery that grew its own upload would skip the storage gate and the
//! shared-drive identity rules that the existing path carries.

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

fn fn_body(src: &str, sig: &str) -> String {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("signature not found: {sig}"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return src[body_start..=body_start + i].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("fn body never closes: {sig}");
}

/// Without content protection the overlay is in its own screenshot.
#[test]
fn the_overlay_keeps_itself_out_of_the_capture() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn build_overlay(");
    assert!(
        body.contains(".content_protected(true)"),
        "the overlay must be excluded from screen capture"
    );
    assert!(
        fn_body(&src, "async fn open_overlay(").contains("build_overlay("),
        "every overlay is built by build_overlay"
    );
}

/// Same rule for the recording control bar — otherwise it films itself.
#[test]
fn the_controls_keep_themselves_out_of_the_recording() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn open_controls(");
    assert!(
        body.contains(".content_protected(true)"),
        "the control bar must be excluded from screen capture"
    );
}

/// The overlay's capability must grant the labels the overlays are created
/// with; a glob that matches nothing fails silently — the window opens with
/// no event permissions at all.
#[test]
fn the_overlay_capability_matches_the_overlay_labels() {
    let src = read("src/capture/commands.rs");
    let prefix_line = src
        .lines()
        .find(|l| l.contains("pub const OVERLAY_LABEL_PREFIX"))
        .expect("OVERLAY_LABEL_PREFIX is declared");
    let prefix = prefix_line.split('"').nth(1).expect("prefix is a string literal");

    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-overlay.json")).expect("capability parses");
    let windows: Vec<&str> = capability["windows"]
        .as_array()
        .expect("windows")
        .iter()
        .filter_map(|w| w.as_str())
        .collect();
    assert!(
        windows.contains(&format!("{prefix}*").as_str()),
        "capture-overlay.json must grant {prefix}* — it grants {windows:?}"
    );
}

/// The overlay sits over every app on screen; it must not inherit the main
/// window's file-system or opener grants.
#[test]
fn the_overlay_capability_grants_nothing_it_does_not_use() {
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-overlay.json")).expect("capability parses");
    for permission in capability["permissions"].as_array().expect("permissions") {
        let name = permission.as_str().unwrap_or_default();
        assert!(
            name.starts_with("core:"),
            "the capture overlay must hold core permissions only, found {name}"
        );
    }
}

/// A capture is uploaded and shared through the paths a dropped file and the
/// Finder's "Share with Hippius" already take, never a new one.
#[test]
fn delivery_reuses_the_existing_upload_and_share_paths() {
    let src = read("src/capture/deliver.rs");
    let body = fn_body(&src, "pub async fn place(");
    assert!(
        body.contains("upload_files_to_remote_folder_inner("),
        "the upload must be the remote file upload"
    );
    let mint = fn_body(&src, "pub async fn mint(");
    // A capture in a synced drive is shared by its place in the drive, so
    // Drive shows it as shared and can revoke the link; any other file the
    // way the Finder shares one.
    assert!(mint.contains("share_synced_file("), "a synced capture's link must record its origin");
    assert!(mint.contains("share_external_file("), "the link must come from the existing share path");
    for body in [&body, &mint] {
        for forbidden in ["HcfsClient", "reqwest", "encrypt"] {
            assert!(!body.contains(forbidden), "delivery must not talk to the server itself ({forbidden})");
        }
    }
}

/// A failed upload must leave the capture on disk; only a delivered one is removed.
#[test]
fn the_temp_copy_is_removed_only_after_the_upload_lands() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "async fn deliver_and_announce(");
    let ok_arm = body.find("Ok((account_id, destination, mint_link, placed)) =>").expect("success arm");
    let err_arm = body.find("Err(e) =>").expect("failure arm");
    let removal = body.find("remove_dir_all").expect("the temp copy is removed somewhere");
    assert!(ok_arm < removal && removal < err_arm, "remove_dir_all must sit in the success arm only");
    assert_eq!(body.matches("remove_dir_all").count(), 1, "exactly one removal, on success");
}

/// The card hears that the file is in the drive before the link is made,
/// and a synced capture is followed from that moment. Waiting for both held
/// the card on "Preparing upload" through the whole upload and the mint.
#[test]
fn the_card_is_told_the_file_is_placed_before_the_link_is_made() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "async fn deliver_and_announce(");
    let placed = body.find("announce_placed(").expect("the placement is announced");
    let link = body.find("link_for(").expect("the link is made");
    assert!(placed < link, "the card must hear of the placement before the mint");
    let announce = fn_body(&src, "fn announce_placed(");
    assert!(announce.contains("spawn_sync_follow("), "a synced capture is followed at once");
    assert!(announce.contains("LinkState::Creating"), "the card says the link is being made");
    // The follower asks every source the engine answers from.
    let facts = fn_body(&src, "fn sync_facts(");
    for source in ["current_session", "recent_files", "is_synced("] {
        assert!(facts.contains(source), "sync_facts must read {source}");
    }
    assert!(facts.contains("same_drive_path("), "the row is matched by its path in the drive");
    let follow = fn_body(&src, "fn spawn_sync_follow(");
    assert!(follow.contains("link_fallback_applies("), "the bounded fallback must be applied");
    // The cycle is started, never waited for, by the placement.
    let place = fn_body(&read("src/capture/deliver.rs"), "pub async fn place(");
    let spawn = place.find("async_runtime::spawn(").expect("the sync is started in the background");
    let trigger = place.find("trigger_sync_now(").expect("the sync is nudged");
    assert!(
        spawn < trigger,
        "trigger_sync_now must run inside the spawned task, not be awaited inline"
    );
}

/// The preview card floats over whatever the user captures next, and it is
/// information, not a dialog: it must stay out of captures and must not take
/// the keyboard from the app the user is typing in.
#[test]
fn the_preview_card_stays_out_of_captures_and_never_takes_focus() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn open_preview_window(");
    assert!(body.contains(".content_protected(true)"), "the card must be excluded from screen capture");
    assert!(body.contains(".focused(false)"), "the card must open without taking focus");
    // Never key, so without first-mouse its buttons swallow the first click.
    assert!(
        body.contains(".accept_first_mouse(true)"),
        "the card's buttons must answer the first click"
    );
}

/// Same silent failure as the overlay: a capability for the wrong label leaves
/// the card with no event permission, so it never learns the upload finished.
#[test]
fn the_preview_capability_matches_its_label_and_holds_core_only() {
    let src = read("src/capture/commands.rs");
    let label = src
        .lines()
        .find(|l| l.contains("pub const PREVIEW_LABEL"))
        .and_then(|l| l.split('"').nth(1))
        .expect("PREVIEW_LABEL is declared");
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-preview.json")).expect("capability parses");
    let windows: Vec<&str> = capability["windows"]
        .as_array()
        .expect("windows")
        .iter()
        .filter_map(|w| w.as_str())
        .collect();
    assert_eq!(windows, vec![label], "capture-preview.json must grant exactly the card's window");
    for permission in capability["permissions"].as_array().expect("permissions") {
        let name = permission.as_str().unwrap_or_default();
        assert!(
            name.starts_with("core:"),
            "the capture card must hold core permissions only, found {name}"
        );
    }
    let conf = read("tauri.conf.json");
    assert!(
        conf.contains("\"capture-preview\""),
        "tauri.conf.json must list the capture-preview capability"
    );
}

/// A command that is declared but not registered fails only when the surface
/// that calls it is used, with "command not found" in a window nobody watches.
#[test]
fn every_capture_command_is_registered() {
    let src = read("src/capture/commands.rs");
    let main = read("src/main.rs");
    let mut found = 0;
    let lines: Vec<&str> = src.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        let sig = lines.get(i + 1).copied().unwrap_or_default();
        let name = sig
            .split("fn ")
            .nth(1)
            .and_then(|rest| rest.split(['(', '<']).next())
            .expect("a command signature follows #[tauri::command]");
        found += 1;
        assert!(
            main.contains(&format!("crate::capture::commands::{name},")),
            "{name} is a capture command but main.rs does not register it"
        );
    }
    assert!(found >= 25, "expected the capture commands to be found, got {found}");
}

/// Retry on the card sends the same file the same way, never a second path.
#[test]
fn retry_goes_through_the_same_delivery() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "pub fn capture_preview_retry(");
    assert!(body.contains("deliver_and_announce("), "Retry must reuse deliver_and_announce");
    assert!(body.contains("can_retry()"), "only a failed upload can be retried");
}

/// The camera is the one capture window that must be FILMED: a protected
/// bubble records as a black hole in the video, and a protected stage makes a
/// camera-only recording a black rectangle. It still must not take focus.
#[test]
fn the_camera_is_filmed_and_never_takes_focus() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn open_camera_window(");
    assert!(
        body.contains(".content_protected(false)"),
        "the camera must be left out of content protection, explicitly"
    );
    assert!(!body.contains(".content_protected(true)"), "a protected camera films as black");
    assert!(body.contains(".focused(false)"), "the camera must open without taking focus");
}

/// The camera page listens for its state and is dragged; a capability for the
/// wrong label leaves it blank with nothing reported anywhere.
#[test]
fn the_camera_capability_matches_its_label_and_holds_core_only() {
    let src = read("src/capture/commands.rs");
    let label = src
        .lines()
        .find(|l| l.contains("pub const CAMERA_LABEL"))
        .and_then(|l| l.split('"').nth(1))
        .expect("CAMERA_LABEL is declared");
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-camera.json")).expect("capability parses");
    let windows: Vec<&str> = capability["windows"]
        .as_array()
        .expect("windows")
        .iter()
        .filter_map(|w| w.as_str())
        .collect();
    assert_eq!(windows, vec![label], "capture-camera.json must grant exactly the camera's window");
    let permissions: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert!(
        permissions.iter().all(|p| p.starts_with("core:")),
        "core permissions only: {permissions:?}"
    );
    assert!(
        permissions.contains(&"core:window:allow-start-dragging"),
        "the bubble is placed by dragging it"
    );
    assert!(
        read("tauri.conf.json").contains("\"capture-camera\""),
        "tauri.conf.json must list the capture-camera capability"
    );
}

/// A signed, hardened build denies the camera silently without this
/// entitlement: the bubble would say "Camera unavailable" on every release.
#[test]
fn the_app_may_use_the_camera_and_says_why() {
    let entitlements = read("entitlements.plist");
    assert!(entitlements.contains("<key>com.apple.security.device.camera</key>"));
    let info = read("Info.plist");
    assert!(info.contains("<key>NSCameraUsageDescription</key>"));
}

/// Whether a plist sets `key` to `<true/>`: the value right after the key,
/// whitespace aside.
fn plist_key_is_true(plist: &str, key: &str) -> bool {
    plist
        .split(&format!("<key>{key}</key>"))
        .nth(1)
        .is_some_and(|rest| rest.trim_start().starts_with("<true/>"))
}

/// macOS offers an iPhone as a Continuity Camera only to a process whose
/// Info.plist opts in. Two processes need it: the app (the camera window's
/// getUserMedia) and the helper, whose `--list-cameras` fills the bar's
/// camera menu. A command-line helper has no bundle, so its plist must be
/// linked into the binary, and the helper must say it is signed with the
/// identifier the plist names.
#[test]
fn the_app_and_the_helper_opt_in_to_continuity_camera() {
    let key = "NSCameraUseContinuityCameraDeviceType";
    assert!(plist_key_is_true(&read("Info.plist"), key), "src-tauri/Info.plist must set {key} to true");

    let helper_plist = read("../macos/HippiusCapture/Info.plist");
    assert!(plist_key_is_true(&helper_plist, key), "the helper's Info.plist must set {key} to true");
    assert!(helper_plist.contains("<string>hippius.com.HippiusCapture</string>"));
    for usage in ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"] {
        assert!(
            helper_plist.contains(&format!("<key>{usage}</key>")),
            "the helper's Info.plist must carry {usage}"
        );
    }

    let package = read("../macos/HippiusCapture/Package.swift");
    for flag in [
        "\"-sectcreate\"",
        "\"__TEXT\"",
        "\"__info_plist\"",
        "appendingPathComponent(\"Info.plist\")",
    ] {
        assert!(
            package.contains(flag),
            "Package.swift must link Info.plist into the helper ({flag} missing)"
        );
    }

    let embed = read("../macos/embed-capture-helper.sh");
    assert!(
        embed.contains("--identifier \"hippius.com.HippiusCapture\"") && embed.contains("__TEXT,__info_plist"),
        "embed-capture-helper.sh must sign with the plist's identifier and check the plist is embedded"
    );
}

/// Camera only records the stage window itself, and every way a recording
/// ends takes the camera away with it.
#[test]
fn camera_only_records_the_stage_and_every_ending_removes_the_camera() {
    let src = read("src/capture/commands.rs");
    let confirm = fn_body(&src, "pub async fn capture_confirm(");
    assert!(confirm.contains("CameraShape::Stage") && confirm.contains("camera_window_id("));
    for ending in [
        "pub(crate) async fn stop_inner(",
        "pub(crate) async fn cancel_inner(",
        "async fn begin_recording(",
        "async fn fail_capture(",
    ] {
        assert!(fn_body(&src, ending).contains("end_camera("), "{ending} must end the camera");
    }
}

/// Once the choice is made, every failure ends the session in ONE place.
/// A `?` that skipped it left the phase stuck with no UI, and every later
/// capture was refused until a relaunch.
#[test]
fn every_failure_after_the_choice_goes_through_fail_capture() {
    let src = read("src/capture/commands.rs");
    let fail = fn_body(&src, "async fn fail_capture(");
    for step in [
        "CaptureEvent::Failed",
        "FAILED_EVENT",
        "restore_main_window(",
        "end_camera(",
        "close_controls(",
        "close_overlays(",
        "drop_unused_preview(",
        "take_leftovers(",
    ] {
        assert!(fail.contains(step), "fail_capture must do {step}");
    }
    let select = fn_body(&src, "async fn select_inner(");
    let moved = select.find("CaptureEvent::Selected").expect("select_inner moves the phase");
    let routed = select.find("fail_capture(").expect("select_inner routes failures");
    assert!(moved < routed, "failures after the phase moved go through fail_capture");
    for sig in ["async fn finish_screenshot(", "async fn begin_recording("] {
        let body = fn_body(&src, sig);
        assert!(
            !body.contains("CaptureEvent::Failed") && !body.contains("FAILED_EVENT"),
            "{sig} must return its error to select_inner, not end the session itself"
        );
    }
    for sig in ["pub(crate) async fn stop_inner(", "pub async fn capture_restart("] {
        assert!(
            fn_body(&src, sig).contains("fail_capture("),
            "{sig} must end a failed session through fail_capture"
        );
    }
}

/// A recorder that finishes starting after a Cancel is cancelled, never
/// left recording with no pill: it is adopted only under the phase check.
#[test]
fn a_recorder_is_adopted_only_while_the_session_waits_for_it() {
    let src = read("src/capture/commands.rs");
    let begin = fn_body(&src, "async fn begin_recording(");
    assert!(begin.contains("adopt_recorder("), "the recorder must be adopted under the phase lock");
    assert!(begin.contains("discard_recording(Some(orphan)"), "a refused recorder must be cancelled");
    // The main window stays hidden while recording: it would be filmed.
    assert!(
        !begin.contains("restore_main_window("),
        "the main window must not come back mid-recording"
    );
}

/// Camera only records the camera window itself: closing it before the
/// recorder stops ends the stream with the file still open.
#[test]
fn stop_closes_the_file_before_the_camera_goes() {
    let src = read("src/capture/commands.rs");
    let stop = fn_body(&src, "pub(crate) async fn stop_inner(");
    let stopped = stop.find("recorder.stop()").expect("stop_inner stops the recorder");
    let camera = stop.find("end_camera(").expect("stop_inner ends the camera");
    assert!(stopped < camera, "the recorder must stop before the camera window closes");
}

/// A start that could not open its overlays takes down everything it put up.
/// A recording that ends on its own (display unplugged, helper crashed) must
/// end the session as Stop does, through `stop_inner`, so the saved part is
/// delivered; the tick loop would otherwise count on over a dead recorder.
#[test]
fn a_recording_that_dies_is_stopped_and_delivered() {
    let src = read("src/capture/commands.rs");
    let tick = fn_body(&src, "fn tick_once(");
    assert!(tick.contains("take_death()"), "the tick must ask whether the recorder died");
    assert!(tick.contains("stop_inner(&app)"), "a dead recorder ends through stop_inner");
    assert!(tick.contains("return Tick::Done"), "the tick loop ends once the recorder died");
    assert!(!tick.contains("capture_stop("), "the command wrapper is not the internal path");
}

#[test]
fn a_start_that_fails_takes_its_windows_down() {
    let src = read("src/capture/commands.rs");
    let start = fn_body(&src, "pub async fn capture_start(");
    let arm_start = start.find("if let Err(e) = open_capture_ui(").expect("the failure arm");
    let arm = &start[arm_start..];
    let arm = &arm[..arm.find("return Err(e);").expect("the arm returns")];
    for step in [
        "end_camera(",
        "close_controls(",
        "close_overlays(",
        "drop_unused_preview(",
        "CaptureEvent::Failed",
    ] {
        assert!(arm.contains(step), "capture_start's failure arm must do {step}");
    }
    // The permission dialog asks macOS itself; asking here too put two
    // dialogs on screen at once.
    assert!(!start.contains("request_screen_capture"), "capture_start must not prompt for permission");
}

/// The share picker's pictures show every window on screen; they go to the
/// overlay that asked, not to every webview.
#[test]
fn share_pictures_go_to_the_picker_only() {
    let src = read("src/capture/commands.rs");
    let flush = fn_body(&src, "fn flush_share_art(");
    assert!(flush.contains(".emit_to("), "share pictures must be sent to one window");
    assert!(!flush.contains(".emit("), "share pictures must never be broadcast");
}

/// The pill is dragged by its body (`data-tauri-drag-region`), which needs
/// the start-dragging permission; without it the drag does nothing, silently.
#[test]
fn the_pill_may_be_dragged() {
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-controls.json")).expect("capability parses");
    let permissions: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert!(permissions.contains(&"core:window:allow-start-dragging"), "{permissions:?}");
    assert!(
        permissions.iter().all(|p| p.starts_with("core:")),
        "core permissions only: {permissions:?}"
    );
}

/// Signing out cancels a live capture and unregisters the shortcut, before
/// the session is cleared (the cancel needs nothing from it, the delivery
/// of a capture left running would fail with no account).
#[test]
fn signing_out_ends_the_capture_and_the_shortcut() {
    let src = read("src/auth/logout.rs");
    let body = fn_body(&src, "pub async fn logout_full(");
    let ended = body.find("capture::commands::end_for_logout(").expect("logout_full ends the capture");
    let cleared = body.find("auth_logout_internal(").expect("logout_full clears the session");
    assert!(ended < cleared, "the capture ends before the session is cleared");
    let end = fn_body(&read("src/capture/commands.rs"), "pub async fn end_for_logout(");
    assert!(end.contains("cancel_inner(") && end.contains("shortcut::apply(app, None)"));
}

/// The shortcut toggles, decided in Rust; it no longer only emits.
#[test]
fn the_shortcut_is_handled_in_rust() {
    let src = read("src/capture/shortcut.rs");
    let plugin = fn_body(&src, "pub fn plugin(");
    assert!(plugin.contains("on_shortcut(app)"), "the handler must go through commands::on_shortcut");
    let on = fn_body(&read("src/capture/commands.rs"), "pub fn on_shortcut(");
    for action in ["stop_inner(", "cancel_inner(", "SHORTCUT_EVENT", "show_main_window("] {
        assert!(on.contains(action), "on_shortcut must handle {action}");
    }
}

/// Old capture temp folders are cleared at launch, off the start-up path.
#[test]
fn launch_reclaims_old_capture_folders() {
    let main = read("src/main.rs");
    let setup = fn_body(&main, "pub fn setup(");
    assert!(setup.contains("capture::commands::reclaim_capture_tmp_at_launch()"));
    let reclaim = fn_body(&read("src/capture/commands.rs"), "pub fn reclaim_capture_tmp_at_launch(");
    assert!(reclaim.contains("std::thread::Builder"), "the sweep must not run on the start-up thread");
}

/// Each command the capture surfaces call is registered; a missing one only
/// fails when its button is pressed.
#[test]
fn the_card_and_session_commands_are_registered() {
    let main = read("src/main.rs");
    for name in [
        "capture_refresh_windows",
        "capture_restart",
        "capture_request_permission",
        "capture_permission_status",
        "capture_reset_permission",
        "capture_relaunch_for_permission",
        "capture_preview_mint_link",
        "capture_preview_revoke_link",
        "capture_preview_reveal",
        "capture_preview_discard",
        "capture_preview_upgrade",
    ] {
        assert!(
            main.contains(&format!("crate::capture::commands::{name},")),
            "{name} must be registered in main.rs"
        );
    }
}

/// The menu bar's recording time is written by Rust on every phase change.
/// Every broadcast goes through `emit_phase` (the transitions, the
/// rebroadcast and the recorder's adoption), and `emit_phase` writes the
/// tray; a broadcast that skipped it left the last time beside the icon.
#[test]
fn every_phase_change_updates_the_tray() {
    let src = read("src/capture/commands.rs");
    let emit = fn_body(&src, "fn emit_phase(");
    assert!(emit.contains("show_phase_in_tray(app, event)"), "emit_phase must write the tray");
    assert_eq!(
        src.matches("STATE_CHANGED_EVENT,").count(),
        1,
        "capture_state_changed is emitted only by emit_phase"
    );
    assert!(fn_body(&src, "fn advance(").contains("emit_phase(app, e)"));
    for call in ["rebroadcast(|e| emit_phase(", "adopt_recorder(recorder, |e| emit_phase("] {
        assert!(src.contains(call), "{call} must broadcast through emit_phase");
    }
    // Posted, never waited for: it runs under the phase lock.
    let show = fn_body(&src, "fn show_phase_in_tray(");
    assert!(show.contains("run_on_main_thread"));
    assert!(show.contains("newest_for_tray("), "a late write must not bring an older time back");
    // An empty title, because `tray-icon` ignores `None` on macOS.
    let write = fn_body(&src, "fn write_tray_text(");
    assert!(write.contains("set_title(Some("), "the title is cleared with an empty string, never None");
    assert!(write.contains("set_tooltip("), "Windows reads the time from the tooltip");
}

/// A tray click during a recording shows the pill and never reaches the
/// popover or Stop; the webview no longer decides it.
#[test]
fn the_tray_click_asks_the_capture_first() {
    let panel = read("src/tray/panel.rs");
    let click = fn_body(&panel, "fn on_left_click(");
    let ask = click.find("on_tray_click(app, signed_in)").expect("the click asks the capture");
    let open = click.find("toggle_panel(").expect("the click can open the popover");
    assert!(ask < open, "the capture is asked before the popover opens");
    assert!(
        fn_body(&panel, "pub fn toggle_tray_panel(").contains("on_left_click("),
        "the IPC form routes the same way"
    );
    let on_click = fn_body(&read("src/capture/commands.rs"), "pub fn on_tray_click(");
    assert!(on_click.contains("show_without_focus("), "the pill comes back without focus");
    assert!(!on_click.contains("stop_inner("), "a tray click never stops the recording");
    let hook = std::fs::read_to_string(format!("{}/../app/lib/hooks/useTraySync.ts", env!("CARGO_MANIFEST_DIR"))).unwrap();
    for gone in ["capture_stop", "setTitle(", "capture_state_changed"] {
        assert!(!hook.contains(gone), "useTraySync must not own the recording's tray ({gone})");
    }
}

/// The popover stopped opening: the click went to a callback the main
/// window's page registered, which a reload of that page left dead. Rust
/// listens for the click itself, and the webview only reports sign-in.
#[test]
fn the_tray_click_reaches_rust_whatever_the_webview_does() {
    let main = read("src/main.rs");
    assert!(
        main.contains(".on_tray_icon_event(|app, event| crate::tray::panel::on_tray_icon_event(app, &event))"),
        "the app must listen for tray clicks in Rust"
    );
    assert!(main.contains("tray_set_signed_in,"), "the sign-in mirror must be registered");
    let panel = read("src/tray/panel.rs");
    let handler = fn_body(&panel, "pub fn on_tray_icon_event(");
    for needle in ["MouseButton::Left", "MouseButtonState::Up", "TRAY_ID", "on_left_click("] {
        assert!(handler.contains(needle), "on_tray_icon_event must check {needle}");
    }
    let hook = std::fs::read_to_string(format!("{}/../app/lib/hooks/useTraySync.ts", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(
        !hook.contains("handleTrayClick") && !hook.contains("TrayIconEvent"),
        "the icon must not route its click through a webview callback"
    );
    assert!(!hook.contains("\"toggle_tray_panel\""), "the webview must not open the popover itself");
    assert!(hook.contains("\"tray_set_signed_in\""), "the webview reports sign-in to Rust");
    // A tray that survives a reload gets a live context menu again.
    assert!(hook.contains("existingTray.setMenu("), "a reload must re-attach the context menu");
}

/// Every phase used to rewrite the status item; now only a change does.
#[test]
fn the_tray_is_written_only_when_its_text_changes() {
    let src = read("src/capture/commands.rs");
    let show = fn_body(&src, "fn show_phase_in_tray(");
    assert!(show.contains("tray_needs_write("), "the tray is written only when its text changes");
}

/// The Screen Recording button must reach macOS's prompt again whenever TCC
/// has no entry for this build: a bare "asked once" flag outlived rebuilds
/// and `tccutil reset`, so the button opened System Settings on a list
/// without Hippius in it and the only way in was the "+" button.
#[test]
fn the_permission_button_asks_macos_whenever_it_has_no_entry() {
    let src = read("src/capture/commands.rs");
    let request = fn_body(&src, "pub async fn capture_request_permission(");
    assert!(
        request.contains("current_signature().key()"),
        "the asked flag must be keyed by the build TCC sees, not a bare flag"
    );
    let settings_arm = &request[request.find("PermissionRequest::OpenedSettings =>").expect("the Settings arm")..];
    let ask = settings_arm.find("ask_macos()").expect("the Settings arm asks macOS too");
    let open = settings_arm.find("open_permission_settings(").expect("the Settings arm opens the pane");
    assert!(ask < open, "ask macOS (re-adding a removed entry) before opening the pane");
    assert!(
        fn_body(&src, "async fn ask_macos(").contains("request_screen_capture"),
        "ask_macos must call CGRequestScreenCaptureAccess"
    );

    // The stale-entry fix resets only Hippius's own entry, then asks afresh.
    let reset = fn_body(&src, "async fn reset_permission(state: &AppState");
    let tcc = reset.find("tccutil_reset_args(").expect("the reset runs tccutil");
    let asked = reset.rfind("ask_macos()").expect("the reset asks macOS again");
    assert!(tcc < asked);
}

/// "Relaunch Hippius" records that this build was relaunched for the grant
/// before restarting; without the marker a stale entry after the relaunch
/// reads as plain "asked" and the dialog never offers the fix.
#[test]
fn the_permission_relaunch_is_remembered_then_restarts() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "pub async fn capture_relaunch_for_permission(");
    let mark = body.find("RELAUNCHED_KEY").expect("the relaunch is remembered");
    let restart = body.find("request_restart()").expect("the app restarts through Tauri");
    assert!(mark < restart, "remember the relaunch before restarting");
}

/// A window recording films one window, so a bubble on screen was left out of
/// the video without a word. The helper adds the camera window by number, and
/// Record puts the bubble inside what is filmed first.
#[test]
fn the_bubble_is_filmed_with_a_window_recording() {
    let src = read("src/capture/commands.rs");
    let begin = fn_body(&src, "async fn begin_recording(");
    assert!(
        begin.contains("camera_window: filmed_camera_window("),
        "the recording must be told the camera window's number"
    );
    let sync = fn_body(&src, "async fn sync_camera(");
    assert!(
        sync.contains("recording_bubble_frame("),
        "Record must move the bubble inside what is filmed"
    );
    // Hidden from the pill mid-recording: ordered out, keeping its number,
    // or showing it again would bring back a window the recording never saw.
    let hide = sync.find("if mid_recording").expect("a mid-recording hide arm");
    let close = sync.find("window.close()").expect("the close arm");
    assert!(hide < close && sync[hide..close].contains("window.hide()"));

    let protocol = read("src/capture/recording/protocol.rs");
    assert!(protocol.contains("pub camera_window_id: Option<u32>"));
    let swift = read("../macos/HippiusCapture/Sources/main.swift");
    assert!(swift.contains(r#"intU32(obj["cameraWindowId"])"#), "the helper reads the camera window");
    assert!(
        swift.contains("SCContentFilter(display: screen, including: [window, camera])"),
        "a window recording with the camera films both windows"
    );
}

/// Browsers, the share link's page included, play only a file's first audio
/// track: a separate microphone track went unheard. One track, mixed.
#[test]
fn a_recording_has_one_audio_track() {
    let swift = read("../macos/HippiusCapture/Sources/main.swift");
    assert_eq!(
        swift.matches("AVAssetWriterInput(mediaType: .audio").count(),
        1,
        "the helper must write exactly one audio track"
    );
    assert!(swift.contains("final class AudioMixer"));
    assert!(
        swift.contains("config.capturesAudio = options.systemAudio"),
        "system audio only when asked for"
    );
    let src = read("src/capture/commands.rs");
    assert!(fn_body(&src, "async fn begin_recording(").contains("system_audio: saved.system_audio"));
}

/// The recorder child is the app's own executable. If `main` reached the
/// builder first, every recording would open a second window, tray and
/// single-instance handler (which would hand the argv to the running app and
/// exit), so the branch must come before all of it.
#[test]
fn the_recorder_child_branches_before_the_app_boots() {
    let main = read("src/main.rs");
    let body = fn_body(&main, "fn main()");
    let branch = body.find("argv_requests_recorder(").expect("main branches into the recorder child");
    for later in ["load_env()", "init_logging()", "Builder::default()"] {
        let at = body.find(later).unwrap_or_else(|| panic!("main calls {later}"));
        assert!(branch < at, "the recorder child must branch before {later}");
    }
    assert!(body[branch..].contains("recorder_child::run("), "the branch runs the recorder child");
}

/// Windows and Linux record with this executable in recorder mode, and the
/// flag the app passes is the one `main` looks for.
#[test]
fn the_app_starts_its_recorder_with_the_flag_main_looks_for() {
    let helper = read("src/capture/recording/helper.rs");
    assert!(fn_body(&helper, "pub fn own_recorder_command(").contains("recorder_child::RECORDER_FLAG"));
    let cli = read("src/cli.rs");
    assert!(fn_body(&cli, "pub fn argv_requests_recorder<").contains("recorder_child::RECORDER_FLAG"));
    let child = read("src/capture/recorder_child/mod.rs");
    assert!(child.contains("pub const RECORDER_FLAG: &str = \"--capture-recorder\";"));
    for platform in ["src/capture/recording/windows.rs", "src/capture/recording/linux.rs"] {
        assert!(
            fn_body(&read(platform), "pub fn helper_command(").contains("own_recorder_command()"),
            "{platform} records with the app's own executable"
        );
    }
}

/// On Windows, content protection is `SetWindowDisplayAffinity`, whose
/// failure tao discards. Every overlay reads its affinity back, and a
/// session where it did not hold clears the screen before the grab, or the
/// screenshot is of the dimmed selection UI.
#[test]
fn windows_overlays_check_that_they_are_kept_out_of_the_shot() {
    let src = read("src/capture/commands.rs");
    let open = fn_body(&src, "async fn open_overlay(");
    assert!(open.contains("kept_out_of_captures(&window)"), "every overlay checks its affinity");
    assert!(open.contains("ui_in_grabs.store(true"), "a failed check is remembered for the grab");
    let check = fn_body(&src, "fn kept_out_of_captures(window: &tauri::WebviewWindow) -> bool {");
    assert!(check.contains("GetWindowDisplayAffinity") && check.contains("WDA_EXCLUDEFROMCAPTURE"));
    let start = fn_body(&src, "pub async fn capture_start(");
    assert!(
        start.contains("windows_excludes_from_capture("),
        "below Windows 10 2004 every session clears the screen first"
    );
    let finish = fn_body(&src, "async fn finish_screenshot(");
    let cleared = finish.find("clear_screen_for_grab(").expect("the screen is cleared when needed");
    let grab = finish.find("take_screenshot(").expect("finish_screenshot grabs");
    assert!(cleared < grab, "the screen is cleared before the grab");
    let take = fn_body(&src, "async fn take_screenshot(");
    let settle = take.find("settle_compositor()").expect("the compositor is settled");
    assert!(settle < take.find("capture_blocking(").unwrap(), "settled before the pixels are read");
    let clear = fn_body(&src, "async fn clear_screen_for_grab(");
    assert!(clear.contains("PREVIEW_LABEL") && clear.contains(".hide()"), "the card is hidden too");
    assert!(clear.contains("OVERLAY_LABEL_PREFIX"), "the overlays are waited out");
}

/// Windows window shots go through Windows.Graphics.Capture (xcap `wgc`):
/// GDI returns only part of a DPI-unaware app's window on a scaled monitor.
#[test]
fn windows_screenshots_use_windows_graphics_capture() {
    let manifest = read("Cargo.toml");
    assert!(
        manifest.contains(r#"xcap = { version = "0.9", features = ["wgc"] }"#),
        "xcap must be built with its wgc feature"
    );
}

/// Screenshots and recording follow the per-platform rollout, so a platform
/// still on staging is simply unsupported on beta and production.
#[test]
fn capture_follows_the_rollout_gate() {
    let src = read("src/capture/commands.rs");
    assert!(fn_body(&src, "pub fn capture_supported()").contains("rollout::allows(super::rollout::Feature::Screenshots)"));
    assert!(fn_body(&src, "pub async fn capture_start(").contains("!capture_supported()"));
    assert!(fn_body(&src, "pub fn capture_support()").contains("supported: capture_supported()"));
    let recording = read("src/capture/recording/mod.rs");
    assert!(fn_body(&recording, "pub fn recording_unavailable()").contains("rollout::allows(super::rollout::Feature::Recording)"));
}

/// Camera only on a platform that cannot record says so in the recording's
/// own words before looking for the camera window (whose absence would read
/// as "try again in a moment", which never helps).
#[test]
fn camera_only_refuses_with_the_recording_line_first() {
    let src = read("src/capture/commands.rs");
    let confirm = fn_body(&src, "pub async fn capture_confirm(");
    let refusal = confirm.find("recording::recording_unavailable()").expect("checks recording first");
    let lookup = confirm.find("camera_window_id(").expect("looks for the camera");
    assert!(refusal < lookup);
}

/// Wayland: a screenshot goes straight to the desktop's screenshot tool.
/// No Hippius overlay may open first (on Wayland it could neither cover the
/// screen nor see the windows under it), and the session is decided by
/// Rust's surfaces, never by the frontend checking the platform.
#[test]
fn a_wayland_screenshot_skips_the_overlay_for_the_desktops_picker() {
    let src = read("src/capture/commands.rs");
    let start = fn_body(&src, "pub async fn capture_start(");
    let plan = start.find("support::start_plan(").expect("capture_start asks for the plan");
    let picker = start.find("system_picker_screenshot(").expect("the picker path is spawned");
    let overlay = start.find("open_capture_ui(").expect("the overlay path");
    assert!(plan < picker && picker < overlay, "the picker returns before any overlay opens");
    let take = fn_body(&src, "async fn take_with_system_picker(");
    assert!(take.contains("linux_portal::request()") && take.contains("linux_portal::settle("));
    assert!(
        take.find("open_preview(").unwrap() < take.find("CaptureEvent::Captured").unwrap(),
        "the card opens before the session ends, as for an overlay screenshot"
    );
    // A cancel in the desktop's tool is a cancel, not a failure.
    let flow = fn_body(&src, "async fn system_picker_screenshot(");
    assert!(flow.contains("Ok(false)") && flow.contains("CaptureEvent::Cancel"));
    assert!(flow.contains("fail_capture("), "every other ending goes through fail_capture");
}

/// Linux X11 has no content protection: every X11 session clears the
/// screen before the grab, and the overlay covers the panels so its (0, 0)
/// is the display's.
#[test]
fn linux_overlays_close_before_the_grab_and_cover_the_panels() {
    let src = read("src/capture/commands.rs");
    let start = fn_body(&src, "pub async fn capture_start(");
    assert!(start.contains(r#"cfg!(target_os = "linux") || !super::permissions::windows_excludes_from_capture("#));
    assert!(fn_body(&src, "async fn open_overlay(").contains("cover_whole_display(&window)"));
    let linux_check = src
        .split("#[cfg(not(any(windows, target_os = \"macos\")))]\nfn kept_out_of_captures")
        .nth(1)
        .expect("a Linux kept_out_of_captures");
    assert!(
        linux_check
            .trim_start()
            .starts_with("(_window: &tauri::WebviewWindow) -> bool {\n    false")
    );
}

/// Linux capture adds no build or runtime package: x11rb and ashpd are
/// pure Rust and Linux-only, and the .deb only RECOMMENDS a portal.
#[test]
fn linux_capture_is_linux_only_and_recommends_the_portal() {
    let manifest = read("Cargo.toml");
    let linux = manifest
        .split("[target.'cfg(target_os = \"linux\")'.dependencies]")
        .nth(1)
        .expect("a Linux-only dependency table");
    let table = linux.split("\n[").next().unwrap();
    assert!(table.contains("x11rb = ") && table.contains("ashpd = "));
    assert!(table.contains("default-features = false"), "ashpd brings only the portals capture uses");
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let recommends = conf["bundle"]["linux"]["deb"]["recommends"].as_array().expect("deb recommends");
    assert!(recommends.iter().any(|r| r == "xdg-desktop-portal"));
    let depends = conf["bundle"]["linux"]["deb"]["depends"].as_array().unwrap();
    assert!(
        !depends.iter().any(|d| d.as_str().is_some_and(|d| d.contains("portal"))),
        "a portal is recommended, never required: X11 desktops capture without one"
    );
}
