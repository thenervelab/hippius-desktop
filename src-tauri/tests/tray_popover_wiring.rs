//! Wiring guards for the tray popover next to the screen-capture windows.
//!
//! The popover stopped opening under the menu bar icon once screen capture
//! landed: a signed-in click during a recording was routed to the recording
//! pill alone (already on screen, so the icon looked dead), the popover sat
//! at the same window level as the capture preview card (which is ordered
//! front whenever it shows and covered the popover's lower half on a laptop
//! display), and a capture window taking the keyboard back as the app
//! activated hid the popover the moment it appeared. The routing and the
//! timing rule are unit-tested in `capture::tray_status` and `tray::panel`;
//! these source pins keep the window code using them, since the show path
//! cannot run without an app.

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

/// A signed-in click opens the popover in every capture phase: the only
/// route that skips it is the signed-out one.
#[test]
fn a_recording_never_swallows_the_popover_click() {
    let panel = read("src/tray/panel.rs");
    let click = fn_body(&panel, "fn on_left_click(");
    assert!(
        click.contains("TrayClickRoute::TogglePanel { recording } => toggle_panel(app, rect, recording)"),
        "every signed-in click must reach toggle_panel, recording or not"
    );
    let route = fn_body(&read("src/capture/tray_status.rs"), "pub fn tray_click_route(");
    assert!(
        route.contains("(true, recording) => TrayClickRoute::TogglePanel { recording }"),
        "signed in, the route is the popover whatever the phase"
    );
}

/// The popover shown mid-recording is kept out of the video, and lifted
/// again on the next show after it.
#[test]
fn the_popover_is_kept_out_of_a_recording() {
    let body = fn_body(&read("src/tray/panel.rs"), "fn toggle_panel(");
    let protect = body
        .find("set_content_protected(recording)")
        .expect("content protection follows the recording");
    let show = body.find("win.show()").expect("the panel is shown");
    assert!(protect < show, "protection is set before the panel appears");
}

/// Above the capture card at every show, so a card shown later cannot cover it.
#[test]
fn the_popover_is_raised_above_the_capture_card_on_every_show() {
    let panel = read("src/tray/panel.rs");
    let body = fn_body(&panel, "fn toggle_panel(");
    let raise = body.find("raise_above_capture_surfaces(&win)").expect("the panel is raised on show");
    let show = body.find("win.show()").expect("the panel is shown");
    assert!(raise < show, "raised before it appears");
    assert!(
        fn_body(&panel, "pub fn prewarm(").contains("raise_above_capture_surfaces("),
        "the prewarmed panel is raised too"
    );
    let raise_fn = fn_body(&panel, "fn raise_above_capture_surfaces(win: &WebviewWindow)");
    assert!(raise_fn.contains("setLevel: PANEL_WINDOW_LEVEL"), "the level is the popover's own");
}

/// A blur right after the show (the activation settling) keeps the panel;
/// only a later one is a click outside.
#[test]
fn a_blur_right_after_the_show_keeps_the_popover() {
    let panel = read("src/tray/panel.rs");
    let blur = fn_body(&panel, "pub fn on_panel_blur(");
    let check = blur.find("blur_dismisses(").expect("the blur asks whether it dismisses");
    let hide = blur.find("win.hide()").expect("a dismissing blur hides");
    assert!(check < hide, "the settle check comes before the hide");
    assert!(
        fn_body(&panel, "fn toggle_panel(").contains("tray_panel_shown_at.store(now_ms()"),
        "every show records when it happened"
    );
}
