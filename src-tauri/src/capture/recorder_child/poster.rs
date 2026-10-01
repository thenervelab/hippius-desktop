//! `--poster <video> <seconds>...` in the recorder child: stills from a
//! finished recording for the capture card, on Windows (Media Foundation's
//! Source Reader) and Linux (GStreamer). It prints the Swift helper's exact
//! line (`macos/HippiusCapture/Sources/Poster.swift`), so the app reads every
//! platform the same way (`capture::poster`):
//!
//! ```text
//! {"duration":12.4,"frames":[{"jpeg":"<base64>","time":1.0}]}
//! ```
//!
//! One still per asked time, in the order asked, each clamped into the video
//! (a time past the end is the last frame); a time the file cannot give is
//! left out. Everything here is platform free: a platform only opens the
//! file and decodes the picture nearest a time ([`StillSource`]); the
//! clamping, the size, the JPEG and the line are shared and tested on every
//! machine.

use std::io::Cursor;

use base64::Engine;
use serde::Serialize;

/// The longest edge of a still: twice the card's picture, so it stays crisp
/// on a high-density display after the app scales it to the card. The
/// Swift helper's `posterLongEdge`.
pub const LONG_EDGE: u32 = 1120;
/// The Swift helper's `kCGImageDestinationLossyCompressionQuality: 0.85`.
const JPEG_QUALITY: u8 = 85;
/// A frame this close to the asked time is as good as the exact one, and
/// much faster to reach (AVAssetImageGenerator's tolerance in the helper).
pub const TOLERANCE_SECS: f64 = 0.25;

/// A finished recording a platform has opened.
pub trait StillSource {
    /// The video's length in seconds (0 when the file does not say).
    fn duration(&self) -> f64;
    /// The picture at about `secs` (within [`TOLERANCE_SECS`]), upright and
    /// at the file's display size, or `None` when it cannot be read.
    fn still_at(&mut self, secs: f64) -> Option<image::RgbImage>;
}

/// `time` inside a video `duration` long: never negative, never past the
/// last frame (a request at or past the end returns nothing on some files).
/// The Swift helper's `clampedPosterTime`.
#[must_use]
pub fn clamped_time(time: f64, duration: f64) -> f64 {
    if !time.is_finite() {
        return 0.0;
    }
    let duration = if duration.is_finite() { duration } else { 0.0 };
    let last = (duration - 0.1).max(0.0);
    time.max(0.0).min(last)
}

/// The video path and the asked times from the child's arguments
/// (`... --poster <video> <seconds>...`); times that are not numbers are
/// skipped, as the helper's `compactMap { Double($0) }` does.
#[must_use]
pub fn parse_args(args: &[String]) -> Option<(String, Vec<f64>)> {
    let at = args.iter().position(|a| a == "--poster")?;
    let path = args.get(at + 1)?.clone();
    let times = args[at + 2..].iter().filter_map(|t| t.parse::<f64>().ok()).collect();
    Some((path, times))
}

/// `(width, height)` scaled to fit [`LONG_EDGE`], keeping the shape, never
/// enlarged, never zero.
#[must_use]
pub fn fitted(width: u32, height: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= LONG_EDGE || long == 0 {
        return (width, height);
    }
    let scale = f64::from(LONG_EDGE) / f64::from(long);
    let side = |v: u32| ((f64::from(v) * scale).round() as u32).max(1);
    (side(width), side(height))
}

/// `image` fitted to [`LONG_EDGE`] (a copy only when it has to shrink).
#[must_use]
pub fn fit_image(image: image::RgbImage) -> image::RgbImage {
    let (w, h) = fitted(image.width(), image.height());
    if (w, h) == image.dimensions() {
        image
    } else {
        image::imageops::resize(&image, w, h, image::imageops::FilterType::Triangle)
    }
}

/// `image` as base64 JPEG, or `None` for an empty picture.
#[must_use]
pub fn jpeg_base64(image: &image::RgbImage) -> Option<String> {
    if image.width() == 0 || image.height() == 0 {
        return None;
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), JPEG_QUALITY)
        .encode_image(image)
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// One still in the line. Fields in the order the helper's sorted keys
/// print them.
#[derive(Serialize)]
struct Frame {
    jpeg: String,
    time: f64,
}

#[derive(Serialize)]
struct Line {
    duration: f64,
    frames: Vec<Frame>,
}

/// The line for `duration` and its stills (time, base64 JPEG).
#[must_use]
pub fn line(duration: f64, frames: Vec<(f64, String)>) -> String {
    let duration = if duration.is_finite() { duration.max(0.0) } else { 0.0 };
    let line = Line {
        duration,
        frames: frames.into_iter().map(|(time, jpeg)| Frame { jpeg, time }).collect(),
    };
    serde_json::to_string(&line).unwrap_or_else(|_| empty_line())
}

/// The line for a file that could not be opened at all.
#[must_use]
pub fn empty_line() -> String {
    r#"{"duration":0.0,"frames":[]}"#.to_string()
}

/// The stills at `times` from `source`, as the line.
///
/// It stops after the first still that is not black: the app keeps the
/// first lit one in the order asked (`capture::poster::choose`), so the
/// later ones would be decoded for nothing. That matters here as it does
/// not for the Swift helper: Media Foundation and GStreamer decode in
/// software from the key frame before each time, and the app waits only
/// `capture::poster::WAIT` for the answer.
pub fn read(source: &mut dyn StillSource, times: &[f64]) -> String {
    let duration = source.duration();
    let mut frames = Vec::with_capacity(times.len());
    for &asked in times {
        let time = clamped_time(asked, duration);
        let Some(still) = source.still_at(time).map(fit_image) else {
            continue;
        };
        let lit = !crate::capture::poster::is_blank(&image::DynamicImage::ImageRgb8(still.clone()));
        if let Some(jpeg) = jpeg_base64(&still) {
            frames.push((time, jpeg));
            if lit {
                break;
            }
        }
    }
    line(duration, frames)
}

/// BT.709 limited-range YCbCr (what the recorders write: H.264 at HD sizes)
/// to RGB, in fixed point.
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8) -> [u8; 3] {
    let c = i32::from(y) - 16;
    let d = i32::from(cb) - 128;
    let e = i32::from(cr) - 128;
    let clamp = |v: i32| ((v + 128) >> 8).clamp(0, 255) as u8;
    [clamp(298 * c + 459 * e), clamp(298 * c - 55 * d - 136 * e), clamp(298 * c + 541 * d)]
}

/// A decoded NV12 picture as RGB: `data` holds `rows` rows of luma `pitch`
/// bytes apart, then the interleaved chroma plane at half height. Only the
/// visible `width` x `height` from the top left is kept (a decoder pads to
/// 16 rows; the padding is not picture). `None` when `data` is too short
/// for what it claims to hold.
#[must_use]
pub fn nv12_to_rgb(data: &[u8], pitch: usize, rows: usize, width: u32, height: u32) -> Option<image::RgbImage> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || pitch < w || rows < h {
        return None;
    }
    let chroma = pitch.checked_mul(rows)?;
    let needed = chroma.checked_add(pitch.checked_mul(h.div_ceil(2))?)?;
    if data.len() < needed {
        return None;
    }
    let mut out = image::RgbImage::new(width, height);
    for (y, row) in out.rows_mut().enumerate() {
        let luma = &data[y * pitch..y * pitch + w];
        let uv = &data[chroma + (y / 2) * pitch..];
        for (x, pixel) in row.enumerate() {
            let pair = (x / 2) * 2;
            pixel.0 = ycbcr_to_rgb(luma[x], uv[pair], uv[pair + 1]);
        }
    }
    Some(out)
}

/// A decoded picture with four bytes a pixel (`RGBx`, GStreamer's
/// `videoconvert` output), rows `stride` bytes apart, as RGB.
#[must_use]
pub fn rgbx_to_rgb(data: &[u8], stride: usize, width: u32, height: u32) -> Option<image::RgbImage> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || stride < w * 4 || data.len() < stride * (h - 1) + w * 4 {
        return None;
    }
    let mut out = image::RgbImage::new(width, height);
    for (y, row) in out.rows_mut().enumerate() {
        let line = &data[y * stride..y * stride + w * 4];
        for (pixel, px) in row.zip(line.chunks_exact(4)) {
            pixel.0 = [px[0], px[1], px[2]];
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_clamped_into_the_video_as_the_helper_does() {
        assert!((clamped_time(1.0, 10.0) - 1.0).abs() < 1e-9);
        assert!((clamped_time(12.0, 10.0) - 9.9).abs() < 1e-9, "past the end is the last frame");
        assert!((clamped_time(-2.0, 10.0)).abs() < 1e-9);
        assert!((clamped_time(f64::NAN, 10.0)).abs() < 1e-9);
        assert!((clamped_time(0.5, 0.05)).abs() < 1e-9, "a video shorter than a frame");
        assert!((clamped_time(3.0, f64::NAN)).abs() < 1e-9);
    }

    #[test]
    fn the_path_and_the_numbers_after_it_are_read() {
        let args: Vec<String> = ["--capture-recorder", "--poster", "C:\\Users\\a b\\Rec 1.mp4", "1.000", "x", "5.5"]
            .iter()
            .map(ToString::to_string)
            .collect();
        let (path, times) = parse_args(&args).unwrap();
        assert_eq!(path, "C:\\Users\\a b\\Rec 1.mp4");
        assert_eq!(times, vec![1.0, 5.5]);
        assert!(parse_args(&["--poster".to_string()]).is_none(), "no video named");
        assert!(parse_args(&["--probe".to_string()]).is_none());
    }

    #[test]
    fn stills_fit_the_long_edge_and_keep_their_shape() {
        assert_eq!(fitted(3840, 2160), (1120, 630));
        assert_eq!(fitted(1080, 1920), (630, 1120), "portrait");
        assert_eq!(fitted(800, 600), (800, 600), "never enlarged");
        assert_eq!(fitted(5000, 2), (1120, 1), "never zero");
        assert_eq!(fitted(0, 0), (0, 0));
    }

    struct Fake {
        duration: f64,
        asked: Vec<f64>,
        gives: fn(f64) -> Option<image::RgbImage>,
    }

    impl StillSource for Fake {
        fn duration(&self) -> f64 {
            self.duration
        }
        fn still_at(&mut self, secs: f64) -> Option<image::RgbImage> {
            self.asked.push(secs);
            (self.gives)(secs)
        }
    }

    fn grey(v: u8) -> image::RgbImage {
        image::RgbImage::from_pixel(1920, 1080, image::Rgb([v, v, v]))
    }

    /// The line is what `capture::poster` reads, keys in the helper's order,
    /// and a still the file cannot give is left out rather than failing the
    /// rest.
    #[test]
    fn the_line_is_the_helpers_and_the_app_reads_it() {
        let mut fake = Fake {
            duration: 4.0,
            asked: Vec::new(),
            gives: |t| (t < 3.0).then(|| grey(if t < 1.5 { 0 } else { 180 })),
        };
        let line = read(&mut fake, &[1.0, 2.0, 30.0]);
        assert_eq!(fake.asked, vec![1.0, 2.0], "nothing is read after the first lit still");
        assert!(line.starts_with(r#"{"duration":4.0,"frames":[{"jpeg":""#), "{}", &line[..60]);
        assert!(line.contains(r#","time":1.0}"#) && line.contains(r#","time":2.0}"#));
        assert!(!line.contains('\n'));

        let frames = crate::capture::poster::parse_frames(&line);
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0].width(), frames[0].height()), (1120, 630), "fitted to the long edge");
        let (kept, lit) = crate::capture::poster::choose(frames).unwrap();
        assert!(lit, "the black first still is skipped for the lit one");
        assert!(!crate::capture::poster::is_blank(&kept));
    }

    /// Every still black (a camera still waking, a display asleep): all the
    /// times are read, each clamped into the file, so the app can show the
    /// first one marked black.
    #[test]
    fn black_stills_are_all_read_and_a_late_time_is_the_last_frame() {
        let mut fake = Fake {
            duration: 4.0,
            asked: Vec::new(),
            gives: |_| Some(grey(0)),
        };
        let line = read(&mut fake, &[1.0, 2.0, 30.0]);
        assert_eq!(fake.asked, vec![1.0, 2.0, 3.9], "the last time was clamped to the end");
        let frames = crate::capture::poster::parse_frames(&line);
        assert_eq!(frames.len(), 3);
        assert!(!crate::capture::poster::choose(frames).unwrap().1, "marked black");
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_empty_answer() {
        assert!(crate::capture::poster::parse_frames(&empty_line()).is_empty());
        let mut fake = Fake {
            duration: f64::NAN,
            asked: Vec::new(),
            gives: |_| None,
        };
        assert_eq!(read(&mut fake, &[1.0]), r#"{"duration":0.0,"frames":[]}"#);
    }

    #[test]
    fn nv12_white_black_and_colour_come_out_right() {
        // 4 x 2 picture, pitch 6, padded to 4 rows like a decoder's 16-row
        // alignment; the padding rows are garbage that must not show.
        let (pitch, rows) = (6usize, 4usize);
        let mut data = vec![0u8; pitch * rows + pitch * rows / 2];
        // Luma: left half white (235), right half black (16).
        for y in 0..2 {
            for x in 0..4 {
                data[y * pitch + x] = if x < 2 { 235 } else { 16 };
            }
        }
        for y in 2..4 {
            for x in 0..pitch {
                data[y * pitch + x] = 99;
            }
        }
        // Chroma neutral everywhere.
        for b in &mut data[pitch * rows..] {
            *b = 128;
        }
        let rgb = nv12_to_rgb(&data, pitch, rows, 4, 2).unwrap();
        assert_eq!(rgb.dimensions(), (4, 2));
        assert_eq!(rgb.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(rgb.get_pixel(3, 1).0, [0, 0, 0]);

        // Pure BT.709 red (Y 63, Cb 102, Cr 240) comes out red.
        let mut red = vec![63u8; 2 * 2];
        red.extend_from_slice(&[102, 240]);
        let px = nv12_to_rgb(&red, 2, 2, 2, 2).unwrap().get_pixel(1, 1).0;
        assert!(px[0] > 240 && px[1] < 15 && px[2] < 15, "{px:?}");
    }

    #[test]
    fn a_short_or_odd_buffer_is_refused_not_read_past() {
        assert!(nv12_to_rgb(&[0; 10], 4, 2, 4, 2).is_none());
        assert!(nv12_to_rgb(&[0; 64], 2, 2, 4, 2).is_none(), "pitch narrower than the picture");
        assert!(nv12_to_rgb(&[0; 64], 4, 2, 0, 2).is_none());
        // Odd height: the last chroma row covers it.
        assert!(nv12_to_rgb(&[128; 4 * 3 + 4 * 2], 4, 3, 4, 3).is_some());
    }

    #[test]
    fn rgbx_rows_with_padding_become_rgb() {
        let stride = 12; // 2 pixels of 4 bytes, plus 4 bytes of padding.
        let data = [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9, 7, 8, 9, 0, 10, 11, 12, 0];
        let rgb = rgbx_to_rgb(&data, stride, 2, 2).unwrap();
        assert_eq!(rgb.get_pixel(1, 0).0, [4, 5, 6]);
        assert_eq!(rgb.get_pixel(1, 1).0, [10, 11, 12]);
        assert!(rgbx_to_rgb(&data[..10], stride, 2, 2).is_none());
    }
}
