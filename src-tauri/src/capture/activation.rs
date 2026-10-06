//! Switching to Hippius during a recording (macOS). The main window is
//! hidden while a recording runs, and AppKit brings nothing back by itself:
//!
//! - the Dock icon sends "reopen", which `main.rs` hands to
//!   [`commands::on_app_reopen`](super::commands::on_app_reopen); it used to
//!   ignore a reopen whenever ANY window was visible, and the pill always is;
//! - Cmd+Tab sends no reopen at all, only `NSApplicationDidBecomeActive`,
//!   which this module listens for and hands to
//!   [`commands::on_app_activated`](super::commands::on_app_activated).
//!
//! The decisions are `own_windows`'; this is only the AppKit wiring.

use tauri::AppHandle;

/// Listen for Hippius becoming the active app, once, for the app's life.
/// Must run on the main thread (Tauri's `setup` does).
#[cfg(target_os = "macos")]
pub fn watch(app: &AppHandle) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::OnceLock;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    if APP.set(app.clone()).is_err() {
        return;
    }

    extern "C" fn did_become_active(_this: &Object, _cmd: Sel, _note: id) {
        if let Some(app) = APP.get() {
            super::commands::on_app_activated(app);
        }
    }

    const CLASS: &str = "HippiusActivationObserver";
    let class = Class::get(CLASS).unwrap_or_else(|| {
        let mut decl = ClassDecl::new(CLASS, class!(NSObject)).expect("the observer class is declared once");
        // SAFETY: the method's signature matches the selector it is added
        // for: one object argument (the notification), no return value.
        unsafe {
            decl.add_method(sel!(appDidBecomeActive:), did_become_active as extern "C" fn(&Object, Sel, id));
        }
        decl.register()
    });
    // SAFETY: AppKit on the main thread. The observer is never released, so
    // the notification centre never holds a dangling pointer; there is one
    // for the app's life. The name is AppKit's
    // `NSApplicationDidBecomeActiveNotification` constant's value.
    unsafe {
        let observer: id = msg_send![class, new];
        let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
        let name = NSString::alloc(nil).init_str("NSApplicationDidBecomeActiveNotification");
        let () = msg_send![center, addObserver: observer selector: sel!(appDidBecomeActive:) name: name object: nil];
    }
}

/// Elsewhere the tray's Open Hippius brings the main window back; there is
/// no Dock and no app activation to follow.
#[cfg(not(target_os = "macos"))]
pub fn watch(_app: &AppHandle) {}

/// Whether a mouse button is held now (macOS): a click on one of Hippius's
/// own windows activates the app too, and must not bring the main window.
#[cfg(target_os = "macos")]
pub fn mouse_down() -> bool {
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: a class method that only reads the current button state.
    let buttons: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    buttons != 0
}
