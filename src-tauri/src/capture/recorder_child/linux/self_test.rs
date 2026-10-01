//! `--self-test` on Linux: the real GStreamer writer, fed the synthetic
//! source, checked by reading the file back. For the Linux CI lane, where a
//! hosted runner has no desktop or microphone but can install the encoders.
//!
//! It records 3 s, pauses 1 s, records 2 s more and stops, through the same
//! [`Pipeline`] and timeline as a real recording, then demuxes the file with
//! GStreamer and checks: about 5 s long (the pause cut out), one H.264 video
//! stream and one AAC audio stream, an even picture size. It runs on the
//! clock, so it takes about six seconds. A second (ignored) test kills a
//! writer mid-recording and checks the fragments it left still play.

use std::path::Path;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use serde::Serialize;

use super::super::frame::{self, Bgra};
use super::super::linux_plan;
use super::super::mixer::Source;
use super::super::pipeline::Pipeline;
use super::super::synthetic::{self, Synthetic};
use super::super::timeline::Timeline;
use super::super::{Clock, Sample};
use super::capture::appsink;
use super::encoder::GstEncoder;

/// The picture the test records.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;

/// What `--self-test` prints.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub encoder: Option<String>,
    pub duration_secs: f64,
    pub video: bool,
    pub audio: bool,
    pub width: u32,
    pub height: u32,
    pub problems: Vec<String>,
}

/// Record, read back, judge.
#[must_use]
pub fn run() -> Report {
    let path = std::env::temp_dir().join(format!("hippius-recorder-self-test-{}.mp4", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut report = match record(&path, Some(Duration::from_secs(6))) {
        Ok(encoder) => {
            let mut report = read_back(&path);
            report.encoder = Some(encoder.into());
            report
        }
        Err(e) => Report {
            problems: vec![e],
            ..Report::default()
        },
    };
    if (report.duration_secs - 5.0).abs() > 0.3 {
        report.problems.push(format!("{:.2} s long, expected 5 s", report.duration_secs));
    }
    if !report.video {
        report.problems.push("no H.264 video stream".into());
    }
    if !report.audio {
        report.problems.push("no AAC audio stream".into());
    }
    if report.width % 2 != 0 || report.height % 2 != 0 || report.width == 0 {
        report.problems.push(format!("picture {}x{} is not even", report.width, report.height));
    }
    report.ok = report.problems.is_empty();
    let _ = std::fs::remove_file(&path);
    report
}

/// 3 s, a 1 s pause, 2 s, through the real writer; `None` = until killed.
/// Answers the H.264 encoder used.
fn record(path: &Path, length: Option<Duration>) -> Result<&'static str, String> {
    super::init()?;
    let candidates = linux_plan::candidates(super::installed);
    let encoder = GstEncoder::create(path, (WIDTH, HEIGHT), &candidates, true)?;
    let used = encoder.video_encoder;
    let mut pipeline = Pipeline::new(encoder, &[Source::Microphone]);
    let clock = Clock::start();
    let mut source = Synthetic::new(clock);
    let mut timeline = Timeline::new();
    let started = Instant::now();
    let (mut paused, mut resumed) = (false, false);
    let mut picture = Vec::new();
    let mut nv12 = Vec::new();
    while length.is_none_or(|l| started.elapsed() < l) {
        let elapsed = started.elapsed();
        if length.is_some() && !paused && elapsed >= Duration::from_secs(3) {
            timeline.pause(clock.now());
            paused = true;
        }
        if paused && !resumed && elapsed >= Duration::from_secs(4) {
            timeline.resume(clock.now());
            resumed = true;
        }
        match source.next_sample() {
            Sample::Video { time, bar_x } => {
                let Some(placed) = timeline.place(time) else { continue };
                draw(&mut picture, bar_x);
                frame::to_nv12(
                    Bgra {
                        data: &picture,
                        width: synthetic::WIDTH,
                        height: synthetic::HEIGHT,
                        stride: synthetic::WIDTH as usize * 4,
                    },
                    WIDTH,
                    HEIGHT,
                    &mut nv12,
                );
                pipeline.video(placed, std::mem::take(&mut nv12))?;
            }
            Sample::Audio { time, samples } => {
                let Some(placed) = timeline.place(time) else { continue };
                let stereo: Vec<f32> = samples.iter().flat_map(|s| [*s, *s]).collect();
                pipeline.audio(Source::Microphone, placed, &stereo)?;
            }
        }
    }
    let end = timeline.end_time(clock.now(), pipeline.last_video());
    pipeline.finish(end)?;
    Ok(used)
}

/// The synthetic source's moving bar, in BGRA.
fn draw(picture: &mut Vec<u8>, bar_x: u32) {
    let w = synthetic::WIDTH as usize;
    picture.clear();
    picture.resize(w * synthetic::HEIGHT as usize * 4, 0x20);
    let bar = bar_x as usize..(bar_x as usize + 40).min(w);
    for row in picture.chunks_exact_mut(w * 4) {
        for x in bar.clone() {
            row[x * 4..x * 4 + 4].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        }
    }
}

/// Demux the file to its end and say what is in it: how long each track
/// runs and what it is. A file cut short (a killed writer) reads up to where
/// its last whole fragment ends.
fn read_back(path: &Path) -> Report {
    let mut report = Report::default();
    let Some(location) = path.to_str() else {
        report.problems.push("the path is not UTF-8".into());
        return report;
    };
    let description = format!(
        "filesrc location={} ! qtdemux name=d \
         d.video_0 ! queue ! appsink name=v sync=false async=false \
         d.audio_0 ! queue ! appsink name=a sync=false async=false",
        linux_plan::quoted(location)
    );
    let opened = gst::parse::launch(&description)
        .map_err(|e| e.to_string())
        .and_then(|e| e.downcast::<gst::Pipeline>().map_err(|_| "not a pipeline".to_string()));
    let pipeline = match opened {
        Ok(p) => p,
        Err(e) => {
            report.problems.push(format!("the file does not open: {e}"));
            return report;
        }
    };
    let (Ok(video), Ok(audio)) = (appsink(&pipeline, "v"), appsink(&pipeline, "a")) else {
        report.problems.push("the reader has no sinks".into());
        return report;
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        report.problems.push("the file does not play".into());
        return report;
    }
    let deadline = Instant::now() + Duration::from_mins(1);
    let mut video_end = gst::ClockTime::ZERO;
    let mut audio_end = gst::ClockTime::ZERO;
    let mut aac_streams = 0;
    let end_of = |buffer: &gst::BufferRef| buffer.pts().map(|p| p + buffer.duration().unwrap_or(gst::ClockTime::ZERO));
    while Instant::now() < deadline {
        let mut got = false;
        if let Some(sample) = video.try_pull_sample(gst::ClockTime::from_mseconds(20)) {
            got = true;
            if let Some(s) = sample.caps().and_then(|c| c.structure(0)) {
                report.video |= s.name() == "video/x-h264";
                report.width = s.get::<i32>("width").ok().and_then(|w| u32::try_from(w).ok()).unwrap_or(report.width);
                report.height = s.get::<i32>("height").ok().and_then(|h| u32::try_from(h).ok()).unwrap_or(report.height);
            }
            if let Some(end) = sample.buffer().and_then(end_of) {
                video_end = video_end.max(end);
            }
        }
        if let Some(sample) = audio.try_pull_sample(gst::ClockTime::from_mseconds(20)) {
            got = true;
            if !report.audio
                && sample
                    .caps()
                    .and_then(|c| c.structure(0))
                    .is_some_and(|s| s.name() == "audio/mpeg" && s.get::<i32>("mpegversion").ok() == Some(4))
            {
                report.audio = true;
                aac_streams += 1;
            }
            if let Some(end) = sample.buffer().and_then(end_of) {
                audio_end = audio_end.max(end);
            }
        }
        if !got && video.is_eos() && (audio.is_eos() || !report.audio) {
            break;
        }
        // A truncated last fragment ends the read with an error: what came
        // before it is what plays.
        if !got
            && let Some(bus) = pipeline.bus()
            && bus.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos]).is_some()
        {
            break;
        }
    }
    let _ = pipeline.set_state(gst::State::Null);
    if aac_streams > 1 {
        report.problems.push("more than one audio stream".into());
    }
    #[allow(clippy::cast_precision_loss)]
    let secs = video_end.max(audio_end).nseconds() as f64 / 1e9;
    report.duration_secs = secs;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where a killed writer writes, when this test binary is that writer.
    const KILLED_WRITER: &str = "HIPPIUS_RECORDER_KILLED_WRITER";

    fn encoders_installed() -> bool {
        super::super::init().is_ok() && !linux_plan::candidates(super::super::installed).is_empty()
    }

    /// The real GStreamer writer: a paused take comes back 5 s long with
    /// one H.264 and one AAC stream. CI's `rust-linux` installs the plugins
    /// and runs it.
    #[test]
    #[ignore = "needs GStreamer's encoders: cargo test --lib capture::recorder_child::linux -- --ignored"]
    fn the_real_writer_records_a_paused_take_that_reads_back() {
        assert!(encoders_installed(), "install gstreamer1.0-plugins-ugly and gstreamer1.0-libav");
        let report = run();
        assert!(report.ok, "{report:?}");
    }

    /// A writer killed with SIGKILL after 6 s (no Stop, no chance to finish)
    /// leaves fragments that play at least 4 s: what a crashed recorder or
    /// a killed app leaves the user. The test binary runs itself as that
    /// writer.
    #[test]
    #[ignore = "needs GStreamer's encoders: cargo test --lib capture::recorder_child::linux -- --ignored"]
    fn a_killed_writer_leaves_a_file_that_plays() {
        if let Some(path) = std::env::var_os(KILLED_WRITER) {
            // The writer: record until killed.
            let _ = record(Path::new(&path), None);
            return;
        }
        assert!(encoders_installed(), "install gstreamer1.0-plugins-ugly and gstreamer1.0-libav");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("killed recording.mp4");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "capture::recorder_child::linux::self_test::tests::a_killed_writer_leaves_a_file_that_plays",
                "--ignored",
                "--nocapture",
            ])
            .env(KILLED_WRITER, &path)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_secs(6));
        child.kill().unwrap();
        let _ = child.wait();
        let report = read_back(&path);
        assert!(report.video, "{report:?}");
        assert!(report.duration_secs >= 4.0, "only {:.2} s survived: {report:?}", report.duration_secs);
    }
}
