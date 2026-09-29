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
    let body = fn_body(&src, "fn open_overlay(");
    assert!(
        body.contains(".content_protected(true)"),
        "the overlay must be excluded from screen capture"
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
    assert!(body.contains("share_external_file("), "the link must come from the existing share path");
    for forbidden in ["HcfsClient", "reqwest", "encrypt"] {
        assert!(!body.contains(forbidden), "delivery must not talk to the server itself ({forbidden})");
    }
}

/// A failed upload must leave the capture on disk; only a delivered one is removed.
#[test]
fn the_temp_copy_is_removed_only_after_the_upload_lands() {
    let src = read("src/capture/commands.rs");
    let body = fn_body(&src, "async fn deliver_and_announce(");
    let ok_arm = body.find("Ok(delivered) =>").expect("success arm");
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
