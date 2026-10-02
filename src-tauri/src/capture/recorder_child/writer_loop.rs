//! The writer thread of a recording whose sources run on threads of their
//! own, apart from any encoder so it is tested on every OS against a fake.
//!
//! Capture threads (one per device: the picture, the microphone, the
//! system's sound) place each sample on the pause [`Timeline`] and send it
//! here as a [`Msg`]. This thread alone owns the encoder and the
//! [`Pipeline`] (held picture, mixer, origin), so nothing else touches the
//! file. The encoder is made from the first picture, whose size fixes the
//! recording's; `started` waits for it ([`run`]'s `ready`), so an encoder
//! that cannot start fails Start with its reason. A recording that ends on
//! its own ([`Msg::Ended`], or an encoder failure) is finished here and the
//! app is told `stream_stopped` with `saved`; Stop and Cancel answer on the
//! channel they bring. (The app dying closes the child's stdin, and `serve`
//! then Stops, so the file is finished and kept.)
//!
//! Linux's recorder runs it; Windows' has its own copy in
//! `recorder_child::windows` (Media Foundation needs its COM apartment
//! entered on this thread), which can move onto this one later.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use super::mixer::Source;
use super::pipeline::{Encoder, Pipeline};
use super::timeline::Timeline;
use super::{Output, emit};
use crate::capture::recording::protocol;

/// How often the writer looks at the clock when nothing arrives (a still
/// screen is rewritten once a second, `pacing::REPEAT_AFTER`).
pub const TICK: Duration = Duration::from_millis(100);
/// Pictures waiting for the writer before capture threads drop new ones: an
/// encoder that falls behind loses frames, not memory.
pub const MAX_PENDING_FRAMES: usize = 4;

/// What the capture threads tell the writer.
pub enum Msg {
    /// A picture at `time` (capture clock, placed), already in the
    /// encoder's format at `size`.
    Video { time: u64, frame: Vec<u8>, size: (u32, u32) },
    /// Interleaved stereo 48 kHz float from `source`, starting at `time`.
    Audio { source: Source, time: u64, samples: Vec<f32> },
    /// What was recorded went away (window closed, sharing stopped).
    Ended(String),
    /// Stop: finish the file and answer.
    Finish(Sender<Result<(), String>>),
    /// Discard: drop the file unfinished and answer.
    Cancel(Sender<()>),
}

/// State the capture threads share with the session and the writer.
pub struct Shared {
    pub timeline: Mutex<Timeline>,
    to_writer: Mutex<Sender<Msg>>,
    /// Pictures sent and not yet taken by the writer.
    pending_frames: AtomicUsize,
    /// The capture clock in microseconds: what every sample is stamped
    /// with, and what pause and resume read.
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl Shared {
    pub fn new(to_writer: Sender<Msg>, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            timeline: Mutex::new(Timeline::new()),
            to_writer: Mutex::new(to_writer),
            pending_frames: AtomicUsize::new(0),
            clock: Box::new(clock),
        }
    }

    /// The capture clock now.
    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Where a sample taken at `time` lands, or `None` inside a pause.
    pub fn place(&self, time: u64) -> Option<u64> {
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).place(time)
    }

    pub fn pause(&self) {
        let now = self.now();
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).pause(now);
    }

    pub fn resume(&self) {
        let now = self.now();
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).resume(now);
    }

    pub fn send(&self, msg: Msg) -> bool {
        self.to_writer.lock().unwrap_or_else(PoisonError::into_inner).send(msg).is_ok()
    }

    /// Send a picture unless the writer is already [`MAX_PENDING_FRAMES`]
    /// behind; `false` when it was dropped (or the writer is gone).
    pub fn send_frame(&self, time: u64, frame: Vec<u8>, size: (u32, u32)) -> bool {
        if self.pending_frames.load(Ordering::SeqCst) >= MAX_PENDING_FRAMES {
            return false;
        }
        self.pending_frames.fetch_add(1, Ordering::SeqCst);
        let sent = self.send(Msg::Video { time, frame, size });
        if !sent {
            self.pending_frames.fetch_sub(1, Ordering::SeqCst);
        }
        sent
    }
}

/// Diagnostics go to stderr, which the app logs at `warn`.
fn say(line: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{line}");
}

const NOTHING_CAPTURED: &str = "The recording stopped before anything was captured.";

/// The writer thread: owns the pipeline until Finish, Cancel, or every
/// sender is gone (then it finishes and keeps the file). `create` makes the
/// encoder for the first picture's size; `ready` hears that size (or why the
/// encoder could not start) once.
pub fn run<E: Encoder>(
    rx: &Receiver<Msg>,
    shared: &Shared,
    out: &Output,
    sources: &[Source],
    ready: &Sender<Result<(u32, u32), String>>,
    mut create: impl FnMut((u32, u32)) -> Result<E, String>,
) {
    let mut pipeline: Option<Pipeline<E>> = None;
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
                    let now = shared.place(shared.now());
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
                    match create(size) {
                        Ok(encoder) => {
                            pipeline = Some(Pipeline::new(encoder, sources));
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
                    // Gone before the first picture: Start is still waiting
                    // for one, and hears why.
                    let _ = ready.send(Err(reason.clone()));
                    Err(NOTHING_CAPTURED.into())
                };
                if pipeline.is_some() {
                    emit(out, &protocol::stream_stopped_line(&reason, result.is_ok()));
                }
                say(&format!("recording ended on its own: {reason}"));
                done = Some(result);
            }
            Msg::Finish(reply) => {
                let result = match (done.take(), pipeline.as_mut()) {
                    (Some(result), _) => result,
                    (None, Some(p)) => end_now(p, shared),
                    (None, None) => Err(NOTHING_CAPTURED.into()),
                };
                let _ = reply.send(result);
                return;
            }
            Msg::Cancel(reply) => {
                // Dropping the encoder unfinished releases the file.
                drop(pipeline.take());
                let _ = reply.send(());
                return;
            }
        }
    }
}

/// Finish the file where the recording is now.
fn end_now<E: Encoder>(pipeline: &mut Pipeline<E>, shared: &Shared) -> Result<(), String> {
    let now = shared.now();
    let end = shared
        .timeline
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .end_time(now, pipeline.last_video());
    pipeline.finish(end)
}

/// The encoder failed mid-recording: finish what can be finished and say so
/// now, not at Stop.
fn fail<E: Encoder>(pipeline: &mut Pipeline<E>, shared: &Shared, out: &Output, error: &str) -> Result<(), String> {
    say(&format!("writer failed: {error}"));
    let saved = end_now(pipeline, shared).is_ok();
    emit(out, &protocol::stream_stopped_line(error, saved));
    if saved { Ok(()) } else { Err(error.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    /// What the fake encoder was handed, kept after the writer drops it.
    #[derive(Default)]
    struct Log {
        video: Vec<(i64, i64)>,
        audio: usize,
        finished: bool,
    }

    struct Fake {
        log: Arc<Mutex<Log>>,
        fail_video: bool,
    }

    impl Encoder for Fake {
        fn video(&mut self, _nv12: &[u8], start: i64, duration: i64) -> Result<(), String> {
            if self.fail_video {
                return Err("encoder gone".into());
            }
            self.log.lock().unwrap().video.push((start, duration));
            Ok(())
        }
        fn audio(&mut self, _pcm: &[i16], _start: i64, _duration: i64) -> Result<(), String> {
            self.log.lock().unwrap().audio += 1;
            Ok(())
        }
        fn finish(&mut self) -> Result<(), String> {
            self.log.lock().unwrap().finished = true;
            Ok(())
        }
    }

    /// Lines the writer said, as the app would read them.
    #[derive(Clone, Default)]
    struct Lines(Arc<Mutex<Vec<u8>>>);

    impl Write for Lines {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Lines {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    struct Rig {
        shared: Arc<Shared>,
        clock: Arc<AtomicU64>,
        log: Arc<Mutex<Log>>,
        lines: Lines,
        ready: mpsc::Receiver<Result<(u32, u32), String>>,
        thread: std::thread::JoinHandle<()>,
    }

    fn rig(sources: &'static [Source], fail_create: bool, fail_video: bool) -> Rig {
        let (tx, rx) = mpsc::channel();
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let shared = Arc::new(Shared::new(tx, {
            let clock = Arc::clone(&clock);
            move || clock.load(Ordering::SeqCst)
        }));
        let log = Arc::new(Mutex::new(Log::default()));
        let lines = Lines::default();
        let out: Output = Arc::new(Mutex::new(Box::new(lines.clone())));
        let (ready_tx, ready) = mpsc::channel();
        let thread = std::thread::spawn({
            let shared = Arc::clone(&shared);
            let log = Arc::clone(&log);
            move || {
                run(&rx, &shared, &out, sources, &ready_tx, |_size| {
                    if fail_create {
                        Err("no H.264 encoder".to_string())
                    } else {
                        Ok(Fake {
                            log: Arc::clone(&log),
                            fail_video,
                        })
                    }
                });
            }
        });
        Rig {
            shared,
            clock,
            log,
            lines,
            ready,
            thread,
        }
    }

    fn frame(rig: &Rig, at: u64) {
        rig.clock.store(at, Ordering::SeqCst);
        let placed = rig.shared.place(at).expect("not paused");
        assert!(rig.shared.send_frame(placed, vec![0; 6], (2, 2)));
        // Let the writer take it, so the pending count never drops one.
        std::thread::sleep(Duration::from_millis(5));
    }

    fn finish(rig: Rig) -> (Result<(), String>, Rig) {
        let (tx, rx) = mpsc::channel();
        assert!(rig.shared.send(Msg::Finish(tx)));
        let result = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        (result, rig)
    }

    /// The first picture fixes the size and answers Start; Stop finishes the
    /// file with the held picture lasting to the end, sound mixed in.
    #[test]
    fn pictures_and_sound_reach_the_encoder_and_stop_finishes_the_file() {
        let rig = rig(&[Source::Microphone], false, false);
        frame(&rig, 1_000_000);
        assert_eq!(rig.ready.recv_timeout(Duration::from_secs(5)).unwrap(), Ok((2, 2)));
        assert!(rig.shared.send(Msg::Audio {
            source: Source::Microphone,
            time: 1_000_000,
            samples: vec![0.1; 2 * 4800],
        }));
        frame(&rig, 1_100_000);
        rig.clock.store(1_500_000, Ordering::SeqCst);
        let (result, rig) = finish(rig);
        assert_eq!(result, Ok(()));
        rig.thread.join().unwrap();
        let log = rig.log.lock().unwrap();
        assert!(log.finished);
        assert_eq!(log.video.first(), Some(&(0, 1_000_000)), "the first picture lasts until the next");
        let (start, duration) = *log.video.last().unwrap();
        assert_eq!(start + duration, 5_000_000, "the held picture lasts to the stop");
        assert!(log.audio > 0);
        assert!(rig.lines.text().is_empty(), "a normal stop says nothing unprompted");
    }

    /// A pause cuts its time out of the file.
    #[test]
    fn a_pause_is_cut_out() {
        let rig = rig(&[], false, false);
        frame(&rig, 1_000_000);
        rig.clock.store(1_200_000, Ordering::SeqCst);
        rig.shared.pause();
        assert_eq!(rig.shared.place(1_500_000), None, "inside the pause");
        rig.clock.store(3_200_000, Ordering::SeqCst);
        rig.shared.resume();
        frame(&rig, 3_300_000);
        rig.clock.store(3_400_000, Ordering::SeqCst);
        let (result, rig) = finish(rig);
        assert_eq!(result, Ok(()));
        rig.thread.join().unwrap();
        let log = rig.log.lock().unwrap();
        let (start, duration) = *log.video.last().unwrap();
        assert_eq!(start + duration, 4_000_000, "0.4 s recorded, the 2 s pause gone");
    }

    /// An encoder that cannot start fails Start with its reason.
    #[test]
    fn an_encoder_that_cannot_start_fails_start_with_its_reason() {
        let rig = rig(&[], true, false);
        frame(&rig, 1_000_000);
        assert_eq!(rig.ready.recv_timeout(Duration::from_secs(5)).unwrap(), Err("no H.264 encoder".into()));
        let (result, rig) = finish(rig);
        assert_eq!(result, Err("no H.264 encoder".into()));
        rig.thread.join().unwrap();
    }

    /// The window closed or sharing was stopped: the file is finished at
    /// once and the app hears `stream_stopped` with `saved`.
    #[test]
    fn a_source_that_ends_finishes_the_file_and_says_so() {
        let rig = rig(&[], false, false);
        frame(&rig, 1_000_000);
        rig.clock.store(2_000_000, Ordering::SeqCst);
        assert!(rig.shared.send(Msg::Ended("Screen sharing was stopped from your desktop.".into())));
        std::thread::sleep(Duration::from_millis(50));
        assert!(rig.log.lock().unwrap().finished);
        let said = protocol::parse_event(rig.lines.text().trim()).unwrap();
        assert_eq!(
            said.event,
            protocol::HelperEvent::StreamStopped {
                message: "Screen sharing was stopped from your desktop.".into(),
                saved: true
            }
        );
        // The Stop that follows gets the same answer, without a second end.
        let (result, rig) = finish(rig);
        assert_eq!(result, Ok(()));
        rig.thread.join().unwrap();
    }

    /// A source gone before the first picture fails Start with why.
    #[test]
    fn a_source_gone_before_the_first_picture_fails_start() {
        let rig = rig(&[], false, false);
        assert!(rig.shared.send(Msg::Ended("The window being recorded was closed.".into())));
        assert_eq!(
            rig.ready.recv_timeout(Duration::from_secs(5)).unwrap(),
            Err("The window being recorded was closed.".into())
        );
        let (result, rig) = finish(rig);
        assert_eq!(result, Err(NOTHING_CAPTURED.into()));
        rig.thread.join().unwrap();
        assert!(rig.lines.text().is_empty(), "no stream_stopped for a start that never began");
    }

    /// An encoder failing mid-recording is said at once, not at Stop.
    #[test]
    fn an_encoder_failure_is_said_at_once() {
        let rig = rig(&[], false, true);
        frame(&rig, 1_000_000);
        frame(&rig, 1_100_000);
        std::thread::sleep(Duration::from_millis(50));
        let said = protocol::parse_event(rig.lines.text().trim()).unwrap();
        assert!(matches!(said.event, protocol::HelperEvent::StreamStopped { .. }), "{said:?}");
        let (result, rig) = finish(rig);
        assert!(result.is_err());
        rig.thread.join().unwrap();
    }

    /// Cancel drops the file unfinished: no end is written.
    #[test]
    fn cancel_drops_the_file_unfinished() {
        let rig = rig(&[], false, false);
        frame(&rig, 1_000_000);
        let (tx, rx) = mpsc::channel();
        assert!(rig.shared.send(Msg::Cancel(tx)));
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        rig.thread.join().unwrap();
        assert!(!rig.log.lock().unwrap().finished);
    }

    /// A writer that falls behind loses pictures, not memory.
    #[test]
    fn a_writer_behind_drops_new_pictures() {
        let (tx, _rx) = mpsc::channel();
        let shared = Shared::new(tx, || 0);
        for _ in 0..MAX_PENDING_FRAMES {
            assert!(shared.send_frame(0, Vec::new(), (2, 2)));
        }
        assert!(!shared.send_frame(0, Vec::new(), (2, 2)), "the fifth waiting picture is dropped");
    }
}
