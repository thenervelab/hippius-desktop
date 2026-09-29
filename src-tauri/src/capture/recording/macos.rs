//! macOS recording: spawn the Swift ScreenCaptureKit helper and drive it over
//! newline-delimited JSON on stdin/stdout.
//!
//! The helper lives next to the app binary as `HippiusCapture` (see
//! `macos/build-capture-helper.sh` and Tauri `externalBin`). Dev builds look
//! next to the current exe and, failing that, under `macos/HippiusCapture/
//! .build/` so `pnpm tauri:dev` works after a one-shot helper build.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{RecordOptions, Recorder};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

const HELPER_NAME: &str = "HippiusCapture";

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
    let Some(helper) = helper_path() else { return Vec::new() };
    let Ok(out) = Command::new(helper).arg("--list-microphones").output() else {
        return Vec::new();
    };
    parse_microphones(&String::from_utf8_lossy(&out.stdout))
}

fn parse_microphones(stdout: &str) -> Vec<super::Microphone> {
    serde_json::from_str(stdout.trim()).unwrap_or_default()
}

pub fn start(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    if !macos_at_least(13, 0) {
        return Err(AppError::Validation("Screen recording needs macOS 13 or later.".into()));
    }
    let helper =
        helper_path().ok_or_else(|| AppError::Other("The screen-recording helper is missing. Rebuild with macos/build-capture-helper.sh.".into()))?;

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
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                tracing::debug!(target: "capture.helper", "{line}");
            }
        });
    }

    let (tx, rx) = mpsc::channel::<HelperEvent>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            match parse_event(&line) {
                Ok(ev) => {
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
                Err(e) => tracing::warn!(target: "capture.helper", error = %e, line = %line, "bad helper line"),
            }
        }
    });

    // Wait for the helper's ready handshake before sending start.
    wait_for(&rx, |e| matches!(e, HelperEvent::Ready), Duration::from_secs(5))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("recording helper has no stdin".into()))?;

    let microphone = options.microphone;
    let start_cmd = StartCommand::from_selection(selection, dest, options)?;
    let mut session = MacosRecorder {
        child: Some(child),
        stdin: Some(stdin),
        events: rx,
        output: dest.to_path_buf(),
        microphone,
        running_since: None,
        accumulated: Duration::ZERO,
        paused: false,
    };
    session.write_cmd(&start_cmd)?;
    wait_for(&session.events, |e| matches!(e, HelperEvent::Started), Duration::from_secs(30))?;
    session.running_since = Some(Instant::now());
    Ok(Box::new(session))
}

struct MacosRecorder {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    events: Receiver<HelperEvent>,
    output: PathBuf,
    microphone: bool,
    running_since: Option<Instant>,
    accumulated: Duration,
    paused: bool,
}

impl MacosRecorder {
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

    fn freeze_elapsed(&mut self) {
        if let Some(since) = self.running_since.take() {
            self.accumulated += since.elapsed();
        }
    }
}

impl Recorder for MacosRecorder {
    fn pause(&mut self) -> Result<()> {
        if self.paused {
            return Ok(());
        }
        self.write_cmd(&SimpleCommand { cmd: "pause" })?;
        wait_for(&self.events, |e| matches!(e, HelperEvent::Paused), Duration::from_secs(5))?;
        self.freeze_elapsed();
        self.paused = true;
        Ok(())
    }

    fn resume(&mut self) -> Result<()> {
        if !self.paused {
            return Ok(());
        }
        self.write_cmd(&SimpleCommand { cmd: "resume" })?;
        wait_for(&self.events, |e| matches!(e, HelperEvent::Resumed), Duration::from_secs(5))?;
        self.running_since = Some(Instant::now());
        self.paused = false;
        Ok(())
    }

    fn stop(mut self: Box<Self>) -> Result<PathBuf> {
        self.write_cmd(&SimpleCommand { cmd: "stop" })?;
        wait_for(&self.events, |e| matches!(e, HelperEvent::Stopped), Duration::from_mins(2))?;
        self.freeze_elapsed();
        self.shutdown();
        if !self.output.is_file() {
            return Err(AppError::Other("The recording helper finished without a file.".into()));
        }
        Ok(self.output.clone())
    }

    fn cancel(mut self: Box<Self>) -> Result<()> {
        let _ = self.write_cmd(&SimpleCommand { cmd: "cancel" });
        let _ = wait_for(
            &self.events,
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
}

impl MacosRecorder {
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartCommand {
    cmd: &'static str,
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
    fn from_selection(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Self> {
        let output = dest
            .to_str()
            .ok_or_else(|| AppError::Other("Recording path is not valid UTF-8.".into()))?
            .to_string();
        let mut cmd = Self {
            cmd: "start",
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

#[derive(Debug)]
enum HelperEvent {
    Ready,
    Started,
    Paused,
    Resumed,
    Stopped,
    Cancelled,
    Error(String),
}

#[derive(Deserialize)]
struct WireEvent {
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_event(line: &str) -> std::result::Result<HelperEvent, String> {
    let v: WireEvent = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if v.ok == Some(false) || v.error.is_some() {
        return Ok(HelperEvent::Error(v.error.unwrap_or_else(|| "helper error".into())));
    }
    match v.event.as_deref() {
        Some("ready") => Ok(HelperEvent::Ready),
        Some("started") => Ok(HelperEvent::Started),
        Some("paused") => Ok(HelperEvent::Paused),
        Some("resumed") => Ok(HelperEvent::Resumed),
        Some("stopped") => Ok(HelperEvent::Stopped),
        Some("cancelled") => Ok(HelperEvent::Cancelled),
        other => Err(format!("unknown helper event: {other:?}")),
    }
}

fn wait_for(rx: &Receiver<HelperEvent>, pred: impl Fn(&HelperEvent) -> bool, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(AppError::Other("The recording helper did not respond in time.".into()));
        }
        match rx.recv_timeout(left) {
            Ok(HelperEvent::Error(msg)) => return Err(AppError::Other(msg)),
            Ok(ev) if pred(&ev) => return Ok(()),
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

fn helper_path() -> Option<PathBuf> {
    // 1. Next to the running binary (Tauri externalBin / copied for dev).
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join(HELPER_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Tauri sometimes nests external bins under `binaries/` next to the exe
        // in some layouts; also try the resource dir sibling.
        let nested = dir.join("binaries").join(HELPER_NAME);
        if nested.is_file() {
            return Some(nested);
        }
    }

    // 2. Dev fallback: the local Swift build product.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest
        .join("..")
        .join("macos")
        .join("HippiusCapture")
        .join(".build")
        .join("release")
        .join(HELPER_NAME);
    if dev.is_file() {
        return Some(dev);
    }
    let debug = manifest
        .join("..")
        .join("macos")
        .join("HippiusCapture")
        .join(".build")
        .join("debug")
        .join(HELPER_NAME);
    if debug.is_file() {
        return Some(debug);
    }
    None
}

fn macos_at_least(major: u64, minor: u64) -> bool {
    let Ok(out) = Command::new("sw_vers").arg("-productVersion").output() else {
        return false;
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let mut parts = s.trim().split('.').filter_map(|p| p.parse::<u64>().ok());
    let maj = parts.next().unwrap_or(0);
    let min = parts.next().unwrap_or(0);
    (maj, min) >= (major, minor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;

    #[test]
    fn start_command_for_area_includes_crop() {
        let cmd = StartCommand::from_selection(
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
        assert_eq!(v["displayId"], 3);
        assert_eq!(v["crop"]["width"], 100.0);
        assert_eq!(v["microphone"], true);
        // The Swift helper reads these exact keys.
        assert_eq!(v["showClicks"], true);
        assert_eq!(v["microphoneDeviceId"], "BuiltInMicrophoneDevice");
    }

    #[test]
    fn reads_the_helpers_microphone_list_and_survives_garbage() {
        let mics = parse_microphones(r#"[{"id":"BuiltInMicrophoneDevice","name":"MacBook Pro Microphone"}]"#);
        assert_eq!(mics.len(), 1);
        assert_eq!(mics[0].name, "MacBook Pro Microphone");
        assert!(parse_microphones("helper crashed").is_empty());
    }

    #[test]
    fn parses_helper_events() {
        assert!(matches!(parse_event(r#"{"ok":true,"event":"ready"}"#).unwrap(), HelperEvent::Ready));
        assert!(matches!(
            parse_event(r#"{"ok":false,"error":"no display"}"#).unwrap(),
            HelperEvent::Error(_)
        ));
    }
}
