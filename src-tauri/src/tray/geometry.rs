//! Pure anchoring math for the tray panel popover.
//!
//! This module deliberately depends on **no** Tauri or OS types — it works on
//! plain integer rectangles in physical-pixel screen coordinates. Keeping it
//! free of `AppHandle`/`Monitor` makes the placement decision (which edge the
//! panel drops from, how it is clamped on-screen) exhaustively unit-testable
//! without a running Tauri event loop or a real display attached.
//!
//! The one rule the rest of the app relies on: the returned position always
//! keeps the panel fully inside `work_area` (the monitor region excluding the
//! menu bar / taskbar), so the popover can never render partly off-screen.

/// A rectangle in physical pixels, in the global multi-monitor coordinate
/// space (so `x`/`y` may be negative for monitors left of / above the primary).
///
/// `i32` rather than `u32` precisely because secondary monitors can sit at
/// negative origins; using an unsigned type here would silently wrap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    /// X coordinate of the rectangle's horizontal midpoint.
    fn center_x(&self) -> i32 {
        self.x + self.width / 2
    }

    /// Y coordinate of the rectangle's vertical midpoint.
    fn center_y(&self) -> i32 {
        self.y + self.height / 2
    }

    /// Y coordinate just past the bottom edge.
    fn bottom(&self) -> i32 {
        self.y + self.height
    }

    /// X coordinate just past the right edge.
    fn right(&self) -> i32 {
        self.x + self.width
    }
}

/// Compute the top-left physical position for the tray panel.
///
/// The vertical side is chosen from geometry, never hardcoded per-OS: if the
/// tray icon sits in the **top** half of its monitor's work area (the macOS
/// menu bar, or a Windows taskbar docked to the top) the panel drops **below**
/// the icon; otherwise (a bottom-docked Windows taskbar) it rises **above**.
/// A user who relocates their taskbar is therefore handled for free. When the
/// preferred side has no room, the panel flips to the side that fits.
///
/// Horizontally the panel is centred on the icon, then both axes are clamped
/// into `work_area` (inset by `margin`) so the popover is always fully visible.
/// `gap` is the breathing room left between the icon and the panel edge.
///
/// All inputs and the returned `(x, y)` are physical pixels in the same global
/// coordinate space as `work_area`.
#[must_use]
pub fn compute_panel_position(icon: Rect, panel_width: i32, panel_height: i32, work_area: Rect, gap: i32, margin: i32) -> (i32, i32) {
    // Drop below when the icon is in the top half of the work area, else rise
    // above. This is the only place the menu-bar-vs-taskbar distinction lives.
    let prefer_below = icon.center_y() <= work_area.center_y();

    let below_y = icon.bottom() + gap;
    let above_y = icon.y - gap - panel_height;
    let fits_below = below_y + panel_height <= work_area.bottom();
    let fits_above = above_y >= work_area.y;

    // Honour the preferred side, but flip to the other side when the preferred
    // one cannot fit the whole panel (e.g. a short monitor). If neither fits,
    // fall back to the preferred side and let the clamp below do its best.
    let y = if prefer_below {
        if fits_below || !fits_above { below_y } else { above_y }
    } else if fits_above || !fits_below {
        above_y
    } else {
        below_y
    };

    let raw_x = icon.center_x() - panel_width / 2;

    // Clamp into the work area, inset by `margin`. `hi.max(lo)` guards the
    // degenerate case where the panel is wider/taller than the work area:
    // without it `clamp` would panic on `lo > hi`.
    let lo_x = work_area.x + margin;
    let hi_x = (work_area.right() - panel_width - margin).max(lo_x);
    let x = raw_x.clamp(lo_x, hi_x);

    let lo_y = work_area.y + margin;
    let hi_y = (work_area.bottom() - panel_height - margin).max(lo_y);
    let y = y.clamp(lo_y, hi_y);

    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A typical 2560x1440 primary monitor with a 24px-tall macOS menu bar
    // already excluded from the work area.
    const MAC_WORK_AREA: Rect = Rect {
        x: 0,
        y: 24,
        width: 2560,
        height: 1416,
    };
    const PANEL_W: i32 = 380;
    const PANEL_H: i32 = 600;
    const GAP: i32 = 8;
    const MARGIN: i32 = 8;

    #[test]
    fn mac_top_icon_anchors_below() {
        // Tray icon in the menu bar near the top edge.
        let icon = Rect {
            x: 1200,
            y: 2,
            width: 24,
            height: 22,
        };
        let (_, y) = compute_panel_position(icon, PANEL_W, PANEL_H, MAC_WORK_AREA, GAP, MARGIN);
        // Below: just under the icon's bottom edge plus the gap.
        assert_eq!(y, icon.bottom() + GAP);
    }

    #[test]
    fn mac_icon_centers_horizontally_under_icon() {
        let icon = Rect {
            x: 1200,
            y: 2,
            width: 24,
            height: 22,
        };
        let (x, _) = compute_panel_position(icon, PANEL_W, PANEL_H, MAC_WORK_AREA, GAP, MARGIN);
        // Centre of icon is 1212; panel left = 1212 - 190 = 1022.
        assert_eq!(x, 1212 - PANEL_W / 2);
    }

    #[test]
    fn windows_bottom_icon_anchors_above() {
        // Windows taskbar docked at the bottom: work area excludes the 48px bar,
        // and the tray icon physically sits inside the taskbar (below work area).
        let work = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
        };
        let icon = Rect {
            x: 1850,
            y: 1040,
            width: 24,
            height: 24,
        };
        let (_, y) = compute_panel_position(icon, PANEL_W, PANEL_H, work, GAP, MARGIN);
        // Above means the panel bottom is at or above the icon top; clamped to
        // stay inside the work area.
        assert!(y + PANEL_H <= work.height, "panel must stay within work area: y={y}");
        assert!(y < icon.y, "panel must sit above the icon: y={y}, icon.y={}", icon.y);
    }

    #[test]
    fn left_edge_icon_clamps_to_margin() {
        // Icon hugging the left edge would push the centred panel off-screen.
        let icon = Rect {
            x: 4,
            y: 2,
            width: 24,
            height: 22,
        };
        let (x, _) = compute_panel_position(icon, PANEL_W, PANEL_H, MAC_WORK_AREA, GAP, MARGIN);
        assert_eq!(x, MAC_WORK_AREA.x + MARGIN);
    }

    #[test]
    fn right_edge_icon_clamps_to_margin() {
        let icon = Rect {
            x: 2550,
            y: 2,
            width: 24,
            height: 22,
        };
        let (x, _) = compute_panel_position(icon, PANEL_W, PANEL_H, MAC_WORK_AREA, GAP, MARGIN);
        assert_eq!(x, MAC_WORK_AREA.right() - PANEL_W - MARGIN);
    }

    #[test]
    fn secondary_monitor_position_stays_on_that_monitor() {
        // A second monitor to the right of the primary, origin at x=2560.
        let work = Rect {
            x: 2560,
            y: 24,
            width: 1920,
            height: 1056,
        };
        let icon = Rect {
            x: 3000,
            y: 2,
            width: 24,
            height: 22,
        };
        let (x, y) = compute_panel_position(icon, PANEL_W, PANEL_H, work, GAP, MARGIN);
        assert!(x >= work.x + MARGIN, "x must be on the secondary monitor: {x}");
        assert!(x + PANEL_W <= work.right() - MARGIN, "x must stay within the secondary monitor: {x}");
        assert!(y >= work.y + MARGIN, "y must be on the secondary monitor: {y}");
    }

    #[test]
    fn panel_larger_than_work_area_does_not_panic() {
        // Degenerate: panel bigger than the whole work area. Must clamp to the
        // top-left inset without panicking on an inverted clamp range.
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 200,
            height: 200,
        };
        let icon = Rect {
            x: 100,
            y: 0,
            width: 24,
            height: 24,
        };
        let (x, y) = compute_panel_position(icon, PANEL_W, PANEL_H, tiny, GAP, MARGIN);
        assert_eq!((x, y), (tiny.x + MARGIN, tiny.y + MARGIN));
    }
}
