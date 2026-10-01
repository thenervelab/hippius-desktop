//! `--poster <video> <seconds>...` on Linux: stills from the finished MP4
//! with GStreamer, for the capture card's picture (the shared rules and the
//! line are [`super::super::poster`]). This is also what gives a Wayland
//! recording a picture at all: Hippius cannot screenshot the screen there,
//! so there is no start screenshot to fall back on.
//!
//! The pipeline decodes with whatever H.264 decoder the distro has
//! (`decodebin`: libav, openh264 or a VA-API one) and converts to `RGBx`;
//! it is prerolled paused, then each time is an accurate flushing seek and
//! the picture the sink prerolls on. Without a decoder the pipeline does not
//! preroll and the line is empty: the card keeps the start screenshot.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::super::linux_plan::quoted;
use super::super::poster::{self, StillSource};
use super::capture::{appsink, bus_error, launch};
use super::say;

/// How long the pipeline may take to preroll and each seek to settle.
const SETTLE: gst::ClockTime = gst::ClockTime::from_seconds(2);
const SINK: &str = "poster";

/// The pipeline for `path`: only the picture is decoded (the sound pad of
/// `decodebin` is left unlinked, which the demuxer allows).
#[must_use]
pub fn pipeline_text(path: &str) -> String {
    format!(
        "filesrc location={} ! decodebin ! videoconvert ! video/x-raw,format=RGBx ! appsink name={SINK} sync=false max-buffers=1",
        quoted(path)
    )
}

/// Print the line for `args` (`... --poster <video> <seconds>...`).
/// Returns the process's exit code.
#[must_use]
pub fn run(args: &[String]) -> i32 {
    let line = match poster::parse_args(args) {
        Some((path, times)) => match Reader::open(&path) {
            Ok(mut reader) => {
                let line = poster::read(&mut reader, &times);
                let _ = reader.pipeline.set_state(gst::State::Null);
                line
            }
            Err(e) => {
                say(&format!("poster: the recording could not be opened: {e}"));
                poster::empty_line()
            }
        },
        None => poster::empty_line(),
    };
    super::super::print_line(&line)
}

struct Reader {
    pipeline: gst::Pipeline,
    sink: gst_app::AppSink,
    duration: f64,
}

impl Reader {
    fn open(path: &str) -> Result<Self, String> {
        super::init()?;
        let pipeline = launch(&pipeline_text(path))?;
        let sink = appsink(&pipeline, SINK)?;
        let failed = |pipeline: &gst::Pipeline| {
            let detail = bus_error(pipeline).unwrap_or_else(|| "it did not preroll".into());
            let _ = pipeline.set_state(gst::State::Null);
            detail
        };
        if pipeline.set_state(gst::State::Paused).is_err() {
            return Err(failed(&pipeline));
        }
        let (changed, _, _) = pipeline.state(SETTLE);
        if changed.is_err() {
            return Err(failed(&pipeline));
        }
        let duration = pipeline.query_duration::<gst::ClockTime>().map_or(0.0, |d| d.nseconds() as f64 / 1e9);
        Ok(Self { pipeline, sink, duration })
    }
}

/// The picture in a prerolled sample, as RGB.
fn picture(sample: &gst::Sample) -> Option<image::RgbImage> {
    let caps = sample.caps()?;
    let s = caps.structure(0)?;
    let width = u32::try_from(s.get::<i32>("width").ok()?).ok()?;
    let height = u32::try_from(s.get::<i32>("height").ok()?).ok()?;
    let buffer = sample.buffer()?;
    let map = buffer.map_readable().ok()?;
    // `RGBx` rows are four bytes a pixel and already 4-byte aligned, so the
    // stride is the width's; a padded buffer says so by its size.
    let stride = if height > 0 { map.size() / height as usize } else { 0 };
    poster::rgbx_to_rgb(map.as_slice(), stride, width, height)
}

impl StillSource for Reader {
    fn duration(&self) -> f64 {
        self.duration
    }

    fn still_at(&mut self, secs: f64) -> Option<image::RgbImage> {
        let at = gst::ClockTime::from_nseconds((secs.max(0.0) * 1e9) as u64);
        self.pipeline.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, at).ok()?;
        let (changed, _, _) = self.pipeline.state(SETTLE);
        changed.ok()?;
        let sample = self.sink.try_pull_preroll(SETTLE)?;
        picture(&sample)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_spaces_and_quotes_is_one_value() {
        let text = pipeline_text("/home/a b/Screen Recording \"1\".mp4");
        assert!(
            text.starts_with(r#"filesrc location="/home/a b/Screen Recording \"1\".mp4" ! decodebin"#),
            "{text}"
        );
        assert!(text.contains("format=RGBx") && text.contains("appsink name=poster"));
    }
}
