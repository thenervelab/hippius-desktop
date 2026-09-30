//! The recorder protocol: one JSON object per line each way, between the app
//! and whatever records.
//!
//! On macOS the other end is the Swift helper
//! (`macos/HippiusCapture/Sources/main.swift`); on Windows and Linux it is
//! the app's own executable started with `--capture-recorder`
//! ([`crate::capture::recorder_child`]). Both ends of the Rust side read and
//! write the types here, so the app and its child cannot drift apart, and the
//! Swift helper's exact lines are pinned by the tests below.
//!
//! Commands (app to recorder), each with an `id` the reply echoes:
//! `{"cmd":"start","id":1,"output":"…","displayId":…,"windowId":…,"crop":…}`,
//! `pause`, `resume`, `stop`, `cancel`. Closing stdin means "finish the file
//! and keep it".
//!
//! Events (recorder to app): `{"ok":true,"event":"ready"}` once, then
//! `{"ok":true,"event":"started"|"paused"|"resumed"|"stopped"|"cancelled","id":n}`
//! or `{"ok":false,"error":"…","id":n}`, and the unprompted
//! `{"ok":false,"event":"stream_stopped","error":"…","saved":bool}` when the
//! recording ended on its own and the file was finished with what it had.

use serde::{Deserialize, Serialize};

use super::RecordOptions;
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

/// A command without arguments: `pause`, `resume`, `stop`, `cancel`.
#[derive(Debug, Serialize)]
pub struct SimpleCommand {
    pub cmd: &'static str,
    pub id: u64,
}

fn start_cmd() -> &'static str {
    "start"
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// `start`: what to record and where. The Swift helper reads these exact
/// keys (camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCommand {
    #[serde(skip_deserializing, default = "start_cmd")]
    pub cmd: &'static str,
    pub id: u64,
    pub output: String,
    #[serde(default)]
    pub display_id: Option<u32>,
    #[serde(default)]
    pub window_id: Option<u32>,
    #[serde(default)]
    pub crop: Option<CropRect>,
    #[serde(default)]
    pub microphone: bool,
    /// The microphone's platform id (`AVCaptureDevice.uniqueID` on macOS);
    /// absent = the system default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_device_id: Option<String>,
    /// Ring the pointer where it clicks (ScreenCaptureKit, macOS 15+; the
    /// helper ignores it on older systems).
    #[serde(default)]
    pub show_clicks: bool,
    /// Record the child's test pattern instead of the screen. Only the Rust
    /// child knows it; never sent by the app's own sessions, and left off the
    /// wire when false so the Swift helper never sees it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub synthetic: bool,
}

/// An area inside a display, in the display's own units (points on macOS,
/// the display's logical units elsewhere; the recorder scales to pixels).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl StartCommand {
    /// The `start` line for `selection`, written to `dest`.
    ///
    /// # Errors
    ///
    /// A destination path that is not UTF-8 cannot travel as JSON text.
    pub fn from_selection(id: u64, selection: Selection, dest: &std::path::Path, options: RecordOptions) -> Result<Self> {
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
            synthetic: false,
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

/// What the recorder said, as the app reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperEvent {
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

/// One line from the recorder: the event, and the id of the command it
/// answers (none for `ready` and `stream_stopped`).
#[derive(Debug)]
pub struct Incoming {
    pub id: Option<u64>,
    pub event: HelperEvent,
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

/// Read one event line.
///
/// # Errors
///
/// A line that is not JSON, or names an event the app does not know.
pub fn parse_event(line: &str) -> std::result::Result<Incoming, String> {
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

// ── The recorder's side ─────────────────────────────────────────────────────

/// A command as the recorder reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Start(StartCommand),
    Pause { id: Option<u64> },
    Resume { id: Option<u64> },
    Stop { id: Option<u64> },
    Cancel { id: Option<u64> },
}

/// Why a command line could not be read, with the id to answer it on when
/// the line had one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadCommand {
    pub id: Option<u64>,
    pub error: String,
}

/// Read one command line, the way the Swift helper does: `cmd` names it,
/// `id` is echoed on the reply.
///
/// # Errors
///
/// [`BadCommand`] with the helper's own wording (`malformed command`,
/// `unknown cmd: …`, `missing output path`).
pub fn parse_command(line: &str) -> std::result::Result<Command, BadCommand> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| BadCommand {
        id: None,
        error: "malformed command".into(),
    })?;
    let id = value.get("id").and_then(serde_json::Value::as_u64);
    let Some(cmd) = value.get("cmd").and_then(serde_json::Value::as_str) else {
        return Err(BadCommand {
            id,
            error: "malformed command".into(),
        });
    };
    match cmd {
        "start" => serde_json::from_value::<StartCommand>(value.clone())
            .ok()
            .filter(|s| !s.output.is_empty())
            .map(Command::Start)
            .ok_or_else(|| BadCommand {
                id,
                error: "missing output path".into(),
            }),
        "pause" => Ok(Command::Pause { id }),
        "resume" => Ok(Command::Resume { id }),
        "stop" => Ok(Command::Stop { id }),
        "cancel" => Ok(Command::Cancel { id }),
        other => Err(BadCommand {
            id,
            error: format!("unknown cmd: {other}"),
        }),
    }
}

/// `{"ok":true,"event":"ready"}`: the recorder is listening.
#[must_use]
pub fn ready_line() -> String {
    serde_json::json!({ "ok": true, "event": "ready" }).to_string()
}

/// A successful reply to command `id`. `started` also carries the output's
/// pixel size, as the Swift helper's does.
#[must_use]
pub fn ok_line(event: &str, id: Option<u64>, size: Option<(u32, u32)>) -> String {
    let mut body = serde_json::json!({ "ok": true, "event": event });
    if let Some(id) = id {
        body["id"] = id.into();
    }
    if let Some((width, height)) = size {
        body["width"] = width.into();
        body["height"] = height.into();
    }
    body.to_string()
}

/// A refused command.
#[must_use]
pub fn error_line(error: &str, id: Option<u64>) -> String {
    let mut body = serde_json::json!({ "ok": false, "error": error });
    if let Some(id) = id {
        body["id"] = id.into();
    }
    body.to_string()
}

/// The recording ended on its own; `saved` says whether the file was
/// finished.
#[must_use]
pub fn stream_stopped_line(error: &str, saved: bool) -> String {
    serde_json::json!({ "ok": false, "event": "stream_stopped", "error": error, "saved": saved }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;
    use std::path::Path;

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
        // The child's test pattern never reaches the Swift helper.
        assert!(v.get("synthetic").is_none(), "{v}");
    }

    /// What the app writes, the child reads back unchanged.
    #[test]
    fn a_start_line_round_trips_through_the_child() {
        let cmd = StartCommand::from_selection(2, Selection::Window { window_id: 99 }, Path::new("/tmp/w.mp4"), RecordOptions::default()).unwrap();
        let line = serde_json::to_string(&cmd).unwrap();
        assert_eq!(parse_command(&line), Ok(Command::Start(cmd)));
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

    /// Every line the child writes is one the app reads as meant.
    #[test]
    fn the_childs_lines_read_back_as_the_events_they_name() {
        assert_eq!(parse_event(&ready_line()).unwrap().event, HelperEvent::Ready);
        let started = parse_event(&ok_line("started", Some(1), Some((1920, 1080)))).unwrap();
        assert_eq!((started.id, started.event), (Some(1), HelperEvent::Started));
        for (name, event) in [
            ("paused", HelperEvent::Paused),
            ("resumed", HelperEvent::Resumed),
            ("stopped", HelperEvent::Stopped),
            ("cancelled", HelperEvent::Cancelled),
        ] {
            let got = parse_event(&ok_line(name, Some(5), None)).unwrap();
            assert_eq!((got.id, got.event), (Some(5), event), "{name}");
        }
        let refused = parse_event(&error_line("not recording", Some(3))).unwrap();
        assert_eq!((refused.id, refused.event), (Some(3), HelperEvent::Error("not recording".into())));
        let died = parse_event(&stream_stopped_line("window closed", true)).unwrap();
        assert_eq!(
            (died.id, died.event),
            (
                None,
                HelperEvent::StreamStopped {
                    message: "window closed".into(),
                    saved: true
                }
            )
        );
    }

    /// The child answers bad input in the Swift helper's words.
    #[test]
    fn bad_commands_are_refused_in_the_helpers_words() {
        assert_eq!(
            parse_command("not json"),
            Err(BadCommand {
                id: None,
                error: "malformed command".into()
            })
        );
        assert_eq!(
            parse_command(r#"{"id":4}"#),
            Err(BadCommand {
                id: Some(4),
                error: "malformed command".into()
            })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"zoom","id":5}"#),
            Err(BadCommand {
                id: Some(5),
                error: "unknown cmd: zoom".into()
            })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"start","id":6}"#),
            Err(BadCommand {
                id: Some(6),
                error: "missing output path".into()
            })
        );
        assert_eq!(parse_command(r#"{"cmd":"pause","id":7}"#), Ok(Command::Pause { id: Some(7) }));
        assert_eq!(parse_command(r#"{"cmd":"cancel"}"#), Ok(Command::Cancel { id: None }));
    }
}
