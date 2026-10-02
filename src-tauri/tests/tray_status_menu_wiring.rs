//! Wiring guard for the macOS tray left click (`tray::status_menu`).
//!
//! On newer macOS a status item that owns a menu opens it on every click
//! before the `tray-icon` click view sees the mouse, so no left click ever
//! reached the app and the popover never opened (a left click showed the
//! small context menu). The menu must come off the status item: told by the
//! page after every attach, and again on any hover over the icon, from
//! Rust's one tray listener (`tray::panel::on_tray_icon_event`). `tray::status_menu` unit-tests which
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

/// One tray listener for the whole app: `tray::panel::on_tray_icon_event`
/// hands every event of the icon to `status_menu` first, then routes the
/// left click. A second `on_tray_icon_event` registration (one for the menu,
/// one for the click) would run each click through both.
#[test]
fn rust_listens_to_every_tray_event_once() {
    let main = read("src/main.rs");
    assert_eq!(main.matches(".on_tray_icon_event(").count(), 1, "exactly one tray listener");
    assert!(
        main.contains(".on_tray_icon_event(|app, event| crate::tray::panel::on_tray_icon_event(app, &event))"),
        "the one listener is the panel's"
    );
    assert_eq!(
        main.matches("crate::tray::status_menu::tray_menu_attached,").count(),
        1,
        "the page's report is registered once"
    );
    let panel = read("src/tray/panel.rs");
    let listener = fn_body(&panel, "pub fn on_tray_icon_event(");
    assert!(
        listener.contains("status_menu::on_tray_event(app, event)"),
        "the hover and right-click events reach status_menu"
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

    let panel = read("src/tray/panel.rs");
    let listener = fn_body(&panel, "pub fn on_tray_icon_event(");
    assert!(listener.contains("TRAY_ID"), "only the Hippius icon is touched");
    assert!(listener.contains("info!("), "every click leaves a line in the log");
}

/// The page rebuilds the icon on a reload: the new icon carries none of a
/// running recording's marks (its time, its dot, its Linux menu), so the
/// report of the new menu puts them back.
#[test]
fn a_new_icon_gets_a_running_recordings_marks_back() {
    let src = read("src/tray/status_menu.rs");
    let report = fn_body(&src, "pub fn tray_menu_attached(");
    let detach = report.find("imp::detach(&app)").expect("the menu comes off the status item");
    let restore = report
        .find("crate::capture::commands::restore_recording_in_tray(&app)")
        .expect("a running recording's marks go back on");
    assert!(detach < restore, "the menu is handled first");
}

#[test]
fn the_page_reports_every_menu_it_attaches() {
    let hook = read("../app/lib/hooks/useTraySync.ts");
    let creates = hook.matches("await TrayIcon.new(").count();
    let swaps = hook.matches(".setMenu(").count();
    let reports = hook.matches("await reportMenuAttached();").count();
    assert!(creates >= 2, "the first (or rebuilt) icon and the recreated one");
    assert_eq!(reports, creates + swaps, "each TrayIcon.new and setMenu is followed by its report");
    assert!(hook.contains("invoke(\"tray_menu_attached\")"), "the report reaches Rust");
    assert!(
        hook.contains("await existingTray.close();"),
        "a reload closes the icon the previous page made and builds a fresh one"
    );
    for (at, _) in hook.match_indices("await TrayIcon.new({") {
        let opts = &hook[at..at + hook[at..].find("});").expect("options close")];
        assert!(!opts.contains("action"), "no click callback on the icon: Rust receives the click");
    }
}
