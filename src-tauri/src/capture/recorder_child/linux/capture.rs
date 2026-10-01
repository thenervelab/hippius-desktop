//! The capture pipelines: one for the picture, one per sound device, each
//! pulled by the one thread that owns it. Samples leave stamped on the
//! capture clock and placed on the pause timeline; the writer does the rest.
//!
//! The picture is the screen (`ximagesrc`, the portal's `pipewiresrc`), a
//! window with the bubble drawn in, a Wayland area cut out of its monitor
//! ([`Held`]), or (camera only on Wayland) the camera itself
//! ([`Video::start_camera`]).

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::super::linux_plan::{self, VideoEnd, VideoSource};
use super::super::mixer::Source;
use super::super::pacing::Gate;
use super::super::plan::{self, PixelRect};
use super::super::writer_loop::{Msg, Shared};
use super::{installed, say};
use crate::capture::recording::protocol::CameraPick;

/// How long one pull waits before the thread looks at its stop flag and its
/// pipeline's bus again.
const PULL: gst::ClockTime = gst::ClockTime::from_mseconds(100);
/// How long a source may take to open (a device, the X server, PipeWire).
const OPEN_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(5);
/// How long a camera may stay busy while the stage page lets go of it, and
/// how long its first picture may take once open.
const CAMERA_FREE_WITHIN: Duration = Duration::from_secs(3);
const CAMERA_FIRST_PICTURE: Duration = Duration::from_secs(5);
/// How long a held stream's first picture may take (a portal stream can
/// take a moment to negotiate).
const FIRST_PICTURE_WITHIN: Duration = Duration::from_secs(15);

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
                move || {
                    let ended = |end: &VideoEnd| linux_plan::ended_reason(&source, end);
                    pull_video(&pipeline, &sink, &filter, source.known_size(), &ended, &shared, &stop);
                }
            })
            .map_err(|e| format!("could not start the capture thread: {e}"))?;
        Ok(Self(Running {
            pipeline,
            stop,
            thread: Some(thread),
        }))
    }

    /// A window recording with the camera bubble drawn in (X11), as the
    /// Windows recorder does it: `ximagesrc` films one window, so the
    /// bubble (another window, always on top) is read from the X server on
    /// each picture and drawn where it sits over the recorded window
    /// ([`overlay`]), only its round or rounded shape, and not while the
    /// pill has hidden it. Anything that keeps the bubble from being read
    /// falls back to the window alone, with a stderr line.
    pub fn start_with_camera(source: VideoSource, camera_xid: u32, scale: f64, shared: Arc<Shared>) -> Result<Self, String> {
        let VideoSource::X11Window { xid, .. } = source else {
            return Self::start(source, shared);
        };
        let reader = match crate::capture::linux_x11::WindowReader::open() {
            Ok(reader) => reader,
            Err(e) => {
                say(&format!("the camera bubble cannot be added to the window recording: {e}"));
                return Self::start(source, shared);
            }
        };
        let pipeline = launch(&linux_plan::video_capture_bgrx(&source))?;
        let sink = appsink(&pipeline, linux_plan::VIDEO_SINK)?;
        play(&pipeline).map_err(|detail| {
            say(&format!("the window could not be read: {detail}"));
            "The window to record has closed.".to_string()
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("capture-video".into())
            .spawn({
                let pipeline = pipeline.clone();
                let stop = Arc::clone(&stop);
                move || {
                    let mut composer = Composer {
                        reader,
                        window: xid,
                        camera: camera_xid,
                        scale,
                        size: None,
                        gate: Gate::new(),
                        composed: Vec::new(),
                    };
                    pull_composed(&pipeline, &sink, &source, &mut composer, &shared, &stop);
                }
            })
            .map_err(|e| format!("could not start the capture thread: {e}"))?;
        Ok(Self(Running {
            pipeline,
            stop,
            thread: Some(thread),
        }))
    }

    /// Camera only where no window can be filmed (Wayland): the camera the
    /// bubble showed, opened from GStreamer's own device (the element
    /// WebKitGTK would make for it), mirrored and sized like any picture.
    /// The stage page is letting go of it as this runs, so a busy camera is
    /// tried again for [`CAMERA_FREE_WITHIN`]; a camera that offers nothing
    /// at a bounded size and rate is opened at whatever it offers.
    pub fn start_camera(pick: &CameraPick, shared: Arc<Shared>) -> Result<Self, String> {
        const NOT_OPENED: &str = "The camera could not be opened. Check it is connected and not in use by another app.";
        let monitor = gst::DeviceMonitor::new();
        let _ = monitor.add_filter(Some("Video/Source"), None);
        if monitor.start().is_err() {
            say("the camera list could not be read");
            return Err(NOT_OPENED.into());
        }
        let devices: Vec<gst::Device> = monitor.devices().into_iter().filter(|d| d.has_classes("Video/Source")).collect();
        monitor.stop();
        let found: Vec<linux_plan::RawCamera> = devices.iter().map(super::devices::raw_camera).collect();
        let (index, chosen) = linux_plan::pick_camera(&found, pick).ok_or("No camera is connected.")?;
        if !chosen {
            say("the chosen camera is not connected; recording the default camera");
        }
        let device = &devices[index];
        let jpeg = installed(linux_plan::JPEG_DECODER);
        let deadline = Instant::now() + CAMERA_FREE_WITHIN;
        let mut constrained = true;
        let (pipeline, sink, filter) = loop {
            match open_camera(device, constrained, jpeg) {
                Ok(opened) => break opened,
                Err(detail) if constrained => {
                    say(&format!("the camera did not start at a bounded size, trying any: {detail}"));
                    constrained = false;
                }
                Err(detail) if Instant::now() < deadline => {
                    say(&format!("the camera is not free yet: {detail}"));
                    std::thread::sleep(Duration::from_millis(250));
                    constrained = true;
                }
                Err(detail) => {
                    say(&format!("the camera could not be opened: {detail}"));
                    return Err(NOT_OPENED.into());
                }
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("capture-camera".into())
            .spawn({
                let pipeline = pipeline.clone();
                let stop = Arc::clone(&stop);
                move || {
                    let ended = |_: &VideoEnd| linux_plan::CAMERA_ENDED.to_string();
                    pull_video(&pipeline, &sink, &filter, None, &ended, &shared, &stop);
                }
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

/// `device`'s element linked into the camera pipeline
/// (`linux_plan::camera_capture_tail`), playing, with a first picture seen:
/// a camera whose caps do not negotiate fails here, not mid-recording.
fn open_camera(device: &gst::Device, constrained: bool, jpeg: bool) -> Result<(gst::Pipeline, gst_app::AppSink, gst::Element), String> {
    let pipeline = launch(&linux_plan::camera_capture_tail(constrained, jpeg))?;
    let source = device.create_element(None).map_err(|e| format!("no element for the camera: {e}"))?;
    let input = pipeline.by_name(linux_plan::CAMERA_IN).ok_or("the camera pipeline has no input")?;
    pipeline.add(&source).map_err(|e| format!("the camera could not be added: {e}"))?;
    source.link(&input).map_err(|e| format!("the camera could not be linked: {e}"))?;
    let sink = appsink(&pipeline, linux_plan::VIDEO_SINK)?;
    let filter = pipeline.by_name(linux_plan::SIZE_FILTER).ok_or("the pipeline has no size filter")?;
    play(&pipeline)?;
    let deadline = Instant::now() + CAMERA_FIRST_PICTURE;
    loop {
        if let Some(detail) = bus_error(&pipeline) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(detail);
        }
        if sink.try_pull_sample(PULL).is_some() {
            return Ok((pipeline, sink, filter));
        }
        if Instant::now() >= deadline {
            let _ = pipeline.set_state(gst::State::Null);
            return Err("no picture from the camera".into());
        }
    }
}

/// The first picture of a held stream, BGRx, rows `width * 4` bytes apart.
pub struct FirstPicture {
    pub bgrx: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Where a held stream's pictures go once the area is known.
struct CropTarget {
    shared: Arc<Shared>,
    area: PixelRect,
    out: (u32, u32),
}

/// A Wayland area's monitor, open and read whole, while the area is drawn
/// on its first picture: later pictures are dropped until
/// [`Held::release`] names the area, then each is cut to it (the stream's
/// own pixels, `frame::to_nv12` reading the area's rows in place) and sent
/// to the writer at the area's size. Nothing renegotiates mid-stream.
pub struct Held {
    running: Running,
    target: Arc<Mutex<Option<CropTarget>>>,
    /// Why the stream ended while the area was being drawn.
    ended: Arc<Mutex<Option<String>>>,
}

impl Held {
    /// Open `source` and wait for its first picture.
    pub fn start(source: VideoSource) -> Result<(Self, FirstPicture), String> {
        let pipeline = launch(&linux_plan::video_capture_bgrx(&source))?;
        let sink = appsink(&pipeline, linux_plan::VIDEO_SINK)?;
        play(&pipeline).map_err(|detail| {
            say(&format!("the screen could not be read: {detail}"));
            "The screen could not be read.".to_string()
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let target: Arc<Mutex<Option<CropTarget>>> = Arc::new(Mutex::new(None));
        let ended = Arc::new(Mutex::new(None));
        let (first_tx, first_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("capture-video".into())
            .spawn({
                let pipeline = pipeline.clone();
                let stop = Arc::clone(&stop);
                let target = Arc::clone(&target);
                let ended = Arc::clone(&ended);
                move || pull_held(&pipeline, &sink, &source, &target, &ended, first_tx, &stop)
            })
            .map_err(|e| format!("could not start the capture thread: {e}"))?;
        let running = Running {
            pipeline,
            stop,
            thread: Some(thread),
        };
        if let Ok(first) = first_rx.recv_timeout(FIRST_PICTURE_WITHIN) {
            Ok((Self { running, target, ended }, first))
        } else {
            running.stop();
            Err("The screen sent no picture to record.".into())
        }
    }

    /// Record `area` from now on, through `shared`.
    pub fn release(self, area: PixelRect, shared: Arc<Shared>) -> Result<Video, String> {
        if let Some(reason) = self.ended.lock().unwrap_or_else(PoisonError::into_inner).clone() {
            self.running.stop();
            return Err(reason);
        }
        *self.target.lock().unwrap_or_else(PoisonError::into_inner) = Some(CropTarget {
            shared,
            area,
            out: plan::output_size(area.width(), area.height()),
        });
        Ok(Video(self.running))
    }

    pub fn stop(self) {
        self.running.stop();
    }
}

/// The held stream's thread: the first picture out, then nothing until the
/// area is known, then pull, stamp, place, pace, cut, send.
fn pull_held(
    pipeline: &gst::Pipeline,
    sink: &gst_app::AppSink,
    source: &VideoSource,
    target: &Mutex<Option<CropTarget>>,
    ended_early: &Mutex<Option<String>>,
    first: mpsc::Sender<FirstPicture>,
    stop: &AtomicBool,
) {
    let mut first = Some(first);
    let mut gate = Gate::new();
    let mut quiet = Quiet { last: None };
    let finish = |end: &VideoEnd| {
        let reason = linux_plan::ended_reason(source, end);
        match target.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            Some(t) => {
                t.shared.send(Msg::Ended(reason));
            }
            None => *ended_early.lock().unwrap_or_else(PoisonError::into_inner) = Some(reason),
        }
    };
    while !stop.load(Ordering::SeqCst) {
        if let Some(end) = ended(pipeline) {
            if let VideoEnd::Error(detail) = &end {
                say(&format!("the picture's pipeline failed: {detail}"));
            }
            finish(&end);
            return;
        }
        let Some(sample) = sink.try_pull_sample(PULL) else {
            if sink.is_eos() {
                finish(&VideoEnd::Eos);
                return;
            }
            continue;
        };
        let Some((w, h)) = sample_size(&sample) else { continue };
        let Some(buffer) = sample.buffer() else { continue };
        let Ok(map) = buffer.map_readable() else { continue };
        let stride = w as usize * 4;
        let bytes = map.as_slice();
        if bytes.len() < stride * h as usize {
            continue;
        }
        if let Some(tx) = first.take() {
            let _ = tx.send(FirstPicture {
                bgrx: bytes[..stride * h as usize].to_vec(),
                width: w,
                height: h,
            });
        }
        let guard = target.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(t) = guard.as_ref() else { continue };
        // A monitor whose resolution changed keeps what is left of the area.
        let Some(area) = t.area.within(w, h) else { continue };
        let Some(time) = micros_of(pipeline, buffer.pts()) else { continue };
        let Some(placed) = t.shared.place(time) else { continue };
        if !gate.accept(placed) {
            continue;
        }
        let at = area.y0 as usize * stride + area.x0 as usize * 4;
        let mut nv12 = Vec::new();
        super::super::frame::to_nv12(
            super::super::frame::Bgra {
                data: &bytes[at..],
                width: area.width(),
                height: area.height(),
                stride,
            },
            t.out.0,
            t.out.1,
            &mut nv12,
        );
        if !t.shared.send_frame(placed, nv12, t.out) {
            quiet.say("the writer is behind; pictures are being dropped");
        }
    }
}

/// How the picture's pipeline ended on its own, if it did.
fn ended(pipeline: &gst::Pipeline) -> Option<VideoEnd> {
    pipeline
        .bus()?
        .pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos])
        .map(|msg| match msg.view() {
            gst::MessageView::Error(err) => VideoEnd::Error(err.error().to_string()),
            _ => VideoEnd::Eos,
        })
}

/// The recorded window and the bubble drawn into it.
struct Composer {
    reader: crate::capture::linux_x11::WindowReader,
    window: u32,
    camera: u32,
    /// The screen's one scale: the bubble page's CSS pixels to the window's.
    scale: f64,
    size: Option<(u32, u32)>,
    gate: Gate,
    composed: Vec<u8>,
}

impl Composer {
    /// The window's picture (`w` x `h` BGRx) with the bubble drawn where it
    /// sits, as NV12 at the recording's size.
    fn compose(&mut self, picture: &[u8], w: u32, h: u32) -> (Vec<u8>, (u32, u32)) {
        use super::super::frame::{self, Bgra};
        use super::super::overlay::{self, Pixels, Rect};

        let out = *self.size.get_or_insert_with(|| plan::output_size(w, h));
        self.composed.clear();
        self.composed.extend_from_slice(picture);
        let rect = |f: crate::capture::targets::NativeFrame| Rect {
            x: f.x,
            y: f.y,
            width: i32::try_from(f.width).unwrap_or(i32::MAX),
            height: i32::try_from(f.height).unwrap_or(i32::MAX),
        };
        // The pill hides the bubble by unmapping it: no placement, no bubble.
        if let (Some(on_screen), Some(bubble)) = (self.reader.placement(self.window), self.reader.placement(self.camera))
            && let Some(camera) = self.reader.pixels(self.camera, bubble.width, bubble.height)
        {
            let mut bgra = camera.into_raw();
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            let at = overlay::placement(rect(on_screen), rect(bubble), (w, h));
            let shape = overlay::bubble_shape(bubble.width, bubble.height, self.scale);
            overlay::composite(
                &mut self.composed,
                w,
                h,
                w as usize * 4,
                Pixels {
                    data: &bgra,
                    width: bubble.width,
                    height: bubble.height,
                    stride: bubble.width as usize * 4,
                },
                at,
                shape,
            );
        }
        let mut nv12 = Vec::new();
        frame::to_nv12(
            Bgra {
                data: &self.composed,
                width: w,
                height: h,
                stride: w as usize * 4,
            },
            out.0,
            out.1,
            &mut nv12,
        );
        (nv12, out)
    }
}

/// The picture thread with the bubble: pull, stamp, place, pace, compose,
/// send.
fn pull_composed(
    pipeline: &gst::Pipeline,
    sink: &gst_app::AppSink,
    source: &VideoSource,
    composer: &mut Composer,
    shared: &Shared,
    stop: &AtomicBool,
) {
    let mut quiet = Quiet { last: None };
    while !stop.load(Ordering::SeqCst) {
        if let Some(end) = ended(pipeline) {
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
        let Some(buffer) = sample.buffer() else { continue };
        let Some(time) = micros_of(pipeline, buffer.pts()) else { continue };
        let Some(placed) = shared.place(time) else { continue };
        if !composer.gate.accept(placed) {
            continue;
        }
        let Ok(map) = buffer.map_readable() else { continue };
        if map.as_slice().len() < w as usize * h as usize * 4 {
            continue;
        }
        let (nv12, out) = composer.compose(map.as_slice(), w, h);
        if !shared.send_frame(placed, nv12, out) {
            quiet.say("the writer is behind; pictures are being dropped");
        }
    }
}

/// The picture thread: pull, size, stamp, place, pace, send. `known` is
/// the picture's size when the source says it up front; `ended_reason`
/// words a stream that stopped on its own.
fn pull_video(
    pipeline: &gst::Pipeline,
    sink: &gst_app::AppSink,
    filter: &gst::Element,
    known: Option<(u32, u32)>,
    ended_reason: &dyn Fn(&VideoEnd) -> String,
    shared: &Shared,
    stop: &AtomicBool,
) {
    let mut size = known.map(|(w, h)| plan::output_size(w, h));
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
            shared.send(Msg::Ended(ended_reason(&end)));
            return;
        }
        let Some(sample) = sink.try_pull_sample(PULL) else {
            if sink.is_eos() {
                shared.send(Msg::Ended(ended_reason(&VideoEnd::Eos)));
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
