//! What a video file holds, read from the engine's own description of it.
//!
//! The engine ships without `ffprobe` (half the size again), so the stream
//! list comes from `ffmpeg -i <file>`, which prints it to stderr and exits.
//! That listing has kept the same shape for well over a decade; the parser
//! below reads only the lines it needs and ignores everything else:
//!
//! ```text
//! Input #0, asf, from '/path/movie.wmv':
//!   Duration: 00:00:20.78, start: 0.000000, bitrate: 7811 kb/s
//!   Stream #0:0(eng): Audio: wmapro (b[1][0][0] / 0x0162), 48000 Hz, 5.1, fltp, 384 kb/s
//!   Stream #0:1(eng): Video: wmv3 (Main) (WMV3 / 0x33564D57), yuv420p, 1440x1080, 8000 kb/s, SAR 4:3 DAR 16:9, 24 fps, 24 tbr, 1k tbn
//! ```
//!
//! Only lines indented by exactly two spaces count: a file's own metadata
//! (title, comment) is printed at four or more, so a title that reads like a
//! stream line cannot add a stream.

use serde::Serialize;

/// One video stream.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    /// The stream's absolute index in the file (`-map 0:<index>`).
    pub index: u32,
    /// The engine's codec name: `h264`, `hevc`, `wmv3`, `vc1`, `mpeg2video`, ...
    pub codec: String,
    /// The pixel format without its colour detail: `yuv420p`, `yuv420p10le`.
    pub pix_fmt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: Option<f64>,
}

/// One audio stream.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: u32,
    /// `aac`, `mp3`, `ac3`, `wmav2`, `wmapro`, ...
    pub codec: String,
}

/// Everything the preview decision needs about a file.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// The demuxer's names for the container (`asf`, `matroska`, `webm`, ...).
    pub formats: Vec<String>,
    /// Seconds, when the container says.
    pub duration: Option<f64>,
    /// The first real video stream (cover art is skipped).
    pub video: Option<VideoStream>,
    /// The first audio stream.
    pub audio: Option<AudioStream>,
}

/// Parse the stderr of `ffmpeg -hide_banner -i <file>`. Returns `None` when
/// the engine did not recognise the file at all (no `Input #0` line).
#[must_use]
pub fn parse_probe(stderr: &str) -> Option<MediaInfo> {
    let mut info = MediaInfo::default();
    let mut seen_input = false;
    for line in stderr.lines() {
        if let Some(rest) = line.strip_prefix("Input #0, ") {
            seen_input = true;
            // `matroska,webm, from '...'`: the names end at ", from '".
            let names = rest.split(", from '").next().unwrap_or("");
            info.formats = names.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            continue;
        }
        if !seen_input {
            continue;
        }
        // A second input or the output section ends the listing.
        if line.starts_with("Input #") || line.starts_with("Output #") {
            break;
        }
        let Some(body) = line.strip_prefix("  ") else { continue };
        if body.starts_with(' ') {
            continue; // metadata, four or more spaces deep
        }
        if let Some(rest) = body.strip_prefix("Duration: ") {
            info.duration = parse_duration(rest.split(',').next().unwrap_or(""));
        } else if let Some(rest) = body.strip_prefix("Stream #0:") {
            parse_stream(rest, &mut info);
        }
    }
    seen_input.then_some(info)
}

/// `HH:MM:SS.ss` to seconds; `N/A` and garbage are `None`.
fn parse_duration(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = h * 3600.0 + m * 60.0 + sec;
    (total.is_finite() && total > 0.0).then_some(total)
}

/// `1(eng): Video: wmv3 (Main) (...), yuv420p, 1440x1080, ...` (the text
/// after `Stream #0:`).
fn parse_stream(rest: &str, info: &mut MediaInfo) {
    let index_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let Ok(index) = rest[..index_end].parse::<u32>() else { return };
    let Some(colon) = rest.find(": ") else { return };
    let after = &rest[colon + 2..];
    if let Some(spec) = after.strip_prefix("Video: ") {
        if info.video.is_some() || spec.contains("(attached pic)") {
            return;
        }
        let fields = top_level_fields(spec);
        let Some(codec) = fields.first().and_then(|f| f.split_whitespace().next()) else {
            return;
        };
        let pix_fmt = fields
            .get(1)
            .map(|f| f.split('(').next().unwrap_or("").trim().to_string())
            .filter(|f| !f.is_empty());
        let (width, height) = fields.iter().find_map(|f| parse_size(f)).unwrap_or((0, 0));
        let fps = fields
            .iter()
            .find_map(|f| f.strip_suffix(" fps").and_then(|n| n.trim().parse::<f64>().ok()));
        info.video = Some(VideoStream {
            index,
            codec: codec.to_string(),
            pix_fmt,
            width,
            height,
            fps,
        });
    } else if let Some(spec) = after.strip_prefix("Audio: ") {
        if info.audio.is_some() {
            return;
        }
        let Some(codec) = spec.split([' ', ',']).next().filter(|c| !c.is_empty()) else {
            return;
        };
        info.audio = Some(AudioStream {
            index,
            codec: codec.to_string(),
        });
    }
}

/// Split on commas that are not inside parentheses or brackets:
/// `yuv420p(tv, bt709, progressive)` stays one field.
fn top_level_fields(spec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in spec.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => {
                out.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// `1280x720` or `1280x720 [SAR 1:1 DAR 16:9]`.
fn parse_size(field: &str) -> Option<(u32, u32)> {
    let token = field.split_whitespace().next()?;
    let (w, h) = token.split_once('x')?;
    let w: u32 = w.parse().ok()?;
    let h: u32 = h.parse().ok()?;
    (w > 0 && h > 0).then_some((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WMV: &str = "Input #0, asf, from '/x/movie.wmv':
  Metadata:
    WMFSDKVersion   : 9.00.00.2980
    Title           :   Stream #0:9: Video: h264, yuv420p, 9999x9999
  Duration: 00:00:20.78, start: 0.000000, bitrate: 7811 kb/s
  Stream #0:0(eng): Audio: wmapro (b[1][0][0] / 0x0162), 48000 Hz, 5.1, fltp, 384 kb/s
  Stream #0:1(eng): Video: wmv3 (Main) (WMV3 / 0x33564D57), yuv420p, 1440x1080, 8000 kb/s, SAR 4:3 DAR 16:9, 24 fps, 24 tbr, 1k tbn
At least one output file must be specified
";

    #[test]
    fn a_wmv_listing_gives_its_codecs_size_and_duration() {
        let info = parse_probe(WMV).expect("recognised");
        assert_eq!(info.formats, vec!["asf"]);
        assert_eq!(info.duration, Some(20.78));
        let video = info.video.expect("video");
        assert_eq!((video.index, video.codec.as_str()), (1, "wmv3"));
        assert_eq!(video.pix_fmt.as_deref(), Some("yuv420p"));
        assert_eq!((video.width, video.height), (1440, 1080));
        assert_eq!(video.fps, Some(24.0));
        assert_eq!(
            info.audio,
            Some(AudioStream {
                index: 0,
                codec: "wmapro".into()
            })
        );
    }

    /// Metadata is indented deeper than streams, so a title shaped like a
    /// stream line is not a stream.
    #[test]
    fn metadata_never_adds_a_stream() {
        let info = parse_probe(WMV).unwrap();
        assert_ne!(info.video.unwrap().width, 9999);
    }

    #[test]
    fn colour_detail_and_bracketed_aspect_do_not_break_the_fields() {
        let ts = "Input #0, mpegts, from 'a.m2ts':
  Duration: 00:00:10.01, start: 1.400000, bitrate: 3330 kb/s
  Program 1
  Stream #0:0[0x1011]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p10le(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 30 tbr, 90k tbn, start 1.405333
  Stream #0:1[0x1100]: Audio: ac3 (AC-3 / 0x332D4341), 48000 Hz, 5.1(side), fltp, 384 kb/s
";
        let info = parse_probe(ts).unwrap();
        let video = info.video.unwrap();
        assert_eq!(video.codec, "h264");
        assert_eq!(video.pix_fmt.as_deref(), Some("yuv420p10le"));
        assert_eq!((video.width, video.height), (1920, 1080));
        assert_eq!(video.fps, Some(29.97));
        assert_eq!(info.audio.unwrap().codec, "ac3");
    }

    #[test]
    fn matroska_names_both_its_demuxer_names_and_a_cover_is_not_the_video() {
        let mkv = "Input #0, matroska,webm, from 'a, from 'b.mkv':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600, 90k tbr, 90k tbn (attached pic)
  Stream #0:1: Video: mpeg4 (Simple Profile) (xvid / 0x64697678), yuv420p, 640x480 [SAR 1:1 DAR 4:3], 25 fps
";
        let info = parse_probe(mkv).unwrap();
        assert_eq!(info.formats, vec!["matroska", "webm"]);
        assert_eq!(info.duration, None);
        assert_eq!(info.video.unwrap().codec, "mpeg4");
        assert!(info.audio.is_none());
    }

    #[test]
    fn an_unrecognised_file_is_none() {
        assert_eq!(parse_probe("/x/a.wmv: Invalid data found when processing input\n"), None);
        assert_eq!(parse_probe(""), None);
    }

    #[test]
    fn durations_parse_or_are_none() {
        assert_eq!(parse_duration("01:02:03.50"), Some(3723.5));
        assert_eq!(parse_duration("N/A"), None);
        assert_eq!(parse_duration("00:00:00.00"), None);
        assert_eq!(parse_duration("1:2"), None);
    }
}
