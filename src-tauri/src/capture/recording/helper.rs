//! A recording driven in another process over the recorder protocol
//! ([`super::protocol`]): the Swift helper on macOS, the app's own executable
//! in `--capture-recorder` mode on Windows and Linux.
//!
//! Platform free: each platform module only says which program to start
//! (`helper_command`) and when recording is possible at all. Everything
//! about the session lives here: the `ready` handshake, ids echoed on
//! replies (a late answer to an earlier command is never read as the answer
//! to this one), and the unprompted `stream_stopped`. The reader thread notes
//! that (and a recorder that vanished) in [`Shared`], which
//! [`Recorder::take_death`] reports to the session.
//!
//! A separate process keeps crash safety: an encoder or a capture driver that
//! dies takes the recorder with it, not the app, and the file it was writing
//! is fragmented so what was written still plays.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::protocol::{HelperEvent, Incoming, SimpleCommand, StartCommand, parse_event};
use super::{MediaDevice, RecordOptions, Recorder};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

/// A file the recorder left behind without finishing it is kept only when it
/// is at least this big: the first movie fragment (2 s of video) is well
/// above it, a header with no picture is well below.
pub const MIN_PARTIAL_BYTES: u64 = 16 * 1024;

/// How long the recorder has to say `ready` after it starts.
const READY_WITHIN: Duration = Duration::from_secs(5);
/// How long `start` may take (a window server or portal asking the user).
const START_WITHIN: Duration = Duration::from_secs(30);
/// Pause, resume and cancel answer at once.
const COMMAND_WITHIN: Duration = Duration::from_secs(5);
/// Finishing the file of a long recording.
const STOP_WITHIN: Duration = Duration::from_mins(2);

/// Start `program` and record `selection` into `dest` with it.
///
/// # Errors
///
/// The program could not start, never said `ready`, or refused the `start`.
pub fn start(program: Command, selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    start_within(program, selection, dest, options, START_WITHIN)
}

/// [`start`], allowing `start_within` for the `started` reply: a recorder
/// that opens the desktop's screen-sharing dialog (the Wayland ScreenCast
/// portal) waits for the user, who may take a while to choose.
///
/// # Errors
///
/// The program could not start, never said `ready`, or refused the `start`.
pub fn start_within(
    mut program: Command,
    selection: Selection,
    dest: &Path,
    options: RecordOptions,
    start_within: Duration,
) -> Result<Box<dyn Recorder>> {
    let mut child = program
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(format!("Could not start the recording helper: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("recording helper has no stdout".into()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("recording helper has no stdin".into()))?;
    if let Some(stderr) = child.stderr.take() {
        // The recorder writes to stderr only when something went wrong (a
        // stream that stopped, a writer that failed), so it belongs in the
        // logs a user sends with a support request.
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                tracing::warn!(target: "capture.helper", "{line}");
            }
        });
    }
    let microphone = options.microphone;
    let recorder = HelperRecorder::begin_within(
        Some(child),
        Box::new(stdin),
        stdout,
        dest.to_path_buf(),
        microphone,
        |id| StartCommand::from_selection(id, selection, dest, options),
        start_within,
    )?;
    Ok(Box::new(recorder))
}

/// This executable in recorder mode (`--capture-recorder`): the recorder on
/// Windows and Linux, which need no second binary to build, sign or ship.
///
/// # Errors
///
/// The running executable's path could not be read.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn own_recorder_command() -> Result<Command> {
    let exe = std::env::current_exe().map_err(|e| AppError::Other(format!("Could not find the app to record with: {e}")))?;
    let mut program = Command::new(exe);
    program.arg(crate::capture::recorder_child::RECORDER_FLAG);
    Ok(program)
}

/// Run `program` once with `flag` (`--list-microphones`, `--list-cameras`)
/// and read the device list it prints.
pub fn list_devices(mut program: Command, flag: &str) -> Vec<MediaDevice> {
    // A closed stdin: an older helper that does not know the flag starts a
    // session instead, and must see end-of-input and exit at once.
    let Ok(out) = program.arg(flag).stdin(Stdio::null()).output() else {
        return Vec::new();
    };
    parse_devices(&String::from_utf8_lossy(&out.stdout))
}

/// Run `program` to the end with a closed stdin and return what it printed,
/// or `None` when it could not start or did not finish within `limit` (it is
/// then killed, so a stuck helper never holds the caller up for longer).
pub fn output_within(mut program: Command, limit: Duration) -> Option<String> {
    let mut child = program.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        let read = stdout.read_to_string(&mut text).map(|_| text);
        let _ = tx.send(read);
    });
    if let Ok(Ok(text)) = rx.recv_timeout(limit) {
        let _ = child.wait();
        Some(text)
    } else {
        let _ = child.kill();
        let _ = child.wait();
        None
    }
}

/// The recorder prints one JSON array; anything else (an old helper that
/// does not know the flag and starts a session instead, a crash) reads as
/// none.
pub fn parse_devices(stdout: &str) -> Vec<MediaDevice> {
    stdout
        .lines()
        .find_map(|line| serde_json::from_str::<Vec<MediaDevice>>(line.trim()).ok())
        .unwrap_or_default()
}

/// Forward the recorder's stdout as events; note a recording that ended on
/// its own (`stream_stopped`, or the recorder gone) before anyone is told.
fn read_events(stdout: impl Read, tx: &mpsc::Sender<Incoming>, shared: &Shared) {
    for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
        match parse_event(&line) {
            Ok(Incoming {
                event: HelperEvent::DeviceLost { device },
                ..
            }) => {
                // Not a reply to anything and not the end: kept for the
                // session to tell the user, never handed to `wait_for`.
                if let Ok(mut lost) = shared.lost.lock() {
                    lost.push(device);
                }
            }
            Ok(incoming) => {
                if incoming.event == HelperEvent::Started
                    && let Some(token) = &incoming.restore_token
                    && let Ok(mut slot) = shared.restore_token.lock()
                {
                    *slot = Some(token.clone());
                }
                if let HelperEvent::StreamStopped { message, saved } = &incoming.event {
                    shared.died(Death::StreamStopped {
                        message: message.clone(),
                        saved: *saved,
                    });
                }
                // The receiver goes away with the recorder; keep reading so
                // the death is still recorded for anyone holding `shared`.
                let _ = tx.send(incoming);
            }
            Err(e) => tracing::warn!(target: "capture.helper", error = %e, line = %line, "bad helper line"),
        }
    }
    shared.died(Death::Exited);
}

/// Why a recording ended without being asked to.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Death {
    /// The stream stopped (display gone, sleep, permission revoked, the
    /// encoder failed); the recorder finished the file, `saved` says whether
    /// that worked.
    StreamStopped { message: String, saved: bool },
    /// The recorder's stdout closed: it crashed or was killed. Movie
    /// fragments already written still play.
    Exited,
}

impl Death {
    fn to_error(&self) -> AppError {
        match self {
            Self::StreamStopped { message, .. } => AppError::Other(format!("The recording stopped on its own: {message}")),
            Self::Exited => AppError::Other("The recording helper exited unexpectedly.".into()),
        }
    }
}

/// Written by the reader thread, read by the session.
#[derive(Default)]
struct Shared {
    death: Mutex<Option<Death>>,
    /// `take_death` has handed the death out once already.
    reported: AtomicBool,
    /// The portal's restore token from `started` (Wayland only).
    restore_token: Mutex<Option<String>>,
    /// Sound sources that went away mid-recording, oldest first, not yet
    /// handed out by `take_lost_device`.
    lost: Mutex<Vec<String>>,
}

impl Shared {
    /// The first cause wins: a `stream_stopped` is followed by the recorder
    /// exiting, and the stream is the reason worth telling.
    fn died(&self, death: Death) {
        if let Ok(mut slot) = self.death.lock()
            && slot.is_none()
        {
            *slot = Some(death);
        }
    }

    fn death(&self) -> Option<Death> {
        self.death.lock().ok().and_then(|slot| slot.clone())
    }
}

/// One recording in another process. Built by [`start`]; tests drive it
/// over in-process pipes instead of a child.
pub struct HelperRecorder {
    child: Option<Child>,
    stdin: Option<Box<dyn Write + Send>>,
    events: Receiver<Incoming>,
    shared: Arc<Shared>,
    next_id: u64,
    output: PathBuf,
    microphone: bool,
    running_since: Option<Instant>,
    accumulated: Duration,
    paused: bool,
}

impl HelperRecorder {
    /// Wait for `ready`, send the `start` that `start_cmd` builds with its
    /// id, and wait for `started`. The recorder is shut down (killed if it
    /// is a child) when any of that fails.
    #[cfg(test)]
    pub(crate) fn begin(
        child: Option<Child>,
        stdin: Box<dyn Write + Send>,
        stdout: impl Read + Send + 'static,
        output: PathBuf,
        microphone: bool,
        start_cmd: impl FnOnce(u64) -> Result<StartCommand>,
    ) -> Result<Self> {
        Self::begin_within(child, stdin, stdout, output, microphone, start_cmd, START_WITHIN)
    }

    /// [`Self::begin`], waiting up to `start_within` for `started`.
    pub(crate) fn begin_within(
        child: Option<Child>,
        stdin: Box<dyn Write + Send>,
        stdout: impl Read + Send + 'static,
        output: PathBuf,
        microphone: bool,
        start_cmd: impl FnOnce(u64) -> Result<StartCommand>,
        start_within: Duration,
    ) -> Result<Self> {
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel::<Incoming>();
        thread::spawn({
            let shared = Arc::clone(&shared);
            move || read_events(stdout, &tx, &shared)
        });
        let mut session = Self {
            child,
            stdin: Some(stdin),
            events: rx,
            shared,
            next_id: 0,
            output,
            microphone,
            running_since: None,
            accumulated: Duration::ZERO,
            paused: false,
        };
        // The recorder's ready handshake comes before the start.
        wait_for(&session.events, None, |e| matches!(e, HelperEvent::Ready), READY_WITHIN)?;
        let id = session.next_id();
        let cmd = start_cmd(id)?;
        session.write_cmd(&cmd)?;
        session.wait(id, |e| matches!(e, HelperEvent::Started), start_within)?;
        session.running_since = Some(Instant::now());
        Ok(session)
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn write_cmd<T: Serialize>(&mut self, cmd: &T) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Other("recording helper stdin closed".into()))?;
        let mut line = serde_json::to_string(cmd).map_err(|e| AppError::Other(e.to_string()))?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|e| AppError::Other(format!("Could not talk to the recording helper: {e}")))
    }

    /// Send a command without arguments and wait for its reply.
    fn command(&mut self, cmd: &'static str, pred: impl Fn(&HelperEvent) -> bool, timeout: Duration) -> Result<()> {
        let id = self.next_id();
        self.write_cmd(&SimpleCommand { cmd, id })?;
        self.wait(id, pred, timeout)
    }

    fn wait(&self, id: u64, pred: impl Fn(&HelperEvent) -> bool, timeout: Duration) -> Result<()> {
        wait_for(&self.events, Some(id), pred, timeout)
    }

    fn freeze_elapsed(&mut self) {
        if let Some(since) = self.running_since.take() {
            self.accumulated += since.elapsed();
        }
    }

    /// Why the recorder stopped, waiting briefly for the reader thread to
    /// say: a write to a recorder that just died fails before its stdout
    /// closes.
    fn settled_death(&self) -> Option<Death> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(death) = self.shared.death() {
                return Some(death);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// The recording ended on its own: hand back what was saved.
    fn salvage(&mut self, death: &Death) -> Result<PathBuf> {
        self.freeze_elapsed();
        self.shutdown();
        let size = std::fs::metadata(&self.output).map_or(0, |m| m.len());
        if kept_after(death, size) {
            tracing::warn!(target: "capture.helper", ?death, size, "recording ended on its own; keeping what was saved");
            Ok(self.output.clone())
        } else {
            Err(death.to_error())
        }
    }

    /// Close stdin and end the recorder. After a finished stop or cancel it
    /// has nothing left to write; anywhere else (an error path dropping the
    /// recorder) killing it leaves the movie fragments already on disk.
    fn shutdown(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Whether the file a recording that ended on its own left behind is worth
/// delivering: finished by the recorder, or long enough to hold a fragment.
fn kept_after(death: &Death, size: u64) -> bool {
    match death {
        Death::StreamStopped { saved: true, .. } => size > 0,
        _ => size >= MIN_PARTIAL_BYTES,
    }
}

impl Recorder for HelperRecorder {
    fn pause(&mut self) -> Result<()> {
        if self.paused {
            return Ok(());
        }
        self.command("pause", |e| matches!(e, HelperEvent::Paused), COMMAND_WITHIN)?;
        self.freeze_elapsed();
        self.paused = true;
        Ok(())
    }

    fn resume(&mut self) -> Result<()> {
        if !self.paused {
            return Ok(());
        }
        self.command("resume", |e| matches!(e, HelperEvent::Resumed), COMMAND_WITHIN)?;
        self.running_since = Some(Instant::now());
        self.paused = false;
        Ok(())
    }

    fn stop(mut self: Box<Self>) -> Result<PathBuf> {
        if let Some(death) = self.shared.death() {
            return self.salvage(&death);
        }
        let stopped = self.command("stop", |e| matches!(e, HelperEvent::Stopped), STOP_WITHIN);
        if let Err(e) = stopped {
            // Stop raced the stream stopping by itself, or the recorder died:
            // what it saved is still the user's recording.
            if let Some(death) = self.settled_death() {
                return self.salvage(&death);
            }
            self.shutdown();
            return Err(e);
        }
        self.freeze_elapsed();
        self.shutdown();
        if !self.output.is_file() {
            return Err(AppError::Other("The recording helper finished without a file.".into()));
        }
        Ok(self.output.clone())
    }

    fn cancel(mut self: Box<Self>) -> Result<()> {
        let _ = self.command("cancel", |e| matches!(e, HelperEvent::Cancelled | HelperEvent::Stopped), COMMAND_WITHIN);
        self.shutdown();
        if self.output.exists() {
            let _ = std::fs::remove_file(&self.output);
        }
        Ok(())
    }

    fn elapsed_secs(&self) -> u64 {
        let mut total = self.accumulated;
        if let Some(since) = self.running_since {
            total += since.elapsed();
        }
        total.as_secs()
    }

    fn microphone(&self) -> bool {
        self.microphone
    }

    fn restore_token(&self) -> Option<String> {
        self.shared.restore_token.lock().ok().and_then(|slot| slot.clone())
    }

    fn take_death(&self) -> Option<AppError> {
        let death = self.shared.death()?;
        if self.shared.reported.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(death.to_error())
    }

    fn take_lost_device(&self) -> Option<String> {
        let mut lost = self.shared.lost.lock().ok()?;
        (!lost.is_empty()).then(|| lost.remove(0))
    }
}

impl Drop for HelperRecorder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Wait for the reply to command `id` (any reply when `None`). A reply that
/// names another command is a late answer to an earlier one and is skipped;
/// a `stream_stopped` ends the wait whatever was asked.
fn wait_for(rx: &Receiver<Incoming>, id: Option<u64>, pred: impl Fn(&HelperEvent) -> bool, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(AppError::Other("The recording helper did not respond in time.".into()));
        }
        match rx.recv_timeout(left) {
            Ok(Incoming {
                event: HelperEvent::StreamStopped { message, .. },
                ..
            }) => return Err(AppError::Other(format!("The recording stopped on its own: {message}"))),
            Ok(incoming) if id.is_some() && incoming.id.is_some() && incoming.id != id => {
                tracing::debug!(target: "capture.helper", ?incoming, "late reply skipped");
            }
            Ok(Incoming {
                event: HelperEvent::Error(msg),
                ..
            }) => return Err(AppError::Other(msg)),
            Ok(incoming) if pred(&incoming.event) => return Ok(()),
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {
                return Err(AppError::Other("The recording helper did not respond in time.".into()));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(AppError::Other("The recording helper exited unexpectedly.".into()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_one_shot_run_returns_what_it_printed_and_a_stuck_one_is_killed() {
        let mut quick = Command::new("sh");
        quick.args(["-c", "echo poster"]);
        assert_eq!(output_within(quick, Duration::from_secs(5)).as_deref(), Some("poster\n"));

        let mut stuck = Command::new("sh");
        stuck.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert_eq!(output_within(stuck, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5), "the caller waited for the stuck run");

        assert_eq!(output_within(Command::new("/no/such/helper"), Duration::from_secs(1)), None);
    }

    #[test]
    fn reads_the_helpers_microphone_list_and_survives_garbage() {
        let mics = parse_devices(r#"[{"id":"BuiltInMicrophoneDevice","name":"MacBook Pro Microphone"}]"#);
        assert_eq!(mics.len(), 1);
        assert_eq!(mics[0].name, "MacBook Pro Microphone");
        assert!(!mics[0].is_default, "an older helper sends no default mark");
        assert!(parse_devices("helper crashed").is_empty());
    }

    /// The helper marks the system default; the picker puts it first.
    #[test]
    fn reads_the_default_mark() {
        let mics = parse_devices(
            r#"[{"id":"usb-1","name":"Yeti","isDefault":false},{"id":"BuiltInMicrophoneDevice","name":"MacBook Pro Microphone","isDefault":true}]"#,
        );
        assert!(mics[1].is_default && !mics[0].is_default);
    }

    /// An older helper does not know `--list-cameras`: it announces a session
    /// and exits on the closed stdin. That reads as no cameras, not an error.
    #[test]
    fn a_helper_that_does_not_know_the_flag_lists_nothing() {
        assert!(parse_devices("{\"ok\":true,\"event\":\"ready\"}\n").is_empty());
        let cams = parse_devices("[{\"id\":\"0x1\",\"name\":\"FaceTime HD Camera\",\"isDefault\":true}]\n");
        assert_eq!(cams[0].name, "FaceTime HD Camera");
    }

    fn channel(lines: &[&str]) -> Receiver<Incoming> {
        let (tx, rx) = mpsc::channel();
        for line in lines {
            tx.send(parse_event(line).unwrap()).unwrap();
        }
        rx
    }

    /// A reply that timed out once must not answer the next command.
    #[test]
    fn a_late_reply_to_an_earlier_command_is_skipped() {
        let rx = channel(&[
            r#"{"ok":false,"error":"not recording","id":2}"#,
            r#"{"ok":true,"event":"stopped","id":3}"#,
        ]);
        assert!(wait_for(&rx, Some(3), |e| matches!(e, HelperEvent::Stopped), Duration::from_secs(1)).is_ok());

        let rx = channel(&[r#"{"ok":false,"error":"writer failed","id":3}"#]);
        let err = wait_for(&rx, Some(3), |e| matches!(e, HelperEvent::Stopped), Duration::from_secs(1)).unwrap_err();
        assert!(err.to_string().contains("writer failed"));
    }

    #[test]
    fn a_stream_stopping_ends_any_wait() {
        let rx = channel(&[r#"{"ok":false,"event":"stream_stopped","error":"display gone","saved":true}"#]);
        let err = wait_for(&rx, Some(5), |e| matches!(e, HelperEvent::Paused), Duration::from_secs(1)).unwrap_err();
        assert!(err.to_string().contains("display gone"), "{err}");
    }

    /// The reader notes the death before the session looks, and the session
    /// is told once.
    #[test]
    fn a_death_is_recorded_by_the_reader_and_reported_once() {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        let out = b"{\"ok\":true,\"event\":\"ready\"}\n{\"ok\":false,\"event\":\"stream_stopped\",\"error\":\"display gone\",\"saved\":true}\n";
        read_events(&out[..], &tx, &shared);
        assert_eq!(
            shared.death(),
            Some(Death::StreamStopped {
                message: "display gone".into(),
                saved: true
            }),
            "the stream is the reason, not the exit that follows it"
        );
        assert_eq!(rx.try_iter().count(), 2);

        let recorder = HelperRecorder {
            child: None,
            stdin: None,
            events: rx,
            shared,
            next_id: 0,
            output: PathBuf::from("/nonexistent/out.mp4"),
            microphone: false,
            running_since: None,
            accumulated: Duration::ZERO,
            paused: false,
        };
        let first = recorder.take_death().expect("reported");
        assert!(first.to_string().contains("display gone"));
        assert!(recorder.take_death().is_none(), "reported once");
    }

    /// A lost microphone is not a death and is no reply: the reader keeps
    /// it for the session, which hands it out once.
    #[test]
    fn a_lost_device_is_kept_for_the_session_and_handed_out_once() {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        let out = format!(
            "{}\n{}\n",
            crate::capture::recording::protocol::ready_line(),
            crate::capture::recording::protocol::device_lost_line("microphone", "the device went away")
        );
        read_events(out.as_bytes(), &tx, &shared);
        assert_eq!(rx.try_iter().count(), 1, "only ready is forwarded");
        let recorder = HelperRecorder {
            child: None,
            stdin: None,
            events: mpsc::channel().1,
            shared,
            next_id: 0,
            output: PathBuf::from("/nonexistent/out.mp4"),
            microphone: true,
            running_since: None,
            accumulated: Duration::ZERO,
            paused: false,
        };
        assert_eq!(recorder.take_lost_device().as_deref(), Some("microphone"));
        assert_eq!(recorder.take_lost_device(), None);
        assert_eq!(recorder.shared.death(), Some(Death::Exited), "only the stream closing ends it");
    }

    #[test]
    fn a_helper_that_vanishes_is_a_death() {
        let (tx, _rx) = mpsc::channel();
        let shared = Shared::default();
        read_events(&b"{\"ok\":true,\"event\":\"ready\"}\n"[..], &tx, &shared);
        assert_eq!(shared.death(), Some(Death::Exited));
    }

    #[test]
    fn what_a_recording_that_ended_on_its_own_keeps() {
        let saved = Death::StreamStopped {
            message: String::new(),
            saved: true,
        };
        let unsaved = Death::StreamStopped {
            message: String::new(),
            saved: false,
        };
        assert!(kept_after(&saved, 1));
        assert!(!kept_after(&saved, 0));
        assert!(kept_after(&Death::Exited, MIN_PARTIAL_BYTES));
        assert!(!kept_after(&Death::Exited, 100), "a header with no picture is not a recording");
        assert!(!kept_after(&unsaved, 100));
    }

    /// Windows and Linux record with this very executable, in recorder mode.
    #[test]
    fn the_own_recorder_is_this_executable_with_the_flag() {
        let program = own_recorder_command().unwrap();
        assert_eq!(program.get_program(), std::env::current_exe().unwrap().as_os_str());
        let args: Vec<_> = program.get_args().collect();
        assert_eq!(args, ["--capture-recorder"]);
    }

    /// A recorder that never says `ready` fails the start rather than
    /// leaving the session waiting.
    #[test]
    fn a_recorder_that_says_nothing_fails_the_start() {
        let (reader, writer) = std::io::pipe().unwrap();
        let (_, stdin) = std::io::pipe().unwrap();
        drop(writer);
        let err = HelperRecorder::begin(None, Box::new(stdin), reader, PathBuf::from("/tmp/x.mp4"), false, |id| {
            StartCommand::from_selection(id, Selection::Screen { display_id: 1 }, Path::new("/tmp/x.mp4"), RecordOptions::default())
        })
        .err()
        .expect("refused");
        assert!(err.to_string().contains("exited unexpectedly"), "{err}");
    }
}
