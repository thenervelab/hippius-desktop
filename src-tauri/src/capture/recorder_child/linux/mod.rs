//! The Linux recorder: the picture from X11 (`ximagesrc`) or from the
//! Wayland ScreenCast portal's PipeWire stream (`pipewiresrc`), the
//! microphone and the system's sound from PulseAudio or PipeWire
//! (`pulsesrc`), into a fragmented MP4 with H.264 and one AAC track, all in
//! the recorder child and all through the distro's GStreamer.
//!
//! Threads, and who owns what (the Windows recorder's rule):
//!
//! - **The picture** ([`capture::Video`]): its own GStreamer pipeline and the
//!   one thread that pulls from it. Each picture is stamped on the capture
//!   clock, placed on the pause timeline, thinned to 30 fps and sent to the
//!   writer at the recording's fixed size.
//! - **Sound** ([`capture::Audio`]): one pipeline and one thread per device,
//!   the microphone the user chose and, when system audio is on, the default
//!   output's monitor. A device that cannot open is left out with a stderr
//!   line; a device lost mid-recording ends only its own thread.
//! - **The writer** ([`super::writer_loop`]): one thread owns the encoding
//!   pipeline ([`encoder::GstEncoder`]) and the mixer; nothing else touches
//!   the file.
//! - **The camera** is opened here only for camera only on Wayland, where
//!   there is no window to film ([`capture::Video::start_camera`]); the
//!   stage page has let go of it by then (the app tells it to as Record is
//!   pressed), and the open retries briefly while the device is still
//!   busy. Everywhere else the bubble's webview owns it and is filmed as a
//!   window. Either way every device has one owner.
//! - **A Wayland area** ([`AreaPicking`]): the monitor's stream is open and
//!   its first picture goes to the app to draw the area on; later pictures
//!   are held back and no sound is open until `crop`, which starts the
//!   recording as a plain `start` would, cutting the area out of each
//!   picture in Rust ([`capture::Held`]).
//! - **The desktop** ([`portal::Desktop`]): on Wayland the ScreenCast
//!   session belongs to this process's D-Bus connection, so if the child
//!   dies the desktop's "sharing" indicator goes with it. Both sessions ask
//!   the Inhibit portal to keep the screen from blanking while recording.
//!
//! Every pipeline runs on GStreamer's monotonic system clock, so a buffer's
//! time is its pipeline's base time plus its timestamp, comparable across
//! the picture and every sound, and pause and resume read the same clock.

pub mod capture;
pub mod devices;
pub mod encoder;
pub mod meter;
pub mod portal;
pub mod poster;
pub mod probe;
pub mod self_test;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;

use super::linux_plan;
use super::mixer::Source;
use super::writer_loop::{self, Msg, Shared};
use super::{Begun, Live, Output, Picking, Started};
use crate::capture::recording::RecordingUnavailable;
use crate::capture::recording::protocol::{self, StartCommand};
use crate::capture::rollout::{Platform, current_platform};

/// How long the first picture may take after the source starts (a portal
/// stream can take a moment to negotiate).
const FIRST_FRAME_WITHIN: Duration = Duration::from_secs(15);
/// Finishing the file is time-boxed; fragments already written still play.
const FINISH_WITHIN: Duration = Duration::from_secs(30);

/// Diagnostics go to stderr, which the app logs at `warn`.
pub(crate) fn say(line: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// Start GStreamer once (idempotent); its error is the codec line, since
/// without GStreamer nothing records.
pub(crate) fn init() -> Result<(), String> {
    gst::init().map_err(|e| {
        say(&format!("GStreamer did not start: {e}"));
        RecordingUnavailable::CodecsMissing.message().to_string()
    })
}

/// The capture clock in microseconds: GStreamer's system clock, which every
/// pipeline here is told to use.
pub(crate) fn clock_micros() -> u64 {
    gst::SystemClock::obtain().time().nseconds() / 1000
}

/// Whether this element is installed.
pub(crate) fn installed(name: &str) -> bool {
    gst::ElementFactory::find(name).is_some()
}

/// Start recording what `cmd` asks for into `cmd.output`, or (a Wayland
/// area) open the monitor and answer with its first picture.
pub fn start(cmd: &StartCommand, out: &Output) -> Result<Begun, String> {
    init()?;
    let wayland = current_platform() == Platform::LinuxWayland;
    let candidates = linux_plan::candidates(installed);
    if candidates.is_empty() {
        return Err(RecordingUnavailable::CodecsMissing.message().into());
    }

    // Camera only with no window to film: the camera itself, no dialog.
    if let Some(pick) = cmd.camera.clone() {
        let mut desktop = portal::Desktop::new()?;
        desktop.keep_awake();
        return record(cmd, out, desktop, candidates, move |shared| capture::Video::start_camera(&pick, shared)).map(Begun::Live);
    }

    // The desktop first: on Wayland the user chooses in its dialog before
    // anything else opens, and a cancel there leaves nothing behind.
    let mut desktop = portal::Desktop::new()?;
    let source = if wayland {
        let ask = linux_plan::portal_ask(cmd);
        desktop.open_screencast(&ask)?
    } else {
        let displays = crate::capture::linux_x11::list_displays().map_err(|e| e.to_string())?;
        // Camera only records the app's own stage window, trimmed of its
        // margin; the window list names each window's process.
        let inset = cmd.window_id.map_or(0, |xid| {
            let pid = crate::capture::linux_x11::list_windows()
                .ok()
                .and_then(|windows| windows.into_iter().find(|w| w.id == xid))
                .and_then(|w| w.pid);
            let scale = displays.first().map_or(1.0, |d| d.scale_factor);
            linux_plan::stage_inset(pid, std::os::unix::process::parent_id(), scale)
        });
        linux_plan::x11_source(cmd, &displays, inset)?
    };
    if wayland && cmd.pick_area {
        // The monitor is open; its first picture goes to the app, which
        // answers with the area (`crop`).
        desktop.keep_awake();
        let (held, first) = match capture::Held::start(source) {
            Ok(opened) => opened,
            Err(e) => {
                desktop.close();
                return Err(e);
            }
        };
        let Some(jpeg) = super::still::jpeg_from_bgrx(&first.bgrx, first.width as usize * 4, first.width, first.height) else {
            held.stop();
            desktop.close();
            return Err("The screen sent no picture to record.".into());
        };
        let still = protocol::StreamStill {
            width: first.width,
            height: first.height,
            jpeg,
            placement: desktop.stream_placement(),
        };
        let picking = AreaPicking {
            cmd: cmd.clone(),
            out: Arc::clone(out),
            desktop: Some(desktop),
            candidates,
            held: Some(held),
        };
        return Ok(Begun::Picking(Box::new(picking), still));
    }

    // A window recording on X11 with the camera bubble: the bubble is drawn
    // in (`capture::Video::start_with_camera`). Wayland never gets an id.
    let with_camera = match (&source, cmd.camera_window_id) {
        (linux_plan::VideoSource::X11Window { .. }, Some(camera)) if !wayland => {
            let scale = crate::capture::linux_x11::list_displays()
                .ok()
                .and_then(|d| d.first().map(|d| d.scale_factor))
                .unwrap_or(1.0);
            Some((camera, scale))
        }
        _ => None,
    };
    desktop.keep_awake();
    record(cmd, out, desktop, candidates, move |shared| match with_camera {
        Some((camera, scale)) => capture::Video::start_with_camera(source, camera, scale, shared),
        None => capture::Video::start(source, shared),
    })
    .map(Begun::Live)
}

/// A Wayland area being drawn: the desktop's stream, its pictures held
/// back, and everything a recording needs to start once the area is known.
struct AreaPicking {
    cmd: StartCommand,
    out: Output,
    desktop: Option<portal::Desktop>,
    candidates: Vec<linux_plan::Encoders>,
    held: Option<capture::Held>,
}

impl Picking for AreaPicking {
    fn crop(mut self: Box<Self>, area: protocol::StreamCrop) -> Result<Started, String> {
        let (Some(desktop), Some(held)) = (self.desktop.take(), self.held.take()) else {
            return Err("The screen is no longer being shared.".into());
        };
        let rect = super::plan::PixelRect {
            x0: area.x,
            y0: area.y,
            x1: area.x.saturating_add(area.width),
            y1: area.y.saturating_add(area.height),
        };
        let candidates = std::mem::take(&mut self.candidates);
        record(&self.cmd, &self.out, desktop, candidates, move |shared| held.release(rect, shared))
    }

    fn cancel(mut self: Box<Self>) {
        if let Some(held) = self.held.take() {
            held.stop();
        }
        if let Some(desktop) = self.desktop.take() {
            desktop.close();
        }
    }
}

/// Open the sound, the writer and then the picture (`video`, handed the
/// shared state), and wait for the first picture, which fixes the file's
/// size and answers `started`. Anything that fails takes the rest down.
fn record(
    cmd: &StartCommand,
    out: &Output,
    desktop: portal::Desktop,
    candidates: Vec<linux_plan::Encoders>,
    video: impl FnOnce(Arc<Shared>) -> Result<capture::Video, String>,
) -> Result<Started, String> {
    let output = PathBuf::from(&cmd.output);
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = Arc::new(Shared::new(tx, clock_micros));

    // Each sound device opened once, here, before the file exists: one that
    // cannot open is left out, and the file has an audio track only if one
    // did.
    let mut audio = Vec::new();
    let mut sources = Vec::new();
    if cmd.microphone {
        // A chosen microphone that is gone (unplugged since the bar listed
        // it) records the default instead, as the bar shows it.
        let chosen = cmd.microphone_device_id.as_deref().filter(|id| !id.is_empty() && *id != "default");
        let opened =
            capture::Audio::start(chosen, Source::Microphone, Arc::clone(&shared), tell_lost(out, Source::Microphone)).or_else(|e| match chosen {
                Some(_) => {
                    say(&format!("the chosen microphone could not be opened, recording the default: {e}"));
                    capture::Audio::start(None, Source::Microphone, Arc::clone(&shared), tell_lost(out, Source::Microphone))
                }
                None => Err(e),
            });
        match opened {
            Ok(a) => {
                sources.push(Source::Microphone);
                audio.push(a);
            }
            Err(e) => say(&format!("the microphone could not be opened, recording without it: {e}")),
        }
    }
    if cmd.system_audio {
        match capture::Audio::start(
            Some(linux_plan::DEFAULT_MONITOR),
            Source::System,
            Arc::clone(&shared),
            tell_lost(out, Source::System),
        ) {
            Ok(a) => {
                sources.push(Source::System);
                audio.push(a);
            }
            Err(e) => say(&format!("system audio could not be opened, recording without it: {e}")),
        }
    }

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u32), String>>();
    let writer = spawn_writer(
        rx,
        Arc::clone(&shared),
        Arc::clone(out),
        output.clone(),
        sources,
        ready_tx,
        candidates,
        cmd.watermark,
    );

    let video = match video(Arc::clone(&shared)) {
        Ok(video) => video,
        Err(e) => {
            Box::new(Session::parts(output, shared, None, audio, Some(writer), desktop)).cancel();
            return Err(e);
        }
    };
    let silent = if cmd.camera.is_some() {
        "The camera sent no picture to record."
    } else {
        "The screen sent no picture to record."
    };
    let ready = ready_rx.recv_timeout(FIRST_FRAME_WITHIN).unwrap_or_else(|_| Err(silent.into()));
    let session = Session::parts(output, shared, Some(video), audio, Some(writer), desktop);
    match ready {
        Ok(size) => Ok((Box::new(session), size)),
        Err(e) => {
            Box::new(session).cancel();
            Err(e)
        }
    }
}

/// What a sound thread calls when its device goes away mid-recording: the
/// app is told (`device_lost`, the event Windows sends too), so the pill can
/// say the recording goes on without it.
fn tell_lost(out: &Output, source: Source) -> impl FnOnce(&str) + Send + 'static {
    let out = Arc::clone(out);
    move |error| super::emit(&out, &protocol::device_lost_line(source.device_name(), error))
}

#[allow(clippy::too_many_arguments)]
fn spawn_writer(
    rx: mpsc::Receiver<Msg>,
    shared: Arc<Shared>,
    out: Output,
    output: PathBuf,
    sources: Vec<Source>,
    ready: Sender<Result<(u32, u32), String>>,
    candidates: Vec<linux_plan::Encoders>,
    watermark: bool,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let has_audio = !sources.is_empty();
        writer_loop::run(&rx, &shared, &out, &sources, &ready, watermark, |size| {
            encoder::GstEncoder::create(&output, size, &candidates, has_audio)
        });
    })
}

/// One Linux recording in progress.
struct Session {
    output: PathBuf,
    shared: Arc<Shared>,
    video: Option<capture::Video>,
    audio: Vec<capture::Audio>,
    writer: Option<JoinHandle<()>>,
    desktop: Option<portal::Desktop>,
}

impl Session {
    fn parts(
        output: PathBuf,
        shared: Arc<Shared>,
        video: Option<capture::Video>,
        audio: Vec<capture::Audio>,
        writer: Option<JoinHandle<()>>,
        desktop: portal::Desktop,
    ) -> Self {
        Self {
            output,
            shared,
            video,
            audio,
            writer,
            desktop: Some(desktop),
        }
    }

    /// Stop every source; the writer is left to finish or drop the file.
    fn stop_sources(&mut self) {
        if let Some(video) = self.video.take() {
            video.stop();
        }
        for audio in self.audio.drain(..) {
            audio.stop();
        }
    }

    /// The desktop's screen-sharing session and the inhibit end once the
    /// sources are stopped, so its indicator goes away with the recording.
    fn close_desktop(&mut self) {
        if let Some(desktop) = self.desktop.take() {
            desktop.close();
        }
    }

    fn join_writer(&mut self) {
        if let Some(thread) = self.writer.take() {
            let _ = thread.join();
        }
    }
}

impl Live for Session {
    fn pause(&self) {
        self.shared.pause();
    }

    fn resume(&self) {
        self.shared.resume();
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        let at = self.shared.now();
        self.stop_sources();
        self.close_desktop();
        let (reply_tx, reply_rx) = mpsc::channel();
        if !self.shared.send(Msg::Finish { reply: reply_tx, at }) {
            self.join_writer();
            return Err("The recorder's writer had already stopped.".into());
        }
        let result = reply_rx
            .recv_timeout(FINISH_WITHIN)
            .unwrap_or_else(|_| Err("Finishing the recording took too long; what was written is kept.".into()));
        // A writer stuck finishing is left behind: the process ends soon
        // after, and the fragments on disk already play.
        if result.is_ok() {
            self.join_writer();
        }
        result
    }

    fn cancel(mut self: Box<Self>) {
        self.stop_sources();
        self.close_desktop();
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.shared.send(Msg::Cancel(reply_tx)) {
            let _ = reply_rx.recv_timeout(Duration::from_secs(5));
        }
        self.join_writer();
        let _ = std::fs::remove_file(&self.output);
    }

    fn restore_token(&self) -> Option<String> {
        self.desktop.as_ref().and_then(portal::Desktop::restore_token)
    }
}
