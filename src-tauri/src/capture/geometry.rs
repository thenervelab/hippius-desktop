//! Turning the rectangle a user dragged into the pixels to keep.
//!
//! The overlay is a webview, so it reports its selection in CSS pixels —
//! logical points, relative to the display it is drawn on. The capture is in
//! physical pixels. Every conversion between the two lives here, once, because
//! getting it wrong is silent: on a Retina display a selection read as pixels
//! crops the top-left quarter of what the user chose, and nothing errors.

use serde::{Deserialize, Serialize};

/// A selection in logical points, relative to the top-left of its display.
///
/// `width` and `height` may be negative: a drag up or left reports its
/// starting corner and a negative extent, and [`crop_rect`] normalises it
/// rather than making every overlay remember to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A region of a captured display image, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The pixels to keep from a display image `image_width` × `image_height`
/// for a selection made at `scale_factor`.
///
/// Rounds OUTWARD — floor the near edges, ceil the far ones — so a selection
/// that ends mid-pixel keeps that pixel rather than shaving a line off what the
/// user framed. Clamps to the image, since a drag that ran off the edge of the
/// display still means "up to the edge".
///
/// `None` for a selection with no area after clamping: a click without a drag,
/// or a rectangle entirely off the image. The caller treats that as "nothing
/// selected", never as a zero-pixel screenshot.
pub fn crop_rect(selection: LogicalRect, scale_factor: f64, image_width: u32, image_height: u32) -> Option<PixelRect> {
    if !(scale_factor.is_finite() && scale_factor > 0.0) {
        return None;
    }
    let values = [selection.x, selection.y, selection.width, selection.height];
    if values.iter().any(|v| !v.is_finite()) {
        return None;
    }

    // Normalise a drag in any direction to a top-left origin and a positive extent.
    let (left, right) = ordered(selection.x, selection.x + selection.width);
    let (top, bottom) = ordered(selection.y, selection.y + selection.height);

    let clamp_x = |v: f64| v.clamp(0.0, f64::from(image_width));
    let clamp_y = |v: f64| v.clamp(0.0, f64::from(image_height));
    let x0 = clamp_x((left * scale_factor).floor());
    let y0 = clamp_y((top * scale_factor).floor());
    let x1 = clamp_x((right * scale_factor).ceil());
    let y1 = clamp_y((bottom * scale_factor).ceil());

    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    // Every value is clamped into 0..=u32::MAX above, so the casts cannot wrap.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(PixelRect {
        x: x0 as u32,
        y: y0 as u32,
        width: (x1 - x0) as u32,
        height: (y1 - y0) as u32,
    })
}

fn ordered(a: f64, b: f64) -> (f64, f64) {
    if a <= b { (a, b) } else { (b, a) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect { x, y, width, height }
    }

    #[test]
    fn a_standard_display_crops_one_to_one() {
        assert_eq!(
            crop_rect(rect(10.0, 20.0, 300.0, 200.0), 1.0, 1920, 1080),
            Some(PixelRect {
                x: 10,
                y: 20,
                width: 300,
                height: 200
            })
        );
    }

    /// The silent failure this module exists for: read as pixels, a Retina
    /// selection keeps a quarter of what the user framed.
    #[test]
    fn a_retina_display_doubles_every_edge() {
        assert_eq!(
            crop_rect(rect(10.0, 20.0, 300.0, 200.0), 2.0, 3024, 1964),
            Some(PixelRect {
                x: 20,
                y: 40,
                width: 600,
                height: 400
            })
        );
    }

    #[test]
    fn a_fractional_scale_rounds_outward_and_keeps_the_edge_pixel() {
        // 1.5×: 10.3 → 15.45 floors to 15; (10.3 + 100.1) × 1.5 = 165.6 ceils to 166.
        assert_eq!(
            crop_rect(rect(10.3, 10.3, 100.1, 100.1), 1.5, 2880, 1620),
            Some(PixelRect {
                x: 15,
                y: 15,
                width: 151,
                height: 151
            })
        );
    }

    #[test]
    fn a_drag_up_and_left_is_the_same_rectangle() {
        let forwards = crop_rect(rect(100.0, 100.0, 50.0, 40.0), 2.0, 2000, 2000);
        let backwards = crop_rect(rect(150.0, 140.0, -50.0, -40.0), 2.0, 2000, 2000);
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn a_drag_off_the_edge_stops_at_the_edge() {
        assert_eq!(
            crop_rect(rect(-20.0, 1000.0, 120.0, 200.0), 1.0, 1920, 1080),
            Some(PixelRect {
                x: 0,
                y: 1000,
                width: 100,
                height: 80
            })
        );
    }

    #[test]
    fn a_click_without_a_drag_selects_nothing() {
        assert_eq!(crop_rect(rect(50.0, 50.0, 0.0, 0.0), 2.0, 2000, 2000), None);
        assert_eq!(crop_rect(rect(50.0, 50.0, 300.0, 0.0), 2.0, 2000, 2000), None);
    }

    #[test]
    fn a_selection_wholly_off_the_image_selects_nothing() {
        assert_eq!(crop_rect(rect(5000.0, 5000.0, 10.0, 10.0), 1.0, 1920, 1080), None);
    }

    /// The overlay is a webview; a NaN from a bad event must not become a
    /// crop that panics in the image library.
    #[test]
    fn nonsense_input_selects_nothing_rather_than_panicking() {
        assert_eq!(crop_rect(rect(f64::NAN, 0.0, 10.0, 10.0), 1.0, 100, 100), None);
        assert_eq!(crop_rect(rect(0.0, 0.0, f64::INFINITY, 10.0), 1.0, 100, 100), None);
        assert_eq!(crop_rect(rect(0.0, 0.0, 10.0, 10.0), 0.0, 100, 100), None);
        assert_eq!(crop_rect(rect(0.0, 0.0, 10.0, 10.0), -2.0, 100, 100), None);
    }
}
