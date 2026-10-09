//! Which pixels of a captured picture are recorded, and at what size.
//!
//! A monitor or window is captured whole (Windows.Graphics.Capture gives
//! physical pixels); an area is cut out of its monitor's picture and the
//! camera stage is trimmed of its transparent margin. The output size is
//! fixed at Start: even (H.264) and capped at [`MAX_LONG_EDGE`], the Swift
//! helper's rules ([`super::sizing`]).
//!
//! Pure, so it is tested on every OS.

use super::sizing::{self, Rect};
use crate::capture::recording::protocol::CropRect;

/// A rectangle of whole pixels, `[x0, x1) x [y0, y1)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl PixelRect {
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.x1 - self.x0
    }

    #[must_use]
    pub const fn height(&self) -> u32 {
        self.y1 - self.y0
    }

    /// This rectangle inside a `width` x `height` picture, or `None` when
    /// nothing of it is left (a display whose resolution changed under an
    /// area recording).
    #[must_use]
    pub fn within(self, width: u32, height: u32) -> Option<Self> {
        let r = Self {
            x0: self.x0.min(width),
            y0: self.y0.min(height),
            x1: self.x1.min(width),
            y1: self.y1.min(height),
        };
        (r.x1 > r.x0 && r.y1 > r.y0).then_some(r)
    }
}

/// The camera stage's transparent margin and rounded corner, in the page's
/// own pixels (CSS px): the Swift helper's `stageInset`, pinned against the
/// page by `recording::macos`'s test.
pub const STAGE_INSET: f64 = 12.0;

/// The pixels an area covers: `crop` is in the display's logical units,
/// `scale` its pixels per unit, `px_w` x `px_h` its picture. Grown outward
/// to whole, even pixels inside the display, like the Swift helper's
/// `alignToPixels`. `None` for an area with no size.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn area_pixels(crop: CropRect, scale: f64, px_w: u32, px_h: u32) -> Option<PixelRect> {
    if crop.width <= 0.0 || crop.height <= 0.0 || px_w < 2 || px_h < 2 {
        return None;
    }
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: f64::from(px_w) / scale,
        height: f64::from(px_h) / scale,
    };
    let rect = Rect {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
    };
    let (aligned, w, h) = sizing::align_to_pixels(rect, scale, bounds);
    let x0 = (aligned.x * scale).round().max(0.0) as u32;
    let y0 = (aligned.y * scale).round().max(0.0) as u32;
    PixelRect {
        x0,
        y0,
        x1: x0 + w,
        y1: y0 + h,
    }
    .within(px_w, px_h)
}

/// The recording's size for a picture of `width` x `height`: even each way
/// and capped at the long edge.
#[must_use]
pub fn output_size(width: u32, height: u32) -> (u32, u32) {
    let even = |v: u32| (v & !1).max(2);
    sizing::capped(even(width), even(height))
}

/// The camera stage's picture without its margin: `scale` is the window's
/// pixels per CSS px (its DPI over 96). The whole picture when it is too
/// small to trim.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn stage_crop(width: u32, height: u32, scale: f64) -> PixelRect {
    let inset = (STAGE_INSET * if scale.is_finite() && scale > 0.0 { scale } else { 1.0 }).round() as u32;
    if width <= inset * 2 + 2 || height <= inset * 2 + 2 {
        return PixelRect {
            x0: 0,
            y0: 0,
            x1: width,
            y1: height,
        };
    }
    PixelRect {
        x0: inset,
        y0: inset,
        x1: width - inset,
        y1: height - inset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop(x: f64, y: f64, width: f64, height: f64) -> CropRect {
        CropRect { x, y, width, height }
    }

    #[test]
    fn an_area_on_a_150_percent_display_covers_its_pixels_on_even_edges() {
        // 1920x1200 logical at 150 % is 2880x1800 pixels.
        let r = area_pixels(crop(100.0, 50.0, 333.0, 201.0), 1.5, 2880, 1800).unwrap();
        assert_eq!((r.x0, r.y0), (150, 75));
        assert_eq!(r.width() % 2, 0);
        assert_eq!(r.height() % 2, 0);
        assert!(r.width() >= 500 && r.width() <= 502, "{r:?}");
        assert!(r.height() >= 302 && r.height() <= 304, "{r:?}");
    }

    #[test]
    fn the_whole_display_dragged_is_every_pixel() {
        let r = area_pixels(crop(0.0, 0.0, 1920.0, 1200.0), 1.5, 2880, 1800).unwrap();
        assert_eq!(
            r,
            PixelRect {
                x0: 0,
                y0: 0,
                x1: 2880,
                y1: 1800
            }
        );
    }

    #[test]
    fn an_area_at_the_far_edge_stays_inside_the_display() {
        let r = area_pixels(crop(1900.0, 1190.0, 40.0, 40.0), 1.0, 1920, 1200).unwrap();
        assert!(r.x1 <= 1920 && r.y1 <= 1200, "{r:?}");
        assert!(r.width() >= 2 && r.height() >= 2);
    }

    #[test]
    fn an_area_with_no_size_is_refused() {
        assert_eq!(area_pixels(crop(10.0, 10.0, 0.0, 50.0), 1.0, 1920, 1080), None);
    }

    #[test]
    fn a_display_that_shrank_under_the_area_keeps_what_is_left() {
        let r = PixelRect {
            x0: 100,
            y0: 100,
            x1: 900,
            y1: 700,
        };
        assert_eq!(
            r.within(800, 600),
            Some(PixelRect {
                x0: 100,
                y0: 100,
                x1: 800,
                y1: 600
            })
        );
        assert_eq!(r.within(50, 50), None);
    }

    #[test]
    fn the_output_is_even_and_capped() {
        assert_eq!(output_size(1921, 1081), (1920, 1080));
        assert_eq!(output_size(5120, 2880), (3840, 2160));
        assert_eq!(output_size(1, 1), (2, 2));
    }

    #[test]
    fn the_stage_loses_its_margin_at_the_windows_scale() {
        assert_eq!(
            stage_crop(400, 300, 1.0),
            PixelRect {
                x0: 12,
                y0: 12,
                x1: 388,
                y1: 288
            }
        );
        assert_eq!(
            stage_crop(600, 450, 1.5),
            PixelRect {
                x0: 18,
                y0: 18,
                x1: 582,
                y1: 432
            }
        );
        assert_eq!(
            stage_crop(20, 20, 1.0),
            PixelRect {
                x0: 0,
                y0: 0,
                x1: 20,
                y1: 20
            }
        );
    }

    /// Every platform's recording starts with its index, so a share link's
    /// page plays from the first bytes instead of downloading the whole file
    /// to reach an index at the end (share links cannot be read from the
    /// middle). The Mac's writer moves it there at Stop; Linux writes
    /// fragments while recording and rewrites them at Stop as one movie
    /// with its index first (GStreamer 1.20's fragments do not decode in
    /// Chrome, and Chrome walks any fragmented file back and forth before
    /// playing it); Windows writes fragmented files whose index is first.
    #[test]
    fn recordings_put_their_index_first() {
        let swift = include_str!("../../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        assert!(swift.contains("writer.shouldOptimizeForNetworkUse = true"), "macOS: index at the front");
        let windows = include_str!("windows/writer.rs");
        assert!(windows.contains("MFTranscodeContainerType_FMPEG4"), "Windows: fragmented MP4");
        let linux = include_str!("linux_plan.rs");
        assert!(linux.contains("mp4mux name=mux fragment-duration="), "Linux: fragments while recording");
        assert!(linux.contains("mp4mux name=remux faststart=true"), "Linux: index first at Stop");
        let linux_writer = include_str!("linux/encoder.rs");
        assert!(
            linux_writer.contains("faststart_in_place(&self.output"),
            "Linux: the rewrite runs at Stop"
        );
    }

    /// The stage inset is the Swift helper's, which is pinned against the
    /// camera page; both platforms trim the same margin.
    #[test]
    fn the_stage_inset_is_the_swift_helpers() {
        let swift = include_str!("../../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        assert!(swift.contains("let stageInset: CGFloat = 12"));
        assert!((STAGE_INSET - 12.0).abs() < f64::EPSILON);
    }
}
