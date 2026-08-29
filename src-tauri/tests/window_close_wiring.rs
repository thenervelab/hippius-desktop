//! Closing the main window on Linux/Windows must actually quit the process.
//!
//! Staging called `prevent_close()` on every platform, then `exit(0)` from
//! inside the GTK/WebKit `CloseRequested` handler. That is a known
//! re-entrancy trap: the chrome vanishes and `/usr/bin/Hippius` stays in
//! state S at 0% CPU (H-003). The hidden `tray-panel` webview (prewarmed
//! even on Linux, where the popover is unused) can keep the event loop
//! alive if `exit(0)` never finishes.
//!
//! macOS is the exception: red-X hides to tray, so it *must* `prevent_close`.

/// Brace-matched body of the item whose signature contains `sig`.
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

fn main_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).expect("read main.rs")
}

/// `prevent_close` on Linux/Windows is the H-003 trap. It may appear only
/// in the macOS hide-to-tray arm.
#[test]
fn prevent_close_is_macos_only() {
    let src = main_src();
    let body = fn_body(&src, "pub fn on_window_event(");

    let macos_at = body.find("#[cfg(target_os = \"macos\")]").expect("on_window_event has a macOS arm");
    let not_macos_at = body
        .find("#[cfg(not(target_os = \"macos\"))]")
        .expect("on_window_event has a non-macOS arm");
    assert!(macos_at < not_macos_at, "macOS hide-to-tray arm must come first");

    let macos_arm = &body[macos_at..not_macos_at];
    let rest = &body[not_macos_at..];

    assert!(
        macos_arm.contains("prevent_close()"),
        "macOS red-X must prevent_close so hide-to-tray can run",
    );
    assert!(
        !rest.contains("prevent_close()"),
        "Linux/Windows must not call prevent_close(): cancelling the close and \
         exit(0) from inside the GTK handler orphans the process",
    );
}

/// The non-macOS close path must destroy the tray panel *before* exit so a
/// prewarmed hidden webview cannot keep the event loop alive.
#[test]
fn linux_windows_close_destroys_the_tray_panel_then_exits() {
    let src = main_src();
    let body = fn_body(&src, "pub fn on_window_event(");
    let not_macos_at = body
        .find("#[cfg(not(target_os = \"macos\"))]")
        .expect("on_window_event has a non-macOS arm");
    let rest = &body[not_macos_at..];

    assert!(
        rest.contains("quit_desktop") || (rest.contains("PANEL_LABEL") && rest.contains("destroy")),
        "non-macOS close must tear down tray-panel before exit",
    );
}

/// Tray Quit and the window X must share teardown, or one path still orphans.
#[test]
fn app_close_shares_quit_desktop() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/status.rs")).expect("read status.rs");
    let body = fn_body(&src, "pub fn app_close(");
    assert!(
        body.contains("quit_desktop"),
        "tray Quit (app_close) must use the same teardown as the window X",
    );
}

/// `quit_desktop` itself must destroy the panel, then exit — order is the
/// property that keeps a hidden webview from outliving the main window.
#[test]
fn quit_desktop_destroys_panel_before_exit() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray/panel.rs")).expect("read panel.rs");
    let body = fn_body(&src, "pub fn quit_desktop(");

    let panel_at = body.find("PANEL_LABEL").expect("quit_desktop looks up the tray panel");
    let destroy_at = body.find("destroy").expect("quit_desktop destroys the tray panel");
    let exit_at = body.find("exit(0)").expect("quit_desktop exits the app");

    assert!(
        panel_at < destroy_at && destroy_at < exit_at,
        "destroy the tray panel BEFORE exit(0), or the hidden webview can \
         keep the process in state S after the main window is gone",
    );
}
