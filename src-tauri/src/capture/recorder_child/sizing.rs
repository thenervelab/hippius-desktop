//! How big a recording is and how many bits it gets: the Swift helper's
//! `alignToPixels`, `capped`, `videoBitRate` and keyframe interval
//! (`macos/HippiusCapture/Sources/HippiusCapture.swift`), with the same numbers, so a
//! recording made on Windows or Linux matches one made on a Mac. Pinned
//! against the Swift constants by the tests below.
//!
//! The rate is an AVERAGE the encoder aims for, never a constant rate: a
//! still screen (text, windows) spends well under it and a busy one (a video
//! playing, a fast scroll, a camera) is held to it. Measured on Apple Silicon
//! with the helper's own writer settings, 5 Mbps at 1080p kept code and prose
//! as readable as the former 14 Mbps at 2x zoom, while a busy screen came out
//! at 5.1 Mbps instead of 12.8. Quality-based rate control was measured too
//! and left out on the Mac: VideoToolbox's quality target ignores the average
//! and has no ceiling (a busy Retina screen went to 40 Mbps, above the old
//! 27), and Intel Macs do not offer it.

/// The longest edge a recording is encoded at. A 5K or 6K display is scaled
/// down to this, so the file stays a size people can upload and share.
pub const MAX_LONG_EDGE: u32 = 3840;

/// Average bit rate at 1080p, and its bounds. Apple's HLS authoring spec
/// puts 1080p H.264 at 6 to 7.8 Mbps for camera video; screen content needs
/// less for the same sharpness.
const BITS_AT_1080P: f64 = 5_000_000.0;
const MIN_BITS: f64 = 1_000_000.0;
const MAX_BITS: f64 = 10_000_000.0;

/// The most an encoder that takes a ceiling may spend over a short window,
/// as a multiple of the average: the HLS authoring spec's limit for
/// on-demand video (peak at most 200% of the average), so a busy moment still
/// streams from a share link. The Mac's encoder gets no ceiling: a
/// VideoToolbox `DataRateLimits` switched it to a rate control that softened
/// text on every keyframe, and its average alone held a busy screen to
/// 5.1 Mbps for a 5 Mbps target.
pub const PEAK_TO_AVERAGE: u32 = 2;

/// Seconds between keyframes at most. A keyframe repaints the whole screen,
/// so on a still screen it is most of the file: 4 s instead of 2 s took a
/// still 1080p desktop from 2.5 to 1.5 Mbps (5.1 to 3.3 at Retina). A
/// browser seeking in a share link decodes at most 4 s of pictures from the
/// keyframe before, which is quick.
pub const KEYFRAME_SECONDS: u32 = 4;

/// Frames a second, every platform's.
pub const FPS: u32 = 30;

/// [`KEYFRAME_SECONDS`] in frames, for the encoders that count frames.
pub const KEYFRAME_FRAMES: u32 = KEYFRAME_SECONDS * FPS;

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

/// Average bit rate for a 30 fps recording: 5 Mbps at 1080p, growing with
/// the square root of the pixel count (screens are mostly still, and text
/// stays sharp well below a linear rise), bounded to 1..10 Mbps. A Retina
/// laptop's whole 3456 x 2234 screen gets 9.6 Mbps and 4K the 10 Mbps cap.
/// Camera only is filmed at the stage's size and gets the same rule (about
/// 5.6 Mbps for a Retina laptop's stage, near the HLS spec's 1080p): an
/// average spends what moving pictures need up to it, so a camera needs no
/// rule of its own.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn video_bit_rate(width: u32, height: u32) -> u32 {
    let ratio = f64::from(width) * f64::from(height) / (1920.0 * 1080.0);
    (BITS_AT_1080P * ratio.sqrt()).clamp(MIN_BITS, MAX_BITS) as u32
}

/// What a recording's H.264 encoder is told, the same on every platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateControl {
    /// Bits a second on average ([`video_bit_rate`]).
    pub average: u32,
    /// Bits a second at most, for the encoders that take a ceiling
    /// ([`PEAK_TO_AVERAGE`] times the average).
    pub peak: u32,
    /// Frames between keyframes at most ([`KEYFRAME_FRAMES`]).
    pub keyframe_frames: u32,
}

impl RateControl {
    /// The rate control for a `width` x `height` recording.
    #[must_use]
    pub fn for_size(width: u32, height: u32) -> Self {
        let average = video_bit_rate(width, height);
        Self {
            average,
            peak: average.saturating_mul(PEAK_TO_AVERAGE),
            keyframe_frames: KEYFRAME_FRAMES,
        }
    }

    /// The average in kbit/s, rounded up (x264's and the VA encoders' unit).
    #[must_use]
    pub const fn average_kbps(self) -> u32 {
        self.average.div_ceil(1000)
    }

    /// The peak in kbit/s, rounded up.
    #[must_use]
    pub const fn peak_kbps(self) -> u32 {
        self.peak.div_ceil(1000)
    }
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
            SWIFT.contains("let bps = 5_000_000 * ratio.squareRoot()"),
            "HippiusCapture.swift's 1080p rate changed"
        );
        assert!(
            SWIFT.contains("return Int(min(10_000_000, max(1_000_000, bps)))"),
            "HippiusCapture.swift's rate bounds changed"
        );
        assert!(SWIFT.contains("let ratio = Double(width * height) / (1920.0 * 1080.0)"));
        assert!(SWIFT.contains("return (max(2, Int(Double(width) * k) & ~1), max(2, Int(Double(height) * k) & ~1))"));
        assert!(
            SWIFT.contains("let keyframeSeconds = 4"),
            "HippiusCapture.swift's keyframe interval changed"
        );
        assert!(SWIFT.contains("AVVideoMaxKeyFrameIntervalKey: keyframeSeconds * 30"));
        assert!(SWIFT.contains("AVVideoMaxKeyFrameIntervalDurationKey: keyframeSeconds"));
        assert!(SWIFT.contains("AVVideoExpectedSourceFrameRateKey: 30"));
        assert!(SWIFT.contains("config.minimumFrameInterval = CMTime(value: 1, timescale: 30)"));
    }

    /// The Mac's encoder is told an average and nothing else (see
    /// [`PEAK_TO_AVERAGE`]): a quality target overrides the average and has
    /// no ceiling, and a data rate limit softens text on keyframes. Both
    /// were measured; neither may come back unmeasured.
    #[test]
    fn the_mac_encoder_is_told_an_average_only() {
        assert!(SWIFT.contains("AVVideoAverageBitRateKey: videoBitRate(width: width, height: height)"));
        assert!(!SWIFT.contains("AVVideoQualityKey"), "a quality target has no ceiling on the Mac");
        assert!(!SWIFT.contains("DataRateLimits"), "a data rate limit softens text on keyframes");
    }

    #[test]
    fn bit_rate_follows_the_square_root_of_the_pixels_within_bounds() {
        assert_eq!(video_bit_rate(1920, 1080), 5_000_000);
        // 1440p: 5 Mbps * sqrt(16/9) = 6.67 Mbps.
        assert_eq!(video_bit_rate(2560, 1440), 6_666_666);
        // A 14-inch MacBook Pro's whole Retina screen.
        assert_eq!(video_bit_rate(3456, 2234), 9_647_970);
        assert_eq!(video_bit_rate(3840, 2160), 10_000_000, "4K is 10 Mbps, the cap");
        assert_eq!(video_bit_rate(5120, 2880), 10_000_000);
        assert_eq!(video_bit_rate(1280, 720), 3_333_333);
        assert_eq!(video_bit_rate(320, 240), 1_000_000, "a tiny area gets the floor");
    }

    /// The point of the rate: a 10-minute recording's video at most (an
    /// average bounds the file; a still screen spends less, never more).
    #[test]
    fn ten_minutes_stays_well_under_the_old_size() {
        let megabytes = |w, h| u64::from(video_bit_rate(w, h)) * 600 / 8 / 1_000_000;
        assert_eq!(megabytes(1920, 1080), 375, "was 1050 at 14 Mbps");
        assert_eq!(megabytes(3456, 2234), 723, "was 2025 at 27 Mbps");
        assert_eq!(megabytes(3840, 2160), 750, "was 2100 at 28 Mbps");
    }

    #[test]
    fn every_encoder_gets_the_same_average_peak_and_keyframes() {
        let rate = RateControl::for_size(1920, 1080);
        assert_eq!(rate.average, 5_000_000);
        assert_eq!(rate.peak, 10_000_000, "twice the average, the HLS spec's on-demand limit");
        assert_eq!(rate.keyframe_frames, 120, "a keyframe every 4 s at 30 fps");
        assert_eq!((rate.average_kbps(), rate.peak_kbps()), (5000, 10_000));
        let odd = RateControl::for_size(2560, 1440);
        assert_eq!((odd.average_kbps(), odd.peak_kbps()), (6667, 13_334), "rounded up, never 0");
        let tiny = RateControl::for_size(2, 2);
        assert_eq!((tiny.average, tiny.peak), (1_000_000, 2_000_000));
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
