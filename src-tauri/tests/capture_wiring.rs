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

/// The recording pill is kept out of the recording: by content protection
/// where the recorder cannot leave windows out (Windows), and on macOS by the
/// helper, which leaves Hippius out of a screen or area recording all but
/// the main window and the bubble. A protected pill would be missing from a
/// Google Meet share too, so macOS must not protect it (`own_windows`).
#[test]
fn the_controls_keep_themselves_out_of_the_recording() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn open_controls(");
    assert!(
        body.contains(".content_protected(super::own_windows::content_protected(") && body.contains("OwnWindow::Pill"),
        "the pill's protection is own_windows' decision"
    );
    // The helper is told which of Hippius's windows it may film.
    let begin = fn_body(&src, "async fn begin_recording(");
    assert!(begin.contains("own_windows::recorder_leaves_app_out(") && begin.contains("own_windows_filmed,"));
    assert!(begin.contains("main_window_number(app).await") && begin.contains("filmed_camera_window(&state.capture)"));
    let protocol = read("src/capture/recording/protocol.rs");
    assert!(protocol.contains("pub own_windows_filmed: Vec<u32>,"));
    // The Swift helper reads that key and leaves its parent app out.
    let swift = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
    assert!(swift.contains(r#"obj["ownWindowsFilmed"]"#), "the helper reads ownWindowsFilmed");
    assert!(
        swift.contains("excludingApplications: [app]") && swift.contains("exceptingWindows:"),
        "a screen or area recording leaves Hippius out with ScreenCaptureKit, not content protection"
    );
}

/// A visible card is not content protected on macOS, so a screenshot hides
/// it before the screen is read; Windows and Linux keep their own path.
#[test]
fn a_screenshot_takes_a_visible_card_off_screen_first() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "async fn finish_screenshot(");
    let hide = body.find("hide_card_for_grab(app).await").expect("the card is hidden");
    let gated = body.find("own_windows::hide_card_for_screenshot(").expect("where it is not protected");
    let grab = body.find("take_screenshot(selection, clear)").expect("then the grab");
    assert!(gated < hide && hide < grab);
    let helper = fn_body(&src, "async fn hide_card_for_grab(");
    assert!(helper.contains("card.hide()") && helper.contains("is_visible()"));
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

/// A failed upload must leave the capture on disk; only a delivered one is
/// removed, and only through `remove_temp_dir`, which touches nothing but the
/// capture's own temp folder. A capture sent from the folder it was kept in
/// while no drive existed lives in the user's drive folder: removing its
/// parent there would delete every other capture with it.
#[test]
fn the_temp_copy_is_removed_only_after_the_upload_lands() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "async fn deliver_and_announce(");
    let ok_arm = body.find("Ok(Delivery::Placed {").expect("success arm");
    let err_arm = body.find("Err(e) =>").expect("failure arm");
    let removal = body.find("remove_temp_dir(path)").expect("the temp copy is removed somewhere");
    assert!(ok_arm < removal && removal < err_arm, "the removal must sit in the success arm only");
    assert_eq!(body.matches("remove_temp_dir(").count(), 1, "exactly one removal, on success");
    assert!(!body.contains("remove_dir_all"), "never a bare remove_dir_all of the file's parent");
    let keep = fn_body(&src, "async fn keep_here(");
    assert!(!keep.contains("remove_dir_all"), "a kept capture never removes a folder itself");
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

/// An overlay that is not the key window (any display but the bar's, or all
/// of them while another app is active) would spend the first press on
/// focusing itself, so a drag to draw a new area did nothing at all.
#[test]
fn the_overlay_answers_the_first_press() {
    let src = read("src/capture/commands.rs");
    assert!(
        fn_body(&src, "fn build_overlay(").contains(".accept_first_mouse(true)"),
        "a press on an overlay must reach the page even when the overlay is not focused"
    );
}

/// The preview card floats over whatever the user captures next, and it is
/// information, not a dialog: it must stay out of captures and must not take
/// the keyboard from the app the user is typing in.
#[test]
fn the_preview_card_stays_out_of_captures_and_never_takes_focus() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "fn open_preview_window(");
    assert!(
        body.contains(".content_protected(super::own_windows::content_protected(") && body.contains("OwnWindow::Card"),
        "the card's protection is own_windows' decision"
    );
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

/// The captures drive: its commands are registered, a capture nobody has
/// placed yet asks the user (after it is kept, so the dialog never races the
/// file), and the user's answer sends the card's capture through the same
/// delivery as Retry BEFORE the rest of the waiting ones are moved in, so
/// the two never move the same file. The drive itself is added through the
/// same command the Drive page's Sync a Folder runs.
#[test]
fn the_captures_drive_is_asked_for_made_and_fed_through_the_usual_paths() {
    let main = read("src/main.rs");
    for name in ["capture_drive_status", "capture_drive_location", "capture_drive_create"] {
        assert!(main.contains(&format!("crate::capture::setup::{name},")), "{name} must be registered");
    }
    let commands = read("src/capture/commands.rs");
    let keep = fn_body(&commands, "async fn keep_here(");
    let kept = keep.find("keep_in_folder(").expect("the capture is kept first");
    let ask = keep.find("ask_for_location(").expect("an unplaced capture asks where captures go");
    assert!(kept < ask, "keep the capture before asking");
    assert!(keep.contains("if kept_as.ask"), "only a capture nobody placed asks");
    let redeliver = fn_body(&commands, "pub(super) fn redeliver_kept_card(");
    assert!(
        redeliver.contains("deliver_and_announce("),
        "the card's capture goes through the usual delivery"
    );
    assert!(redeliver.contains("kept_locally"), "only a capture kept on this computer is sent again");

    let setup = read("src/capture/setup.rs");
    let create = fn_body(&setup, "pub async fn capture_drive_create(");
    let card = create.find("redeliver_kept_card(").expect("the card's capture is sent");
    let rest = create.find("move_waiting(").expect("the other waiting captures are moved in");
    assert!(card < rest, "the card's capture is claimed before the rest are moved");
    assert!(create.contains("on_card.as_deref()"), "the card's capture is left for its own delivery");
    assert!(create.contains("ENSURE_LOCK"), "one setup at a time");
    let add = fn_body(&setup, "async fn add_drive(");
    assert!(add.contains("add_local_sync_folder("), "the drive is added like Sync a Folder adds one");
    assert!(add.contains("check_location("), "never inside or around another drive");
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

/// The bar's device lists stay live through the helper's `--watch-devices`
/// mode, so a phone's microphone that arrives after the menu was read still
/// shows up. The flag crosses a language boundary nothing else checks: a
/// helper that does not know it would start a recording session instead and
/// the lists would silently stop updating. The watcher must also end with
/// the bar (closing the overlays stops it, and the helper exits when its
/// stdin closes), or a discovery process would outlive every capture.
#[test]
fn the_device_watcher_is_a_mode_the_helper_knows_and_ends_with_the_bar() {
    let watch = read("src/capture/device_watch.rs");
    let helper = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
    assert!(watch.contains("\"--watch-devices\""), "device_watch.rs starts the helper's watch mode");
    assert!(
        helper.contains("arguments.contains(\"--watch-devices\")"),
        "the helper must handle --watch-devices"
    );
    let watcher = fn_body(&helper, "func watchDevices(");
    assert!(watcher.contains("while readLine() != nil {}"), "the watcher exits when its stdin closes");
    assert!(watcher.contains("exit(0)"), "the watcher exits when its stdin closes");

    let commands = read("src/capture/commands.rs");
    assert!(
        fn_body(&commands, "fn close_overlays(").contains("device_watch::stop()"),
        "closing the overlays stops the device watcher"
    );
    for sig in ["pub async fn capture_microphones(", "pub async fn capture_cameras("] {
        assert!(fn_body(&commands, sig).contains("watch_devices("), "{sig} starts the watcher");
    }
}

/// On Windows and Linux the watcher and the card's picture are the recorder
/// child's `--watch-devices` and `--poster` modes. Both flags cross a
/// process boundary nothing else checks: a child that did not know one
/// would serve the recording protocol instead, the watcher would print
/// nothing and every card would fall back to the start screenshot (none on
/// Wayland), silently. The watcher must also end when its stdin closes.
#[test]
fn the_recorder_child_knows_the_watch_and_poster_modes_the_app_starts() {
    let child = read("src/capture/recorder_child/mod.rs");
    let run = fn_body(&child, "pub fn run<");
    for (flag, windows, linux) in [
        ("--poster", "windows::poster::run(&args)", "linux::poster::run(&args)"),
        ("--watch-devices", "windows::watch::run()", "linux::watch::run()"),
    ] {
        assert!(run.contains(&format!("has(\"{flag}\")")), "the child handles {flag}");
        assert!(run.contains(windows) && run.contains(linux), "{flag} reaches both platform readers");
        // Before `--meter` and the list modes: a recording's name can be
        // anything, and the poster's times follow the flag.
        assert!(run.find(flag) < run.find("--meter"), "{flag} is matched first");
    }

    let watch = read("src/capture/device_watch.rs");
    let command = fn_body(&watch, "fn watcher_command(");
    assert!(command.contains("recording::windows::helper_command()"));
    assert!(command.contains("recording::linux::helper_command()"));
    let shared = read("src/capture/recorder_child/watch.rs");
    assert!(
        fn_body(&shared, "pub fn stop_on_stdin_close(").contains("Wake::Stop"),
        "the child's watcher stops when its stdin closes"
    );
    for platform in ["windows", "linux"] {
        let src = read(&format!("src/capture/recorder_child/{platform}/watch.rs"));
        assert!(src.contains("watch::stop_on_stdin_close("), "{platform} watcher ends with the bar");
    }

    let recording = read("src/capture/recording/mod.rs");
    let poster = fn_body(&recording, "pub fn poster_command(");
    assert!(poster.contains("windows::helper_command()") && poster.contains("linux::helper_command()"));
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
    // The overlay and the Wayland panel open through one failure arm.
    assert!(start.contains("open_capture_ui(&app, &state.capture, &areas)") && start.contains("open_panel(&app, &state.capture)"));
    let arm_start = start.find("if let Err(e) = opened {").expect("the failure arm");
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

/// A tray click during a recording brings the pill back and never reaches
/// Stop; the webview no longer decides it. (It opens the popover as well:
/// `tests/tray_popover_wiring.rs`.)
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
    // A tray that survives a reload is replaced by a fresh one, whose menu
    // items call into the live page; Rust puts a running recording's marks
    // back on it when told of the new menu.
    assert!(hook.contains("existingTray.close()"), "a reload must rebuild the icon");
    assert!(
        fn_body(&read("src/tray/status_menu.rs"), "pub fn tray_menu_attached(").contains("restore_recording_in_tray("),
        "a rebuilt icon gets a running recording's marks back"
    );
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
    let swift = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
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
    let swift = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
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

/// The recorder owns the microphone: every phase broadcast outside choosing a
/// recording stops the bar's meter, so the meter has let go before the
/// recorder opens the device. A meter left running would keep the microphone
/// open in a second process through the whole recording.
#[test]
fn the_mic_meter_lets_go_before_the_recorder_starts() {
    let src = read("src/capture/commands.rs");
    let emit = fn_body(&src, "fn emit_phase(");
    assert!(
        emit.contains("meter_may_run(event.phase)") && emit.contains("mic_meter.stop()"),
        "emit_phase must stop the microphone meter outside choosing a recording"
    );
    let start = fn_body(&src, "pub async fn capture_mic_meter_start(");
    assert!(
        start.matches("meter_may_run(").count() >= 2 && start.contains("stop_if(generation)"),
        "a meter started while the phase moved must re-check and stop itself"
    );
    let helper = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
    assert!(
        helper.contains("\"--meter\"") && helper.contains("runMeter("),
        "the helper must serve --meter"
    );
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

/// Linux capture is Linux-only and requires nothing at run time: x11rb and
/// ashpd are pure Rust, GStreamer (recording) links only libraries WebKitGTK
/// already brings, and the .deb only RECOMMENDS a portal and the plugins.
#[test]
fn linux_capture_is_linux_only_and_recommends_the_portal() {
    let manifest = read("Cargo.toml");
    let linux = manifest
        .split("[target.'cfg(target_os = \"linux\")'.dependencies]")
        .nth(1)
        .expect("a Linux-only dependency table");
    let table = linux.split("\n[").next().unwrap();
    assert!(table.contains("x11rb = ") && table.contains("ashpd = "));
    assert!(
        table.contains("gstreamer = ") && table.contains("gstreamer-app = "),
        "GStreamer is Linux-only"
    );
    assert!(
        !manifest.split("[target.").next().unwrap().contains("gstreamer"),
        "never a dependency of every OS"
    );
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

/// WebView2 denies `getUserMedia` unless its host answers: the camera bubble
/// stays black and the bar's mic meter never moves on Windows. The answer is
/// given to the camera window and the overlays (the meter) only; the pill
/// and the card never open a device. The camera stays filmed (not
/// protected) and the pill stays out of the recording.
#[test]
fn only_the_camera_and_overlay_webviews_may_open_devices() {
    let src = read("src/capture/commands.rs");
    assert!(fn_body(&src, "fn open_camera_window(").contains("webview_media::allow_capture_devices(&window)"));
    assert!(fn_body(&src, "fn build_overlay(").contains("webview_media::allow_capture_devices(window)"));
    assert_eq!(
        src.matches("allow_capture_devices(").count(),
        2,
        "the device permission is given to the camera and overlay windows only"
    );
    assert!(!fn_body(&src, "fn open_controls(").contains("allow_capture_devices"));
    assert!(fn_body(&src, "fn open_camera_window(").contains(".content_protected(false)"));
    assert!(fn_body(&src, "fn open_controls(").contains("OwnWindow::Pill"));
    let media = read("src/capture/webview_media.rs");
    let gate = fn_body(&media, "pub fn allows_capture_devices(");
    assert!(gate.contains("CAMERA_LABEL") && gate.contains("OVERLAY_LABEL_PREFIX"));
    assert!(
        media.contains("COREWEBVIEW2_PERMISSION_KIND_CAMERA") && media.contains("is_app_origin(&uri)"),
        "only the camera and microphone, only for the app's own pages"
    );
}

/// The Windows recorder is the app's own executable started without a
/// console window, and Windows recording ships to staging and beta, not to
/// production until its hardware checklist passes and the installer is signed.
#[test]
fn windows_records_in_its_own_child_and_stays_out_of_production() {
    let windows = read("src/capture/recording/windows.rs");
    assert!(fn_body(&windows, "pub fn helper_command(").contains("own_recorder_command()"));
    assert!(fn_body(&windows, "pub fn helper_command(").contains("CREATE_NO_WINDOW"));
    use tauri_project_lib::capture::rollout::{Feature, Platform, enabled};
    use tauri_project_lib::release_channel::ReleaseChannel;
    assert!(enabled(ReleaseChannel::Staging, Platform::Windows, Feature::Recording));
    assert!(enabled(ReleaseChannel::Beta, Platform::Windows, Feature::Recording));
    assert!(
        !enabled(ReleaseChannel::Production, Platform::Windows, Feature::Recording),
        "Windows recording reaches production only once its hardware checklist passes"
    );
}

/// Linux records in the app's own child, waits for the user in the
/// desktop's screen-sharing dialog, and ships to staging and beta, not to
/// production until its checklist passes on real sessions.
#[test]
fn linux_records_in_its_own_child_and_stays_out_of_production() {
    let linux = read("src/capture/recording/linux.rs");
    assert!(fn_body(&linux, "pub fn helper_command(").contains("own_recorder_command()"));
    assert!(fn_body(&linux, "pub fn start(").contains("helper::start_within("));
    assert!(fn_body(&linux, "pub fn meter_command(").contains("\"--meter\""));
    use tauri_project_lib::capture::rollout::{Feature, Platform, enabled};
    use tauri_project_lib::release_channel::ReleaseChannel;
    for platform in [Platform::LinuxX11, Platform::LinuxWayland] {
        assert!(enabled(ReleaseChannel::Staging, platform, Feature::Recording));
        assert!(enabled(ReleaseChannel::Beta, platform, Feature::Recording));
        assert!(
            !enabled(ReleaseChannel::Production, platform, Feature::Recording),
            "{platform:?} recording reaches production only once its Linux checklist passes"
        );
    }
}

/// One owner per device on Linux: the recorder opens the screen and the
/// sound sources, and the camera only for camera only on Wayland (no window
/// to film there), from GStreamer's own device rather than a source written
/// by hand; the app asks for that only there, and the stage page lets go
/// of the camera whenever Rust says the recorder has it.
#[test]
fn the_linux_recorder_opens_the_camera_only_where_no_window_can_be_filmed() {
    for file in ["mod.rs", "capture.rs", "encoder.rs", "portal.rs"] {
        let src = read(&format!("src/capture/recorder_child/linux/{file}"));
        for camera in ["v4l2src", "pipewiresrc camera"] {
            assert!(!src.contains(&format!("\"{camera}")), "{file} must not write a camera source ({camera})");
        }
    }
    let session = read("src/capture/recorder_child/linux/mod.rs");
    assert!(session.contains("capture::Audio::start(") && session.contains("capture::Video::start("));
    assert_eq!(session.matches("capture::Video::start_camera(").count(), 1);
    let start = fn_body(&session, "pub fn start(");
    assert!(
        start.find("if let Some(pick) = cmd.camera.clone()").unwrap() < start.find("capture::Video::start_camera(").unwrap(),
        "the camera is opened only when the app named one"
    );
    let capture = read("src/capture/recorder_child/linux/capture.rs");
    assert!(fn_body(&capture, "fn open_camera(").contains("device.create_element(None)"));

    let commands = read("src/capture/commands.rs");
    let begin = fn_body(&commands, "async fn begin_recording(");
    assert!(begin.contains("if recorder_opens_camera(*lock(&state.capture.recording_camera))"));
    let opens = fn_body(&commands, "fn recorder_opens_camera(");
    assert!(opens.contains("CameraShape::Stage") && opens.contains("support::camera_by_recorder("));
    let camera_state = fn_body(&commands, "async fn camera_state_for(");
    assert!(camera_state.contains("recorder_owns_camera: recording && recorder_opens_camera(shape)"));
    let page = read("../app/capture-camera/page.tsx");
    assert!(
        page.contains("const live = !!camera?.shape && !camera.hidden && !handedOver;"),
        "the stage page closes its stream when the recorder has the camera"
    );
}

/// A Wayland area: the recorder answers with the monitor's picture, the
/// area is drawn on it in its own window (a selection surface every ending
/// closes), mapped onto the stream's pixels in Rust, and the window is gone
/// from the screen before the recorder crops, so the first picture never
/// shows it. The countdown and the restore token come after the area.
#[test]
fn a_wayland_area_is_drawn_on_the_streams_picture_then_cropped() {
    let commands = read("src/capture/commands.rs");
    let begin = fn_body(&commands, "async fn begin_recording(");
    let drawn = begin.find("draw_area(app, recorder, still)").expect("the area is drawn");
    assert!(begin.find("take_area_still()").unwrap() < drawn);
    assert!(drawn < begin.find("screencast_token::remember(").unwrap());
    assert!(drawn < begin.find("count_down_in_pill(").unwrap(), "the pill counts after the area");
    assert!(begin.contains("support::picks_area_after_dialog(&surfaces, selection)"));
    let draw = fn_body(&commands, "async fn draw_area(");
    let gone = draw.find("window.destroy()").expect("the window comes down");
    assert!(gone < draw.find("COMPOSITOR_SETTLE").unwrap());
    assert!(draw.find("COMPOSITOR_SETTLE").unwrap() < draw.find("recorder.crop(area)").unwrap());
    assert!(fn_body(&commands, "pub fn capture_area_choose(").contains("stream_area("));
    assert!(fn_body(&commands, "fn close_overlays(").contains("label == AREA_LABEL"));

    let label = commands
        .lines()
        .find(|l| l.contains("pub const AREA_LABEL"))
        .and_then(|l| l.split('"').nth(1))
        .expect("AREA_LABEL");
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-area.json")).expect("capability parses");
    assert_eq!(capability["windows"], serde_json::json!([label]));
    for permission in capability["permissions"].as_array().expect("permissions") {
        assert!(permission.as_str().unwrap_or_default().starts_with("core:"), "{permission}");
    }
    let shell = read("../app/components/AppShell.tsx");
    assert!(shell.contains(&format!("\"/{label}\"")), "the area page boots without the app");
    assert!(fn_body(&commands, "fn open_area_window(").contains(&format!("\"{label}.html\"")));
}

/// Wayland's recording panel: one window (the overlay page, so its
/// capability and media permission apply), no display watch (it is no
/// display's overlay), Record resolved to the desktop's dialog, and a cancel
/// in that dialog ending the session quietly.
#[test]
fn the_wayland_panel_hands_the_choice_to_the_desktop() {
    let src = read("src/capture/commands.rs");
    let start = fn_body(&src, "pub async fn capture_start(");
    assert!(start.contains("open_panel(&app, &state.capture)"));
    assert!(start.contains("if plan != super::support::StartPlan::Panel {\n        spawn_display_watch("));
    assert!(fn_body(&src, "async fn open_panel(").contains("build_overlay(app, &label, &display, false)"));
    assert!(fn_body(&src, "pub async fn capture_confirm(").contains("support::system_picker_selection(mode)"));
    let fail = fn_body(&src, "async fn fail_capture(");
    assert!(
        fail.find("recording::cancelled_in_picker(e)").unwrap() < fail.find("FAILED_EVENT").unwrap(),
        "a cancel in the desktop's dialog is not reported as a failure"
    );
    let begin = fn_body(&src, "async fn begin_recording(");
    assert!(begin.contains("screencast_token::for_start(") && begin.contains("screencast_token::remember("));
}

/// WebKitGTK never offers `getUserMedia` unless media stream is on, and
/// denies what nobody answers: on Linux the camera bubble needs both. Both
/// are given to the capture windows only (the same gate as WebView2's), for
/// the app's own pages only, and only for the camera and microphone (and
/// their names); any other request keeps WebKitGTK's default.
#[test]
fn linux_webviews_open_devices_only_in_the_capture_windows() {
    let media = read("src/capture/webview_media.rs");
    let allow = fn_body(&media, "pub fn allow_capture_devices(");
    let linux = allow.split("#[cfg(target_os = \"linux\")]").nth(1).expect("a Linux arm");
    assert!(linux.trim_start().starts_with("if allows_capture_devices(window.label()) {"));
    assert!(linux.contains("webview_media_gtk::attach(&webview)"));
    let gtk = read("src/capture/webview_media_gtk.rs");
    assert!(gtk.contains("set_enable_media_stream(true)"));
    assert!(gtk.contains("is::<UserMediaPermissionRequest>()") && gtk.contains("is::<DeviceInfoPermissionRequest>()"));
    assert!(gtk.contains("is_app_origin(&uri)") && gtk.contains("request.deny()"));
    assert!(gtk.contains("return false;"), "other requests keep WebKitGTK's default");
}

/// Windows' meter is the recorder child's WASAPI client, the same program
/// and endpoint id the recording uses; the child serves `--meter` before
/// anything else and lets go of the device when stdin closes. The one-owner
/// rule above (`emit_phase` stops the meter) covers it unchanged.
#[test]
fn windows_meters_the_microphone_in_its_recorder_child() {
    let recording = read("src/capture/recording/mod.rs");
    let meter = fn_body(&recording, "pub fn meter_command(");
    assert!(meter.contains("windows::meter_command(device)"), "Windows must have a meter");
    let windows = read("src/capture/recording/windows.rs");
    let command = fn_body(&windows, "pub fn meter_command(");
    assert!(command.contains("helper_command()") && command.contains("\"--meter\""));
    let child = read("src/capture/recorder_child/mod.rs");
    let run = fn_body(&child, "pub fn run<");
    assert!(
        run.find("\"--meter\"").unwrap() < run.find("serve(std::io::stdin()").unwrap(),
        "the meter mode returns before a recording session would start"
    );
    let audio = read("src/capture/recorder_child/windows/audio.rs");
    assert!(fn_body(&audio, "pub fn run_meter(").contains("meter::serve("));
    let serve = fn_body(&read("src/capture/recorder_child/meter.rs"), "pub fn serve<");
    assert!(serve.contains("stop.store(true"), "stdin closing stops the meter");
}

/// System audio leaves Hippius's own sounds out on Windows 11: the child is
/// told the app's pid, and asks for process loopback excluding that tree
/// before falling back to the whole output.
#[test]
fn windows_system_audio_leaves_the_apps_own_tree_out() {
    let windows = read("src/capture/recording/windows.rs");
    assert!(fn_body(&windows, "pub fn helper_command(").contains("program.env(APP_PID_ENV, std::process::id()"));
    let audio = read("src/capture/recorder_child/windows/audio.rs");
    assert!(fn_body(&audio, "pub fn system(").contains("sources::system_audio_route("));
    let activate = fn_body(&audio, "fn activate_process_loopback(");
    assert!(activate.contains("PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE") && activate.contains("VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK"));
    let open = fn_body(&audio, "pub fn open(");
    assert!(
        open.contains("SystemAudioRoute::WholeOutput"),
        "a refused process loopback falls back to the whole output"
    );
    let child = read("src/capture/recorder_child/windows/mod.rs");
    assert!(
        child.contains("audio::Device::system()"),
        "the recording asks for the route, not plain loopback"
    );
}

/// A microphone unplugged mid-recording is not a death: the child says
/// `device_lost`, the helper keeps it apart from replies and deaths, and the
/// tick tells the pill in Rust's words while the recording goes on.
#[test]
fn a_lost_microphone_reaches_the_pill_without_ending_the_recording() {
    let child = read("src/capture/recorder_child/windows/mod.rs");
    assert!(fn_body(&child, "fn tell_lost(").contains("protocol::device_lost_line("));
    assert!(
        child.matches("tell_lost(out, Source::").count() == 2,
        "the microphone and system audio both tell"
    );
    let helper = read("src/capture/recording/helper.rs");
    let reader = fn_body(&helper, "fn read_events(");
    assert!(reader.contains("HelperEvent::DeviceLost") && reader.contains("shared.lost"));
    let commands = read("src/capture/commands.rs");
    let tick = fn_body(&commands, "fn tick_once(");
    assert!(tick.contains("take_lost_device()") && tick.contains("DEVICE_LOST_EVENT"));
    let lost = tick.find("DEVICE_LOST_EVENT").unwrap();
    let died = tick.find("if let Some(e) = died").unwrap();
    assert!(lost < died, "a lost device is told even on the tick that ends the recording");
    let pill = read("../app/capture-controls/page.tsx");
    assert!(
        pill.contains("DEVICE_LOST_EVENT") && pill.contains("lost.message"),
        "the pill says Rust's line"
    );
}

/// "Open Settings" under a row Windows' privacy settings block opens only
/// the camera or microphone page, decided in Rust.
#[test]
fn the_privacy_settings_button_opens_only_rusts_pages() {
    let commands = read("src/capture/commands.rs");
    let open = fn_body(&commands, "pub fn capture_open_privacy_settings(");
    assert!(open.contains("privacy::settings_uri_for(") && open.contains("open_url(uri"));
    assert!(fn_body(&commands, "pub async fn capture_overlay_context(").contains("privacy::device_privacy()"));
    let bar = read("../app/capture-overlay/CaptureBar.tsx");
    assert!(bar.contains("openCapturePrivacySettings(device)"));
    assert!(!bar.contains("ms-settings:"), "the bar never names a Settings URI itself");
}

/// Windows' tray shows no title, so a recording marks the icon itself
/// (XP-15), redrawn on every write while it runs, and hands the icon back to
/// the main window when it ends.
#[test]
fn windows_marks_the_tray_icon_while_recording_and_hands_it_back() {
    let commands = read("src/capture/commands.rs");
    let show = fn_body(&commands, "fn show_phase_in_tray(");
    assert!(show.contains("TRAY_ICON_MARKS_RECORDING") && show.contains("write_tray_glyph("));
    let glyph = fn_body(&commands, "fn write_tray_glyph(");
    assert!(glyph.contains("set_icon(") && glyph.contains("TRAY_ICON_RELEASED_EVENT"));
    let hook = std::fs::read_to_string(format!("{}/../app/lib/hooks/useTraySync.ts", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(hook.contains("\"capture_tray_icon_released\""), "the main window re-applies its icon");
    assert!(commands.contains("pub const TRAY_ICON_RELEASED_EVENT: &str = \"capture_tray_icon_released\";"));
}

/// A Windows window recording films the camera bubble: the child is given
/// the bubble's window and composites it, and the bubble is moved inside
/// the recorded window at Record.
#[test]
fn a_windows_window_recording_films_the_bubble() {
    let child = read("src/capture/recorder_child/windows/mod.rs");
    assert!(child.contains("cmd.camera_window_id.map(handle_from_id)"));
    assert!(child.contains("wgc::start(target, Arc::clone(&shared), camera)"));
    let wgc = read("src/capture/recorder_child/windows/wgc.rs");
    assert!(fn_body(&wgc, "fn render(").contains("overlay::composite("));
    let bar = read("src/capture/bar.rs");
    assert!(bar.contains("pub const fn window_recording_adds_camera_on("));
    let commands = read("src/capture/commands.rs");
    // The app hands the child the bubble's window on Windows too.
    assert!(commands.contains("#[cfg(windows)]\nfn remember_camera_window_number("));
    // Record (and a mid-recording resize) place the bubble by the window's
    // frame, read in `filmed_now`.
    assert!(fn_body(&commands, "async fn recording_bubble_frame(").contains("filmed_now(app)"));
    assert!(fn_body(&commands, "async fn filmed_now(").contains("camera::window_region("));
}

/// An X11 window recording films the bubble: the app remembers the camera
/// window's XID, the child reads the window raw and draws the bubble in
/// with the same `overlay` code Windows uses; Wayland never gets an id.
#[test]
fn an_x11_window_recording_films_the_bubble() {
    let commands = read("src/capture/commands.rs");
    let remember = fn_body(&commands, "#[cfg(target_os = \"linux\")]\nfn remember_camera_window_number(");
    assert!(remember.contains("Platform::LinuxX11") && remember.contains("camera_window_number.store("));
    let child = read("src/capture/recorder_child/linux/mod.rs");
    assert!(child.contains("capture::Video::start_with_camera(source, camera, scale"));
    let capture = read("src/capture/recorder_child/linux/capture.rs");
    let compose = fn_body(&capture, "fn compose(");
    assert!(compose.contains("overlay::composite(") && compose.contains("overlay::bubble_shape("));
    assert!(compose.contains("frame::to_nv12("));
    assert!(fn_body(&capture, "pub fn start_with_camera(").contains("video_capture_bgrx("));
}

/// The recording pill's window never carries a native shadow. On a
/// transparent window AppKit and DWM draw it from the window's rectangle,
/// not the rounded pill, which framed the pill in a border; and the page's
/// own shadow must fit inside the window, or its clipped edge does the same.
#[test]
fn the_recording_pill_has_no_rectangular_shadow() {
    let src = read("src/capture/commands.rs");
    let open = fn_body(&src, "fn open_controls(");
    assert!(open.contains(".shadow(false)"), "the pill's window must not draw a native shadow");
    let page = read("../app/capture-controls/page.tsx");
    assert!(
        page.contains("${GLASS_PILL}") && !page.contains("${GLASS_BAR}"),
        "the pill uses the glass whose shadow fits its window"
    );
    let glass = read("../app/lib/capture/glass.ts");
    let pill = glass
        .split("export const GLASS_PILL")
        .nth(1)
        .expect("GLASS_PILL")
        .split(';')
        .next()
        .unwrap();
    assert!(pill.contains("shadow-[0_2px_6px"), "a shadow reaching at most 8px: {pill}");
}

/// The helper's entry point is `@main` in `HippiusCapture.swift`. A file
/// named `main.swift` is top-level code by definition, and newer Swift
/// refuses `@main` beside it; the release's helper build failed that way.
#[test]
fn the_recording_helper_has_no_main_swift() {
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../macos/HippiusCapture/Sources/main.swift")
            .exists(),
        "macos/HippiusCapture/Sources/main.swift is back; keep @main in HippiusCapture.swift"
    );
    assert!(read("../macos/HippiusCapture/Sources/HippiusCapture.swift").contains("@main"));
}

/// Mute mid-recording writes silence in place of the microphone: the device
/// stays open and its buffers keep their timestamps, so the file's one audio
/// track runs on in step with the picture (dropping them would leave a hole
/// players close up, and the sound would drift ahead of the video). A switch
/// is the same stream reconfigured, never a new recording.
#[test]
fn a_muted_or_switched_microphone_keeps_one_continuous_track() {
    let swift = read("../macos/HippiusCapture/Sources/HippiusCapture.swift");
    assert!(
        swift.contains("let gain: Float = silent ? 0 :"),
        "a muted microphone is mixed at zero gain, never skipped"
    );
    assert!(
        swift.contains("mixAudio(sampleBuffer, from: .microphone, at: placed.time, silent: microphoneMuted(at: pts))"),
        "the mute is decided by each buffer's capture time"
    );
    assert!(
        swift.contains("try await stream.updateConfiguration(configuration)"),
        "a microphone switch reconfigures the running stream"
    );
    assert_eq!(
        swift.matches("AVAssetWriterInput(mediaType: .audio").count(),
        1,
        "still exactly one audio track"
    );
}

/// The pill's microphone changes reach the recorder before the pill is told,
/// so a refused switch leaves the old microphone recording and showing; every
/// recording (a restart too) starts heard, and every ending forgets it.
#[test]
fn the_pill_changes_the_microphone_through_the_recorder_first() {
    let src = read("src/capture/commands.rs");
    let change = fn_body(&src, "async fn change_microphone(");
    let asked = change.find("with_recorder(").expect("the recorder is asked");
    let told = change.find("set_live_microphone(").expect("the pill is told");
    assert!(asked < told, "the recorder answers before the pill is told");
    assert!(change.contains(".plan("), "Rust decides whether the change applies");

    let begin = fn_body(&src, "async fn begin_recording(");
    let adopted = begin.find("adopt_recorder(").expect("the recorder is adopted");
    let reset = begin.find("LiveMicrophone::started(").expect("the microphone is reset at start");
    assert!(adopted < reset);
    assert!(fn_body(&src, "async fn end_camera(").contains("LiveMicrophone::default()"));

    let mute = fn_body(&src, "pub async fn capture_microphone_mute(");
    assert!(mute.contains("MicrophoneAction::Mute(muted)"));
    let switch = fn_body(&src, "pub async fn capture_microphone_switch(");
    assert!(switch.contains("MicrophoneAction::Switch("));
}

/// The pill's menus live in the pill's own window, which is content
/// protected (`the_controls_keep_themselves_out_of_the_recording`): the
/// window grows to hold them and shrinks back, rather than a native menu or
/// another window, which would be filmed.
#[test]
fn the_pill_menus_grow_the_protected_pill_window() {
    let src = read("src/capture/commands.rs");
    let menu = fn_body(&src, "pub async fn capture_controls_menu(");
    assert!(menu.contains("get_webview_window(CONTROLS_LABEL)"));
    assert!(menu.contains("live_controls::pill_with_menu("));
    assert!(menu.contains("live_controls::pill_without_menu("));
    // A pill shown again is placed at its own size, whatever was open.
    assert!(fn_body(&src, "fn open_controls(").contains("pill_menu).take()"));
}

/// The bubble's size changes mid-recording by moving its window inside what
/// is filmed, so the camera in the file follows; the camera only stage is
/// never resized (it is the recording).
#[test]
fn a_bubble_resized_mid_recording_stays_in_the_video() {
    let src = read("src/capture/commands.rs");
    let set_size = fn_body(&src, "pub async fn capture_camera_set_size(");
    let live = set_size.find("live_controls::is_live(").expect("a mid-recording branch");
    let resize = set_size.find("resize_bubble_while_recording(").expect("resized while recording");
    assert!(live < resize);
    assert!(set_size[live..resize].contains("Some(CameraShape::Bubble)"), "only a bubble");
    let body = fn_body(&src, "async fn resize_bubble_while_recording(");
    assert!(body.contains("filmed_now(app)"), "sized inside what is filmed");
    assert!(body.contains("camera::resized_while_recording("));
}

/// A camera switched from the pill goes through the camera window (the only
/// page that may call `getUserMedia`), never the recorder, and is refused
/// where the recorder holds the camera itself.
#[test]
fn a_camera_switched_mid_recording_goes_through_the_camera_window() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "pub async fn capture_camera_switch(");
    assert!(body.contains("live_controls::camera_switch("));
    assert!(body.contains("recorder_opens_camera("));
    assert!(body.contains("sync_camera(&app)"), "the camera page is told the new device");
    assert!(!body.contains("with_recorder("), "the recorder never opens the bubble's camera");
}

/// Linux's recording tray menu (Stop, Pause, Show recording controls) is
/// answered by ONE app-wide listener, added at start-up before any
/// recording's menu exists, and every click goes through the phase-aware
/// route to the same commands the pill uses. Two listeners would run each
/// click twice; none would leave the items doing nothing.
#[test]
fn the_linux_recording_menu_reaches_the_session() {
    let main = read("src/main.rs");
    let setup = fn_body(&main, "pub fn setup(");
    assert!(
        setup.contains("crate::capture::commands::listen_to_recording_menu(app.handle())"),
        "the recording menu's listener is added at start-up"
    );
    let src = read("src/capture/commands.rs");
    assert_eq!(src.matches(".on_menu_event(").count(), 1, "one menu listener for the recording's items");
    let listener = fn_body(&src, "pub fn listen_to_recording_menu(");
    assert!(listener.contains("Once") && listener.contains("on_recording_menu_item("));
    let item = fn_body(&src, "fn on_recording_menu_item(");
    assert!(item.contains("effect_for(action, phase)"), "clicks are read against the phase now");
    for call in ["stop_inner(&app)", "capture_pause(app)", "capture_resume(app)", "bring_controls_back("] {
        assert!(item.contains(call), "the tray menu uses {call}");
    }
    assert!(
        fn_body(&src, "fn write_tray_menu(").contains("listen_to_recording_menu(app)"),
        "a menu is never put up without its listener"
    );
}

/// Wayland: the drawn area is remembered for the next one, and the pill is
/// moved outside it before the recording's first cropped picture.
#[test]
fn a_wayland_area_is_remembered_and_keeps_the_pill_out() {
    let src = read("src/capture/commands.rs");
    let draw = fn_body(&src, "async fn draw_area(");
    assert!(draw.contains("initial_area(remembered, stream)"));
    assert!(draw.contains("bar::remember_area(pool, super::area_pick::REMEMBERED_AREA_ID"));
    let placed = draw.find("place_pill_clear_of_stream_area(").expect("the pill is placed");
    let cropped = draw.find("recorder.crop(area)").expect("the recorder crops");
    assert!(placed < cropped, "the pill moves before the first cropped picture");
}

/// The shortcut is the one-step area screenshot: Rust's press asks the main
/// window for `instant`, `capture_start` lets `capture::instant` decide what
/// that is here, and the session's flag reaches every overlay (no bar, no
/// remembered area, no timer). The bar's last mode is not moved by it.
#[test]
fn the_shortcut_starts_the_instant_area_screenshot() {
    let src = read("src/capture/commands.rs");
    let on = fn_body(&src, "pub fn on_shortcut(");
    assert!(on.contains("shortcut::ShortcutStart::PRESSED"), "the press says what to start");
    let start = fn_body(&src, "pub async fn capture_start(");
    assert!(start.contains("instant::start_choice("), "Rust decides what an instant start is");
    assert!(start.contains("state.capture.instant.store(choice.instant"));
    assert!(
        start.contains("if choice.remember"),
        "an instant shot is not remembered as the bar's last mode"
    );
    let ui = fn_body(&src, "async fn open_capture_ui(");
    assert!(ui.contains("if instant {\n        None"), "nothing is drawn in advance");
    assert!(ui.contains("open_overlay(app, display, Some(display.id) == host, instant)"));
    let context = fn_body(&src, "pub async fn capture_overlay_context(");
    assert!(context.contains("instant::countdown_secs(") && context.contains("instant,"));
    let mode = fn_body(&src, "pub async fn capture_set_mode(");
    assert!(mode.contains("instant::remembers_mode_switch("));
    // The overlay page takes the shot when the drag ends and draws no bar.
    let page = read("../app/capture-overlay/page.tsx");
    assert!(page.contains("submitSelection({ target: \"area\", displayId, rect: created })"));
    assert!(page.contains("context.hostsBar && !counting && !instant &&"));
    // The main window passes Rust's payload on as is.
    let host = read("../app/components/capture/CaptureHost.tsx");
    assert!(host.contains("listen<CaptureShortcutStart>(\"capture_shortcut_pressed\""));
}

/// Hippius stays reachable during a recording (macOS): the Dock's reopen is
/// no longer dropped because the pill is a visible window, Cmd+Tab (only
/// "did become active") brings the hidden main window, and once the user has
/// it the recording's end leaves it alone.
#[test]
fn hippius_can_be_opened_during_a_recording() {
    let main = read("src/main.rs");
    assert!(main.contains("tauri::RunEvent::Reopen { .. } => {"));
    assert!(main.contains("crate::capture::commands::on_app_reopen(app_handle)"));
    assert!(!main.contains("if has_visible_windows"), "a visible pill must not swallow the Dock click");
    assert!(main.contains("crate::capture::activation::watch(app.handle())"));
    assert!(main.contains("crate::capture::commands::on_main_window_focused(window.app_handle())"));

    let src = read("src/capture/commands.rs");
    assert!(fn_body(&src, "pub fn on_app_reopen(").contains("own_windows::reopen_shows_main("));
    let activated = fn_body(&src, "pub fn on_app_activated(");
    assert!(activated.contains("own_windows::activation_shows_main(") && activated.contains("activation::mouse_down()"));
    let focused = fn_body(&src, "pub fn on_main_window_focused(");
    for forget in ["restore_main.store(false", "main_was_focused.store(false", "previous_app).take()"] {
        assert!(focused.contains(forget), "taking the main window back forgets {forget}");
    }

    let watch = read("src/capture/activation.rs");
    assert!(watch.contains("NSApplicationDidBecomeActiveNotification"));
    assert!(watch.contains("pressedMouseButtons"));
}

/// The screenshot editor: its own window and capability (core only, listed
/// in tauri.conf.json, or the page never hears the close button), a page that
/// boots without the app, every command registered, and a save that writes
/// the picture BEFORE the link is replaced, revokes the old link, and goes
/// through the existing upload and share paths rather than a second copy.
#[test]
fn the_screenshot_editor_is_wired_end_to_end() {
    let editor = read("src/capture/editor.rs");
    let label = editor
        .lines()
        .find(|l| l.contains("pub const EDITOR_LABEL"))
        .and_then(|l| l.split('"').nth(1))
        .expect("EDITOR_LABEL");
    let capability: serde_json::Value = serde_json::from_str(&read("capabilities/capture-editor.json")).expect("capability parses");
    assert_eq!(capability["windows"], serde_json::json!([label]));
    for permission in capability["permissions"].as_array().expect("permissions") {
        assert!(permission.as_str().unwrap_or_default().starts_with("core:"), "{permission}");
    }
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).expect("conf parses");
    assert!(
        conf["app"]["security"]["capabilities"]
            .as_array()
            .expect("capabilities")
            .iter()
            .any(|c| c == label),
        "the editor's capability must be enabled"
    );
    let shell = read("../app/components/AppShell.tsx");
    assert!(shell.contains(&format!("\"/{label}\"")), "the editor page boots without the app");
    let open = fn_body(&editor, "fn open_with(");
    assert!(open.contains(&format!("\"{label}.html\"")), "the static export's route");
    assert!(open.contains("api.prevent_close()"), "the page asks before unsaved changes go");

    let main = read("src/main.rs");
    for name in [
        "capture_preview_edit",
        "capture_editor_open_file",
        "capture_editor_context",
        "capture_editor_image",
        "capture_editor_save",
        "capture_editor_copy",
        "capture_editor_close",
        "capture_annotate_latest",
        "capture_annotate_open_latest",
        "capture_annotate_pick",
    ] {
        assert!(main.contains(&format!("crate::capture::editor::{name},")), "{name} must be registered");
    }

    let save = fn_body(&editor, "pub async fn capture_editor_save(");
    let written = save.find("write_edited(").expect("the picture is written");
    let replaced = save.find("replace_link(").expect("the link is replaced");
    assert!(written < replaced, "a new link is made from the EDITED file");
    assert!(save.contains("session_for(&state, &request)"), "a save names its session");
    let write = fn_body(&editor, "async fn write_edited(");
    assert!(write.contains("replace_atomically("));
    assert!(
        write.contains("upload_files_to_remote_folder_inner("),
        "a remote capture reuses the remote upload"
    );
    assert!(write.contains("trigger_sync_now("), "a synced capture is uploaded by the engine");
    let link = fn_body(&editor, "async fn replace_link(");
    assert!(link.contains("super::deliver::mint("), "the capture's own share path");
    assert!(link.contains("hcfs_revoke_share("), "the old link is revoked");

    // The tray's Annotate: Rust shows the dialog and reads only its answer,
    // so no IPC names a path to read.
    let pick_cmd = editor
        .split("pub async fn capture_annotate_pick(")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .expect("capture_annotate_pick");
    assert!(
        !pick_cmd.contains("String") && !pick_cmd.contains("Path"),
        "the picker takes no path: {pick_cmd}"
    );
    let pick = fn_body(&editor, "async fn pick_and_open(");
    assert!(pick.contains(".pick_file("), "the file comes from the system dialog");
    let picked = fn_body(&editor, "async fn open_picked(");
    assert!(picked.contains("locate_in_drives("), "a file in a drive is edited in place");
    assert!(picked.contains("capture_editor_open_file("), "through Drive's own checks");
    assert!(picked.contains("SaveTarget::NewCapture"), "anything else is saved as a new screenshot");
    let new_shot = save.find("save_as_new_capture(").expect("a picked picture's save");
    assert!(new_shot < written, "a picked file is never the one written");
    let copy = fn_body(&editor, "async fn save_as_new_capture(");
    assert!(copy.contains("fresh_capture_dir("), "the copy is a capture of its own");
    assert!(copy.contains("deliver_as_new_screenshot("), "delivered like a fresh capture");
    let commands = read("src/capture/commands.rs");
    let deliver = fn_body(&commands, "pub(super) async fn deliver_as_new_screenshot(");
    assert!(deliver.contains("open_preview(") && deliver.contains("deliver_and_announce("));
}

/// Every `.rs` file under `dir` (relative to the crate), recursively.
fn rust_files(dir: &str) -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
    let mut pending = vec![root];
    let mut found = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
                found.push((path.display().to_string(), src));
            }
        }
    }
    found
}

/// The mutexes `stmt` locks with the capture code's `lock(&…)`, by field.
fn locked_fields(stmt: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut rest = stmt;
    while let Some(at) = rest.find("lock(&") {
        let before = rest[..at].chars().last();
        rest = &rest[at + "lock(&".len()..];
        // `lock(` itself, not `unlock(`, `try_lock(` or `clock(`.
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let path: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        if let Some(field) = path.rsplit('.').next().filter(|f| !f.is_empty()) {
            fields.push(field.to_string());
        }
    }
    fields
}

/// A `std::sync::Mutex` locked twice in one statement waits on its own
/// guard, which lives to the end of the statement: that thread never wakes,
/// and every later lock of that mutex waits too. `camera_state_for` once did
/// this with the recording's camera, so every capture hung at Record (no
/// pill, no bubble, the bar gone, only Escape) while each unit test passed.
#[test]
fn no_capture_statement_locks_the_same_mutex_twice() {
    for (path, src) in rust_files("src/capture") {
        let code: String = src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
        for stmt in code.split([';', '{', '}']) {
            let fields = locked_fields(stmt);
            for (i, field) in fields.iter().enumerate() {
                assert!(
                    !fields[i + 1..].contains(field),
                    "{path}: `{field}` is locked twice in one statement, which deadlocks: {}",
                    stmt.split_whitespace().collect::<Vec<_>>().join(" ")
                );
            }
        }
    }
}

/// The scan above finds the statement that hung every capture.
#[test]
fn the_double_lock_scan_finds_a_double_lock() {
    let hung = "let (a, b) = controls(phase, *lock(&state.capture.recording_camera), hidden, opens(*lock(&state.capture.recording_camera)))";
    assert_eq!(locked_fields(hung), ["recording_camera", "recording_camera"]);
    assert_eq!(locked_fields("let camera = *lock(&self.recording_camera)"), ["recording_camera"]);
    assert!(locked_fields("guard.try_lock(&x); unlock(&y)").is_empty());
}

/// The bar follows the pointer to another display while the user chooses,
/// as macOS's own capture bar does. Each part fails without an error: a
/// follow never spawned leaves the bar on the display the capture started
/// on; one that outlives the choosing keeps reading the pointer for nothing;
/// a move that does not rebroadcast changes Rust's mind but no overlay's;
/// and a bar that is not held moves away mid-countdown.
#[test]
fn the_bar_follows_the_pointer_to_another_display() {
    let src = read("src/capture/commands.rs");
    let start = fn_body(&src, "pub async fn capture_start(");
    assert!(
        start.contains("spawn_display_watch(app.clone());\n        spawn_bar_follow(app.clone());"),
        "the follow runs beside the display watch, never for the Wayland panel"
    );
    let follow = fn_body(&src, "fn spawn_bar_follow(");
    assert!(
        follow.contains("CapturePhase::Selecting { .. }") && follow.contains("break;"),
        "the follow ends with the choosing"
    );
    assert!(
        follow.contains("bar::bar_follow(") && follow.contains("bar_held"),
        "the move is bar::bar_follow's decision, and a held bar stays"
    );
    let moved = fn_body(&src, "fn move_bar(");
    assert!(
        moved.contains("rebroadcast(") && moved.contains("set_focus()"),
        "the overlays hear the move"
    );
    assert!(
        fn_body(&src, "async fn open_capture_ui(").contains("bar_held.store(false"),
        "a hold from an earlier capture does not pin this one's bar"
    );
    let main = read("src/main.rs");
    assert!(main.contains("crate::capture::commands::capture_hold_bar,"));
    let page = read("../app/capture-overlay/page.tsx");
    assert!(page.contains("holdCaptureBar(holdsBar)"), "the bar's overlay holds the bar");
}
