//! Wayland area recording: the area is drawn on a picture of the monitor
//! the user chose in the desktop's screen-sharing dialog, and recorded as a
//! crop of that monitor's stream.
//!
//! Wayland lets an app neither read the screen outside the ScreenCast
//! portal nor place a window, and gives it no global coordinates. So the
//! flow runs in the stream's own pixels end to end:
//!
//! 1. Record (the panel) asks the recorder for a monitor (`pickArea`); the
//!    desktop's dialog chooses which.
//! 2. The recorder answers with the stream's first picture (`area_still`)
//!    and holds every later one back: no sound is open and no file exists.
//! 3. The app shows that picture in one full-screen window (on the monitor
//!    the stream covers when the compositor says where that is; anywhere
//!    otherwise, since the coordinates do not depend on it) and the user
//!    drags the area on it.
//! 4. The drawn rectangle, in the page's CSS pixels, is mapped onto the
//!    picture as the page showed it ([`stream_area`]), which gives the
//!    stream's own pixels whatever the monitor's scale (HiDPI and fractional
//!    scaling included: the ratio is the stream's width over the picture's
//!    shown width), and the recorder crops to it and starts.
//!
//! Drawing over a still rather than a transparent window over the live
//! screen is deliberate: a transparent window would have to sit exactly on
//! the streamed monitor at exactly its logical size for its coordinates to
//! mean anything, and Wayland guarantees neither; the still's coordinates
//! are the stream's whatever the compositor does with the window.
//!
//! Pure, so it is tested on every OS; `commands` carries it out.

use serde::{Deserialize, Serialize};

use super::geometry::LogicalRect;
use super::recorder_child::plan;
use super::recording::protocol::{CropRect, StreamCrop, StreamPlacement};

/// Where the selection page shows the stream's picture, in its CSS pixels
/// (the image's own box, after `object-fit: contain`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShownPicture {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The smallest area recorded, in stream pixels each way: anything smaller
/// is a click, not a drag.
pub const MIN_AREA_PX: u32 = 8;

/// The stream pixels under `drawn` (the page's CSS pixels), given where the
/// page showed the `stream`-sized picture. The part outside the picture is
/// dropped; edges grow outward to whole, even pixels (the recorders'
/// `alignToPixels`). `None` for an area with nothing of the picture in it.
#[must_use]
pub fn stream_area(drawn: LogicalRect, shown: ShownPicture, stream: (u32, u32)) -> Option<StreamCrop> {
    let finite = [drawn.x, drawn.y, drawn.width, drawn.height, shown.x, shown.y, shown.width, shown.height]
        .iter()
        .all(|v| v.is_finite());
    if !finite || shown.width <= 0.0 || shown.height <= 0.0 || stream.0 < 2 || stream.1 < 2 {
        return None;
    }
    // The drawn rectangle on the picture, clipped to it.
    let x0 = (drawn.x - shown.x).clamp(0.0, shown.width);
    let y0 = (drawn.y - shown.y).clamp(0.0, shown.height);
    let x1 = (drawn.x + drawn.width - shown.x).clamp(0.0, shown.width);
    let y1 = (drawn.y + drawn.height - shown.y).clamp(0.0, shown.height);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    // Pixels per CSS pixel. `contain` keeps the picture's shape, so one
    // ratio holds both ways; the width's is the more precise.
    let scale = f64::from(stream.0) / shown.width;
    let crop = CropRect {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
    };
    let px = plan::area_pixels(crop, scale, stream.0, stream.1)?;
    (px.width() >= MIN_AREA_PX && px.height() >= MIN_AREA_PX).then_some(StreamCrop {
        x: px.x0,
        y: px.y0,
        width: px.width(),
        height: px.height(),
    })
}

/// A monitor as the desktop lays them out (GDK's geometry: logical
/// pixels, the layout the portal's stream placement uses).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Which of `monitors` the stream covers, for the selection window to fill:
/// the one at the stream's place and size, else the one it overlaps most.
/// `None` (the compositor puts the window where it likes) when the portal
/// did not say where the stream is or no monitor is under it; the area's
/// coordinates are the stream's either way.
#[must_use]
pub fn monitor_for(placement: Option<StreamPlacement>, monitors: &[MonitorBox]) -> Option<usize> {
    let p = placement?;
    if p.width <= 0 || p.height <= 0 {
        return None;
    }
    let (px, py, pw, ph) = (f64::from(p.x), f64::from(p.y), f64::from(p.width), f64::from(p.height));
    let near = |a: f64, b: f64| (a - b).abs() <= 1.0;
    if let Some(i) = monitors
        .iter()
        .position(|m| near(m.x, px) && near(m.y, py) && near(m.width, pw) && near(m.height, ph))
    {
        return Some(i);
    }
    let overlap = |m: &MonitorBox| {
        let w = (m.x + m.width).min(px + pw) - m.x.max(px);
        let h = (m.y + m.height).min(py + ph) - m.y.max(py);
        if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
    };
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| (i, overlap(m)))
        .filter(|(_, area)| *area > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Where a Wayland area recording is, from Record to the recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaStep {
    /// The desktop's dialog is open (the recorder asked the portal).
    Choosing,
    /// The picture is shown; the user is drawing.
    Drawing,
    /// An area was taken; the recorder crops and starts.
    Starting,
    /// Recording (the countdown, if any, runs in the pill from here).
    Recording,
    /// Ended without a recording: cancelled at any step, or the recorder
    /// failed.
    Ended,
}

/// What moves it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaEvent {
    /// The recorder answered with the monitor's picture.
    StillArrived,
    /// The page sent an area that maps onto the picture.
    AreaChosen,
    /// The recorder said `started` for the crop.
    Started,
    /// Escape, Cancel in the pill, the dialog closed, sign-out, a timeout.
    Cancelled,
    /// The recorder refused or died.
    Failed,
}

/// The next step, or `None` when `event` means nothing at `step` (an area
/// sent twice, or after a cancel): the caller refuses it and nothing moves.
#[must_use]
pub const fn next(step: AreaStep, event: AreaEvent) -> Option<AreaStep> {
    use AreaEvent as E;
    use AreaStep as S;
    match (step, event) {
        (S::Choosing, E::StillArrived) => Some(S::Drawing),
        (S::Drawing, E::AreaChosen) => Some(S::Starting),
        (S::Starting, E::Started) => Some(S::Recording),
        (S::Choosing | S::Drawing | S::Starting, E::Cancelled | E::Failed) => Some(S::Ended),
        _ => None,
    }
}

/// How long the area may take to draw before the recording is given up
/// quietly (the desktop's dialog has the same limit): a stream left open
/// keeps the desktop's "sharing" indicator on.
pub const DRAW_WITHIN: std::time::Duration = std::time::Duration::from_mins(5);

/// The id the last Wayland area is kept under among the remembered areas
/// (`bar::remember_area`, the same device-wide store the overlay's areas
/// use). Wayland gives no display ids, so the area is kept once, in the
/// stream's own pixels, and fitted to whatever monitor is chosen next
/// ([`initial_area`]). No real display id is this value: xcap's are
/// `CGDirectDisplayID`s, HMONITOR low bits and RandR outputs.
pub const REMEMBERED_AREA_ID: u32 = u32::MAX;

/// The area already drawn when the picture comes up, in stream pixels, so
/// the user confirms or adjusts it instead of starting from nothing: the
/// last area recorded (fitted onto this stream: moved back on, or shrunk,
/// when the monitor is smaller), else a centred box half the stream's
/// width and half its height. Whole, even pixels, like every crop. `None`
/// only for a stream too small to hold an area.
#[must_use]
pub fn initial_area(remembered: Option<LogicalRect>, stream: (u32, u32)) -> Option<StreamCrop> {
    let (sw, sh) = stream;
    if sw < MIN_AREA_PX * 2 || sh < MIN_AREA_PX * 2 {
        return None;
    }
    let to_crop = |px: plan::PixelRect| StreamCrop {
        x: px.x0,
        y: px.y0,
        width: px.width(),
        height: px.height(),
    };
    let fitted = remembered
        .and_then(|r| super::bar::fit_area(r, f64::from(sw), f64::from(sh)))
        .and_then(|r| {
            let crop = CropRect {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
            };
            plan::area_pixels(crop, 1.0, sw, sh)
        })
        .filter(|px| px.width() >= MIN_AREA_PX && px.height() >= MIN_AREA_PX);
    if let Some(px) = fitted {
        return Some(to_crop(px));
    }
    let even = |v: u32| v & !1;
    let width = even(sw / 2).max(MIN_AREA_PX);
    let height = even(sh / 2).max(MIN_AREA_PX);
    Some(StreamCrop {
        x: even((sw - width) / 2),
        y: even((sh - height) / 2),
        width,
        height,
    })
}

/// An area as fractions (0..1) of the stream's picture, which is how the
/// selection page draws it: it only knows where it shows the picture, in
/// its own CSS pixels, once the picture has loaded.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PictureFraction {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[must_use]
pub fn fraction_of(area: StreamCrop, stream: (u32, u32)) -> Option<PictureFraction> {
    if stream.0 == 0 || stream.1 == 0 {
        return None;
    }
    let (w, h) = (f64::from(stream.0), f64::from(stream.1));
    Some(PictureFraction {
        x: f64::from(area.x) / w,
        y: f64::from(area.y) / h,
        width: f64::from(area.width) / w,
        height: f64::from(area.height) / h,
    })
}

/// Where a recorded area is on the desktop, in the monitor's layout units
/// (GDK's logical pixels): the stream covers `monitor` whole, so the area
/// scales by the monitor's size over the stream's. Used to keep the pill
/// out of the area (`camera::pill_outside`). `None` for an empty stream or
/// monitor.
#[must_use]
pub fn area_on_monitor(area: StreamCrop, stream: (u32, u32), monitor: MonitorBox) -> Option<super::camera::Frame> {
    if stream.0 == 0 || stream.1 == 0 || monitor.width <= 0.0 || monitor.height <= 0.0 {
        return None;
    }
    let sx = monitor.width / f64::from(stream.0);
    let sy = monitor.height / f64::from(stream.1);
    Some(super::camera::Frame {
        x: monitor.x + f64::from(area.x) * sx,
        y: monitor.y + f64::from(area.y) * sy,
        width: f64::from(area.width) * sx,
        height: f64::from(area.height) * sy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect { x, y, width, height }
    }

    fn shown(x: f64, y: f64, width: f64, height: f64) -> ShownPicture {
        ShownPicture { x, y, width, height }
    }

    /// A 2x monitor: the stream is 3840x2160, the page shows it over its
    /// 1920x1080 CSS pixels. What is drawn doubles, on even pixels.
    #[test]
    fn a_hidpi_monitors_area_is_its_stream_pixels() {
        let area = stream_area(rect(100.0, 50.0, 640.0, 360.0), shown(0.0, 0.0, 1920.0, 1080.0), (3840, 2160)).unwrap();
        assert_eq!(
            area,
            StreamCrop {
                x: 200,
                y: 100,
                width: 1280,
                height: 720
            }
        );
    }

    /// Fractional scaling (150 %): 2880x1800 pixels shown over 1920x1200.
    /// Odd edges grow outward to even pixels, never past the picture.
    #[test]
    fn a_fractionally_scaled_area_grows_outward_to_even_pixels() {
        let area = stream_area(rect(100.0, 50.0, 333.0, 201.0), shown(0.0, 0.0, 1920.0, 1200.0), (2880, 1800)).unwrap();
        assert_eq!((area.x, area.y), (150, 75));
        assert_eq!(area.width % 2, 0);
        assert_eq!(area.height % 2, 0);
        assert!((500..=502).contains(&area.width), "{area:?}");
        assert!((302..=304).contains(&area.height), "{area:?}");
        let whole = stream_area(rect(0.0, 0.0, 1920.0, 1200.0), shown(0.0, 0.0, 1920.0, 1200.0), (2880, 1800)).unwrap();
        assert_eq!(
            whole,
            StreamCrop {
                x: 0,
                y: 0,
                width: 2880,
                height: 1800
            }
        );
    }

    /// The window landed on a monitor of another shape: the picture is
    /// letterboxed in it, and the drawn rectangle is measured from the
    /// picture's own corner, with what lies on the bars dropped.
    #[test]
    fn a_letterboxed_picture_is_measured_from_its_own_corner() {
        // A 16:10 stream (2560x1600) shown at 1600x1000 inside a 1920x1080
        // window: 160 px bars left and right, 40 px top and bottom.
        let picture = shown(160.0, 40.0, 1600.0, 1000.0);
        let area = stream_area(rect(160.0, 40.0, 800.0, 500.0), picture, (2560, 1600)).unwrap();
        assert_eq!(
            area,
            StreamCrop {
                x: 0,
                y: 0,
                width: 1280,
                height: 800
            }
        );
        // Dragged from the bar into the picture: only the picture's part.
        let clipped = stream_area(rect(0.0, 0.0, 260.0, 140.0), picture, (2560, 1600)).unwrap();
        assert_eq!(
            clipped,
            StreamCrop {
                x: 0,
                y: 0,
                width: 160,
                height: 160
            }
        );
        // Wholly on a bar: nothing of the picture.
        assert_eq!(stream_area(rect(0.0, 0.0, 150.0, 30.0), picture, (2560, 1600)), None);
    }

    /// A click, an empty rectangle or a picture the page never measured
    /// is no area.
    #[test]
    fn a_click_or_an_unmeasured_picture_is_no_area() {
        let picture = shown(0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(stream_area(rect(10.0, 10.0, 2.0, 2.0), picture, (1920, 1080)), None);
        assert_eq!(stream_area(rect(10.0, 10.0, 0.0, 50.0), picture, (1920, 1080)), None);
        assert_eq!(stream_area(rect(10.0, 10.0, 50.0, 50.0), shown(0.0, 0.0, 0.0, 0.0), (1920, 1080)), None);
        assert_eq!(stream_area(rect(f64::NAN, 10.0, 50.0, 50.0), picture, (1920, 1080)), None);
        assert_eq!(stream_area(rect(10.0, 10.0, 50.0, 50.0), picture, (0, 0)), None);
    }

    fn monitor(x: f64, y: f64, width: f64, height: f64) -> MonitorBox {
        MonitorBox { x, y, width, height }
    }

    /// Two monitors side by side: the stream's place names one; a stream
    /// the portal did not place goes where the compositor puts it.
    #[test]
    fn the_selection_window_covers_the_monitor_the_stream_shows() {
        let monitors = [monitor(0.0, 0.0, 1920.0, 1080.0), monitor(1920.0, 0.0, 1280.0, 1024.0)];
        let right = StreamPlacement {
            x: 1920,
            y: 0,
            width: 1280,
            height: 1024,
        };
        assert_eq!(monitor_for(Some(right), &monitors), Some(1));
        assert_eq!(
            monitor_for(
                Some(StreamPlacement {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080
                }),
                &monitors
            ),
            Some(0)
        );
        // A layout that moved by a pixel or two still matches, by overlap.
        let shifted = StreamPlacement {
            x: 1900,
            y: 10,
            width: 1280,
            height: 1024,
        };
        assert_eq!(monitor_for(Some(shifted), &monitors), Some(1));
        assert_eq!(monitor_for(None, &monitors), None);
        let nowhere = StreamPlacement {
            x: 9000,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(monitor_for(Some(nowhere), &monitors), None);
    }

    /// Every step can be cancelled; an area counts only while drawing, so
    /// one sent twice (or after a cancel) is refused and moves nothing.
    #[test]
    fn the_area_flow_takes_one_area_and_ends_on_any_cancel() {
        use AreaEvent as E;
        use AreaStep as S;
        let mut step = S::Choosing;
        for event in [E::StillArrived, E::AreaChosen, E::Started] {
            step = next(step, event).unwrap_or_else(|| panic!("{event:?} at {step:?}"));
        }
        assert_eq!(step, S::Recording);
        assert_eq!(next(S::Recording, E::Cancelled), None, "a recording ends through the session, not here");
        for at in [S::Choosing, S::Drawing, S::Starting] {
            assert_eq!(next(at, E::Cancelled), Some(S::Ended), "{at:?}");
            assert_eq!(next(at, E::Failed), Some(S::Ended), "{at:?}");
        }
        assert_eq!(next(S::Starting, E::AreaChosen), None, "a second area is refused");
        assert_eq!(next(S::Ended, E::AreaChosen), None, "an area after a cancel is refused");
        assert_eq!(next(S::Choosing, E::AreaChosen), None, "no area before the picture");
        assert_eq!(next(S::Drawing, E::Started), None);
    }

    fn crop(x: u32, y: u32, width: u32, height: u32) -> StreamCrop {
        StreamCrop { x, y, width, height }
    }

    /// The first time, half the screen each way, centred, on even pixels:
    /// something to confirm or adjust instead of an empty, dimmed picture.
    #[test]
    fn the_first_area_is_a_centred_half_of_the_screen() {
        assert_eq!(initial_area(None, (1920, 1080)), Some(crop(480, 270, 960, 540)));
        assert_eq!(initial_area(None, (3840, 2160)), Some(crop(960, 540, 1920, 1080)));
        // Odd halves round down to even, still centred within a pixel.
        let odd = initial_area(None, (2558, 1438)).unwrap();
        assert_eq!((odd.width, odd.height), (1278, 718));
        assert_eq!((odd.x, odd.y), (640, 360));
        assert!(odd.x + odd.width <= 2558 && odd.y + odd.height <= 1438);
    }

    /// After that the last area recorded comes back as it was, fitted onto
    /// a smaller monitor when the stream is now smaller.
    #[test]
    fn the_last_area_comes_back_fitted_to_the_stream() {
        let last = rect(100.0, 200.0, 800.0, 600.0);
        assert_eq!(initial_area(Some(last), (1920, 1080)), Some(crop(100, 200, 800, 600)));
        // Hangs off a 1280x720 stream: moved back on, kept whole.
        let moved = initial_area(Some(rect(1000.0, 500.0, 600.0, 400.0)), (1280, 720)).unwrap();
        assert_eq!(moved, crop(680, 320, 600, 400));
        // Larger than the stream: shrunk to it.
        let shrunk = initial_area(Some(rect(0.0, 0.0, 4000.0, 3000.0)), (1920, 1080)).unwrap();
        assert_eq!(shrunk, crop(0, 0, 1920, 1080));
        // Unusable (a click, or garbage): the centred half instead.
        assert_eq!(
            initial_area(Some(rect(10.0, 10.0, 2.0, 2.0)), (1920, 1080)),
            Some(crop(480, 270, 960, 540))
        );
        assert_eq!(
            initial_area(Some(rect(f64::NAN, 0.0, 100.0, 100.0)), (1920, 1080)),
            Some(crop(480, 270, 960, 540))
        );
        assert_eq!(initial_area(None, (10, 10)), None);
    }

    /// The page draws the preselected area from fractions of the picture,
    /// and what it sends back maps onto the same stream pixels.
    #[test]
    fn a_preselected_area_round_trips_through_the_page() {
        let stream = (2560, 1440);
        let area = initial_area(None, stream).unwrap();
        let f = fraction_of(area, stream).unwrap();
        assert_eq!((f.x, f.y, f.width, f.height), (0.25, 0.25, 0.5, 0.5));
        // The page shows the picture letterboxed at 1600x900 from (10, 20).
        let shown = shown(10.0, 20.0, 1600.0, 900.0);
        let drawn = rect(
            shown.x + f.x * shown.width,
            shown.y + f.y * shown.height,
            f.width * shown.width,
            f.height * shown.height,
        );
        assert_eq!(stream_area(drawn, shown, stream), Some(area));
        assert_eq!(fraction_of(area, (0, 0)), None);
    }

    /// The recorded area on the desktop, for keeping the pill out of it:
    /// a 2x monitor at (1920, 0) streamed at 3840x2160.
    #[test]
    fn a_recorded_area_is_placed_on_its_monitor() {
        let m = monitor(1920.0, 0.0, 1920.0, 1080.0);
        let f = area_on_monitor(crop(960, 540, 1920, 1080), (3840, 2160), m).unwrap();
        assert_eq!((f.x, f.y, f.width, f.height), (2400.0, 270.0, 960.0, 540.0));
        assert!(area_on_monitor(crop(0, 0, 10, 10), (0, 0), m).is_none());
        assert!(area_on_monitor(crop(0, 0, 10, 10), (100, 100), monitor(0.0, 0.0, 0.0, 10.0)).is_none());
    }
}
