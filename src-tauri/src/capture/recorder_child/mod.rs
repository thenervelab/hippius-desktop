//! The recorder child: the app's own executable started as
//! `Hippius --capture-recorder`, speaking the Swift helper's protocol
//! ([`crate::capture::recording::protocol`]) on stdin and stdout.
//!
//! Windows and Linux record here rather than in the app, so an encoder or a
//! capture driver that crashes takes this process and not the app, and the
//! file it was writing survives. `main` branches into [`run`] before Tauri's
//! builder, so no window, tray, single-instance or deep-link handler starts
//! in it.
//!
//! This is the skeleton the platform recorders fill in: the command loop,
//! the pause timeline ([`timeline`]), the sizing rules shared with the Swift
//! helper ([`sizing`]) and a test pattern ([`synthetic`]) written through a
//! stand-in writer. A `start` for a real screen is refused with the same
//! line `recording_unavailable` gives, until the platform's recorder lands.
//!
//! Rules kept from the Swift helper: every reply echoes its command's `id`;
//! closing stdin FINISHES the file and keeps it (the app died); only `cancel`
//! deletes; a recording that ends on its own says `stream_stopped` with
//! `saved` after finishing the file.

pub mod linux_plan;
pub mod sizing;
pub mod synthetic;
pub mod timeline;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::capture::recording::protocol::{self, Command, StartCommand};
use timeline::Timeline;

/// The flag `main` looks for.
pub const RECORDER_FLAG: &str = "--capture-recorder";

/// The capture clock: microseconds since the child started. Every source
/// stamps its samples on it, and pause and resume are read from it, so the
/// timeline compares like with like.
#[derive(Debug, Clone, Copy)]
pub struct Clock(Instant);

impl Clock {
    #[must_use]
    pub fn start() -> Self {
        Self(Instant::now())
    }

    #[must_use]
    pub fn now(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_micros()).unwrap_or(u64::MAX)
    }
}

/// One piece of a recording, stamped on the capture clock.
#[derive(Debug, Clone, PartialEq)]
pub enum Sample {
    /// A picture. The synthetic source only says where its bar is.
    Video { time: u64, bar_x: u32 },
    /// Mono 48 kHz PCM.
    Audio { time: u64, samples: Vec<f32> },
}

/// Where placed samples go. Times are already retimed and start at zero.
pub trait SampleWriter: Send {
    /// # Errors
    /// The writer failed and will take nothing more.
    fn video(&mut self, time: u64, bar_x: u32) -> std::result::Result<(), String>;
    /// # Errors
    /// The writer failed and will take nothing more.
    fn audio(&mut self, time: u64, samples: &[f32]) -> std::result::Result<(), String>;
    /// Finish the file at `end` (the last frame is held until then).
    ///
    /// # Errors
    /// The file could not be finished.
    fn finish(self: Box<Self>, end: u64) -> std::result::Result<(), String>;
}

/// The stand-in writer: one text line per sample, then the end time. What a
/// real encoder would be handed, readable in a test.
pub struct TextWriter {
    out: std::io::BufWriter<std::fs::File>,
}

impl TextWriter {
    /// # Errors
    /// The output file could not be created.
    pub fn create(path: &std::path::Path) -> std::result::Result<Self, String> {
        let file = std::fs::File::create(path).map_err(|e| format!("could not create the recording: {e}"))?;
        Ok(Self {
            out: std::io::BufWriter::new(file),
        })
    }
}

impl SampleWriter for TextWriter {
    fn video(&mut self, time: u64, bar_x: u32) -> std::result::Result<(), String> {
        writeln!(self.out, "video {time} bar={bar_x}").map_err(|e| e.to_string())
    }

    fn audio(&mut self, time: u64, samples: &[f32]) -> std::result::Result<(), String> {
        writeln!(self.out, "audio {time} n={}", samples.len()).map_err(|e| e.to_string())
    }

    fn finish(mut self: Box<Self>, end: u64) -> std::result::Result<(), String> {
        writeln!(self.out, "end {end}").and_then(|()| self.out.flush()).map_err(|e| e.to_string())
    }
}

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// Write one protocol line and flush it: the app reads line by line.
fn emit(out: &Output, line: &str) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

/// What a running capture thread hands back when it ends.
struct Captured {
    writer: Box<dyn SampleWriter>,
    first: Option<u64>,
    last_video: Option<u64>,
}

/// One recording in progress.
struct Session {
    output: PathBuf,
    clock: Clock,
    timeline: Arc<Mutex<Timeline>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<std::result::Result<Captured, String>>>,
}

impl Session {
    fn start(cmd: &StartCommand, out: &Output) -> std::result::Result<(Self, (u32, u32)), String> {
        if !cmd.synthetic {
            // No screen recorder on this platform yet: the app never gets
            // here (Record is hidden), and a hand-driven start is told why.
            return Err(crate::capture::recording::RecordingUnavailable::UnsupportedPlatform.message().into());
        }
        let output = PathBuf::from(&cmd.output);
        let writer: Box<dyn SampleWriter> = Box::new(TextWriter::create(&output)?);
        let clock = Clock::start();
        let timeline = Arc::new(Mutex::new(Timeline::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::spawn({
            let timeline = Arc::clone(&timeline);
            let stop = Arc::clone(&stop);
            let out = Arc::clone(out);
            move || capture_loop(clock, &timeline, &stop, writer, &out)
        });
        let size = sizing::capped(synthetic::WIDTH, synthetic::HEIGHT);
        Ok((
            Self {
                output,
                clock,
                timeline,
                stop,
                thread: Some(thread),
            },
            size,
        ))
    }

    fn pause(&self) {
        let now = self.clock.now();
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).pause(now);
    }

    fn resume(&self) {
        let now = self.clock.now();
        self.timeline.lock().unwrap_or_else(PoisonError::into_inner).resume(now);
    }

    /// Stop capturing and finish the file.
    fn finish(mut self) -> std::result::Result<(), String> {
        let now = self.clock.now();
        let captured = self.halt()?;
        let timeline = self.timeline.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let Some(first) = captured.first else {
            let _ = std::fs::remove_file(&self.output);
            return Err("The recording stopped before anything was captured.".into());
        };
        let end = timeline.end_time(now, captured.last_video).saturating_sub(first);
        captured.writer.finish(end)
    }

    /// Stop capturing and throw the file away.
    fn cancel(mut self) {
        let _ = self.halt();
        let _ = std::fs::remove_file(&self.output);
    }

    fn halt(&mut self) -> std::result::Result<Captured, String> {
        self.stop.store(true, Ordering::SeqCst);
        match self.thread.take().map(JoinHandle::join) {
            Some(Ok(captured)) => captured,
            Some(Err(_)) => Err("The recorder stopped unexpectedly.".into()),
            None => Err("not recording".into()),
        }
    }
}

/// Pull samples, drop those inside a pause, move the rest back by the pauses
/// before them and hand them to the writer, from time zero.
fn capture_loop(
    clock: Clock,
    timeline: &Mutex<Timeline>,
    stop: &AtomicBool,
    mut writer: Box<dyn SampleWriter>,
    out: &Output,
) -> std::result::Result<Captured, String> {
    let mut source = synthetic::Synthetic::new(clock);
    let mut first: Option<u64> = None;
    let mut last_video: Option<u64> = None;
    while !stop.load(Ordering::SeqCst) {
        let sample = source.next_sample();
        let time = match &sample {
            Sample::Video { time, .. } | Sample::Audio { time, .. } => *time,
        };
        let Some(placed) = timeline.lock().unwrap_or_else(PoisonError::into_inner).place(time) else {
            continue;
        };
        let start = *first.get_or_insert(placed);
        let at = placed.saturating_sub(start);
        let written = match &sample {
            Sample::Video { bar_x, .. } => {
                last_video = Some(placed);
                writer.video(at, *bar_x)
            }
            Sample::Audio { samples, .. } => writer.audio(at, samples),
        };
        if let Err(e) = written {
            // The writer failed for good: say so now, not at Stop.
            let _ = writeln!(std::io::stderr(), "writer failed: {e}");
            emit(out, &protocol::stream_stopped_line(&e, false));
            return Err(e);
        }
    }
    Ok(Captured { writer, first, last_video })
}

/// Serve the protocol on `input` and `output` until `input` closes. Returns
/// once any recording left running has been finished and kept.
pub fn serve(input: impl BufRead, output: impl Write + Send + 'static) {
    let out: Output = Arc::new(Mutex::new(Box::new(output)));
    emit(&out, &protocol::ready_line());
    let mut session: Option<Session> = None;
    for line in input.lines().map_while(std::result::Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match protocol::parse_command(line) {
            Err(bad) => emit(&out, &protocol::error_line(&bad.error, bad.id)),
            Ok(Command::Start(cmd)) => {
                if session.is_some() {
                    emit(&out, &protocol::error_line("already recording", Some(cmd.id)));
                    continue;
                }
                match Session::start(&cmd, &out) {
                    Ok((live, size)) => {
                        session = Some(live);
                        emit(&out, &protocol::ok_line("started", Some(cmd.id), Some(size)));
                    }
                    Err(e) => emit(&out, &protocol::error_line(&e, Some(cmd.id))),
                }
            }
            Ok(Command::Pause { id }) => match &session {
                Some(live) => {
                    live.pause();
                    emit(&out, &protocol::ok_line("paused", id, None));
                }
                None => emit(&out, &protocol::error_line("not recording", id)),
            },
            Ok(Command::Resume { id }) => match &session {
                Some(live) => {
                    live.resume();
                    emit(&out, &protocol::ok_line("resumed", id, None));
                }
                None => emit(&out, &protocol::error_line("not recording", id)),
            },
            Ok(Command::Stop { id }) => match session.take() {
                Some(live) => match live.finish() {
                    Ok(()) => emit(&out, &protocol::ok_line("stopped", id, None)),
                    Err(e) => emit(&out, &protocol::error_line(&e, id)),
                },
                None => emit(&out, &protocol::error_line("not recording", id)),
            },
            Ok(Command::Cancel { id }) => {
                if let Some(live) = session.take() {
                    live.cancel();
                }
                emit(&out, &protocol::ok_line("cancelled", id, None));
            }
        }
    }
    // stdin closed without a stop: the app is gone. Keep what was recorded;
    // only an explicit `cancel` deletes.
    if let Some(live) = session.take() {
        match live.finish() {
            Ok(()) => emit(&out, &protocol::ok_line("stopped", None, None)),
            Err(e) => emit(&out, &protocol::error_line(&e, None)),
        }
    }
}

/// `Hippius --capture-recorder [--list-microphones | --list-cameras]`: the
/// one-shot listings print a JSON array and return; otherwise serve the
/// protocol on stdin and stdout. Returns the process exit code.
#[must_use]
pub fn run<I, S>(args: I) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<String> = args.into_iter().map(|a| a.as_ref().to_string()).collect();
    if args.iter().any(|a| a == "--list-microphones" || a == "--list-cameras") {
        // No devices until the platform's recorder lists them.
        let mut stdout = std::io::stdout();
        return i32::from(writeln!(stdout, "[]").and_then(|()| stdout.flush()).is_err());
    }
    serve(std::io::stdin().lock(), std::io::stdout());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::recording::helper::HelperRecorder;
    use crate::capture::recording::{RecordOptions, Recorder};
    use crate::capture::screenshot::Selection;
    use std::io::BufReader;
    use std::time::Duration;

    /// The child on one end of two pipes, `HelperRecorder` on the other: the
    /// exact session the app runs, minus the process.
    fn wire(dest: &std::path::Path, synthetic: bool) -> (crate::error::Result<HelperRecorder>, JoinHandle<()>) {
        let (child_in, app_out) = std::io::pipe().unwrap();
        let (app_in, child_out) = std::io::pipe().unwrap();
        let child = std::thread::spawn(move || serve(BufReader::new(child_in), child_out));
        let recorder = HelperRecorder::begin(None, Box::new(app_out), app_in, dest.to_path_buf(), false, |id| {
            let mut cmd = StartCommand::from_selection(id, Selection::Screen { display_id: 1 }, dest, RecordOptions::default())?;
            cmd.synthetic = synthetic;
            Ok(cmd)
        });
        (recorder, child)
    }

    fn lines(path: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(path).unwrap().lines().map(str::to_string).collect()
    }

    fn end_of(lines: &[String]) -> u64 {
        lines.last().and_then(|l| l.strip_prefix("end ")).expect("finished").parse().unwrap()
    }

    #[test]
    fn start_pause_resume_stop_leaves_a_file_with_the_pause_cut_out() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("rec.txt");
        let (recorder, child) = wire(&dest, true);
        let mut recorder: Box<dyn Recorder> = Box::new(recorder.expect("started"));
        std::thread::sleep(Duration::from_millis(300));
        recorder.pause().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        recorder.resume().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let path = recorder.stop().expect("stopped");
        child.join().unwrap();

        assert_eq!(path, dest);
        let lines = lines(&dest);
        assert!(lines.iter().any(|l| l.starts_with("video ")), "{lines:?}");
        assert!(lines.iter().any(|l| l.starts_with("audio ")));
        // 0.6 s recorded; the 0.4 s pause is not in the file.
        let end = end_of(&lines);
        assert!((450_000..=900_000).contains(&end), "end at {end} us");
        // No two frames further apart than a frame and a bit: the pause left
        // no hole.
        let frames: Vec<u64> = lines
            .iter()
            .filter_map(|l| l.strip_prefix("video ")?.split(' ').next()?.parse().ok())
            .collect();
        let widest = frames.windows(2).map(|w| w[1] - w[0]).max().unwrap();
        assert!(widest < 150_000, "a {widest} us hole in the video");
    }

    #[test]
    fn cancel_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("rec.txt");
        let (recorder, child) = wire(&dest, true);
        let recorder: Box<dyn Recorder> = Box::new(recorder.expect("started"));
        std::thread::sleep(Duration::from_millis(150));
        recorder.cancel().unwrap();
        child.join().unwrap();
        assert!(!dest.exists());
    }

    /// The app died: its end of stdin closed. The child finishes the file
    /// and keeps it.
    #[test]
    fn stdin_closing_finishes_and_keeps_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("rec.txt");
        let (child_in, mut app_out) = std::io::pipe().unwrap();
        let (app_in, child_out) = std::io::pipe().unwrap();
        let child = std::thread::spawn(move || serve(BufReader::new(child_in), child_out));
        let start = serde_json::json!({ "cmd": "start", "id": 1, "output": dest, "synthetic": true });
        writeln!(app_out, "{start}").unwrap();
        let mut replies = BufReader::new(app_in).lines();
        assert_eq!(replies.next().unwrap().unwrap(), protocol::ready_line());
        let started = protocol::parse_event(&replies.next().unwrap().unwrap()).unwrap();
        assert_eq!(started.event, protocol::HelperEvent::Started);
        std::thread::sleep(Duration::from_millis(200));
        drop(app_out);
        child.join().unwrap();
        let last = protocol::parse_event(&replies.next().unwrap().unwrap()).unwrap();
        assert_eq!(last.event, protocol::HelperEvent::Stopped);
        assert!(end_of(&lines(&dest)) > 0);
    }

    /// A real screen is not recorded here yet: the start is refused with the
    /// line the app shows, and no file is made.
    #[test]
    fn a_real_start_is_refused_with_the_apps_own_line() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("rec.mp4");
        let (recorder, child) = wire(&dest, false);
        let err = recorder.err().expect("refused");
        assert_eq!(
            err.to_string(),
            crate::capture::recording::RecordingUnavailable::UnsupportedPlatform.message()
        );
        child.join().unwrap();
        assert!(!dest.exists());
    }

    /// The helper's replies to a command that makes no sense now.
    #[test]
    fn commands_without_a_recording_are_refused_by_id() {
        let (child_in, mut app_out) = std::io::pipe().unwrap();
        let (app_in, child_out) = std::io::pipe().unwrap();
        let child = std::thread::spawn(move || serve(BufReader::new(child_in), child_out));
        app_out.write_all(b"{\"cmd\":\"pause\",\"id\":4}\n").unwrap();
        app_out.write_all(b"{\"cmd\":\"stop\",\"id\":5}\n").unwrap();
        app_out.write_all(b"{\"cmd\":\"cancel\",\"id\":6}\n").unwrap();
        writeln!(app_out, "garbage").unwrap();
        drop(app_out);
        child.join().unwrap();
        let replies: Vec<String> = BufReader::new(app_in).lines().map(Result::unwrap).collect();
        assert_eq!(
            replies,
            vec![
                protocol::ready_line(),
                protocol::error_line("not recording", Some(4)),
                protocol::error_line("not recording", Some(5)),
                protocol::ok_line("cancelled", Some(6), None),
                protocol::error_line("malformed command", None),
            ]
        );
    }
}
