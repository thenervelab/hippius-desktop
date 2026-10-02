//! Wiring guard for the macOS tray left click (`tray::status_menu`).
//!
//! On newer macOS a status item that owns a menu opens it on every click
//! before the `tray-icon` click view sees the mouse, so no left click ever
//! reached the page's `action` callback and the popover never opened (a left
//! click showed the small context menu). The menu must come off the status
//! item: told by the page after every attach, and again on any hover over the
//! icon, from Rust's own tray listener. `tray::status_menu` unit-tests which
//! event does what; these source-text guards pin the wiring, which cannot run
//! without a real status bar.

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

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
fn rust_listens_to_every_tray_event() {
    let main = read("src/main.rs");
    assert!(
        main.contains("builder.on_tray_icon_event(crate::tray::status_menu::on_tray_icon_event)"),
        "the hover and right-click events must reach status_menu"
    );
    assert!(
        main.contains("crate::tray::status_menu::tray_menu_attached,"),
        "the page's report is a registered command"
    );
}

#[test]
fn the_menu_is_taken_off_and_put_back_only_to_open_it() {
    let src = read("src/tray/status_menu.rs");
    let detach = fn_body(&src, "pub fn detach(app: &AppHandle) -> bool {\n        let Some(tray)");
    assert!(detach.contains("msg_send![item, setMenu: nil]"), "detach takes the menu off the item");

    let pop_up = fn_body(&src, "pub fn pop_up(app: &AppHandle) {\n        let menu");
    let attach = pop_up.find("setMenu: menu as *mut Object").expect("the kept menu is attached to open it");
    let click = pop_up.find("performClick: nil").expect("and opened");
    let off = pop_up.rfind("setMenu: nil").expect("and taken off again");
    assert!(attach < click && click < off, "attach, open, take off, in that order");

    let listener = fn_body(&src, "pub fn on_tray_icon_event(");
    assert!(listener.contains("TRAY_ID"), "only the Hippius icon is touched");
    assert!(listener.contains("tracing::info!"), "every click leaves a line in the log");
}

#[test]
fn the_page_reports_every_menu_it_attaches() {
    let hook = read("../app/lib/hooks/useTraySync.ts");
    let creates = hook.matches("await TrayIcon.new(").count();
    let reports = hook.matches("await reportMenuAttached();").count();
    assert!(creates >= 2, "the first icon and the recreated one");
    assert_eq!(reports, creates, "each TrayIcon.new is followed by its report");
    assert!(hook.contains("invoke(\"tray_menu_attached\")"), "the report reaches Rust");
}
