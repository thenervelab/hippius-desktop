//! Hover on the recording pill, decided from where the pointer is, and the
//! pill's tooltips, drawn in a window of their own. Pure decisions, tested on
//! every OS; `commands.rs` reads the pointer, places the windows and shows
//! them.
//!
//! **Why hover comes from Rust.** The pill is never the key window: it must
//! not take the keyboard from the app being recorded. WebKit on macOS turns
//! mouse moves into DOM hover only for the key window (its tracking area is
//! active in the key window only, wherever scroll bars overlay content), so
//! the pill's buttons never saw the pointer: no hover, and their native
//! `title` tooltips never showed. The pill's watch reads the pointer itself
//! (`NSEvent.mouseLocation` on macOS, the cursor on Windows), and while it is
//! on the pill's row tells the page where ([`pointer_on_row`]); the page
//! finds the button under it. Windows delivers hover to an unfocused window,
//! but uses the same path, so both platforms show the same tooltip at once.
//!
//! **Why the tooltip has its own window.** The pill's window is the pill's
//! height (`CONTROLS_HEIGHT`), so a tooltip above a button would be cut off
//! by its edge; growing the window for a tooltip would move the pill on
//! Windows (its page grows with the window) and leave a transparent band
//! taking clicks from the app under it. So the tooltip is drawn in
//! `capture-pill-tip`, a window in the room just above the pill (below it
//! near the top of the usable area, [`tip_frame`]). It never covers the
//! pill's glass, so it can never take a click meant for a button, and it is
//! up only while the pointer is on the pill, so it never takes one meant for
//! the app under it either; on macOS it also ignores the mouse. It is left
//! out of the recording like the pill: the macOS helper leaves out every
//! Hippius window it is not told to film, and Windows protects it
//! (`own_windows::content_protected`).
//!
//! **Linux has none** ([`supported`]): the pill is filmed there, and a
//! tooltip would be in the video with it. The buttons keep their names for
//! screen readers.

use serde::{Deserialize, Serialize};

use super::bubble_controls::moved;
use super::camera::Frame;
use super::live_controls::pill_without_menu;
use super::rollout::Platform;
use super::support::pill_filmed;

/// The tooltip window's height, in points: two lines of the tooltip (46 pt)
/// and the gap between it and the pill.
pub const TIP_ROOM: f64 = 56.0;

/// The transparent band between the pill window's edge and the pill's glass,
/// in points (the 60 pt row holds the 42 pt pill in its middle). The tooltip
/// window may lie over it, never over the glass.
pub const ROW_MARGIN: f64 = 9.0;

/// The longest label or detail line a tooltip carries; longer text from the
/// page is cut, so the tooltip window never holds a paragraph.
const MAX_TEXT: usize = 120;

/// Whether `platform` has pill tooltips: only where the pill (and so its
/// tooltip) is kept out of the recording.
#[must_use]
pub const fn supported(platform: Platform) -> bool {
    !pill_filmed(platform)
}

/// A point in a window, in points from the top left of `origin`: the pill's
/// row for the pill, the controls' window for the bubble's controls.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPoint {
    pub x: f64,
    pub y: f64,
}

/// The pill's row on screen: the window itself, or, with a menu open, the
/// slice of the grown window the pill is in (the bottom with the menu above,
/// the top with it below; `live_controls::pill_with_menu`).
#[must_use]
pub fn pill_row(window: Frame, menu: Option<bool>, row_height: f64) -> Frame {
    match menu {
        Some(above) => pill_without_menu(window, row_height, above),
        None => window,
    }
}

/// `pointer` (screen points) relative to `frame`, when it is inside it.
#[must_use]
pub fn pointer_in(frame: Frame, pointer: Option<(f64, f64)>) -> Option<WindowPoint> {
    let (x, y) = pointer?;
    frame.contains(x, y).then_some(WindowPoint {
        x: x - frame.x,
        y: y - frame.y,
    })
}

/// Where the pointer is on the pill's row, for the page to find the button
/// under it: `None` off the row, and while a menu is open (the menu is what
/// is being used, and a tooltip above the pill would cover a menu there).
#[must_use]
pub fn pointer_on_row(row: Frame, menu_open: bool, pointer: Option<(f64, f64)>) -> Option<WindowPoint> {
    if menu_open {
        return None;
    }
    pointer_in(row, pointer)
}

/// Whether the page needs telling: the pointer came onto the row, left it,
/// or moved on it by half a point or more.
#[must_use]
pub fn pointer_changed(before: Option<WindowPoint>, now: Option<WindowPoint>) -> bool {
    const SLACK: f64 = 0.5;
    match (before, now) {
        (None, None) => false,
        (Some(b), Some(n)) => (b.x - n.x).abs() >= SLACK || (b.y - n.y).abs() >= SLACK,
        _ => true,
    }
}

/// The tooltip window's frame for the pill's `row`: [`TIP_ROOM`] tall, its
/// bottom on the top of the pill's glass (over the row's transparent band,
/// [`ROW_MARGIN`]), or below the pill the same way where the room above
/// would leave the usable area (`work`, the pill dragged to the top of the
/// screen). As wide as the row, so a tooltip kept inside it is never wider
/// than the pill's span.
#[must_use]
pub fn tip_frame(row: Frame, work: Frame) -> Frame {
    let above = row.y + ROW_MARGIN - TIP_ROOM >= work.y;
    Frame {
        x: row.x,
        y: if above {
            row.y + ROW_MARGIN - TIP_ROOM
        } else {
            row.y + row.height - ROW_MARGIN
        },
        width: row.width,
        height: TIP_ROOM,
    }
}

/// Whether the tooltip window must move: the pill's row moved (a drag, or a
/// menu opening) since it was placed.
#[must_use]
pub fn tip_needs_placing(placed_for: Option<Frame>, row: Frame) -> bool {
    placed_for.is_none() || moved(placed_for, row)
}

/// A box in a window's CSS pixels, from its top left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TipBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl TipBox {
    fn is_sane(&self) -> bool {
        [self.left, self.top, self.width, self.height].iter().all(|v| v.is_finite()) && self.width >= 0.0 && self.height >= 0.0
    }
}

/// The button's box (`anchor`, relative to the pill's row) in the tooltip
/// window's own pixels: the tooltip page places the tooltip against it,
/// above the button where the window has room above the row.
#[must_use]
pub fn anchor_in_tip(anchor: TipBox, row: Frame, tip: Frame) -> TipBox {
    TipBox {
        left: anchor.left + (row.x - tip.x),
        top: anchor.top + (row.y - tip.y),
        ..anchor
    }
}

/// What the pill page asks for: the tooltip of the button under the pointer
/// or with keyboard focus, and where that button is on the row.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TipRequest {
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    pub anchor: TipBox,
    /// From the pointer (shown only while the pointer is on the pill) or
    /// from keyboard focus.
    #[serde(default)]
    pub from_pointer: bool,
}

/// What the tooltip page draws: the text and the button's box in its own
/// window, or nothing. Numbered, so a late first read never puts an older
/// tooltip back over an event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipShown {
    pub seq: u64,
    pub tip: Option<TipText>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipText {
    pub label: String,
    pub detail: Option<String>,
    pub anchor: TipBox,
}

/// The request as it may be shown: text trimmed and cut to [`MAX_TEXT`], an
/// empty detail dropped, and nothing for an empty label or a box that is
/// not a box.
#[must_use]
pub fn cleaned(request: TipRequest) -> Option<TipRequest> {
    let cut = |s: &str| s.trim().chars().take(MAX_TEXT).collect::<String>();
    let label = cut(&request.label);
    if label.is_empty() || !request.anchor.is_sane() {
        return None;
    }
    let detail = request.detail.as_deref().map(cut).filter(|d| !d.is_empty());
    Some(TipRequest { label, detail, ..request })
}

/// Whether a tooltip may be on screen now: the pill is showing and has
/// tooltips here (`pill_shown`), no menu is open (`menu`, the pill's menu
/// side when one is), and a tooltip from the pointer only while the pointer
/// is on the pill (a late request must not show one after it left).
#[must_use]
pub const fn tip_allowed(pill_shown: bool, menu: Option<bool>, from_pointer: bool, pointer_on_pill: bool) -> bool {
    pill_shown && menu.is_none() && (!from_pointer || pointer_on_pill)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROW: Frame = Frame {
        x: 500.0,
        y: 800.0,
        width: 380.0,
        height: 60.0,
    };
    const WORK: Frame = Frame {
        x: 0.0,
        y: 25.0,
        width: 1440.0,
        height: 875.0,
    };

    /// Only where the pill is kept out of the video.
    #[test]
    fn only_platforms_that_keep_the_pill_out_of_the_video_have_its_tooltips() {
        assert!(supported(Platform::MacOs));
        assert!(supported(Platform::Windows));
        assert!(!supported(Platform::LinuxX11));
        assert!(!supported(Platform::LinuxWayland));
    }

    /// The pointer on a button of the pill is handed to the page relative to
    /// the row, whatever the row's place on screen.
    #[test]
    fn the_pointer_on_the_pill_is_given_relative_to_its_row() {
        let on_stop = Some((500.0 + 300.0, 800.0 + 30.0));
        assert_eq!(pointer_on_row(ROW, false, on_stop), Some(WindowPoint { x: 300.0, y: 30.0 }));
        // Edges count: the pill's window ends there.
        assert_eq!(pointer_on_row(ROW, false, Some((500.0, 800.0))), Some(WindowPoint { x: 0.0, y: 0.0 }));
    }

    #[test]
    fn the_pointer_off_the_pill_or_unknown_is_no_hover() {
        assert_eq!(pointer_on_row(ROW, false, Some((499.0, 830.0))), None);
        assert_eq!(pointer_on_row(ROW, false, Some((700.0, 861.0))), None);
        assert_eq!(pointer_on_row(ROW, false, None), None);
    }

    /// An open menu is being used; the pill's tooltips stay out of its way.
    #[test]
    fn no_hover_is_sent_while_a_menu_is_open() {
        assert_eq!(pointer_on_row(ROW, true, Some((800.0, 830.0))), None);
    }

    /// With a menu open the window is taller; the pill is in the slice of it
    /// that stayed where the pill was, so the pointer is measured from there.
    #[test]
    fn the_row_is_the_slice_of_a_grown_window_the_pill_is_in() {
        let above = Frame {
            y: ROW.y - 300.0,
            height: 360.0,
            ..ROW
        };
        assert_eq!(pill_row(above, Some(true), 60.0), ROW);
        let below = Frame { height: 360.0, ..ROW };
        assert_eq!(pill_row(below, Some(false), 60.0), ROW);
        assert_eq!(pill_row(ROW, None, 60.0), ROW);
    }

    #[test]
    fn the_page_is_told_only_when_the_pointer_comes_moves_or_goes() {
        let at = |x: f64| Some(WindowPoint { x, y: 20.0 });
        assert!(!pointer_changed(None, None));
        assert!(pointer_changed(None, at(10.0)));
        assert!(pointer_changed(at(10.0), None));
        assert!(!pointer_changed(at(10.0), at(10.2)));
        assert!(pointer_changed(at(10.0), at(11.0)));
    }

    /// The pill's glass: the row less its transparent band above and below.
    fn glass(row: Frame) -> Frame {
        Frame {
            y: row.y + ROW_MARGIN,
            height: row.height - 2.0 * ROW_MARGIN,
            ..row
        }
    }

    fn overlaps(a: Frame, b: Frame) -> bool {
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    }

    /// The tooltip goes just above the pill, in a window as wide as the
    /// pill's, its bottom on the top of the glass.
    #[test]
    fn the_tooltip_window_sits_on_top_of_the_pill() {
        let tip = tip_frame(ROW, WORK);
        assert_eq!(
            tip,
            Frame {
                x: ROW.x,
                y: ROW.y + ROW_MARGIN - TIP_ROOM,
                width: ROW.width,
                height: TIP_ROOM,
            }
        );
        assert!((tip.y + tip.height - glass(ROW).y).abs() < f64::EPSILON);
    }

    /// A click on the pill's glass (every button) never lands on the tooltip
    /// window, wherever it goes: it does not rely on the window ignoring the
    /// mouse.
    #[test]
    fn the_tooltip_window_never_covers_the_pill() {
        for row in [ROW, Frame { y: WORK.y, ..ROW }, Frame { y: WORK.y + 30.0, ..ROW }] {
            assert!(!overlaps(tip_frame(row, WORK), glass(row)), "{row:?}");
        }
    }

    /// Dragged to the top of the screen, the room above would be under the
    /// menu bar (cut off): the tooltip goes below the pill instead.
    #[test]
    fn near_the_top_of_the_screen_the_tooltip_window_is_below_the_pill() {
        let high = Frame { y: WORK.y + 10.0, ..ROW };
        let tip = tip_frame(high, WORK);
        assert!((tip.y - (glass(high).y + glass(high).height)).abs() < f64::EPSILON);
        assert!((tip.height - TIP_ROOM).abs() < f64::EPSILON);
        // Exactly enough room still goes above.
        let just = Frame {
            y: WORK.y + TIP_ROOM - ROW_MARGIN,
            ..ROW
        };
        assert!((tip_frame(just, WORK).y - WORK.y).abs() < f64::EPSILON);
    }

    /// The button's box from the page (relative to the row) lands on the same
    /// screen points in the tooltip window.
    #[test]
    fn the_buttons_box_is_moved_into_the_tooltip_windows_pixels() {
        let stop = TipBox {
            left: 290.0,
            top: 16.0,
            width: 28.0,
            height: 28.0,
        };
        let above = tip_frame(ROW, WORK);
        let a = anchor_in_tip(stop, ROW, above);
        assert_eq!(
            a,
            TipBox {
                left: 290.0,
                top: 16.0 + TIP_ROOM - ROW_MARGIN,
                width: 28.0,
                height: 28.0,
            }
        );
        // The same screen point: below the tooltip window's bottom, so the
        // tooltip page places the tooltip above it.
        assert!((above.y + a.top - (ROW.y + stop.top)).abs() < f64::EPSILON);
        assert!(a.top > TIP_ROOM);
        let high = Frame { y: WORK.y, ..ROW };
        let below = tip_frame(high, WORK);
        let b = anchor_in_tip(stop, high, below);
        assert!((below.y + b.top - (high.y + stop.top)).abs() < f64::EPSILON);
        assert!(b.top + b.height < 0.0, "above the window: the tooltip goes under it");
    }

    #[test]
    fn the_tooltip_window_moves_only_when_the_pill_did() {
        assert!(tip_needs_placing(None, ROW));
        assert!(!tip_needs_placing(Some(ROW), ROW));
        assert!(tip_needs_placing(Some(Frame { x: ROW.x + 40.0, ..ROW }), ROW));
    }

    fn request(label: &str) -> TipRequest {
        TipRequest {
            label: label.into(),
            detail: Some("  ".into()),
            anchor: TipBox {
                left: 1.0,
                top: 2.0,
                width: 28.0,
                height: 28.0,
            },
            from_pointer: true,
        }
    }

    #[test]
    fn a_request_is_trimmed_and_cut_and_an_empty_one_shows_nothing() {
        let c = cleaned(request("  Stop recording ")).expect("shown");
        assert_eq!(c.label, "Stop recording");
        assert_eq!(c.detail, None, "a blank detail is dropped");
        assert_eq!(cleaned(request("   ")), None);
        let long = cleaned(request(&"x".repeat(500))).expect("shown");
        assert_eq!(long.label.chars().count(), MAX_TEXT);
        let mut bad = request("Stop");
        bad.anchor.width = f64::NAN;
        assert_eq!(cleaned(bad), None);
    }

    /// A late request from a pointer that has left must not bring a tooltip
    /// back; keyboard focus shows one wherever the pointer is.
    #[test]
    fn a_tooltip_shows_only_while_it_still_applies() {
        assert!(tip_allowed(true, None, true, true));
        assert!(!tip_allowed(true, None, true, false), "the pointer left");
        assert!(tip_allowed(true, None, false, false), "keyboard focus");
        assert!(!tip_allowed(true, Some(true), false, true), "a menu is open above");
        assert!(!tip_allowed(true, Some(false), true, true), "a menu is open below");
        assert!(!tip_allowed(false, None, false, true), "the pill is hidden, or filmed (Linux)");
    }
}
