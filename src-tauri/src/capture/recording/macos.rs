//! macOS recording: spawn the Swift ScreenCaptureKit helper and drive it over
//! newline-delimited JSON on stdin/stdout.
//!
//! The helper ships inside the app as `Contents/MacOS/HippiusCapture`, put
//! there and signed by `macos/finalize-macos-release.sh` (see
//! `macos/embed-capture-helper.sh`). Release builds look only there. Debug
//! builds also look under `macos/HippiusCapture/.build/` so `pnpm tauri:dev`
//! works after a one-shot `macos/build-capture-helper.sh`.
//!
//! Every command carries an `id` the helper echoes on its reply, so a late
//! answer to an earlier command is never read as the answer to this one. The
//! helper may also speak unprompted: `stream_stopped` when the recording ended
//! on its own. The reader thread notes that (and a helper that vanished) in
//! [`Shared`], which [`Recorder::take_death`] reports to the session.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{RecordOptions, Recorder};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

const HELPER_NAME: &str = "HippiusCapture";

/// A file the helper left behind without finishing it is kept only when it
/// is at least this big: the first movie fragment (2 s of video) is well
/// above it, a header with no picture is well below.
const MIN_PARTIAL_BYTES: u64 = 16 * 1024;

/// ScreenCaptureKit system audio needs macOS 13+; hide recording below that.
pub fn recording_supported() -> bool {
    macos_at_least(13, 0) && helper_path().is_some()
}

/// ScreenCaptureKit draws click rings from macOS 15.
pub fn show_clicks_supported() -> bool {
    macos_at_least(15, 0)
}

/// The microphone joins the recording from macOS 15.
pub fn microphone_supported() -> bool {
    macos_at_least(15, 0)
}

/// The Mac's microphones, from the helper (`--list-microphones` prints them as
/// JSON and exits). Empty when the helper is missing or recording the
/// microphone is not supported here.
pub fn list_microphones() -> Vec<super::Microphone> {
    if !microphone_supported() {
        return Vec::new();
    }
    list_devices("--list-microphones")
}

/// The Mac's cameras, from the helper (`--list-cameras`), so the bar can offer
/// them before the camera window has opened one. Empty without the helper.
pub fn list_cameras() -> Vec<super::MediaDevice> {
    if !macos_at_least(13, 0) {
        return Vec::new();
    }
    list_devices("--list-cameras")
}

fn list_devices(flag: &str) -> Vec<super::MediaDevice> {
    let Some(helper) = helper_path() else { return Vec::new() };
    // A closed stdin: an older helper that does not know the flag starts a
    // session instead, and must see end-of-input and exit at once.
    let Ok(out) = Command::new(helper).arg(flag).stdin(Stdio::null()).output() else {
        return Vec::new();
    };
    parse_devices(&String::from_utf8_lossy(&out.stdout))
}

/// The helper prints one JSON array; anything else (an old helper that does
/// not know the flag and starts a session instead, a crash) reads as none.
fn parse_devices(stdout: &str) -> Vec<super::MediaDevice> {
    stdout
        .lines()
        .find_map(|line| serde_json::from_str::<Vec<super::MediaDevice>>(line.trim()).ok())
        .unwrap_or_default()
}

pub fn start(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    if !macos_at_least(13, 0) {
        return Err(AppError::Validation("Screen recording needs macOS 13 or later.".into()));
    }
    let helper = helper_path().ok_or_else(|| AppError::Other("The screen-recording helper is missing from this build.".into()))?;

    let mut child = Command::new(&helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(format!("Could not start the recording helper: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("recording helper has no stdout".into()))?;
    if let Some(stderr) = child.stderr.take() {
        // The helper writes to stderr only when something went wrong (a
        // stream that stopped, a writer that failed), so it belongs in the
        // logs a user sends with a support request.
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                tracing::warn!(target: "capture.helper", "{line}");
            }
        });
    }

    let shared = Arc::new(Shared::default());
    let (tx, rx) = mpsc::channel::<Incoming>();
    thread::spawn({
        let shared = Arc::clone(&shared);
        move || read_events(stdout, &tx, &shared)
    });

    // Wait for the helper's ready handshake before sending start.
    wait_for(&rx, None, |e| matches!(e, HelperEvent::Ready), Duration::from_secs(5))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("recording helper has no stdin".into()))?;

    let microphone = options.microphone;
    let mut session = MacosRecorder {
        child: Some(child),
        stdin: Some(stdin),
        events: rx,
        shared,
        next_id: 0,
        output: dest.to_path_buf(),
        microphone,
        running_since: None,
        accumulated: Duration::ZERO,
        paused: false,
    };
    let id = session.next_id();
    let start_cmd = StartCommand::from_selection(id, selection, dest, options)?;
    session.write_cmd(&start_cmd)?;
    session.wait(id, |e| matches!(e, HelperEvent::Started), Duration::from_secs(30))?;
    session.running_since = Some(Instant::now());
    Ok(Box::new(session))
}

/// Forward the helper's stdout as events; note a recording that ended on its
/// own (`stream_stopped`, or the helper gone) before anyone is told.
fn read_events(stdout: impl std::io::Read, tx: &mpsc::Sender<Incoming>, shared: &Shared) {
    for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
        match parse_event(&line) {
            Ok(incoming) => {
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
    /// encoder failed); the helper finished the file, `saved` says whether
    /// that worked.
    StreamStopped { message: String, saved: bool },
    /// The helper's stdout closed: it crashed or was killed. Movie fragments
    /// already written still play.
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
}

impl Shared {
    /// The first cause wins: a `stream_stopped` is followed by the helper
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

struct MacosRecorder {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    events: Receiver<Incoming>,
    shared: Arc<Shared>,
    next_id: u64,
    output: PathBuf,
    microphone: bool,
    running_since: Option<Instant>,
    accumulated: Duration,
    paused: bool,
}

impl MacosRecorder {
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

    /// Why the helper stopped, waiting briefly for the reader thread to say:
    /// a write to a helper that just died fails before its stdout closes.
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
}

/// Whether the file a recording that ended on its own left behind is worth
/// delivering: finished by the helper, or long enough to hold a fragment.
fn kept_after(death: &Death, size: u64) -> bool {
    match death {
        Death::StreamStopped { saved: true, .. } => size > 0,
        _ => size >= MIN_PARTIAL_BYTES,
    }
}

impl Recorder for MacosRecorder {
    fn pause(&mut self) -> Result<()> {
        if self.paused {
            return Ok(());
        }
        self.command("pause", |e| matches!(e, HelperEvent::Paused), Duration::from_secs(5))?;
        self.freeze_elapsed();
        self.paused = true;
        Ok(())
    }

    fn resume(&mut self) -> Result<()> {
        if !self.paused {
            return Ok(());
        }
        self.command("resume", |e| matches!(e, HelperEvent::Resumed), Duration::from_secs(5))?;
        self.running_since = Some(Instant::now());
        self.paused = false;
        Ok(())
    }

    fn stop(mut self: Box<Self>) -> Result<PathBuf> {
        if let Some(death) = self.shared.death() {
            return self.salvage(&death);
        }
        let stopped = self.command("stop", |e| matches!(e, HelperEvent::Stopped), Duration::from_mins(2));
        if let Err(e) = stopped {
            // Stop raced the stream stopping by itself, or the helper died:
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
        let _ = self.command(
            "cancel",
            |e| matches!(e, HelperEvent::Cancelled | HelperEvent::Stopped),
            Duration::from_secs(5),
        );
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

    fn take_death(&self) -> Option<AppError> {
        let death = self.shared.death()?;
        if self.shared.reported.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(death.to_error())
    }
}

impl MacosRecorder {
    /// Close stdin and end the helper. After a finished stop or cancel it has
    /// nothing left to write; anywhere else (an error path dropping the
    /// recorder) killing it leaves the movie fragments already on disk.
    fn shutdown(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for MacosRecorder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Serialize)]
struct SimpleCommand {
    cmd: &'static str,
    id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartCommand {
    cmd: &'static str,
    id: u64,
    output: String,
    display_id: Option<u32>,
    window_id: Option<u32>,
    crop: Option<CropRect>,
    microphone: bool,
    /// The microphone's `AVCaptureDevice.uniqueID`; absent = system default.
    #[serde(skip_serializing_if = "Option::is_none")]
    microphone_device_id: Option<String>,
    /// Ring the pointer where it clicks (ScreenCaptureKit, macOS 15+; the
    /// helper ignores it on older systems).
    show_clicks: bool,
}

#[derive(Serialize)]
struct CropRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl StartCommand {
    fn from_selection(id: u64, selection: Selection, dest: &Path, options: RecordOptions) -> Result<Self> {
        let output = dest
            .to_str()
            .ok_or_else(|| AppError::Other("Recording path is not valid UTF-8.".into()))?
            .to_string();
        let mut cmd = Self {
            cmd: "start",
            id,
            output,
            display_id: None,
            window_id: None,
            crop: None,
            microphone: options.microphone,
            microphone_device_id: options.microphone_device.clone(),
            show_clicks: options.show_clicks,
        };
        match selection {
            Selection::Screen { display_id } => cmd.display_id = Some(display_id),
            Selection::Window { window_id } => cmd.window_id = Some(window_id),
            Selection::Area { display_id, rect } => {
                cmd.display_id = Some(display_id);
                cmd.crop = Some(CropRect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                });
            }
        }
        Ok(cmd)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HelperEvent {
    Ready,
    Started,
    Paused,
    Resumed,
    Stopped,
    Cancelled,
    Error(String),
    /// Unprompted: the recording ended on its own; the file is finished
    /// (`saved`) with what it had.
    StreamStopped {
        message: String,
        saved: bool,
    },
}

/// One line from the helper: the event, and the id of the command it
/// answers (none for `ready` and `stream_stopped`).
#[derive(Debug)]
struct Incoming {
    id: Option<u64>,
    event: HelperEvent,
}

#[derive(Deserialize)]
struct WireEvent {
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    saved: Option<bool>,
}

fn parse_event(line: &str) -> std::result::Result<Incoming, String> {
    let v: WireEvent = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let event = if v.event.as_deref() == Some("stream_stopped") {
        HelperEvent::StreamStopped {
            message: v.error.unwrap_or_else(|| "the stream stopped".into()),
            saved: v.saved.unwrap_or(false),
        }
    } else if v.ok == Some(false) || v.error.is_some() {
        HelperEvent::Error(v.error.unwrap_or_else(|| "helper error".into()))
    } else {
        match v.event.as_deref() {
            Some("ready") => HelperEvent::Ready,
            Some("started") => HelperEvent::Started,
            Some("paused") => HelperEvent::Paused,
            Some("resumed") => HelperEvent::Resumed,
            Some("stopped") => HelperEvent::Stopped,
            Some("cancelled") => HelperEvent::Cancelled,
            other => return Err(format!("unknown helper event: {other:?}")),
        }
    };
    Ok(Incoming { id: v.id, event })
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

/// Where the helper may be, in the order to look. A shipped app has it in
/// one place only: beside the main binary in `Contents/MacOS`. Debug builds
/// also try the Swift package's own build products, so a dev run works
/// after `macos/build-capture-helper.sh`; release builds never probe the CI
/// checkout path that `CARGO_MANIFEST_DIR` would bake in.
fn helper_candidates(exe_dir: Option<&Path>, dev_package: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = exe_dir {
        out.push(dir.join(HELPER_NAME));
    }
    if let Some(pkg) = dev_package {
        let build = pkg.join(".build");
        out.push(build.join("release").join(HELPER_NAME));
        out.push(build.join("apple").join("Products").join("Release").join(HELPER_NAME));
        out.push(build.join("out").join("Products").join("Release").join(HELPER_NAME));
        out.push(build.join("debug").join(HELPER_NAME));
    }
    out
}

fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    #[cfg(debug_assertions)]
    let dev_package = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("macos").join("HippiusCapture"));
    #[cfg(not(debug_assertions))]
    let dev_package: Option<PathBuf> = None;
    helper_candidates(exe_dir, dev_package.as_deref()).into_iter().find(|p| p.is_file())
}

/// Whether this Mac runs at least `major.minor`. The version is read once,
/// in the cache the permission checks share ([`permissions::macos_version`]).
///
/// [`permissions::macos_version`]: crate::capture::permissions::macos_version
fn macos_at_least(major: u64, minor: u64) -> bool {
    crate::capture::permissions::macos_version().is_some_and(|v| v >= (major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;

    #[test]
    fn start_command_for_area_includes_crop() {
        let cmd = StartCommand::from_selection(
            7,
            Selection::Area {
                display_id: 3,
                rect: LogicalRect {
                    x: 10.0,
                    y: 20.0,
                    width: 100.0,
                    height: 50.0,
                },
            },
            Path::new("/tmp/out.mp4"),
            RecordOptions {
                microphone: true,
                microphone_device: Some("BuiltInMicrophoneDevice".into()),
                show_clicks: true,
            },
        )
        .unwrap();
        let v = serde_json::to_value(&cmd).unwrap();
        assert_eq!(v["cmd"], "start");
        assert_eq!(v["id"], 7);
        assert_eq!(v["displayId"], 3);
        assert_eq!(v["crop"]["width"], 100.0);
        assert_eq!(v["microphone"], true);
        // The Swift helper reads these exact keys.
        assert_eq!(v["showClicks"], true);
        assert_eq!(v["microphoneDeviceId"], "BuiltInMicrophoneDevice");
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

    #[test]
    fn parses_helper_events() {
        let ready = parse_event(r#"{"ok":true,"event":"ready"}"#).unwrap();
        assert_eq!((ready.id, ready.event), (None, HelperEvent::Ready));
        let started = parse_event(r#"{"height":2234,"id":1,"ok":true,"event":"started","width":3456}"#).unwrap();
        assert_eq!((started.id, started.event), (Some(1), HelperEvent::Started));
        let err = parse_event(r#"{"ok":false,"error":"no display","id":4}"#).unwrap();
        assert_eq!((err.id, err.event), (Some(4), HelperEvent::Error("no display".into())));
    }

    /// The exact line the helper writes when a recorded window closes.
    #[test]
    fn a_stream_that_stopped_on_its_own_is_its_own_event_not_a_command_error() {
        let line = r#"{"ok":false,"event":"stream_stopped","saved":true,"error":"Failed to find any displays or windows to capture"}"#;
        let got = parse_event(line).unwrap();
        assert_eq!(got.id, None);
        assert_eq!(
            got.event,
            HelperEvent::StreamStopped {
                message: "Failed to find any displays or windows to capture".into(),
                saved: true,
            }
        );
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

        let recorder = MacosRecorder {
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

    #[test]
    fn the_helper_is_looked_for_beside_the_app_first_and_in_the_package_only_for_dev() {
        let exe = Path::new("/Applications/Hippius.app/Contents/MacOS");
        let shipped = helper_candidates(Some(exe), None);
        assert_eq!(shipped, vec![exe.join("HippiusCapture")]);

        let pkg = Path::new("/src/macos/HippiusCapture");
        let dev = helper_candidates(Some(exe), Some(pkg));
        assert_eq!(dev[0], exe.join("HippiusCapture"));
        assert!(dev.contains(&pkg.join(".build/release/HippiusCapture")));
        assert!(dev.contains(&pkg.join(".build/apple/Products/Release/HippiusCapture")));
    }

    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }

    /// Drives the real helper end to end through this recorder:
    /// `cargo test --lib records_pauses_and_stops_for_real -- --ignored`
    /// after `macos/build-capture-helper.sh`, from a terminal allowed to
    /// record the screen. Leaves the file in the temp dir for a player.
    #[test]
    #[ignore = "records the screen: needs the helper built and Screen Recording permission"]
    fn records_pauses_and_stops_for_real() {
        let out = std::env::temp_dir().join("hippius-real-recording.mp4");
        let _ = std::fs::remove_file(&out);
        // SAFETY: CoreGraphics' main display id, no preconditions.
        let display_id = unsafe { CGMainDisplayID() };
        let mut recorder = start(Selection::Screen { display_id }, &out, RecordOptions::default()).expect("started");
        thread::sleep(Duration::from_millis(1500));
        recorder.pause().expect("paused");
        thread::sleep(Duration::from_millis(1500));
        recorder.resume().expect("resumed");
        thread::sleep(Duration::from_millis(1500));
        assert!(recorder.take_death().is_none(), "nothing died");
        let elapsed = recorder.elapsed_secs();
        let path = recorder.stop().expect("stopped");
        let size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(path, out);
        assert!(size > MIN_PARTIAL_BYTES, "{size} bytes");
        assert!((2..=4).contains(&elapsed), "the pause is not counted: {elapsed}");
    }

    /// The helper trims the camera stage's margin and rounded corners by a
    /// fixed amount (`stageInset`) worked out from the page's classes. If the
    /// stage's padding or radius changes, the trim must be worked out again
    /// or the corners come back black.
    #[test]
    fn the_stage_trim_matches_the_stage_page() {
        let swift = include_str!("../../../../macos/HippiusCapture/Sources/main.swift");
        let page = include_str!("../../../../app/capture-camera/page.tsx");
        assert!(swift.contains("let stageInset: CGFloat = 12"), "main.swift lost its stage inset");
        assert!(
            page.contains("h-full w-full p-1.5") && page.contains("rounded-[18px]"),
            "the camera stage's margin (p-1.5) or corner radius (rounded-[18px]) changed; \
             recompute stageInset in macos/HippiusCapture/Sources/main.swift"
        );
    }
}
