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
    let body = fn_body(&src, "pub async fn deliver(");
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
    let ok_arm = body.find("Ok((delivered, destination)) =>").expect("success arm");
    let err_arm = body.find("Err(e) =>").expect("failure arm");
    let removal = body.find("remove_dir_all").expect("the temp copy is removed somewhere");
    assert!(ok_arm < removal && removal < err_arm, "remove_dir_all must sit in the success arm only");
    assert_eq!(body.matches("remove_dir_all").count(), 1, "exactly one removal, on success");
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
        "capture_preview_mint_link",
        "capture_preview_revoke_link",
        "capture_preview_reveal",
        "capture_preview_discard",
    ] {
        assert!(
            main.contains(&format!("crate::capture::commands::{name},")),
            "{name} must be registered in main.rs"
        );
    }
}
