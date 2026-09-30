//! The displays and windows a capture can target, and where they sit.
//!
//! xcap reports geometry in the platform's own space: **points on macOS**
//! (`CGDisplayBounds`), **physical pixels on Windows**. The overlay is a
//! webview and thinks in CSS pixels, which are points on both. So every
//! value this module hands the overlay is converted to display-local points
//! here, and nothing downstream has to know which platform it is on.

use serde::Serialize;

use super::geometry::LogicalRect;

/// True where xcap's coordinates are already logical points.
pub const COORDS_ARE_LOGICAL: bool = cfg!(target_os = "macos");

/// A display, in xcap's native coordinate space.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayTarget {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

impl DisplayTarget {
    /// The display's width in logical points — the overlay's CSS width.
    pub fn logical_width(&self) -> f64 {
        to_logical_on(COORDS_ARE_LOGICAL, f64::from(self.width), self.scale_factor)
    }

    pub fn logical_height(&self) -> f64 {
        to_logical_on(COORDS_ARE_LOGICAL, f64::from(self.height), self.scale_factor)
    }
}

/// A window the user can pick, placed on one display in that display's
/// logical points — ready for the overlay to draw a highlight over.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTarget {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A window's frame in xcap's native space, before placing it on a display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NativeFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Windows smaller than this (in points, either side) are menu-bar items,
/// tooltips and invisible helper windows, not something anyone means to capture.
const MIN_PICKABLE_POINTS: f64 = 40.0;

/// System surfaces that report themselves as windows but are not ones a user
/// would pick. macOS lists the menu bar, Dock and Control Center this way.
const SYSTEM_OWNERS: &[&str] = &["Window Server", "Dock", "Control Center", "Notification Center", "SystemUIServer"];

/// Native units to logical points: unchanged where the platform is already
/// in points (macOS), divided by the display's OWN scale where it is in
/// physical pixels (Windows). Per display, never the primary's: in a mixed
/// setup (a 150 % laptop beside a 100 % monitor) each display has its own.
fn to_logical_on(coords_are_logical: bool, native: f64, scale_factor: f64) -> f64 {
    if coords_are_logical || scale_factor <= 0.0 {
        native
    } else {
        native / scale_factor
    }
}

/// Where `frame` sits on `display`, in the display's local logical points,
/// clipped to the display. `None` when no part of it is on this display.
pub fn window_rect_on_display(frame: NativeFrame, display: &DisplayTarget) -> Option<LogicalRect> {
    window_rect_on_display_on(COORDS_ARE_LOGICAL, frame, display)
}

/// [`window_rect_on_display`] with the platform's coordinate space passed
/// in, so the Windows (physical pixel) maths is tested on every OS.
fn window_rect_on_display_on(coords_are_logical: bool, frame: NativeFrame, display: &DisplayTarget) -> Option<LogicalRect> {
    let left = i64::from(frame.x).max(i64::from(display.x));
    let top = i64::from(frame.y).max(i64::from(display.y));
    let right = (i64::from(frame.x) + i64::from(frame.width)).min(i64::from(display.x) + i64::from(display.width));
    let bottom = (i64::from(frame.y) + i64::from(frame.height)).min(i64::from(display.y) + i64::from(display.height));
    if right <= left || bottom <= top {
        return None;
    }
    // Screen coordinates fit comfortably in f64; nothing here approaches 2^53.
    #[allow(clippy::cast_precision_loss)]
    let native = |v: i64| v as f64;
    let scale = display.scale_factor;
    let logical = |v: i64| to_logical_on(coords_are_logical, native(v), scale);
    Some(LogicalRect {
        x: logical(left - i64::from(display.x)),
        y: logical(top - i64::from(display.y)),
        width: logical(right - left),
        height: logical(bottom - top),
    })
}

/// Whether a listed window is one a user would mean to pick.
///
/// On Windows an untitled window is shell furniture, not an app window: xcap
/// keeps the taskbar (`Shell_TrayWnd`, untitled and taller than the minimum),
/// and it would highlight as pickable. macOS lists real app windows without
/// titles (some panels and players), so the rule is Windows-only there.
pub fn is_pickable(app_name: &str, title: &str, own_pid: bool, minimized: bool, rect: &LogicalRect) -> bool {
    is_pickable_on(UNTITLED_IS_CHROME, app_name, title, own_pid, minimized, rect)
}

/// Where an untitled window is never a pickable one.
const UNTITLED_IS_CHROME: bool = cfg!(windows);

fn is_pickable_on(untitled_is_chrome: bool, app_name: &str, title: &str, own_pid: bool, minimized: bool, rect: &LogicalRect) -> bool {
    let chrome = SYSTEM_OWNERS.contains(&app_name) || (untitled_is_chrome && title.trim().is_empty());
    let sliver = rect.width < MIN_PICKABLE_POINTS || rect.height < MIN_PICKABLE_POINTS;
    !(own_pid || minimized || chrome || sliver)
}

#[cfg(any(target_os = "macos", windows))]
mod os {
    use super::{DisplayTarget, NativeFrame, WindowTarget, is_pickable, window_rect_on_display};
    use crate::error::{AppError, Result};

    fn xcap_err(context: &str, e: &xcap::XCapError) -> AppError {
        AppError::Other(format!("{context}: {e}"))
    }

    pub fn list_displays() -> Result<Vec<DisplayTarget>> {
        let monitors = xcap::Monitor::all().map_err(|e| xcap_err("Could not list displays", &e))?;
        let mut out = Vec::with_capacity(monitors.len());
        for m in monitors {
            out.push(DisplayTarget {
                id: m.id().map_err(|e| xcap_err("display id", &e))?,
                name: m.friendly_name().or_else(|_| m.name()).unwrap_or_default(),
                x: m.x().map_err(|e| xcap_err("display x", &e))?,
                y: m.y().map_err(|e| xcap_err("display y", &e))?,
                width: m.width().map_err(|e| xcap_err("display width", &e))?,
                height: m.height().map_err(|e| xcap_err("display height", &e))?,
                scale_factor: f64::from(m.scale_factor().unwrap_or(1.0)),
                is_primary: m.is_primary().unwrap_or(false),
            });
        }
        Ok(out)
    }

    /// The pickable windows on `display`, FRONT FIRST — the order
    /// `xcap::Window::all` already returns on both platforms
    /// (`CGWindowListCopyWindowInfo` and `EnumWindows` both walk top-down).
    /// The overlay highlights the first one under the cursor, so the order is
    /// the whole of what makes the topmost window win.
    pub fn windows_on_display(display: &DisplayTarget) -> Result<Vec<WindowTarget>> {
        let own = std::process::id();
        let windows = xcap::Window::all().map_err(|e| xcap_err("Could not list windows", &e))?;
        let mut out = Vec::new();
        for w in windows {
            let (Ok(id), Ok(x), Ok(y), Ok(width), Ok(height)) = (w.id(), w.x(), w.y(), w.width(), w.height()) else {
                continue;
            };
            let Some(rect) = window_rect_on_display(NativeFrame { x, y, width, height }, display) else {
                continue;
            };
            let app_name = w.app_name().unwrap_or_default();
            let title = w.title().unwrap_or_default();
            let own_pid = w.pid().is_ok_and(|pid| pid == own);
            let minimized = w.is_minimized().unwrap_or(false);
            if !is_pickable(&app_name, &title, own_pid, minimized, &rect) {
                continue;
            }
            out.push(WindowTarget {
                id,
                app_name,
                title,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
        }
        Ok(out)
    }
}

#[cfg(any(target_os = "macos", windows))]
pub use os::{list_displays, windows_on_display};

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> DisplayTarget {
        DisplayTarget {
            id: 1,
            name: "Test".into(),
            x,
            y,
            width,
            height,
            scale_factor,
            is_primary: true,
        }
    }

    fn frame(x: i32, y: i32, width: u32, height: u32) -> NativeFrame {
        NativeFrame { x, y, width, height }
    }

    #[test]
    fn a_window_wholly_on_a_display_keeps_its_size() {
        let rect = window_rect_on_display(frame(100, 50, 800, 600), &display(0, 0, 1920, 1080, 1.0)).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (100.0, 50.0, 800.0, 600.0));
    }

    /// A second display to the LEFT of the primary has a negative origin; the
    /// overlay still needs its windows relative to its own top-left.
    #[test]
    fn a_display_left_of_the_primary_places_windows_locally() {
        let rect = window_rect_on_display(frame(-1500, 100, 400, 300), &display(-1920, 0, 1920, 1080, 1.0)).unwrap();
        assert_eq!((rect.x, rect.y), (420.0, 100.0));
    }

    #[test]
    fn a_window_straddling_two_displays_is_clipped_to_each() {
        let left = display(0, 0, 1920, 1080, 1.0);
        let right = display(1920, 0, 1920, 1080, 1.0);
        let straddling = frame(1800, 0, 400, 300);
        let on_left = window_rect_on_display(straddling, &left).unwrap();
        let on_right = window_rect_on_display(straddling, &right).unwrap();
        assert_eq!((on_left.x, on_left.width), (1800.0, 120.0));
        assert_eq!((on_right.x, on_right.width), (0.0, 280.0));
    }

    #[test]
    fn a_window_on_another_display_is_not_on_this_one() {
        assert_eq!(window_rect_on_display(frame(3000, 0, 400, 300), &display(0, 0, 1920, 1080, 1.0)), None);
    }

    /// Windows reports physical pixels; the overlay draws in points. On
    /// macOS xcap is already in points, so the same numbers pass through.
    #[test]
    fn native_coordinates_become_logical_points() {
        let rect = window_rect_on_display(frame(200, 100, 800, 600), &display(0, 0, 3840, 2160, 2.0)).unwrap();
        if COORDS_ARE_LOGICAL {
            assert_eq!((rect.x, rect.width), (200.0, 800.0));
        } else {
            assert_eq!((rect.x, rect.width), (100.0, 400.0));
        }
    }

    // ── Windows: physical pixels, a scale per display ──────────────────────

    /// A 150 % laptop (2880 x 1800 physical, 1920 x 1200 points) left of a
    /// 100 % monitor. Windows reports both in physical pixels, each monitor
    /// at its own origin; the overlay on each draws in its own points.
    #[test]
    fn a_mixed_dpi_pair_places_windows_in_each_displays_own_points() {
        let laptop = display(0, 0, 2880, 1800, 1.5);
        let monitor = display(2880, 0, 1920, 1080, 1.0);
        let on_laptop = window_rect_on_display_on(false, frame(300, 150, 1500, 900), &laptop).unwrap();
        assert_eq!(
            (on_laptop.x, on_laptop.y, on_laptop.width, on_laptop.height),
            (200.0, 100.0, 1000.0, 600.0)
        );
        let on_monitor = window_rect_on_display_on(false, frame(3080, 100, 800, 600), &monitor).unwrap();
        assert_eq!(
            (on_monitor.x, on_monitor.y, on_monitor.width, on_monitor.height),
            (200.0, 100.0, 800.0, 600.0)
        );
        assert!((laptop.scale_factor - 1.5).abs() < f64::EPSILON);
    }

    /// The reverse: a 100 % monitor on the left, the 150 % laptop to its
    /// right. A window straddling the seam is clipped to each and each part
    /// is divided by its own display's scale.
    #[test]
    fn a_window_straddling_a_mixed_dpi_seam_is_scaled_per_side() {
        let monitor = display(0, 0, 1920, 1080, 1.0);
        let laptop = display(1920, 0, 2880, 1800, 1.5);
        let straddling = frame(1620, 60, 900, 600);
        let left = window_rect_on_display_on(false, straddling, &monitor).unwrap();
        let right = window_rect_on_display_on(false, straddling, &laptop).unwrap();
        assert_eq!((left.x, left.width), (1620.0, 300.0));
        assert_eq!((right.x, right.y, right.width, right.height), (0.0, 40.0, 400.0, 400.0));
    }

    /// A monitor ABOVE the primary has a negative y; windows on it are still
    /// placed from its own top-left.
    #[test]
    fn a_display_above_the_primary_places_windows_locally() {
        let above = display(-320, -1440, 2560, 1440, 1.25);
        let rect = window_rect_on_display_on(false, frame(-70, -1190, 1000, 500), &above).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (200.0, 200.0, 800.0, 400.0));
    }

    /// The overlay's CSS size on Windows is the display's physical size over
    /// its own scale, which is the unit the area crop is read back in.
    #[test]
    fn a_displays_logical_size_is_its_pixels_over_its_own_scale() {
        assert!((to_logical_on(false, 2880.0, 1.5) - 1920.0).abs() < f64::EPSILON);
        assert!((to_logical_on(false, 3000.0, 1.25) - 2400.0).abs() < f64::EPSILON);
        assert!(
            (to_logical_on(true, 1512.0, 2.0) - 1512.0).abs() < f64::EPSILON,
            "macOS is already in points"
        );
        assert!((to_logical_on(false, 1920.0, 0.0) - 1920.0).abs() < f64::EPSILON, "a missing scale is 1");
    }

    #[test]
    fn our_own_windows_and_system_chrome_are_not_pickable() {
        let big = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(is_pickable("Safari", "Start Page", false, false, &big));
        assert!(
            !is_pickable("Hippius", "Hippius", true, false, &big),
            "the overlay must never offer to capture itself"
        );
        assert!(!is_pickable("Safari", "Start Page", false, true, &big));
        assert!(!is_pickable("Dock", "Dock", false, false, &big));
        assert!(!is_pickable("Window Server", "Menubar", false, false, &big));
    }

    /// The Windows taskbar is an untitled window taller than the minimum;
    /// macOS has real untitled app windows, which stay pickable.
    #[test]
    fn an_untitled_window_is_shell_chrome_on_windows_only() {
        let taskbar = LogicalRect {
            x: 0.0,
            y: 1032.0,
            width: 1920.0,
            height: 48.0,
        };
        assert!(!is_pickable_on(true, "Windows Explorer", "", false, false, &taskbar));
        assert!(!is_pickable_on(true, "Windows Explorer", "  ", false, false, &taskbar));
        assert!(is_pickable_on(true, "Notepad", "notes.txt", false, false, &taskbar));
        assert!(is_pickable_on(false, "QuickTime Player", "", false, false, &taskbar));
    }

    #[test]
    fn slivers_are_not_pickable() {
        let sliver = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 22.0,
        };
        assert!(!is_pickable("Safari", "Start Page", false, false, &sliver));
    }
}
