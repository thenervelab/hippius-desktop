//! The selection overlays as non-activating panels (macOS), and who holds
//! the keyboard while the user chooses what to capture.
//!
//! **Why.** WebKit hit-tests mouse moves (hover, `pointerenter`, the window
//! under the pointer lit in window mode) and takes keys only while its
//! window is the key window, and an ordinary `NSWindow` is only key while
//! Hippius is the active app. Hippius is often not: a capture starts from
//! the shortcut or the tray over the user's app, and that app can come back
//! to the front while the user chooses (a click or a gesture that reaches
//! it). From then on the bar showed no tooltips and Escape did nothing until
//! a click on the bar brought Hippius forward. An `NSPanel` with
//! `NSWindowStyleMaskNonactivatingPanel` is key without activating its app,
//! so the bar has hover and keys whichever app is frontmost, and the user's
//! app keeps its menu bar and Space while they choose.
//!
//! **How.** Tauri builds every window as tao's `TaoWindow` (an `NSWindow`
//! subclass), so the overlay is turned into a panel right after it is built
//! and before it is shown ([`make_panel`]): its class is swapped for
//! [`PANEL_CLASS`], an `NSPanel` subclass with tao's `focusable` ivar at
//! the same offset and tao's own `canBecomeKeyWindow` / `sendEvent:`.
//! Swapping a class under key-value observers breaks them (a later
//! `removeObserver:` throws, which aborts the process), and WebKit observes
//! the window's `contentView` through a KVO subclass. So the content view
//! (the web view's parent) is taken out first, which removes WebKit's
//! observer, the swap happens while only AppKit's own manual observation
//! remains, and the content view goes back, when WebKit observes again and
//! KVO subclasses the panel class itself. Anything unexpected (another
//! class, sizes or ivar offsets that differ, a KVO subclass that overrides
//! more than `setContentView:`) leaves the window as it was, logged, and the
//! overlay works as before (keyed by activating Hippius).
//!
//! **Keeping the keyboard.** [`make_key`] makes the bar's overlay key
//! without activating Hippius. The bar's overlay is keyed once every overlay
//! is up, when the bar moves to another display, when its page has loaded
//! (`capture_overlay_context`), and by the bar-follow watch whenever the
//! keyboard went to another app and the pointer is on an overlay
//! ([`should_rekey`]), never while another Hippius window or another app's
//! window above the overlays (a system prompt) has it.

use tauri::WebviewWindow;

/// The runtime class every macOS selection overlay becomes.
pub const PANEL_CLASS: &str = "HippiusCaptureOverlayPanel";

/// `NSWindowStyleMaskNonactivatingPanel`.
pub const NONACTIVATING_PANEL_MASK: usize = 1 << 7;

/// The methods a key-value-observing subclass of the overlay window may
/// carry for the class swap to be safe: KVO's bookkeeping (`class`,
/// `dealloc`, `_isKVOA`) and the setter of the one key WebKit observes,
/// `contentView`, whose observer goes away with the content view.
pub const KVO_METHODS_SAFE_TO_DROP: [&str; 4] = ["setContentView:", "class", "dealloc", "_isKVOA"];

/// Whether the window's key-value-observing subclass, listed by its own
/// methods, observes nothing but the content view, so its class can be
/// swapped once the content view is out. A window that is not KVO-subclassed
/// lists nothing here.
#[must_use]
pub fn kvo_subclass_allows_swap<S: AsRef<str>>(own_methods: &[S]) -> bool {
    own_methods.iter().all(|m| KVO_METHODS_SAFE_TO_DROP.contains(&m.as_ref()))
}

/// Whether the bar's overlay gets hover and keys: it must be the key
/// window, and an ordinary window is only key in WebKit's sense while
/// Hippius is active; a non-activating panel is key on its own.
#[must_use]
pub const fn bar_gets_pointer(key: bool, panel: bool, app_active: bool) -> bool {
    key && (panel || app_active)
}

/// Whether the bar-follow watch gives the keyboard back to the bar's
/// overlay: only while choosing, only to a panel (an ordinary window would
/// need Hippius activated over the user's app every time), only when no
/// Hippius window has the keyboard (another app took it; the camera bubble
/// or the main window keep theirs) and only when the pointer is on one of
/// the overlays (not on a system prompt above them).
#[must_use]
pub const fn should_rekey(facts: RekeyFacts) -> bool {
    facts.selecting && facts.bar_is_panel && !facts.bar_key && !facts.hippius_has_key_window && facts.pointer_on_overlay
}

/// What [`should_rekey`] decides from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RekeyFacts {
    /// The user is choosing what to capture.
    pub selecting: bool,
    /// The bar's overlay is a non-activating panel.
    pub bar_is_panel: bool,
    /// The bar's overlay is the key window already.
    pub bar_key: bool,
    /// Some Hippius window (the camera bubble, the main window) has the
    /// keyboard.
    pub hippius_has_key_window: bool,
    /// The topmost window under the pointer is one of the overlays.
    pub pointer_on_overlay: bool,
}

/// What the log says about the bar's overlay a moment after it was keyed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyboardState {
    /// `NSWindow.isKeyWindow`.
    pub key: bool,
    /// The overlay is a non-activating panel.
    pub panel: bool,
    /// `NSApp.isActive`.
    pub app_active: bool,
    /// Hippius is the frontmost app (its menu bar shows).
    pub frontmost: bool,
}

impl KeyboardState {
    /// Hover and keys reach the bar.
    #[must_use]
    pub const fn bar_gets_pointer(self) -> bool {
        bar_gets_pointer(self.key, self.panel, self.app_active)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{CStr, c_char, c_void};
    use std::sync::OnceLock;

    use cocoa::base::{BOOL, NO, YES, id, nil};
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::WebviewWindow;

    use super::{KeyboardState, NONACTIVATING_PANEL_MASK, PANEL_CLASS, kvo_subclass_allows_swap};

    unsafe extern "C" {
        fn object_getClass(obj: *const Object) -> *const Class;
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
        fn class_getName(cls: *const Class) -> *const c_char;
        fn class_getInstanceSize(cls: *const Class) -> usize;
        fn class_getInstanceVariable(cls: *const Class, name: *const c_char) -> *const c_void;
        fn ivar_getOffset(ivar: *const c_void) -> isize;
        fn class_copyMethodList(cls: *const Class, count: *mut u32) -> *mut *const c_void;
        fn method_getName(method: *const c_void) -> Sel;
        fn class_getMethodImplementation(cls: *const Class, name: Sel) -> *const c_void;
        fn free(ptr: *mut c_void);
    }

    /// tao's window class, whose methods and `focusable` ivar the panel copies.
    const TAO_WINDOW_CLASS: &str = "TaoWindow";

    extern "C" fn cannot_become_main(_this: &Object, _cmd: Sel) -> BOOL {
        NO
    }

    /// The panel class, declared once. `None` when tao's class is not there
    /// to copy (a tao that changed: the overlay stays an ordinary window).
    fn panel_class() -> Option<&'static Class> {
        static CLASS: OnceLock<Option<usize>> = OnceLock::new();
        let ptr = *CLASS.get_or_init(|| {
            if let Some(existing) = Class::get(PANEL_CLASS) {
                return Some(std::ptr::from_ref(existing) as usize);
            }
            let tao = Class::get(TAO_WINDOW_CLASS)?;
            // tao's own methods, not NSWindow's: a tao that stopped
            // overriding them gets no panel rather than a wrong copy.
            // SAFETY: tao's class is registered for the process.
            let own = |name: Sel| unsafe { own_method_names(std::ptr::from_ref(tao)) }.contains(&name.name().to_owned());
            if !own(sel!(canBecomeKeyWindow)) || !own(sel!(sendEvent:)) {
                return None;
            }
            let mut decl = ClassDecl::new(PANEL_CLASS, class!(NSPanel))?;
            // SAFETY: tao's own implementations, added under the selectors
            // tao registered them for with the same signatures (`BOOL`
            // getters, `sendEvent:` taking one object). They read only the
            // `focusable` ivar, which the panel declares with tao's type and
            // which `convert` checks sits at tao's offset.
            unsafe {
                let key = std::mem::transmute::<*const c_void, extern "C" fn(&Object, Sel) -> BOOL>(class_getMethodImplementation(
                    std::ptr::from_ref(tao),
                    sel!(canBecomeKeyWindow),
                ));
                decl.add_method(sel!(canBecomeKeyWindow), key);
                let send = std::mem::transmute::<*const c_void, extern "C" fn(&Object, Sel, id)>(class_getMethodImplementation(
                    std::ptr::from_ref(tao),
                    sel!(sendEvent:),
                ));
                decl.add_method(sel!(sendEvent:), send);
                // A panel is never the main window: being main is part of
                // activating an app, which this panel must not do.
                decl.add_method(sel!(canBecomeMainWindow), cannot_become_main as extern "C" fn(&Object, Sel) -> BOOL);
            }
            decl.add_ivar::<BOOL>("focusable");
            Some(std::ptr::from_ref(decl.register()) as usize)
        });
        // SAFETY: a registered class lives for the process.
        ptr.map(|p| unsafe { &*(p as *const Class) })
    }

    unsafe fn name_of(cls: *const Class) -> String {
        // SAFETY: a live class; its name is a static C string.
        unsafe { CStr::from_ptr(class_getName(cls)).to_string_lossy().into_owned() }
    }

    unsafe fn ivar_offset(cls: *const Class, name: &CStr) -> Option<isize> {
        // SAFETY: a live class and a NUL-terminated name.
        let ivar = unsafe { class_getInstanceVariable(cls, name.as_ptr()) };
        // SAFETY: a non-null ivar of that class.
        (!ivar.is_null()).then(|| unsafe { ivar_getOffset(ivar) })
    }

    unsafe fn own_method_names(cls: *const Class) -> Vec<String> {
        let mut count = 0u32;
        // SAFETY: a live class; the list is freed below.
        let list = unsafe { class_copyMethodList(cls, &raw mut count) };
        if list.is_null() {
            return Vec::new();
        }
        let names = (0..count as usize)
            // SAFETY: `count` methods were returned.
            .map(|i| unsafe { method_getName(*list.add(i)) }.name().to_owned())
            .collect();
        // SAFETY: returned by `class_copyMethodList`, freed once.
        unsafe { free(list.cast()) };
        names
    }

    /// Why a window was left an ordinary window.
    enum Refusal {
        NotTaoWindow(String),
        NoPanelClass,
        LayoutDiffers,
        NoContentView,
        Observed(Vec<String>),
    }

    impl std::fmt::Display for Refusal {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::NotTaoWindow(class) => write!(f, "its class is {class}, not tao's window"),
                Self::NoPanelClass => f.write_str("tao's window methods were not found to copy"),
                Self::LayoutDiffers => f.write_str("the panel's size or ivar layout differs from tao's window"),
                Self::NoContentView => f.write_str("it has no content view"),
                Self::Observed(methods) => write!(f, "it is observed for more than its content view ({})", methods.join(", ")),
            }
        }
    }

    /// Turn `ns_window` into a non-activating panel, or say why not. Main
    /// thread only.
    unsafe fn convert(ns_window: *mut Object) -> Result<(), Refusal> {
        // SAFETY (whole function): `ns_window` is a live NSWindow touched on
        // the main thread; every call is plain AppKit or the ObjC runtime on
        // it and its own content view.
        unsafe {
            let panel_kind: BOOL = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
            if panel_kind == YES {
                return Ok(());
            }
            // KVO's `class` answers the class under its own subclass.
            let apparent: *const Class = msg_send![ns_window, class];
            if name_of(apparent) != TAO_WINDOW_CLASS {
                return Err(Refusal::NotTaoWindow(name_of(apparent)));
            }
            let panel = panel_class().ok_or(Refusal::NoPanelClass)?;
            let panel_ptr = std::ptr::from_ref(panel);
            let real = object_getClass(ns_window);
            let focusable = c"focusable";
            if class_getInstanceSize(real) != class_getInstanceSize(panel_ptr)
                || class_getInstanceSize(class!(NSWindow)) != class_getInstanceSize(class!(NSPanel))
                || ivar_offset(real, focusable).is_none()
                || ivar_offset(real, focusable) != ivar_offset(panel_ptr, focusable)
            {
                return Err(Refusal::LayoutDiffers);
            }

            // Take the web view's parent out: WebKit stops observing the
            // window's content view, so nothing observes a key the swap
            // would cut off.
            let content: id = msg_send![ns_window, contentView];
            if content == nil {
                return Err(Refusal::NoContentView);
            }
            let _: id = msg_send![content, retain];
            let placeholder: id = msg_send![class!(NSView), new];
            let () = msg_send![ns_window, setContentView: placeholder];

            let real = object_getClass(ns_window);
            let observed = if real == apparent { Vec::new() } else { own_method_names(real) };
            let result = if kvo_subclass_allows_swap(&observed) {
                object_setClass(ns_window, panel_ptr);
                let mask: usize = msg_send![ns_window, styleMask];
                let () = msg_send![ns_window, setStyleMask: mask | NONACTIVATING_PANEL_MASK];
                // A panel hides when its app deactivates, and Hippius is
                // often not the active app while the user chooses.
                let () = msg_send![ns_window, setHidesOnDeactivate: NO];
                let () = msg_send![ns_window, setBecomesKeyOnlyIfNeeded: NO];
                Ok(())
            } else {
                Err(Refusal::Observed(observed))
            };

            // Put the web view back; it takes the keyboard in its window
            // again, as wry set it up.
            let () = msg_send![ns_window, setContentView: content];
            let subviews: id = msg_send![content, subviews];
            let web_view: id = msg_send![subviews, firstObject];
            if web_view != nil {
                let _: BOOL = msg_send![ns_window, makeFirstResponder: web_view];
            }
            let () = msg_send![content, release];
            let () = msg_send![placeholder, release];
            result
        }
    }

    pub fn make_panel(window: &WebviewWindow) {
        let target = window.clone();
        let label = window.label().to_owned();
        let _ = window.run_on_main_thread(move || {
            let Ok(ns_window) = target.ns_window() else { return };
            // SAFETY: this window's live NSWindow, on the main thread.
            match unsafe { convert(ns_window.cast::<Object>()) } {
                Ok(()) => tracing::info!(window = %label, "capture: overlay is a non-activating panel"),
                Err(why) => tracing::warn!(
                    window = %label,
                    reason = %why,
                    "capture: overlay left an ordinary window; it takes the keyboard by bringing Hippius forward"
                ),
            }
        });
    }

    /// Order `ns_window` front and make it key without activating Hippius,
    /// when it is a panel. `false` for an ordinary window.
    unsafe fn key_panel(ns_window: *mut Object) -> bool {
        // SAFETY: a live NSWindow on the main thread.
        unsafe {
            let panel: BOOL = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
            if panel != YES {
                return false;
            }
            let () = msg_send![ns_window, orderFrontRegardless];
            let () = msg_send![ns_window, makeKeyWindow];
            true
        }
    }

    pub fn make_key(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ns_window) = target.ns_window() else { return };
            // SAFETY: this window's live NSWindow, on the main thread.
            if !unsafe { key_panel(ns_window.cast::<Object>()) } {
                // An ordinary window is key only with Hippius active.
                let _ = target.set_focus();
            }
        });
    }

    pub async fn keyboard_state(window: &WebviewWindow) -> Option<KeyboardState> {
        let target = window.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let state = target.ns_window().ok().map(|ns_window| {
                    let ns_window = ns_window.cast::<Object>();
                    // SAFETY: read-only AppKit queries on the main thread.
                    unsafe {
                        let key: BOOL = msg_send![ns_window, isKeyWindow];
                        let panel: BOOL = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
                        let app: id = msg_send![class!(NSApplication), sharedApplication];
                        let active: BOOL = msg_send![app, isActive];
                        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
                        let front: id = msg_send![workspace, frontmostApplication];
                        let front_pid: i32 = if front == nil { 0 } else { msg_send![front, processIdentifier] };
                        KeyboardState {
                            key: key == YES,
                            panel: panel == YES,
                            app_active: active == YES,
                            frontmost: u32::try_from(front_pid).is_ok_and(|pid| pid == std::process::id()),
                        }
                    }
                });
                let _ = tx.send(state);
            })
            .ok()?;
        tokio::time::timeout(std::time::Duration::from_millis(300), rx).await.ok()?.ok()?
    }

    pub fn rekey_if_pointer_on_overlay(window: &WebviewWindow) {
        use cocoa::foundation::NSPoint;
        let target = window.clone();
        let label = window.label().to_owned();
        let _ = window.run_on_main_thread(move || {
            let Ok(ns_window) = target.ns_window() else { return };
            let ns_window = ns_window.cast::<Object>();
            // SAFETY: AppKit on the main thread; every object is checked
            // for nil before use.
            unsafe {
                let panel_kind: BOOL = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
                let key: BOOL = msg_send![ns_window, isKeyWindow];
                let app: id = msg_send![class!(NSApplication), sharedApplication];
                let key_window: id = msg_send![app, keyWindow];
                // The topmost window under the pointer, any app's.
                let at: NSPoint = msg_send![class!(NSEvent), mouseLocation];
                let number: isize = msg_send![class!(NSWindow), windowNumberAtPoint: at belowWindowWithWindowNumber: 0isize];
                let under: id = msg_send![app, windowWithWindowNumber: number];
                let on_overlay = under != nil && name_of(object_getClass(under)).ends_with(PANEL_CLASS);
                let facts = super::RekeyFacts {
                    selecting: true,
                    bar_is_panel: panel_kind == YES,
                    bar_key: key == YES,
                    hippius_has_key_window: key_window != nil,
                    pointer_on_overlay: on_overlay,
                };
                if super::should_rekey(facts) && key_panel(ns_window) {
                    tracing::info!(window = %label, "capture: the keyboard went back to the capture bar from another app");
                }
            }
        });
    }
}

/// Turn a freshly built overlay into a non-activating panel (macOS; queued
/// on the main thread, so call it before the overlay is shown). Elsewhere
/// nothing happens.
pub fn make_panel(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    imp::make_panel(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Bring `window` forward with the keyboard: a panel without activating
/// Hippius (macOS), anything else with `set_focus`, which activates it.
pub fn make_key(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    imp::make_key(window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_focus();
    }
}

/// Read who has the keyboard (macOS), without blocking the main thread for
/// long. `None` elsewhere or when AppKit did not answer in time.
pub async fn keyboard_state(window: &WebviewWindow) -> Option<KeyboardState> {
    #[cfg(target_os = "macos")]
    {
        imp::keyboard_state(window).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

/// The bar-follow watch's check (macOS): give the keyboard back to the
/// bar's overlay when another app took it and the pointer is on an overlay
/// ([`should_rekey`]). The caller checks that the user is still choosing.
pub fn rekey_if_pointer_on_overlay(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    imp::rekey_if_pointer_on_overlay(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Swapping a class under a key-value observer breaks it, and a later
    /// `removeObserver:` throws, which aborts the app. WebKit observes only
    /// the content view, which is taken out before the swap; a window whose
    /// KVO subclass observes anything else keeps its class.
    #[test]
    fn the_class_is_swapped_only_when_nothing_but_the_content_view_is_observed() {
        assert!(kvo_subclass_allows_swap::<&str>(&[]), "a window that is not KVO-subclassed");
        assert!(kvo_subclass_allows_swap(&["setContentView:", "class", "dealloc", "_isKVOA"]));
        assert!(kvo_subclass_allows_swap(&["class", "dealloc", "_isKVOA"]));
        assert!(!kvo_subclass_allows_swap(&[
            "setContentView:",
            "setTitle:",
            "class",
            "dealloc",
            "_isKVOA"
        ]));
        assert!(!kvo_subclass_allows_swap(&["setFrame:display:"]));
    }

    /// WebKit gives hover and keys only to the key window, and an ordinary
    /// window is key only with Hippius active; a non-activating panel is key
    /// with any app frontmost. The log's "bar has the keyboard" says exactly
    /// this, so a passing check means the tooltips work.
    #[test]
    fn the_bar_gets_the_pointer_only_in_the_key_window() {
        assert!(bar_gets_pointer(true, true, false), "a key panel with another app in front");
        assert!(bar_gets_pointer(true, false, true), "an ordinary window with Hippius active");
        assert!(!bar_gets_pointer(true, false, false), "an ordinary window in an inactive app");
        assert!(!bar_gets_pointer(false, true, true), "a panel that is not key");
        let state = KeyboardState {
            key: true,
            panel: true,
            app_active: false,
            frontmost: false,
        };
        assert!(state.bar_gets_pointer());
    }

    /// The watch takes the keyboard back only from another app, only for a
    /// panel, only while choosing and only when the pointer is on an
    /// overlay: never from the camera bubble or another Hippius window, and
    /// never from a system prompt drawn above the overlays.
    #[test]
    fn the_keyboard_is_taken_back_only_from_another_app_with_the_pointer_on_an_overlay() {
        let taken = RekeyFacts {
            selecting: true,
            bar_is_panel: true,
            bar_key: false,
            hippius_has_key_window: false,
            pointer_on_overlay: true,
        };
        assert!(should_rekey(taken));
        assert!(!should_rekey(RekeyFacts { selecting: false, ..taken }), "not choosing");
        assert!(
            !should_rekey(RekeyFacts {
                bar_is_panel: false,
                ..taken
            }),
            "an ordinary window would activate Hippius"
        );
        assert!(!should_rekey(RekeyFacts { bar_key: true, ..taken }), "already key");
        assert!(
            !should_rekey(RekeyFacts {
                hippius_has_key_window: true,
                ..taken
            }),
            "another Hippius window has the keyboard"
        );
        assert!(
            !should_rekey(RekeyFacts {
                pointer_on_overlay: false,
                ..taken
            }),
            "the pointer is not on an overlay"
        );
    }
}
