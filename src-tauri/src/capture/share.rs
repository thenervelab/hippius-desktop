//! "Choose what to share": the picker the capture bar opens for Window and
//! Entire Screen, Chrome's and Loom's way of choosing, with a live picture of
//! every window and every display.
//!
//! This module decides what the picker lists (which windows count, in what
//! order, what each is called) and makes the pictures; `commands.rs` runs it
//! and the overlay only draws the result. Choosing an item goes through the
//! same `capture_select` as clicking a window on the overlay.
//!
//! **Speed.** The list comes back at once; the pictures follow. Each window
//! picture is a real capture, a few tens of milliseconds apiece, so whatever
//! is ready within [`INLINE_BUDGET`] rides along with the list and the rest
//! streams in as [`ShareArt`] batches. The pictures are then refreshed every
//! [`REFRESH_EVERY`] while the picker stays open, so they are live.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::geometry::LogicalRect;
use super::targets::{DisplayTarget, NativeFrame, window_rect_on_display};

/// A picture's box in the picker, in pixels: sharp on a Retina display at the
/// tile's size, small enough to send over IPC.
pub const THUMB_WIDTH: u32 = 480;
pub const THUMB_HEIGHT: u32 = 300;
/// An app icon's side, in pixels.
pub const ICON_SIDE: u32 = 64;
/// Pictures ready this soon come back with the list; later ones stream.
pub const INLINE_BUDGET: Duration = Duration::from_millis(300);
/// How often the pictures are taken again while the picker is open.
pub const REFRESH_EVERY: Duration = Duration::from_secs(3);
/// A picker left open this long stops refreshing (the list stays).
pub const MAX_REFRESHES: u32 = 100;

/// Smaller than this on screen (in points) is a palette, a tooltip or a
/// helper window, not something a person means to share.
const MIN_SHARE_WIDTH: f64 = 80.0;
const MIN_SHARE_HEIGHT: f64 = 60.0;

/// macOS and Windows surfaces that list themselves as windows but are not
/// ones anyone shares: the menu bar and its extras, the Dock, the desktop
/// picture, notification banners, Stage Manager, the login and lock screens.
const HIDDEN_OWNERS: &[&str] = &[
    "Window Server",
    "Dock",
    "Control Center",
    "Control Centre",
    "Notification Center",
    "Notification Centre",
    "SystemUIServer",
    "Wallpaper",
    "WindowManager",
    "Spotlight",
    "TextInputMenuAgent",
    "TextInputSwitcher",
    "loginwindow",
    "CursorUIViewService",
    "Screenshot",
    "universalcontrol",
    "Program Manager",
    "Windows Input Experience",
];

/// The picker's two tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareTab {
    Window,
    Screen,
}

/// A window as the system lists it, before the picker decides about it.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowCandidate {
    pub id: u32,
    pub pid: u32,
    pub app_name: String,
    pub title: String,
    /// In xcap's native space, like [`DisplayTarget`].
    pub frame: NativeFrame,
}

/// A window the picker offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareWindow {
    /// What `capture_select` takes as `windowId`.
    pub id: u32,
    pub app_name: String,
    pub title: String,
    /// The display most of it is on.
    pub display_id: u32,
    /// Its size on screen, in points, for the tile's shape before the
    /// picture arrives.
    pub width: f64,
    pub height: f64,
    pub thumbnail: Option<String>,
    pub icon: Option<String>,
    #[serde(skip)]
    pub pid: u32,
}

/// A display the picker offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDisplay {
    /// What `capture_select` takes as `displayId`.
    pub id: u32,
    pub name: String,
    pub is_primary: bool,
    pub width: f64,
    pub height: f64,
    pub thumbnail: Option<String>,
}

/// What `capture_share_targets` answers with.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTargets {
    /// Tags this picker's pictures; a batch with another token is stale.
    pub token: u64,
    pub windows: Vec<ShareWindow>,
    pub displays: Vec<ShareDisplay>,
    /// More pictures are on their way as [`ShareArt`] batches.
    pub pending: bool,
}

/// One picture (and, for a window, its app's icon) for one item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareArtItem {
    pub tab: ShareTab,
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A batch of pictures, broadcast as `capture_share_art`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareArt {
    pub token: u64,
    pub items: Vec<ShareArtItem>,
}

/// Where a candidate sits: the display holding most of it, and how much of it
/// is there. `None` when no part of it is on any display.
fn placement(frame: NativeFrame, displays: &[DisplayTarget]) -> Option<(u32, LogicalRect)> {
    displays
        .iter()
        .filter_map(|d| window_rect_on_display(frame, d).map(|r| (d.id, r)))
        .max_by(|a, b| (a.1.width * a.1.height).total_cmp(&(b.1.width * b.1.height)))
}

/// Whether the picker offers this window, and on which display.
///
/// Out: Hippius's own windows (the overlays, the camera, the pill and the
/// app itself), windows with no title (helper and drag windows, which a
/// person cannot recognise anyway), system chrome, windows wholly off screen,
/// and slivers smaller than [`MIN_SHARE_WIDTH`] × [`MIN_SHARE_HEIGHT`] points,
/// which is where menu-bar items land.
#[must_use]
pub fn shareable_on(candidate: &WindowCandidate, own_pid: u32, displays: &[DisplayTarget]) -> Option<(u32, LogicalRect)> {
    if candidate.pid == own_pid || candidate.title.trim().is_empty() || HIDDEN_OWNERS.contains(&candidate.app_name.trim()) {
        return None;
    }
    let (display_id, rect) = placement(candidate.frame, displays)?;
    (rect.width >= MIN_SHARE_WIDTH && rect.height >= MIN_SHARE_HEIGHT).then_some((display_id, rect))
}

/// The windows the picker lists, front first (the order the system reports,
/// so the window the user was just in leads).
#[must_use]
pub fn share_windows(candidates: Vec<WindowCandidate>, own_pid: u32, displays: &[DisplayTarget]) -> Vec<ShareWindow> {
    candidates
        .into_iter()
        .filter_map(|c| {
            let (display_id, rect) = shareable_on(&c, own_pid, displays)?;
            Some(ShareWindow {
                id: c.id,
                app_name: c.app_name.trim().to_string(),
                title: c.title.trim().to_string(),
                display_id,
                width: rect.width,
                height: rect.height,
                thumbnail: None,
                icon: None,
                pid: c.pid,
            })
        })
        .collect()
}

/// The displays the picker lists: the main display first, each named, with a
/// number for one the system gives no name.
#[must_use]
pub fn share_displays(displays: &[DisplayTarget]) -> Vec<ShareDisplay> {
    let mut out: Vec<ShareDisplay> = displays
        .iter()
        .enumerate()
        .map(|(i, d)| ShareDisplay {
            id: d.id,
            name: if d.name.trim().is_empty() {
                format!("Display {}", i + 1)
            } else {
                d.name.trim().to_string()
            },
            is_primary: d.is_primary,
            width: d.logical_width(),
            height: d.logical_height(),
            thumbnail: None,
        })
        .collect();
    out.sort_by_key(|d| !d.is_primary);
    out
}

/// The order pictures are taken in: the tab the picker opened on first, so
/// the grid in front of the user fills before the one behind the other tab.
#[must_use]
pub fn art_order(first: ShareTab, windows: &[ShareWindow], displays: &[ShareDisplay]) -> Vec<(ShareTab, u32)> {
    let w = windows.iter().map(|w| (ShareTab::Window, w.id));
    let d = displays.iter().map(|d| (ShareTab::Screen, d.id));
    match first {
        ShareTab::Window => w.chain(d).collect(),
        ShareTab::Screen => d.chain(w).collect(),
    }
}

/// Put a picture onto the listed item it belongs to.
pub fn apply_art(targets: &mut ShareTargets, item: ShareArtItem) {
    match item.tab {
        ShareTab::Window => {
            if let Some(w) = targets.windows.iter_mut().find(|w| w.id == item.id) {
                if item.thumbnail.is_some() {
                    w.thumbnail = item.thumbnail;
                }
                if item.icon.is_some() {
                    w.icon = item.icon;
                }
            }
        }
        ShareTab::Screen => {
            if let Some(d) = targets.displays.iter_mut().find(|d| d.id == item.id)
                && item.thumbnail.is_some()
            {
                d.thumbnail = item.thumbnail;
            }
        }
    }
}

/// What the picture-taking thread reports, in order: the list once, then
/// pictures, then (after the first full pass) that the rest is refreshes.
#[derive(Debug)]
pub enum ShareMessage {
    List(crate::error::Result<(Vec<ShareWindow>, Vec<ShareDisplay>)>),
    Art(ShareArtItem),
    FirstPassDone,
}

/// App icons by process id, as PNG `data:` URLs. Asked of the caller because
/// on macOS they come from AppKit, on the main thread.
pub type IconSource = Box<dyn Fn(&[u32]) -> HashMap<u32, String> + Send>;

#[cfg(any(target_os = "macos", windows))]
mod os {
    use super::{
        IconSource, MAX_REFRESHES, REFRESH_EVERY, ShareMessage, ShareTab, THUMB_HEIGHT, THUMB_WIDTH, WindowCandidate, art_order, share_displays,
        share_windows,
    };
    use crate::capture::targets::{NativeFrame, list_displays};
    use crate::error::AppError;

    /// Run the picker's picture taking on the current (blocking) thread:
    /// list, then take every picture, then take them again every
    /// [`REFRESH_EVERY`] until `keep_going` says the picker has closed.
    pub fn run(first: ShareTab, own_pid: u32, icons: &IconSource, keep_going: &dyn Fn() -> bool, send: &dyn Fn(ShareMessage) -> bool) {
        let listed = (|| -> crate::error::Result<_> {
            let displays = list_displays()?;
            let windows = xcap::Window::all().map_err(|e| AppError::Other(format!("Could not list windows: {e}")))?;
            // Every xcap getter re-reads the system's whole window list, so
            // the cheap refusals (too small, untitled) come before the other
            // getters: most listed windows are helpers that fail one of them.
            // Minimised windows are not in the on-screen list at all.
            let mut handles = std::collections::HashMap::new();
            let mut candidates = Vec::new();
            for w in windows {
                let (Ok(id), Ok(width), Ok(height)) = (w.id(), w.width(), w.height()) else {
                    continue;
                };
                // Native units: points on macOS, pixels (never fewer than
                // points) on Windows, so this never drops a window that
                // `shareable_on` would keep.
                if f64::from(width) < super::MIN_SHARE_WIDTH || f64::from(height) < super::MIN_SHARE_HEIGHT {
                    continue;
                }
                let title = w.title().unwrap_or_default();
                if title.trim().is_empty() {
                    continue;
                }
                let (Ok(x), Ok(y)) = (w.x(), w.y()) else { continue };
                candidates.push(WindowCandidate {
                    id,
                    pid: w.pid().unwrap_or_default(),
                    app_name: w.app_name().unwrap_or_default(),
                    title,
                    frame: NativeFrame { x, y, width, height },
                });
                handles.insert(id, w);
            }
            let monitors = xcap::Monitor::all().map_err(|e| AppError::Other(format!("Could not list displays: {e}")))?;
            Ok((
                share_windows(candidates, own_pid, &displays),
                share_displays(&displays),
                handles,
                monitors,
            ))
        })();
        let (windows, displays, handles, monitors) = match listed {
            Ok(v) => v,
            Err(e) => {
                send(ShareMessage::List(Err(e)));
                return;
            }
        };
        let order = art_order(first, &windows, &displays);
        let pids: Vec<u32> = windows.iter().map(|w| w.pid).collect();
        let pid_of: std::collections::HashMap<u32, u32> = windows.iter().map(|w| (w.id, w.pid)).collect();
        if !send(ShareMessage::List(Ok((windows, displays)))) {
            return;
        }

        let icon_by_pid = icons(&pids);
        for pass in 0..=MAX_REFRESHES {
            for &(tab, id) in &order {
                if !keep_going() {
                    return;
                }
                let image = match tab {
                    ShareTab::Window => handles.get(&id).and_then(|w| w.capture_image().ok()),
                    ShareTab::Screen => monitors
                        .iter()
                        .find(|m| m.id().is_ok_and(|m| m == id))
                        .and_then(|m| m.capture_image().ok()),
                };
                let thumbnail = image.and_then(|img| crate::capture::thumbnail::fit_data_url(&img, THUMB_WIDTH, THUMB_HEIGHT).ok());
                // Each window's icon goes once, with its first picture; the
                // refreshes carry pictures only.
                let icon = if pass == 0 && tab == ShareTab::Window {
                    pid_of.get(&id).and_then(|pid| icon_by_pid.get(pid).cloned())
                } else {
                    None
                };
                if (thumbnail.is_some() || icon.is_some()) && !send(ShareMessage::Art(super::ShareArtItem { tab, id, thumbnail, icon })) {
                    return;
                }
            }
            if pass == 0 && !send(ShareMessage::FirstPassDone) {
                return;
            }
            let rest = std::time::Instant::now() + REFRESH_EVERY;
            while std::time::Instant::now() < rest {
                if !keep_going() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
pub use os::run;

/// The icon of each running app in `pids`, as PNG `data:` URLs. AppKit, so
/// call it on the main thread.
#[cfg(target_os = "macos")]
#[must_use]
pub fn macos_app_icons(pids: &[u32]) -> HashMap<u32, String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize};
    use objc::{class, msg_send, sel, sel_impl};

    let mut out = HashMap::new();
    // SAFETY: AppKit on the main thread (the caller's contract). Every object
    // is checked for nil before it is messaged; the one we alloc is released,
    // the rest are autoreleased into the pool drained below.
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        for &pid in pids {
            if out.contains_key(&pid) {
                continue;
            }
            let Ok(pid_t) = i32::try_from(pid) else { continue };
            let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid_t];
            if app == nil {
                continue;
            }
            let icon: id = msg_send![app, icon];
            if icon == nil {
                continue;
            }
            let side = f64::from(ICON_SIDE);
            let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side));
            let cg: *mut std::ffi::c_void = msg_send![icon, CGImageForProposedRect: &raw mut rect context: nil hints: nil];
            if cg.is_null() {
                continue;
            }
            let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: id = msg_send![rep, initWithCGImage: cg];
            if rep == nil {
                continue;
            }
            let props: id = msg_send![class!(NSDictionary), dictionary];
            // NSBitmapImageFileTypePNG.
            let png: id = msg_send![rep, representationUsingType: 4usize properties: props];
            if png != nil {
                let len: usize = msg_send![png, length];
                let bytes: *const u8 = msg_send![png, bytes];
                if !bytes.is_null() && len > 0 {
                    let encoded = std::slice::from_raw_parts(bytes, len);
                    if let Ok(url) = super::thumbnail::icon_data_url(encoded, ICON_SIDE) {
                        out.insert(pid, url);
                    }
                }
            }
            let () = msg_send![rep, release];
        }
        pool.drain();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: u32, x: i32, width: u32, height: u32, is_primary: bool) -> DisplayTarget {
        DisplayTarget {
            id,
            name: format!("Display {id}"),
            x,
            y: 0,
            width,
            height,
            scale_factor: 2.0,
            is_primary,
        }
    }

    fn window(id: u32, pid: u32, app: &str, title: &str, frame: (i32, i32, u32, u32)) -> WindowCandidate {
        WindowCandidate {
            id,
            pid,
            app_name: app.into(),
            title: title.into(),
            frame: NativeFrame {
                x: frame.0,
                y: frame.1,
                width: frame.2,
                height: frame.3,
            },
        }
    }

    const OWN: u32 = 99;

    fn screens() -> Vec<DisplayTarget> {
        vec![display(1, 0, 1512, 982, true), display(2, 1512, 1920, 1080, false)]
    }

    #[test]
    fn a_normal_window_is_offered_on_the_display_holding_most_of_it() {
        let offered = share_windows(
            vec![
                window(10, 1, "Safari", "Hippius", (100, 100, 1000, 700)),
                window(11, 2, "Notes", "Ideas", (1400, 50, 800, 600)),
            ],
            OWN,
            &screens(),
        );
        assert_eq!(offered.len(), 2);
        assert_eq!(offered[0].display_id, 1);
        assert_eq!(offered[1].display_id, 2, "most of Notes is on the second display");
        assert_eq!(offered[0].title, "Hippius");
    }

    /// The overlays, the camera and the pill are Hippius's own; offering them
    /// would let a user record the capture UI instead of their screen.
    #[test]
    fn hippius_windows_are_never_offered() {
        assert!(shareable_on(&window(1, OWN, "Hippius", "Hippius camera", (0, 0, 800, 600)), OWN, &screens()).is_none());
    }

    #[test]
    fn menu_bar_items_system_chrome_and_slivers_are_left_out() {
        let d = screens();
        // A menu-bar extra: owned by an app, titled, 24 points tall at the top.
        assert!(shareable_on(&window(1, 5, "Dropbox", "Item-0", (1200, 0, 30, 24)), OWN, &d).is_none());
        for owner in ["Dock", "Window Server", "Control Center", "Notification Center", "WindowManager"] {
            assert!(shareable_on(&window(2, 6, owner, "x", (0, 0, 800, 600)), OWN, &d).is_none(), "{owner}");
        }
        // A tall thin palette is not a window anyone shares either.
        assert!(shareable_on(&window(3, 7, "Figma", "Layers", (0, 0, 40, 600)), OWN, &d).is_none());
    }

    #[test]
    fn a_window_entirely_off_screen_is_left_out() {
        assert!(shareable_on(&window(1, 5, "Safari", "Away", (-5000, -5000, 800, 600)), OWN, &screens()).is_none());
    }

    /// A window mostly off the edge counts by what is still visible.
    #[test]
    fn only_the_visible_part_counts_towards_the_minimum() {
        let d = screens();
        assert!(shareable_on(&window(1, 5, "Safari", "Edge", (-750, 0, 800, 600)), OWN, &d).is_none());
        assert!(shareable_on(&window(1, 5, "Safari", "Edge", (-700, 0, 800, 600)), OWN, &d).is_some());
    }

    #[test]
    fn untitled_helper_windows_are_left_out() {
        assert!(shareable_on(&window(1, 5, "Electron", "", (0, 0, 800, 600)), OWN, &screens()).is_none());
        assert!(shareable_on(&window(1, 5, "Electron", "   ", (0, 0, 800, 600)), OWN, &screens()).is_none());
    }

    #[test]
    fn the_front_window_stays_first() {
        let offered = share_windows(
            vec![
                window(3, 1, "Xcode", "main.swift", (0, 0, 900, 700)),
                window(1, 2, "Mail", "Inbox", (0, 0, 900, 700)),
                window(2, 3, "Finder", "Downloads", (0, 0, 900, 700)),
            ],
            OWN,
            &screens(),
        );
        assert_eq!(offered.iter().map(|w| w.id).collect::<Vec<_>>(), [3, 1, 2]);
    }

    #[test]
    fn displays_list_the_main_one_first_and_name_the_nameless() {
        let mut d = screens();
        d.reverse();
        d[0].name = "  ".into();
        let listed = share_displays(&d);
        assert_eq!(listed[0].id, 1, "the main display leads");
        assert!(listed[0].is_primary);
        assert_eq!(listed[1].name, "Display 1", "numbered by the system's order");
    }

    #[test]
    fn the_tab_the_picker_opened_on_gets_its_pictures_first() {
        let windows = share_windows(vec![window(7, 1, "Mail", "Inbox", (0, 0, 900, 700))], OWN, &screens());
        let displays = share_displays(&screens());
        assert_eq!(
            art_order(ShareTab::Window, &windows, &displays),
            [(ShareTab::Window, 7), (ShareTab::Screen, 1), (ShareTab::Screen, 2)]
        );
        assert_eq!(art_order(ShareTab::Screen, &windows, &displays)[0], (ShareTab::Screen, 1));
    }

    #[test]
    fn a_picture_lands_on_its_own_item_and_an_icon_is_not_lost_to_a_refresh() {
        let mut targets = ShareTargets {
            token: 1,
            windows: share_windows(vec![window(7, 1, "Mail", "Inbox", (0, 0, 900, 700))], OWN, &screens()),
            displays: share_displays(&screens()),
            pending: true,
        };
        apply_art(
            &mut targets,
            ShareArtItem {
                tab: ShareTab::Window,
                id: 7,
                thumbnail: Some("data:a".into()),
                icon: Some("data:icon".into()),
            },
        );
        apply_art(
            &mut targets,
            ShareArtItem {
                tab: ShareTab::Window,
                id: 7,
                thumbnail: Some("data:b".into()),
                icon: None,
            },
        );
        assert_eq!(targets.windows[0].thumbnail.as_deref(), Some("data:b"));
        assert_eq!(targets.windows[0].icon.as_deref(), Some("data:icon"));
        apply_art(
            &mut targets,
            ShareArtItem {
                tab: ShareTab::Screen,
                id: 2,
                thumbnail: Some("data:s".into()),
                icon: None,
            },
        );
        assert_eq!(targets.displays[1].thumbnail.as_deref(), Some("data:s"));
        assert!(targets.displays[0].thumbnail.is_none());
    }

    /// The overlay reads these names; `pid` stays in Rust.
    #[test]
    fn the_wire_shape_is_camel_case_without_the_pid() {
        let w = &share_windows(vec![window(7, 1, "Mail", "Inbox", (0, 0, 900, 700))], OWN, &screens())[0];
        let v = serde_json::to_value(w).unwrap();
        assert_eq!(v["appName"], "Mail");
        assert_eq!(v["displayId"], 1);
        assert!(v.get("pid").is_none());
        let art = serde_json::to_value(ShareArtItem {
            tab: ShareTab::Screen,
            id: 2,
            thumbnail: None,
            icon: None,
        })
        .unwrap();
        assert_eq!(art, serde_json::json!({ "tab": "screen", "id": 2 }));
    }
}
