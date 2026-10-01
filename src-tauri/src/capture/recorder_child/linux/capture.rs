//! The capture pipelines: one for the picture, one per sound device, each
//! pulled by the one thread that owns it. Samples leave stamped on the
//! capture clock and placed on the pause timeline; the writer does the rest.

use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::super::linux_plan::{self, VideoEnd, VideoSource};
use super::super::mixer::Source;
use super::super::pacing::Gate;
use super::super::plan;
use super::super::writer_loop::{Msg, Shared};
use super::say;

/// How long one pull waits before the thread looks at its stop flag and its
/// pipeline's bus again.
const PULL: gst::ClockTime = gst::ClockTime::from_mseconds(100);
/// How long a source may take to open (a device, the X server, PipeWire).
const OPEN_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(5);

/// A pipeline from its gst-launch text, on the system clock every capture
/// pipeline shares.
pub(crate) fn launch(description: &str) -> Result<gst::Pipeline, String> {
    let element = gst::parse::launch(description).map_err(|e| format!("could not build the pipeline: {e}"))?;
    let pipeline = element
        .downcast::<gst::Pipeline>()
        .map_err(|_| "the pipeline is not a pipeline".to_string())?;
    pipeline.use_clock(Some(&gst::SystemClock::obtain()));
    Ok(pipeline)
}

pub(crate) fn appsink(pipeline: &gst::Pipeline, name: &str) -> Result<gst_app::AppSink, String> {
    pipeline
        .by_name(name)
        .and_then(|e| e.downcast::<gst_app::AppSink>().ok())
        .ok_or_else(|| format!("the pipeline has no {name} sink"))
}

/// The first error on `pipeline`'s bus, if any, as text for the log.
pub(crate) fn bus_error(pipeline: &gst::Pipeline) -> Option<String> {
    let bus = pipeline.bus()?;
    let msg = bus.pop_filtered(&[gst::MessageType::Error])?;
    match msg.view() {
        gst::MessageView::Error(err) => Some(format!("{} ({})", err.error(), err.debug().map(|d| d.to_string()).unwrap_or_default())),
        _ => None,
    }
}

/// Start `pipeline` and wait until its source has opened, or say why not.
pub(crate) fn play(pipeline: &gst::Pipeline) -> Result<(), String> {
    let failed = |pipeline: &gst::Pipeline| {
        let detail = bus_error(pipeline).unwrap_or_else(|| "it did not start".into());
        let _ = pipeline.set_state(gst::State::Null);
        detail
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        return Err(failed(pipeline));
    }
    let (changed, _, _) = pipeline.state(OPEN_WITHIN);
    if changed.is_err() {
        return Err(failed(pipeline));
    }
    Ok(())
}

/// Where a buffer sits on the capture clock, in microseconds: its
/// pipeline's base time plus its timestamp.
fn micros_of(pipeline: &gst::Pipeline, pts: Option<gst::ClockTime>) -> Option<u64> {
    let at = pipeline.base_time()?.checked_add(pts?)?;
    Some(at.nseconds() / 1000)
}

/// Throttled stderr: at most one line every few seconds per thread.
struct Quiet {
    last: Option<Instant>,
}

impl Quiet {
    const EVERY: Duration = Duration::from_secs(5);

    fn say(&mut self, line: &str) {
        if self.last.is_none_or(|t| t.elapsed() >= Self::EVERY) {
            self.last = Some(Instant::now());
            say(line);
        }
    }
}

/// A running capture: its pipeline, its thread and the flag that stops it.
struct Running {
    pipeline: gst::Pipeline,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// The picture.
pub struct Video(Running);

impl Video {
    /// Open `source` and start sending its pictures to the writer.
    pub fn start(source: VideoSource, shared: Arc<Shared>) -> Result<Self, String> {
        let pipeline = launch(&linux_plan::video_capture(&source))?;
        let sink = appsink(&pipeline, linux_plan::VIDEO_SINK)?;
        let filter = pipeline.by_name(linux_plan::SIZE_FILTER).ok_or("the pipeline has no size filter")?;
        play(&pipeline).map_err(|detail| {
            say(&format!("the screen could not be read: {detail}"));
            match source {
                VideoSource::X11Window { .. } => "The window to record has closed.".to_string(),
                VideoSource::X11Area { .. } | VideoSource::Portal { .. } => "The screen could not be read.".to_string(),
            }
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("capture-video".into())
            .spawn({
                let pipeline = pipeline.clone();
                let stop = Arc::clone(&stop);
                move || pull_video(&pipeline, &sink, &filter, &source, &shared, &stop)
            })
            .map_err(|e| format!("could not start the capture thread: {e}"))?;
        Ok(Self(Running {
            pipeline,
            stop,
            thread: Some(thread),
        }))
    }

    pub fn stop(self) {
        self.0.stop();
    }
}

/// The picture thread: pull, size, stamp, place, pace, send.
fn pull_video(pipeline: &gst::Pipeline, sink: &gst_app::AppSink, filter: &gst::Element, source: &VideoSource, shared: &Shared, stop: &AtomicBool) {
    let mut size = source.known_size().map(|(w, h)| plan::output_size(w, h));
    let mut gate = Gate::new();
    let mut quiet = Quiet { last: None };
    let bus = pipeline.bus();
    while !stop.load(Ordering::SeqCst) {
        if let Some(end) = bus
            .as_ref()
            .and_then(|b| b.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos]))
            .map(|msg| match msg.view() {
                gst::MessageView::Error(err) => VideoEnd::Error(err.error().to_string()),
                _ => VideoEnd::Eos,
            })
        {
            if let VideoEnd::Error(detail) = &end {
                say(&format!("the picture's pipeline failed: {detail}"));
            }
            shared.send(Msg::Ended(linux_plan::ended_reason(source, &end)));
            return;
        }
        let Some(sample) = sink.try_pull_sample(PULL) else {
            if sink.is_eos() {
                shared.send(Msg::Ended(linux_plan::ended_reason(source, &VideoEnd::Eos)));
                return;
            }
            continue;
        };
        let Some((w, h)) = sample_size(&sample) else { continue };
        let out = *size.get_or_insert_with(|| {
            // The first picture says the size; the recording keeps it, and a
            // window that changes shape later is letterboxed into it.
            let out = plan::output_size(w, h);
            if let Ok(caps) = gst::Caps::from_str(&linux_plan::sized_caps(out.0, out.1)) {
                filter.set_property("caps", &caps);
            }
            out
        });
        if (w, h) != out {
            // A picture from before the filter took the recording's size.
            continue;
        }
        let Some(buffer) = sample.buffer() else { continue };
        let Some(time) = micros_of(pipeline, buffer.pts()) else { continue };
        let Some(placed) = shared.place(time) else { continue };
        if !gate.accept(placed) {
            continue;
        }
        let Ok(map) = buffer.map_readable() else { continue };
        if !shared.send_frame(placed, map.as_slice().to_vec(), out) {
            quiet.say("the writer is behind; pictures are being dropped");
        }
    }
}

fn sample_size(sample: &gst::Sample) -> Option<(u32, u32)> {
    let caps = sample.caps()?;
    let s = caps.structure(0)?;
    let w = u32::try_from(s.get::<i32>("width").ok()?).ok()?;
    let h = u32::try_from(s.get::<i32>("height").ok()?).ok()?;
    Some((w, h))
}

/// One sound device.
pub struct Audio(Running);

impl Audio {
    /// Open `device` (a PulseAudio source name; `None` = the default input)
    /// and start sending its sound to the writer as `source`. `lost` is
    /// called once if the device goes away mid-recording (the app is told
    /// `device_lost`, as on Windows).
    pub fn start(device: Option<&str>, source: Source, shared: Arc<Shared>, lost: impl FnOnce(&str) + Send + 'static) -> Result<Self, String> {
        let pipeline = launch(&linux_plan::audio_capture(device))?;
        let sink = appsink(&pipeline, linux_plan::AUDIO_SINK)?;
        play(&pipeline)?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("capture-audio".into())
            .spawn({
                let pipeline = pipeline.clone();
                let stop = Arc::clone(&stop);
                move || {
                    if let Err(reason) = pull_audio(&pipeline, &sink, source, &shared, &stop) {
                        lost(&reason);
                    }
                }
            })
            .map_err(|e| format!("could not start the audio thread: {e}"))?;
        Ok(Self(Running {
            pipeline,
            stop,
            thread: Some(thread),
        }))
    }

    pub fn stop(self) {
        self.0.stop();
    }
}

/// Little-endian float samples from a buffer's bytes.
pub(crate) fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// A sound thread: pull, stamp, place, send. A device that fails (unplugged)
/// ends only this thread with the reason; the recording goes on without it.
fn pull_audio(pipeline: &gst::Pipeline, sink: &gst_app::AppSink, source: Source, shared: &Shared, stop: &AtomicBool) -> Result<(), String> {
    while !stop.load(Ordering::SeqCst) {
        if let Some(detail) = bus_error(pipeline) {
            say(&format!("a sound source stopped, recording goes on without it: {detail}"));
            return Err(detail);
        }
        let Some(sample) = sink.try_pull_sample(PULL) else {
            if sink.is_eos() {
                say("a sound source ended, recording goes on without it");
                return Err("the source ended".into());
            }
            continue;
        };
        let Some(buffer) = sample.buffer() else { continue };
        let Some(time) = micros_of(pipeline, buffer.pts()) else { continue };
        let Some(placed) = shared.place(time) else { continue };
        let Ok(map) = buffer.map_readable() else { continue };
        let samples = floats(map.as_slice());
        if samples.is_empty() {
            continue;
        }
        if !shared.send(Msg::Audio {
            source,
            time: placed,
            samples,
        }) {
            return Ok(());
        }
    }
    Ok(())
}
