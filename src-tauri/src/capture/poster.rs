//! The recording's picture on the capture card, taken from the saved file.
//!
//! It used to be a screenshot of the selection taken as the recorder started
//! (`commands::begin_recording`). That was never what the video shows: the
//! camera bubble moves into what is filmed at that same moment, so it was
//! missing from screen recordings' pictures, and a camera-only recording
//! (the stage window, filmed by window number) got no picture at all. Now
//! the recorder's helper reads stills out of the finished file
//! (`--poster <video> <seconds>...`, AVAssetImageGenerator on macOS), Rust
//! asks for a few moments ([`candidate_times`]) and keeps the first one
//! that is not black ([`choose`]). The start screenshot stays as the
//! fallback where the platform cannot read its own file yet.
//!
//! The rules are pure and tested everywhere; only [`from_recording`] runs a
//! process.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

/// The moment preferred for the picture: late enough that the camera has
/// its first frames and the countdown's last paint is gone, early enough to
/// be what the recording opens on.
pub const PREFERRED_SECS: f64 = 1.0;

/// How long the card waits for a picture from the file before it opens with
/// the fallback. Reading three stills takes about a quarter of a second.
pub const WAIT: Duration = Duration::from_secs(3);

/// Two asked times closer than this are one frame for the purpose of a
/// picture; the helper reads to the nearest frame within a quarter second.
const SAME_MOMENT_SECS: f64 = 0.15;

/// Out of 255. A pixel brighter than this (by luma) is "lit".
const LIT_LUMA: u32 = 24;
/// A picture with fewer lit pixels than this share is treated as black: a
/// camera still waking up, a display asleep, a fade.
const LIT_SHARE: f64 = 0.02;

/// The moments to ask the file for, best first, for a recording about
/// `duration_secs` long (the recorder's elapsed time, pauses left out; the
/// helper clamps each to the file's real length).
///
/// Around one second in (the middle of a shorter one), then the middle,
/// then three quarters in, in case the first ones are black. Each is
/// asked for once.
#[must_use]
pub fn candidate_times(duration_secs: f64) -> Vec<f64> {
    let d = if duration_secs.is_finite() { duration_secs.max(0.0) } else { 0.0 };
    let wanted = [PREFERRED_SECS.min(d / 2.0), d / 2.0, d * 0.75];
    let mut out: Vec<f64> = Vec::with_capacity(wanted.len());
    for t in wanted {
        if !out.iter().any(|seen| (seen - t).abs() < SAME_MOMENT_SECS) {
            out.push(t);
        }
    }
    out
}

/// Whether `image` is (almost) black: fewer than [`LIT_SHARE`] of a sample
/// of its pixels are brighter than [`LIT_LUMA`].
#[must_use]
pub fn is_blank(image: &image::DynamicImage) -> bool {
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();
    if width == 0 || height == 0 {
        return true;
    }
    // About 64 x 64 samples, whatever the size: plenty to tell black apart.
    let step_x = (width / 64).max(1);
    let step_y = (height / 64).max(1);
    let (mut lit, mut seen) = (0u32, 0u32);
    for row in (0..height).step_by(step_y as usize) {
        for col in (0..width).step_by(step_x as usize) {
            let [red, green, blue] = rgb.get_pixel(col, row).0;
            // Rec. 601 luma in integers.
            let luma = (299 * u32::from(red) + 587 * u32::from(green) + 114 * u32::from(blue)) / 1000;
            seen += 1;
            if luma > LIT_LUMA {
                lit += 1;
            }
        }
    }
    f64::from(lit) < f64::from(seen) * LIT_SHARE
}

/// The still to show: the first that is not black, in the order asked, or
/// failing that the first one (marked black). `None` when there are none.
#[must_use]
pub fn choose(frames: Vec<image::DynamicImage>) -> Option<(image::DynamicImage, bool)> {
    let first_lit = frames.iter().position(|f| !is_blank(f));
    let index = first_lit.unwrap_or(0);
    frames.into_iter().nth(index).map(|f| (f, first_lit.is_some()))
}

/// A picture read from the recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Poster {
    /// JPEG `data:` URL, sized for the card.
    pub url: String,
    /// False when every still asked for was black.
    pub lit: bool,
}

/// What the card shows: the file's picture; the start screenshot only when
/// the file gave none or only black ones (a camera-only recording has no
/// start screenshot, and then even a black still is the truth).
#[must_use]
pub fn pick(from_file: Option<Poster>, at_start: Option<String>) -> Option<String> {
    match from_file {
        Some(p) if p.lit => Some(p.url),
        file => at_start.or_else(|| file.map(|p| p.url)),
    }
}

#[derive(Deserialize)]
struct HelperFrame {
    jpeg: String,
}

#[derive(Deserialize)]
struct HelperPosters {
    frames: Vec<HelperFrame>,
}

/// The stills in the helper's one JSON line
/// (`{"duration": d, "frames": [{"time": t, "jpeg": "<base64>"}]}`), in the
/// order asked. Anything unreadable is left out.
#[must_use]
pub fn parse_frames(stdout: &str) -> Vec<image::DynamicImage> {
    let Some(posters) = stdout.lines().find_map(|line| serde_json::from_str::<HelperPosters>(line.trim()).ok()) else {
        return Vec::new();
    };
    posters
        .frames
        .into_iter()
        .filter_map(|f| base64::engine::general_purpose::STANDARD.decode(f.jpeg).ok())
        .filter_map(|bytes| image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).ok())
        .collect()
}

/// The card's picture from the recording at `path`, about `duration_secs`
/// long, or `None` when the platform cannot read stills from its own file
/// (the caller keeps the start screenshot), or the helper fails or takes
/// longer than [`WAIT`]. Blocking.
#[must_use]
pub fn from_recording(path: &Path, duration_secs: f64) -> Option<Poster> {
    let mut command = super::recording::poster_command()?;
    command.arg("--poster").arg(path);
    for t in candidate_times(duration_secs) {
        command.arg(format!("{t:.3}"));
    }
    let stdout = super::recording::helper::output_within(command, WAIT)?;
    let (picked, lit) = choose(parse_frames(&stdout))?;
    let url = super::thumbnail::from_image(&picked).ok()?;
    Some(Poster { url, lit })
}

#[derive(Deserialize)]
struct HelperDuration {
    duration: f64,
}

/// The file's length in seconds from the helper's JSON line, when it gave
/// one that makes sense.
#[must_use]
pub fn parse_duration(stdout: &str) -> Option<f64> {
    stdout
        .lines()
        .find_map(|line| serde_json::from_str::<HelperDuration>(line.trim()).ok())
        .map(|d| d.duration)
        .filter(|d| d.is_finite() && *d >= 0.0)
}

/// Moments asked for when the file's length is not known yet (a saved
/// recording opened later, e.g. a row in the tray popover). The helper
/// clamps each to the real length, so a short file still answers.
pub const UNKNOWN_LENGTH_PROBE_SECS: f64 = 10.0;

/// A still from a saved recording and its length, for a list row's
/// thumbnail. `None` where the platform's helper cannot read stills or it
/// answered nothing usable within `wait`. Blocking.
#[must_use]
pub fn still_from_file(path: &Path, wait: Duration) -> Option<(image::DynamicImage, Option<f64>)> {
    let mut command = super::recording::poster_command()?;
    command.arg("--poster").arg(path);
    for t in candidate_times(UNKNOWN_LENGTH_PROBE_SECS) {
        command.arg(format!("{t:.3}"));
    }
    let stdout = super::recording::helper::output_within(command, wait)?;
    let duration = parse_duration(&stdout);
    let (picked, _lit) = choose(parse_frames(&stdout))?;
    Some((picked, duration))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helpers_duration_is_read_from_its_line() {
        assert_eq!(parse_duration(r#"{"duration": 42.5, "frames": []}"#), Some(42.5));
        // Other output around it (a log line) is skipped.
        assert_eq!(parse_duration("starting\n{\"duration\": 3, \"frames\": []}\n"), Some(3.0));
    }

    #[test]
    fn a_missing_or_nonsense_duration_is_none() {
        assert_eq!(parse_duration(r#"{"frames": []}"#), None);
        assert_eq!(parse_duration(r#"{"duration": -1, "frames": []}"#), None);
        assert_eq!(parse_duration("not json"), None);
        assert_eq!(parse_duration(""), None);
    }

    fn close(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn a_normal_recording_is_pictured_one_second_in_then_the_middle() {
        let times = candidate_times(20.0);
        assert!(close(&times, &[1.0, 10.0, 15.0]), "{times:?}");
    }

    #[test]
    fn a_short_recording_is_pictured_in_its_middle() {
        // Under two seconds the middle comes before one second in.
        assert!(close(&candidate_times(1.0), &[0.5, 0.75]), "{:?}", candidate_times(1.0));
        assert!(close(&candidate_times(1.6), &[0.8, 1.2]), "{:?}", candidate_times(1.6));
    }

    #[test]
    fn an_empty_or_unknown_length_asks_for_the_first_frame_once() {
        assert!(close(&candidate_times(0.0), &[0.0]));
        assert!(close(&candidate_times(f64::NAN), &[0.0]));
        assert!(close(&candidate_times(-3.0), &[0.0]));
    }

    #[test]
    fn every_time_asked_lies_inside_the_recording() {
        for d in [0.3, 1.0, 2.0, 2.4, 7.0, 60.0, 3600.0] {
            for t in candidate_times(d) {
                assert!((0.0..=d).contains(&t), "{t} outside 0..{d}");
            }
        }
    }

    fn solid(w: u32, h: u32, v: u8) -> image::DynamicImage {
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([v, v, v])))
    }

    #[test]
    fn black_and_near_black_stills_are_blank_and_a_picture_is_not() {
        assert!(is_blank(&solid(640, 360, 0)));
        assert!(is_blank(&solid(640, 360, 12)), "a dark encoder grey is still black");
        assert!(!is_blank(&solid(640, 360, 120)));
        assert!(is_blank(&solid(0, 0, 200)));

        // A dark frame with a small lit bubble in a corner is a picture: the
        // bubble alone is what the viewer sees there.
        let mut dark = image::RgbImage::from_pixel(640, 360, image::Rgb([0, 0, 0]));
        for y in 250..350 {
            for x in 10..110 {
                dark.put_pixel(x, y, image::Rgb([200, 170, 150]));
            }
        }
        assert!(!is_blank(&image::DynamicImage::ImageRgb8(dark)));
    }

    #[test]
    fn the_first_still_that_is_not_black_is_kept() {
        let (picked, lit) = choose(vec![solid(8, 8, 0), solid(8, 8, 90), solid(8, 8, 200)]).unwrap();
        assert!(lit);
        assert_eq!(picked.to_rgb8().get_pixel(0, 0).0, [90, 90, 90]);
        let (first, lit) = choose(vec![solid(8, 8, 3), solid(8, 8, 0)]).unwrap();
        assert!(!lit, "all black: the first, marked black");
        assert_eq!(first.to_rgb8().get_pixel(0, 0).0, [3, 3, 3]);
        assert!(choose(Vec::new()).is_none());
    }

    fn poster(url: &str, lit: bool) -> Option<Poster> {
        Some(Poster { url: url.into(), lit })
    }

    #[test]
    fn the_file_wins_and_the_start_screenshot_is_only_a_fallback() {
        let start = Some("start".to_string());
        assert_eq!(pick(poster("file", true), start.clone()).as_deref(), Some("file"));
        assert_eq!(pick(None, start.clone()).as_deref(), Some("start"), "no picture from the file");
        assert_eq!(pick(poster("dark", false), start).as_deref(), Some("start"), "only black stills");
    }

    #[test]
    fn camera_only_gets_the_files_picture_even_without_a_start_screenshot() {
        // Camera only films the stage window: there is no start screenshot.
        assert_eq!(pick(poster("stage", true), None).as_deref(), Some("stage"));
        assert_eq!(pick(poster("dark stage", false), None).as_deref(), Some("dark stage"));
        assert_eq!(pick(None, None), None);
    }

    fn jpeg_base64(v: u8) -> String {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut bytes), 90)
            .encode_image(&solid(16, 9, v).to_rgb8())
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn reads_the_helpers_stills_in_order_and_skips_what_it_cannot_read() {
        let line = serde_json::json!({
            "duration": 4.2,
            "frames": [
                { "time": 1.0, "jpeg": jpeg_base64(0) },
                { "time": 2.1, "jpeg": "not base64!" },
                { "time": 3.1, "jpeg": jpeg_base64(180) },
            ]
        })
        .to_string();
        let frames = parse_frames(&format!("some log line\n{line}\n"));
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0].width(), frames[0].height()), (16, 9));
        // The black one first, then the picture, which is what is kept.
        assert!(is_blank(&frames[0]));
        let (kept, lit) = choose(frames).unwrap();
        assert!(lit && !is_blank(&kept));
    }

    #[test]
    fn an_older_helper_or_a_crash_reads_as_no_stills() {
        assert!(parse_frames("").is_empty());
        assert!(parse_frames("{\"ok\":true,\"event\":\"ready\"}\n").is_empty());
        assert!(parse_frames("[]").is_empty());
    }

    /// Reads the card's picture out of a real recording with the built helper:
    /// `HIPPIUS_POSTER_VIDEO=<file.mp4> cargo test --lib reads_a_real_recordings_picture
    /// -- --ignored` after `macos/build-capture-helper.sh`. Writes the still
    /// beside the video as `<file>.poster.jpg` to look at.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs the helper built and a recording named in HIPPIUS_POSTER_VIDEO"]
    fn reads_a_real_recordings_picture() {
        let video = std::path::PathBuf::from(std::env::var("HIPPIUS_POSTER_VIDEO").expect("HIPPIUS_POSTER_VIDEO"));
        let started = std::time::Instant::now();
        let poster = from_recording(&video, 10.0).expect("a picture from the file");
        let elapsed = started.elapsed();
        assert!(poster.lit, "every still was black");
        assert!(elapsed < WAIT, "took {elapsed:?}");
        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(poster.url.trim_start_matches("data:image/jpeg;base64,"))
            .unwrap();
        let mut out = video.clone().into_os_string();
        out.push(".poster.jpg");
        std::fs::write(&out, jpeg).unwrap();
    }

    /// The helper's flag and output, pinned against its source: a rename on
    /// either side would quietly leave every card without a picture.
    #[test]
    fn the_helper_speaks_the_same_poster_flag_and_line() {
        let main = include_str!("../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        let poster = include_str!("../../../macos/HippiusCapture/Sources/Poster.swift");
        assert!(main.contains("arguments.contains(\"--poster\")"));
        assert!(poster.contains("\"frames\": frames.map { [\"time\": $0.0, \"jpeg\": $0.1] }"));
        assert!(poster.contains("appliesPreferredTrackTransform = true"));
    }
}
