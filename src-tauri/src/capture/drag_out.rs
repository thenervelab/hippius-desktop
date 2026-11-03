//! Drag a capture out of the card into another app as a real file.
//!
//! The card's picture is an `<img>` with a `data:` URL, and the webview's own
//! drag of it hands other apps that URL: dropped into a chat app it pasted a
//! huge string of text instead of the picture. So the page never lets the
//! webview drag it. A press on the picture that moves a few pixels asks Rust
//! to start the system's own file drag with the capture's file on this
//! computer, the same drag a file manager starts. The drop target receives
//! the PNG or MP4 itself, a copy of it; the capture, its drive and its link
//! are untouched.
//!
//! **macOS** is our own `NSDraggingSession` ([`mac`]). The `drag` crate it
//! used before made up a mouse event for the session (event number 0) and
//! offered Copy to the card's own web view too, which accepts any drop:
//! begun that way from the card, every app refused the drop and the picture
//! slid back. The session here begins from the window's real mouse event
//! whenever AppKit still has it (the press is still down: the page asks
//! while it moves), offers nothing inside Hippius, and the card's views stop
//! taking drops until the drag is over. Windows (OLE `DoDragDrop`) and Linux
//! (a GTK drag) keep the `drag` crate.
//!
//! The page never names a path: the card's own file is looked up here.
//! Every drag logs how it ended (`capture: card drag ended`), so a drop
//! that did not happen can be read from the logs.

use std::io::Cursor;
use std::path::PathBuf;

use base64::Engine;

use crate::error::{AppError, Result};

/// The drag picture's longest side, in pixels: a thumbnail under the
/// pointer, not the capture at full size.
pub const ICON_SIDE: u32 = 160;

/// Shown under the pointer when the card has no picture (a recording whose
/// first frame could not be read).
const FALLBACK_ICON: &[u8] = include_bytes!("../../icons/128x128.png");

/// The file a drag of the card hands out: the capture in its drive folder
/// when it is placed there, else the copy kept while it uploads. `None`
/// when neither is on this computer any more.
#[must_use]
pub fn file_to_drag(placed: Option<&PathBuf>, kept: &std::path::Path) -> Option<PathBuf> {
    placed
        .filter(|p| p.is_file())
        .cloned()
        .or_else(|| kept.is_file().then(|| kept.to_path_buf()))
}

/// The picture under the pointer while dragging, as PNG bytes: the card's
/// thumbnail (a JPEG `data:` URL) scaled to [`ICON_SIDE`], or the app icon.
#[must_use]
pub fn drag_icon(thumbnail: Option<&str>) -> Vec<u8> {
    thumbnail.and_then(icon_from_data_url).unwrap_or_else(|| FALLBACK_ICON.to_vec())
}

fn icon_from_data_url(url: &str) -> Option<Vec<u8>> {
    let (_, b64) = url.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let picture = image::load_from_memory(&bytes).ok()?;
    let small = picture.thumbnail(ICON_SIDE, ICON_SIDE);
    let mut png = Vec::new();
    small.to_rgba8().write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}

/// Runs once a drag of the card is over (dropped or cancelled), and when
/// it could not start.
type Ended = Box<dyn Fn() + Send + Sync>;

/// How a drag ended, for the log: AppKit's operation, `NSDragOperationNone`
/// (0) when the drop was refused or the drag cancelled.
#[must_use]
pub fn outcome(operation: usize) -> &'static str {
    if operation == 0 { "cancelled" } else { "dropped" }
}

/// Start the system's file drag of `file` from `window`, on the main thread
/// (AppKit, OLE and GTK all drag from there; the command calling this is not
/// async, so it already runs there and this runs at once). Called while the
/// mouse button that began the drag is still down. `ended` runs once the
/// drop or the cancel is over, and also when the drag could not start.
pub fn start(window: &tauri::WebviewWindow, file: PathBuf, icon: Vec<u8>, ended: impl Fn() + Send + Sync + 'static) -> Result<()> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let ended: Ended = Box::new(ended);
            #[cfg(target_os = "macos")]
            let started = mac::start(&target, &file, &icon, ended);
            #[cfg(not(target_os = "macos"))]
            let started = with_drag_crate(&target, file, icon, ended);
            if let Err((e, ended)) = started {
                tracing::warn!(error = %e, "capture: the card's file drag did not start");
                ended();
            }
        })
        .map_err(|e| AppError::Other(format!("Could not start the drag: {e}")))
}

/// Windows and Linux: the `drag` crate's drag of the file.
#[cfg(not(target_os = "macos"))]
fn with_drag_crate(target: &tauri::WebviewWindow, file: PathBuf, icon: Vec<u8>, ended: Ended) -> std::result::Result<(), (String, Ended)> {
    let ended = std::sync::Arc::new(ended);
    let on_drop = {
        let ended = ended.clone();
        move |result: drag::DragResult, _: drag::CursorPosition| {
            let result = if matches!(result, drag::DragResult::Dropped) {
                "dropped"
            } else {
                "cancelled"
            };
            tracing::info!(result, "capture: card drag ended");
            ended();
        }
    };
    let item = drag::DragItem::Files(vec![file]);
    let image = drag::Image::Raw(icon);
    #[cfg(target_os = "linux")]
    let started = target
        .gtk_window()
        .map_err(|e| e.to_string())
        .and_then(|w| drag::start_drag(&w, item, image, on_drop, drag::Options::default()).map_err(|e| e.to_string()));
    #[cfg(not(target_os = "linux"))]
    let started = drag::start_drag(target, item, image, on_drop, drag::Options::default()).map_err(|e| e.to_string());
    match started {
        Ok(()) => {
            tracing::info!("capture: card drag started");
            Ok(())
        }
        Err(e) => Err((e, Box::new(move || ended()))),
    }
}

/// macOS: an `NSDraggingSession` of the file's URL, begun on the card's
/// content view.
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    use cocoa::base::{NO, YES, id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Protocol, Sel};
    use objc::{class, msg_send, sel, sel_impl};

    use super::{Ended, outcome};

    /// `NSDragOperationNone` and `NSDragOperationCopy`.
    const DRAG_NONE: usize = 0;
    const DRAG_COPY: usize = 1;
    /// `NSDraggingContextWithinApplication`.
    const WITHIN_APPLICATION: isize = 1;
    /// `NSEventTypeLeftMouseDown` and `NSEventTypeLeftMouseDragged`.
    const LEFT_MOUSE_DOWN: usize = 1;
    const LEFT_MOUSE_DRAGGED: usize = 6;
    /// The drag picture's side when the thumbnail could not be read.
    const FALLBACK_SIDE: f64 = 64.0;
    const SOURCE_CLASS: &str = "HippiusCardDragSource";

    /// The drag in progress: who to tell when it ends, the views that stopped
    /// taking drops for it (each with the types it had, both retained), and
    /// its source object, which tells this drag's end from an older one's.
    struct Active {
        ended: Ended,
        suspended: Vec<(usize, usize)>,
        source: usize,
    }

    static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

    fn active() -> std::sync::MutexGuard<'static, Option<Active>> {
        ACTIVE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Begin the drag. On failure the caller gets `ended` back to call.
    pub fn start(window: &tauri::WebviewWindow, file: &Path, icon: &[u8], ended: Ended) -> Result<(), (String, Ended)> {
        let Ok(ns_window) = window.ns_window() else {
            return Err(("the card has no window".into(), ended));
        };
        // An older drag that never said it ended (AppKit always does, so this
        // is a guard, not a path): its card is told now and its views take
        // drops again, so one lost end cannot stop every later drag.
        if let Some(old) = active().take() {
            tracing::warn!("capture: a card drag began before the last one ended");
            // SAFETY: main thread (the caller's contract); the views and type
            // lists were retained when they were suspended.
            unsafe { restore(&old.suspended) };
            (old.ended)();
        }
        // SAFETY: AppKit on the main thread with the card's live NSWindow.
        // Every object is checked for nil before it is messaged; those we
        // alloc or `new` are released or handed to `ACTIVE`, the rest are
        // autoreleased into the pool drained below.
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let begun = begin(ns_window.cast::<Object>(), file, icon);
            pool.drain();
            match begun {
                Ok((source, suspended)) => {
                    *active() = Some(Active {
                        ended,
                        suspended,
                        source: source as usize,
                    });
                    Ok(())
                }
                Err(e) => Err((e, ended)),
            }
        }
    }

    /// Main thread only. The source object (+1) and the suspended views.
    unsafe fn begin(window: id, file: &Path, icon: &[u8]) -> Result<(id, Vec<(usize, usize)>), String> {
        // SAFETY: the caller's contract; see `start`.
        unsafe {
            // The press that began the drag must still be down: a session
            // begun after the button came up ends at once.
            let pressed: usize = msg_send![class!(NSEvent), pressedMouseButtons];
            if pressed & 1 == 0 {
                return Err("the mouse button was already up".into());
            }
            let view: id = msg_send![window, contentView];
            if view == nil {
                return Err("the card has no content view".into());
            }
            let (event, real) = drag_event(window);
            if event == nil {
                return Err("no mouse event to begin the drag with".into());
            }
            let in_window: NSPoint = msg_send![event, locationInWindow];
            let at: NSPoint = msg_send![view, convertPoint: in_window fromView: nil];

            let data: id = msg_send![class!(NSData), dataWithBytes: icon.as_ptr().cast::<c_void>() length: icon.len()];
            let image: id = msg_send![class!(NSImage), alloc];
            let image: id = msg_send![image, initWithData: data];
            let size = if image == nil {
                NSSize::new(FALLBACK_SIDE, FALLBACK_SIDE)
            } else {
                let _: id = msg_send![image, autorelease];
                msg_send![image, size]
            };
            let frame = NSRect::new(NSPoint::new(at.x - size.width / 2.0, at.y - size.height / 2.0), size);

            // A file URL of the capture itself: what Finder, chat apps and
            // browsers take from a file manager's drag.
            let path = NSString::alloc(nil).init_str(&file.to_string_lossy());
            let _: id = msg_send![path, autorelease];
            let url: id = msg_send![class!(NSURL), fileURLWithPath: path isDirectory: NO];
            if url == nil {
                return Err("the capture's path is not a file URL".into());
            }
            let item: id = msg_send![class!(NSDraggingItem), alloc];
            let item: id = msg_send![item, initWithPasteboardWriter: url];
            if item == nil {
                return Err("no dragging item for the file".into());
            }
            let _: id = msg_send![item, autorelease];
            let () = msg_send![item, setDraggingFrame: frame contents: image];
            let items: id = msg_send![class!(NSArray), arrayWithObject: item];

            let Some(class) = source_class() else {
                return Err("the drag source class could not be made".into());
            };
            let source: id = msg_send![class, new];
            let suspended = suspend(view);
            let session: id = msg_send![view, beginDraggingSessionWithItems: items event: event source: source];
            if session == nil {
                restore(&suspended);
                let () = msg_send![source, release];
                return Err("AppKit did not begin the drag".into());
            }
            // Slides back to the card only when nothing took the drop.
            let () = msg_send![session, setAnimatesToStartingPositionsOnCancelOrFail: YES];
            tracing::info!(event = if real { "the press" } else { "made up" }, "capture: card drag started");
            Ok((source, suspended))
        }
    }

    /// The mouse event to begin the session with, and whether it is real.
    /// The command runs on the main thread while the press is down, so
    /// AppKit's current event is usually that press (or its latest move) in
    /// this window: the event the window server knows the drag by. Only when
    /// it is not is one made up at the pointer.
    unsafe fn drag_event(window: id) -> (id, bool) {
        // SAFETY: main thread; `window` is live.
        unsafe {
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let current: id = msg_send![app, currentEvent];
            if current != nil {
                let kind: usize = msg_send![current, type];
                let of: id = msg_send![current, window];
                if is_press_or_move(kind) && of == window {
                    return (current, true);
                }
            }
            let location: NSPoint = msg_send![window, mouseLocationOutsideOfEventStream];
            let number: isize = msg_send![window, windowNumber];
            let info: id = msg_send![class!(NSProcessInfo), processInfo];
            let uptime: f64 = msg_send![info, systemUptime];
            let made: id = msg_send![class!(NSEvent), mouseEventWithType: LEFT_MOUSE_DRAGGED
                location: location
                modifierFlags: 0usize
                timestamp: uptime
                windowNumber: number
                context: nil
                eventNumber: 0isize
                clickCount: 1isize
                pressure: 1.0f32];
            (made, false)
        }
    }

    /// A left press or a move with it held: what AppKit begins a drag from.
    pub(super) fn is_press_or_move(kind: usize) -> bool {
        kind == LEFT_MOUSE_DOWN || kind == LEFT_MOUSE_DRAGGED
    }

    /// What the drag offers where the pointer is: nothing inside Hippius
    /// (the card's own web view would take any drop, and nothing in the app
    /// wants the card's file), a copy anywhere else.
    pub(super) fn operation(context: isize) -> usize {
        if context == WITHIN_APPLICATION { DRAG_NONE } else { DRAG_COPY }
    }

    /// The card's views stop taking drops, so the drag never lands on the
    /// card it came from. Each view and its types are retained until
    /// [`restore`]. Main thread only.
    unsafe fn suspend(root: id) -> Vec<(usize, usize)> {
        let mut saved = Vec::new();
        let mut stack = vec![root];
        // SAFETY: main thread; every view comes from a live view's subviews.
        unsafe {
            while let Some(view) = stack.pop() {
                let types: id = msg_send![view, registeredDraggedTypes];
                let count: usize = if types == nil { 0 } else { msg_send![types, count] };
                if count > 0 {
                    let types: id = msg_send![types, copy];
                    let _: id = msg_send![view, retain];
                    let () = msg_send![view, unregisterDraggedTypes];
                    saved.push((view as usize, types as usize));
                }
                let subviews: id = msg_send![view, subviews];
                let children: usize = if subviews == nil { 0 } else { msg_send![subviews, count] };
                for i in 0..children {
                    let child: id = msg_send![subviews, objectAtIndex: i];
                    stack.push(child);
                }
            }
        }
        saved
    }

    /// Give the views back the drop types [`suspend`] took. Main thread only.
    unsafe fn restore(saved: &[(usize, usize)]) {
        for &(view, types) in saved {
            let (view, types) = (view as id, types as id);
            // SAFETY: both were retained by `suspend` and are released here.
            unsafe {
                let () = msg_send![view, registerForDraggedTypes: types];
                let () = msg_send![types, release];
                let () = msg_send![view, release];
            }
        }
    }

    extern "C" fn source_operation_mask(_this: &Object, _cmd: Sel, _session: id, context: isize) -> usize {
        operation(context)
    }

    /// AppKit's word that the drag is over: the card's views take drops
    /// again, the outcome is logged and the card is told.
    extern "C" fn ended_at_point(this: &Object, _cmd: Sel, _session: id, _at: NSPoint, operation: usize) {
        let this_ptr = std::ptr::from_ref(this) as usize;
        let mine = {
            let mut guard = active();
            if guard.as_ref().is_some_and(|a| a.source == this_ptr) {
                guard.take()
            } else {
                None
            }
        };
        tracing::info!(result = outcome(operation), operation, "capture: card drag ended");
        if let Some(done) = mine {
            // SAFETY: AppKit calls this on the main thread; the views were
            // retained by `suspend`.
            unsafe { restore(&done.suspended) };
            // The card's own code (an event emit) must not unwind into AppKit.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (done.ended)())).is_err() {
                tracing::warn!("capture: telling the card its drag ended panicked");
            }
        }
        // The `new` from `begin`, released once AppKit is done with it.
        // SAFETY: autorelease, as this object's own method is running.
        unsafe {
            let _: id = msg_send![this, autorelease];
        }
    }

    /// The dragging source class, declared once.
    fn source_class() -> Option<&'static Class> {
        static CLASS: OnceLock<Option<usize>> = OnceLock::new();
        let ptr = (*CLASS.get_or_init(|| {
            if let Some(existing) = Class::get(SOURCE_CLASS) {
                return Some(std::ptr::from_ref(existing) as usize);
            }
            let mut decl = ClassDecl::new(SOURCE_CLASS, class!(NSObject))?;
            if let Some(protocol) = Protocol::get("NSDraggingSource") {
                decl.add_protocol(protocol);
            }
            // SAFETY: the selectors are NSDraggingSource's, with its
            // signatures (`NSDraggingContext` is an NSInteger, an
            // `NSDragOperation` an NSUInteger).
            unsafe {
                decl.add_method(
                    sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                    source_operation_mask as extern "C" fn(&Object, Sel, id, isize) -> usize,
                );
                decl.add_method(
                    sel!(draggingSession:endedAtPoint:operation:),
                    ended_at_point as extern "C" fn(&Object, Sel, id, NSPoint, usize),
                );
            }
            Some(std::ptr::from_ref(decl.register()) as usize)
        }))?;
        // SAFETY: a class registered with the runtime lives for the process.
        Some(unsafe { &*(ptr as *const Class) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_drag_hands_out_the_placed_file_else_the_kept_copy() {
        let dir = tempfile::TempDir::new().unwrap();
        let placed = dir.path().join("in-drive.png");
        let kept = dir.path().join("kept.png");
        std::fs::write(&kept, b"kept").unwrap();
        assert_eq!(file_to_drag(Some(&placed), &kept), Some(kept.clone()), "a placed path not there yet");
        std::fs::write(&placed, b"placed").unwrap();
        assert_eq!(file_to_drag(Some(&placed), &kept), Some(placed.clone()));
        assert_eq!(file_to_drag(None, &kept), Some(kept.clone()));
        std::fs::remove_file(&kept).unwrap();
        assert_eq!(file_to_drag(None, &kept), None, "nothing on this computer to drag");
    }

    #[test]
    fn the_drag_picture_is_a_small_png_of_the_thumbnail() {
        let big = image::RgbImage::from_pixel(560, 315, image::Rgb([10, 20, 30]));
        let url = super::super::thumbnail::from_image(&image::DynamicImage::ImageRgb8(big)).unwrap();
        let icon = image::load_from_memory(&drag_icon(Some(&url))).unwrap();
        assert_eq!((icon.width(), icon.height()), (ICON_SIDE, 90), "fits the side, keeps the shape");
        assert_eq!(&drag_icon(Some(&url))[..4], b"\x89PNG");
    }

    #[test]
    fn the_log_says_whether_the_drag_was_dropped() {
        assert_eq!(outcome(0), "cancelled", "NSDragOperationNone: refused or cancelled");
        assert_eq!(outcome(1), "dropped");
        assert_eq!(outcome(16), "dropped");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_drag_offers_a_copy_to_other_apps_and_nothing_inside_hippius() {
        assert_eq!(mac::operation(1), 0, "within Hippius, the card's own web view included");
        assert_eq!(mac::operation(0), 1, "outside: a copy");
        assert!(mac::is_press_or_move(1) && mac::is_press_or_move(6));
        assert!(!mac::is_press_or_move(5), "a move without the button is no drag");
        assert!(!mac::is_press_or_move(2), "nor is the button coming up");
    }

    #[test]
    fn a_card_without_a_readable_picture_drags_the_app_icon() {
        assert_eq!(drag_icon(None), FALLBACK_ICON);
        assert_eq!(drag_icon(Some("data:image/jpeg;base64,not base64")), FALLBACK_ICON);
        assert!(image::load_from_memory(FALLBACK_ICON).is_ok());
    }
}
