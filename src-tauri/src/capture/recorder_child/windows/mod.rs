//! The Windows recorder: Windows.Graphics.Capture for the picture, WASAPI
//! for the microphone and the system's sound, Media Foundation for a
//! fragmented MP4 (H.264 and one AAC track), all inside the recorder child.
//!
//! Threads, and who owns what:
//!
//! - **Capture** ([`wgc`]): `windows-capture`'s own thread owns the WGC
//!   session and its D3D11 device. Each picture is stamped with its QPC time,
//!   placed on the [`Timeline`] (pauses cut), thinned to 30 fps
//!   ([`Gate`](super::pacing::Gate)), cropped on the GPU, read back and
//!   converted to NV12 ([`super::frame`]), then sent to the writer.
//! - **Audio** ([`audio`]): one thread per device, each owning ONE WASAPI
//!   client: the microphone the user chose, and the default output in
//!   loopback when system audio is on. Packets carry QPC times too, so the
//!   same timeline places them.
//! - **Writer** ([`writer`]): one thread owns the Media Foundation sink
//!   writer and the [`Pipeline`] (held frame, mixer, origin). Nothing else
//!   touches the file.
//! - **The camera** is not opened here at all: the bubble's webview owns
//!   it, and the recorder films the bubble's window like any other. On macOS
//!   the camera and the microphone once fought over one capture session; here
//!   every device has exactly one owner, so screen, system audio, microphone
//!   and camera run side by side.
//!
//! A recording that ends on its own (the window closed, the display went
//! away, the encoder failed) is finished by the writer, which says
//! `stream_stopped` with `saved` itself. The display is kept awake while
//! the writer runs.

pub mod audio;
mod com;
pub mod devices;
pub mod poster;
pub mod probe;
pub mod self_test;
pub mod watch;
mod wgc;
mod writer;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use super::mixer::Source;
use super::pipeline::Pipeline;
use super::timeline::Timeline;
use super::{Live, Output, Started, emit};
use crate::capture::recording::protocol::{self, StartCommand};

/// How long the first picture may take after Start (WGC sends one at once;
/// a GPU waking from idle can take a moment).
const FIRST_FRAME_WITHIN: Duration = Duration::from_secs(10);
/// Finishing the file is time-boxed; fragments already written still play.
const FINISH_WITHIN: Duration = Duration::from_secs(30);
/// How often the writer looks at the clock when nothing arrives (a still
/// screen is rewritten once a second, `pacing::REPEAT_AFTER`).
const TICK: Duration = Duration::from_millis(100);
/// Pictures waiting for the writer before new ones are dropped: an encoder
/// that falls behind loses frames, not memory.
const MAX_PENDING_FRAMES: usize = 4;

/// What the capture and audio threads tell the writer.
pub(crate) enum Msg {
    /// A picture at `time` (capture clock, placed), already NV12 at `size`.
    Video {
        time: u64,
        frame: Vec<u8>,
        size: (u32, u32),
    },
    Audio {
        source: Source,
        time: u64,
        samples: Vec<f32>,
    },
    /// What was recorded went away (window closed, display unplugged).
    Ended(String),
    /// Stop: finish the file and answer.
    Finish(Sender<Result<(), String>>),
    /// Discard: drop the file unfinished and answer.
    Cancel(Sender<()>),
}

/// State the capture threads share with the session.
pub(crate) struct Shared {
    pub timeline: Mutex<Timeline>,
    pub to_writer: Mutex<Sender<Msg>>,
    /// Pictures sent and not yet taken by the writer.
    pub pending_frames: AtomicUsize,
}

impl Shared {
    /// Where a sample taken at `time` lands, or `None` inside a pause.
    pub fn place(&self, time: u64) -> Option<u64> {
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).place(time)
    }

    pub fn send(&self, msg: Msg) -> bool {
        self.to_writer.lock().unwrap_or_else(PoisonError::into_inner).send(msg).is_ok()
    }
}

/// What to record, from the start command.
#[derive(Debug, Clone, Copy)]
enum Target {
    Monitor { handle: isize, crop: Option<protocol::CropRect> },
    Window { handle: isize },
}

/// A display or window id as the app sends it (xcap's: the handle's low 32
/// bits) back to a handle. Handles are 32-bit values sign-extended to the
/// pointer size, which is how they cross between processes.
fn handle_from_id(id: u32) -> isize {
    #[allow(clippy::cast_possible_wrap)]
    let low = id as i32;
    low as isize
}

fn target_of(cmd: &StartCommand) -> Result<Target, String> {
    if let Some(window) = cmd.window_id {
        return Ok(Target::Window {
            handle: handle_from_id(window),
        });
    }
    match cmd.display_id {
        Some(display) => Ok(Target::Monitor {
            handle: handle_from_id(display),
            crop: cmd.crop,
        }),
        None => Err("missing display or window".into()),
    }
}

/// Start recording what `cmd` asks for into `cmd.output`. A refusal the
/// user can act on (the OS floor) is said as is; anything else (an encoder
/// or capture HRESULT) goes to stderr, which the app logs, and the user reads
/// [`super::start_failure_for_user`]'s plain line.
pub fn start(cmd: &StartCommand, out: &Output) -> Result<Started, String> {
    start_recording(cmd, out).map_err(|detail| {
        let _ = writeln_stderr(&format!("the recording could not start: {detail}"));
        super::start_failure_for_user(&detail)
    })
}

fn start_recording(cmd: &StartCommand, out: &Output) -> Result<Started, String> {
    use crate::capture::permissions::{windows_build, windows_excludes_from_capture};
    if !windows_excludes_from_capture(windows_build()) {
        return Err(crate::capture::recording::RecordingUnavailable::OsTooOld.message().into());
    }
    let target = target_of(cmd)?;
    // A window recording films that one window: the camera bubble's window
    // is captured too and drawn into it (`wgc::WithCamera`).
    let camera = match target {
        Target::Window { .. } => cmd.camera_window_id.map(handle_from_id),
        Target::Monitor { .. } => None,
    };
    let output = PathBuf::from(&cmd.output);
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = Arc::new(Shared {
        timeline: Mutex::new(Timeline::new()),
        to_writer: Mutex::new(tx),
        pending_frames: AtomicUsize::new(0),
    });

    // Each device opened once, here, before the file exists: a device that
    // cannot be opened is left out (and said on stderr) rather than failing
    // the recording, and the file's audio track exists only if one opened.
    let stop_audio = Arc::new(AtomicBool::new(false));
    let mut audio_threads = Vec::new();
    let mut sources = Vec::new();
    if cmd.microphone {
        match audio::open(audio::Device::Microphone(cmd.microphone_device_id.clone())) {
            Ok(opened) => {
                sources.push(Source::Microphone);
                audio_threads.push(audio::spawn(
                    opened,
                    Source::Microphone,
                    Arc::clone(&shared),
                    Arc::clone(&stop_audio),
                    tell_lost(out, Source::Microphone),
                ));
            }
            Err(e) => {
                let _ = writeln_stderr(&format!("the microphone could not be opened, recording without it: {e}"));
            }
        }
    }
    if cmd.system_audio {
        match audio::open(audio::Device::system()) {
            Ok(opened) => {
                sources.push(Source::System);
                audio_threads.push(audio::spawn(
                    opened,
                    Source::System,
                    Arc::clone(&shared),
                    Arc::clone(&stop_audio),
                    tell_lost(out, Source::System),
                ));
            }
            Err(e) => {
                let _ = writeln_stderr(&format!("system audio could not be opened, recording without it: {e}"));
            }
        }
    }

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u32), String>>();
    let writer_thread = std::thread::spawn({
        let shared = Arc::clone(&shared);
        let out = Arc::clone(out);
        let output = output.clone();
        move || writer_loop(&rx, &shared, &out, &output, &sources, &ready_tx)
    });

    let capture = match wgc::start(target, Arc::clone(&shared), camera) {
        Ok(capture) => capture,
        Err(e) => {
            let session = Session::parts(output, shared, None, stop_audio, audio_threads, Some(writer_thread));
            Box::new(session).cancel();
            return Err(e);
        }
    };
    let ready = match ready_rx.recv_timeout(FIRST_FRAME_WITHIN) {
        Ok(ready) => ready,
        Err(_) => Err("The screen sent no picture to record.".into()),
    };
    let session = Session::parts(output, shared, Some(capture), stop_audio, audio_threads, Some(writer_thread));
    match ready {
        Ok(size) => Ok((Box::new(session), size)),
        Err(e) => {
            Box::new(session).cancel();
            Err(e)
        }
    }
}

/// What an audio thread calls when its device goes away mid-recording: the
/// app is told (`device_lost`), so the pill can say the recording goes on
/// without it.
fn tell_lost(out: &Output, source: Source) -> impl FnOnce(&str) + Send + 'static {
    let out = Arc::clone(out);
    move |error| emit(&out, &protocol::device_lost_line(source.device_name(), error))
}

/// Diagnostics go to stderr, which the app logs at `warn`.
fn writeln_stderr(line: &str) -> std::io::Result<()> {
    use std::io::Write;
    writeln!(std::io::stderr(), "{line}")
}

/// One Windows recording in progress.
struct Session {
    output: PathBuf,
    shared: Arc<Shared>,
    capture: Option<wgc::Capture>,
    stop_audio: Arc<AtomicBool>,
    audio_threads: Vec<JoinHandle<()>>,
    writer_thread: Option<JoinHandle<()>>,
}

impl Session {
    fn parts(
        output: PathBuf,
        shared: Arc<Shared>,
        capture: Option<wgc::Capture>,
        stop_audio: Arc<AtomicBool>,
        audio_threads: Vec<JoinHandle<()>>,
        writer_thread: Option<JoinHandle<()>>,
    ) -> Self {
        Self {
            output,
            shared,
            capture,
            stop_audio,
            audio_threads,
            writer_thread,
        }
    }

    /// Stop every source; the writer is left to finish or drop the file.
    fn stop_sources(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        self.stop_audio.store(true, Ordering::SeqCst);
        for thread in self.audio_threads.drain(..) {
            let _ = thread.join();
        }
    }

    fn join_writer(&mut self) {
        if let Some(thread) = self.writer_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Live for Session {
    fn pause(&self) {
        let now = com::qpc_micros();
        self.shared.timeline.lock().unwrap_or_else(PoisonError::into_inner).pause(now);
    }

    fn resume(&self) {
        let now = com::qpc_micros();
        self.shared.timeline.lock().unwrap_or_else(PoisonError::into_inner).resume(now);
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        self.stop_sources();
        let (reply_tx, reply_rx) = mpsc::channel();
        if !self.shared.send(Msg::Finish(reply_tx)) {
            self.join_writer();
            return Err("The recorder's writer had already stopped.".into());
        }
        let result = reply_rx
            .recv_timeout(FINISH_WITHIN)
            .unwrap_or_else(|_| Err("Finishing the recording took too long; what was written is kept.".into()));
        // A writer stuck in Finalize is left behind: the process ends soon
        // after, and the fragments on disk already play.
        if result.is_ok() {
            self.join_writer();
        }
        result
    }

    fn cancel(mut self: Box<Self>) {
        self.stop_sources();
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.shared.send(Msg::Cancel(reply_tx)) {
            let _ = reply_rx.recv_timeout(Duration::from_secs(5));
        }
        self.join_writer();
        let _ = std::fs::remove_file(&self.output);
    }
}

/// The writer thread: owns the sink writer and the pipeline until Finish,
/// Cancel, or every sender is gone (then it finishes and keeps the file).
fn writer_loop(
    rx: &Receiver<Msg>,
    shared: &Shared,
    out: &Output,
    output: &std::path::Path,
    sources: &[Source],
    ready: &Sender<Result<(u32, u32), String>>,
) {
    let _com = com::Apartment::enter();
    let _media = com::MediaFoundation::start();
    let _awake = com::KeepAwake::start();
    let mut pipeline: Option<Pipeline<writer::MfWriter>> = None;
    // Once the file is finished (or failed for good), what happened, so a
    // later Stop gets the same answer.
    let mut done: Option<Result<(), String>> = None;
    loop {
        let msg = match rx.recv_timeout(TICK) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => {
                if done.is_none()
                    && let Some(p) = pipeline.as_mut()
                {
                    let now = shared.place(com::qpc_micros());
                    if let Err(e) = p.tick(now) {
                        done = Some(fail(p, shared, out, &e));
                    }
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Every sender is gone without a Stop: keep what was made.
                if done.is_none()
                    && let Some(p) = pipeline.as_mut()
                {
                    let _ = end_now(p, shared);
                }
                return;
            }
        };
        match msg {
            Msg::Video { time, frame, size } => {
                shared.pending_frames.fetch_sub(1, Ordering::SeqCst);
                if done.is_some() {
                    continue;
                }
                if pipeline.is_none() {
                    match writer::MfWriter::create(output, size.0, size.1, !sources.is_empty()) {
                        Ok(w) => {
                            pipeline = Some(Pipeline::new(w, sources));
                            let _ = ready.send(Ok(size));
                        }
                        Err(e) => {
                            let _ = ready.send(Err(e.clone()));
                            done = Some(Err(e));
                            continue;
                        }
                    }
                }
                if let Some(p) = pipeline.as_mut()
                    && let Err(e) = p.video(time, frame)
                {
                    done = Some(fail(p, shared, out, &e));
                }
            }
            Msg::Audio { source, time, samples } => {
                if done.is_none()
                    && let Some(p) = pipeline.as_mut()
                    && let Err(e) = p.audio(source, time, &samples)
                {
                    done = Some(fail(p, shared, out, &e));
                }
            }
            Msg::Ended(reason) => {
                if done.is_some() {
                    continue;
                }
                let result = if let Some(p) = pipeline.as_mut() {
                    end_now(p, shared)
                } else {
                    // Gone before the first picture: Start is still
                    // waiting for one.
                    let _ = ready.send(Err(reason.clone()));
                    Err("The recording stopped before anything was captured.".into())
                };
                emit(out, &protocol::stream_stopped_line(&reason, result.is_ok()));
                let _ = writeln_stderr(&format!("recording ended on its own: {reason}"));
                done = Some(result);
            }
            Msg::Finish(reply) => {
                let result = match (done.take(), pipeline.as_mut()) {
                    (Some(result), _) => result,
                    (None, Some(p)) => end_now(p, shared),
                    (None, None) => Err("The recording stopped before anything was captured.".into()),
                };
                let _ = reply.send(result);
                return;
            }
            Msg::Cancel(reply) => {
                // Dropping the sink writer unfinished releases the file.
                drop(pipeline.take());
                let _ = reply.send(());
                return;
            }
        }
    }
}

/// Finish the file where the recording is now.
fn end_now(pipeline: &mut Pipeline<writer::MfWriter>, shared: &Shared) -> Result<(), String> {
    let now = com::qpc_micros();
    let end = shared
        .timeline
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .end_time(now, pipeline.last_video());
    pipeline.finish(end)
}

/// The encoder failed mid-recording: finish what can be finished and say
/// so now, not at Stop.
fn fail(pipeline: &mut Pipeline<writer::MfWriter>, shared: &Shared, out: &Output, error: &str) -> Result<(), String> {
    let _ = writeln_stderr(&format!("writer failed: {error}"));
    let saved = end_now(pipeline, shared).is_ok();
    emit(out, &protocol::stream_stopped_line(error, saved));
    if saved { Ok(()) } else { Err(error.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xcap names a display or window by its handle's low 32 bits; a handle
    /// with the top bit set is a negative 32-bit value, sign-extended back.
    #[test]
    fn ids_become_handles_by_sign_extension() {
        assert_eq!(handle_from_id(0x0001_0001), 0x0001_0001);
        assert_eq!(handle_from_id(0xFFFF_FFFE), -2);
    }

    #[test]
    fn a_window_id_wins_over_a_display() {
        let mut cmd: StartCommand = serde_json::from_str(r#"{"id":1,"output":"C:\\x.mp4","displayId":5}"#).unwrap();
        assert!(matches!(target_of(&cmd), Ok(Target::Monitor { handle: 5, crop: None })));
        cmd.window_id = Some(9);
        assert!(matches!(target_of(&cmd), Ok(Target::Window { handle: 9 })));
        cmd.window_id = None;
        cmd.display_id = None;
        assert!(target_of(&cmd).is_err());
    }
}
