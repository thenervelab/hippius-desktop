//! How big a recording is and how many bits it gets: the Swift helper's
//! `alignToPixels`, `capped` and `videoBitRate`
//! (`macos/HippiusCapture/Sources/HippiusCapture.swift`), with the same numbers, so a
//! recording made on Windows or Linux matches one made on a Mac. Pinned
//! against the Swift constants by the tests below.

/// The longest edge a recording is encoded at. A 5K or 6K display is scaled
/// down to this, so the file stays a size people can upload and share.
pub const MAX_LONG_EDGE: u32 = 3840;

/// Bit rate at 1080p (about 14 Mbps), and its bounds.
const BITS_AT_1080P: f64 = 14_000_000.0;
const MIN_BITS: f64 = 2_000_000.0;
const MAX_BITS: f64 = 28_000_000.0;

/// A rectangle in a display's own units (points on macOS, logical pixels
/// elsewhere).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `rect` (inside `bounds`) grown outward to whole pixels at `scale`, then to
/// an even pixel count each way (H.264 needs even sizes), still inside
/// `bounds`. Returns the rect back in the display's units plus its pixel
/// size, so the source rectangle and the output size describe exactly the
/// same pixels and no edge is resampled.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn align_to_pixels(rect: Rect, scale: f64, bounds: Rect) -> (Rect, u32, u32) {
    let axis = |lo: f64, hi: f64, min: f64, max: f64| -> (f64, f64) {
        let floor_min = (min * scale).ceil();
        let ceil_max = (max * scale).floor();
        let mut a = floor_min.max((lo * scale).floor());
        let mut b = ceil_max.min((hi * scale).ceil());
        if b - a < 2.0 {
            b = a + 2.0;
        }
        if (b - a) as i64 % 2 != 0 {
            if b < ceil_max {
                b += 1.0;
            } else if a > floor_min {
                a -= 1.0;
            } else {
                b -= 1.0;
            }
        }
        (a, b)
    };
    let (x0, x1) = axis(rect.x, rect.x + rect.width, bounds.x, bounds.x + bounds.width);
    let (y0, y1) = axis(rect.y, rect.y + rect.height, bounds.y, bounds.y + bounds.height);
    (
        Rect {
            x: x0 / scale,
            y: y0 / scale,
            width: (x1 - x0) / scale,
            height: (y1 - y0) / scale,
        },
        (x1 - x0) as u32,
        (y1 - y0) as u32,
    )
}

/// Scale a pixel size down so its long edge fits [`MAX_LONG_EDGE`], keeping
/// it even.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn capped(width: u32, height: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= MAX_LONG_EDGE {
        return (width, height);
    }
    let k = f64::from(MAX_LONG_EDGE) / f64::from(long);
    let scale = |v: u32| ((f64::from(v) * k) as u32 & !1).max(2);
    (scale(width), scale(height))
}

/// Average bit rate for a 30 fps screen recording. About 14 Mbps at 1080p,
/// growing with the square root of the pixel count (screens are mostly
/// still, and text stays sharp well below a linear rise), bounded to
/// 2..28 Mbps so a 4K recording stays shareable.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn video_bit_rate(width: u32, height: u32) -> u32 {
    let ratio = f64::from(width) * f64::from(height) / (1920.0 * 1080.0);
    (BITS_AT_1080P * ratio.sqrt()).clamp(MIN_BITS, MAX_BITS) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const SWIFT: &str = include_str!("../../../../macos/HippiusCapture/Sources/HippiusCapture.swift");

    /// If the Swift helper's numbers change, these must change with them, or
    /// a Windows recording and a Mac recording of the same screen differ.
    #[test]
    fn the_numbers_are_the_swift_helpers() {
        assert!(SWIFT.contains("let maxLongEdge = 3840"), "HippiusCapture.swift's maxLongEdge changed");
        assert!(
            SWIFT.contains("let bps = 14_000_000 * ratio.squareRoot()"),
            "HippiusCapture.swift's 1080p rate changed"
        );
        assert!(
            SWIFT.contains("return Int(min(28_000_000, max(2_000_000, bps)))"),
            "HippiusCapture.swift's rate bounds changed"
        );
        assert!(SWIFT.contains("let ratio = Double(width * height) / (1920.0 * 1080.0)"));
        assert!(SWIFT.contains("return (max(2, Int(Double(width) * k) & ~1), max(2, Int(Double(height) * k) & ~1))"));
    }

    #[test]
    fn bit_rate_follows_the_square_root_of_the_pixels_within_bounds() {
        assert_eq!(video_bit_rate(1920, 1080), 14_000_000);
        // 1440p: 14 Mbps * sqrt(16/9) = 18.67 Mbps.
        assert_eq!(video_bit_rate(2560, 1440), 18_666_666);
        assert_eq!(video_bit_rate(3840, 2160), 28_000_000, "4K is 28 Mbps, the cap");
        assert_eq!(video_bit_rate(5120, 2880), 28_000_000);
        assert_eq!(video_bit_rate(320, 240), 2_694_301);
        assert_eq!(video_bit_rate(200, 120), 2_000_000, "a tiny area gets the floor");
    }

    #[test]
    fn a_large_display_is_capped_at_the_long_edge_and_stays_even() {
        assert_eq!(capped(1920, 1080), (1920, 1080));
        assert_eq!(capped(3840, 2160), (3840, 2160));
        assert_eq!(capped(5120, 2880), (3840, 2160));
        assert_eq!(capped(6016, 3384), (3840, 2160));
        // A portrait display: the long edge is the height.
        let (w, h) = capped(2880, 5121);
        assert!((3838..=3840).contains(&h), "{h}");
        assert_eq!((w % 2, h % 2), (0, 0));
    }

    #[test]
    fn an_area_grows_outward_to_whole_even_pixels() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        // 100.25 x 50.5 points at 2x: 200.5 x 101 pixels, grown out to even.
        let (rect, w, h) = align_to_pixels(
            Rect {
                x: 10.1,
                y: 20.0,
                width: 100.25,
                height: 50.5,
            },
            2.0,
            screen,
        );
        assert_eq!((w % 2, h % 2), (0, 0));
        assert_eq!((w, h), (202, 102));
        assert!(rect.x <= 10.1 && rect.x + rect.width >= 110.35, "{rect:?}");
    }

    #[test]
    fn an_area_on_the_edge_stays_inside_the_display() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        // An odd width flush with the right edge grows left instead.
        let (rect, w, h) = align_to_pixels(
            Rect {
                x: 1419.0,
                y: 0.0,
                width: 501.0,
                height: 1080.0,
            },
            1.0,
            screen,
        );
        assert_eq!((w, h), (502, 1080));
        assert!((rect.x + rect.width - 1920.0).abs() < f64::EPSILON, "{rect:?}");
        assert!((rect.x - 1418.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_sliver_is_at_least_two_pixels() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let (_, w, h) = align_to_pixels(
            Rect {
                x: 10.0,
                y: 10.0,
                width: 0.2,
                height: 0.0,
            },
            1.0,
            screen,
        );
        assert_eq!((w, h), (2, 2));
    }
}
