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
    let decide = body
        .find("OwnWindow::TrayPopover { recording }")
        .expect("content protection is decided by own_windows from the recording");
    let protect = body.find("set_content_protected(protect)").expect("and applied to the popover");
    let show = body.find("win.show()").expect("the panel is shown");
    assert!(decide < protect && protect < show, "protection is set before the panel appears");
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

/// macOS: a status item that owns a menu opens it on every click before the
/// `tray-icon` click view sees the mouse, so no left click ever reached the
/// app and the popover never opened (left click showed the small context
/// menu). The menu must come off the status item: told by the page after
/// every attach, and again on any hover over the icon, before the click
/// route runs. `tray::status_menu` unit-tests which event does what.
#[test]
fn the_context_menu_never_sits_on_the_status_item() {
    let panel = read("src/tray/panel.rs");
    let listener = fn_body(&panel, "pub fn on_tray_icon_event(");
    let menu = listener
        .find("status_menu::on_tray_event(app, event)")
        .expect("every event of the icon reaches status_menu");
    let left = listener.find("on_left_click(").expect("the left click is routed");
    assert!(menu < left, "the menu is handled before the left-click route");
    assert!(
        !listener.contains("button: MouseButton::Left,\n        button_state"),
        "the listener must not filter out the hover events status_menu needs"
    );

    let status_menu = read("src/tray/status_menu.rs");
    let detach = fn_body(&status_menu, "pub fn detach(app: &AppHandle) -> bool {\n        let Some(tray)");
    assert!(detach.contains("msg_send![item, setMenu: nil]"), "detach takes the menu off the item");
    let pop_up = fn_body(&status_menu, "pub fn pop_up(app: &AppHandle) {\n        let menu");
    let attach = pop_up.find("setMenu: menu as *mut Object").expect("the kept menu is attached to open it");
    let click = pop_up.find("performClick: nil").expect("and opened");
    let off = pop_up.rfind("setMenu: nil").expect("and taken off again");
    assert!(attach < click && click < off, "attach, open, take off, in that order");

    let main = read("src/main.rs");
    assert!(
        main.contains("crate::tray::status_menu::tray_menu_attached,"),
        "the page's report is a registered command"
    );
    let hook = std::fs::read_to_string(format!("{}/../app/lib/hooks/useTraySync.ts", env!("CARGO_MANIFEST_DIR"))).expect("read useTraySync.ts");
    assert!(hook.contains("invoke(\"tray_menu_attached\")"), "the page reports every menu it attaches");
}

/// The popover's "Copy link" is a registered command that mints only through
/// the Share dialog's two funnels, so the storage gate, the share-origin row
/// (the Drive's "Shared" badge) and the owner wrap apply to it unchanged. A
/// third, private mint path would skip them silently.
#[test]
fn the_popover_copy_link_mints_through_the_share_dialog_funnels() {
    let main = read("src/main.rs");
    assert!(
        main.contains("crate::shares::quick_link::copy_file_share_link,"),
        "copy_file_share_link must be registered"
    );
    let quick = read("src/shares/quick_link.rs");
    let mint = fn_body(&quick, "async fn mint(");
    assert!(mint.contains("share_synced_file("), "a file on disk is shared from disk");
    assert!(
        mint.contains("create_remote_share_inner("),
        "a cloud-only file is shared like the dialog shares it"
    );
    assert!(!mint.contains(".create_share("), "no direct hcfs mint around the gated funnels");
    // Rust writes the clipboard: the popover may have lost focus by the time
    // a link is made, and a webview clipboard write then fails.
    let command = fn_body(&quick, "pub async fn copy_file_share_link(");
    assert!(command.contains("app.clipboard().write_text("), "the link is copied in Rust");
}
