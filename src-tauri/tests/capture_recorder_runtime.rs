//! Runtime checks for screen capture on a real Windows or Linux machine:
//! the BUILT app binary started as the recorder child
//! (`Hippius --capture-recorder ...`), exactly as the app starts it, and the
//! screenshot path in this process.
//!
//! The unit tests prove the logic; only these prove the platform calls work
//! at run time: Media Foundation, WGC and WASAPI on Windows, GStreamer, X11
//! and PulseAudio on Linux. They were written because everything here had
//! only ever been compile-checked from a Mac.
//!
//! Every test is `#[ignore]`d (they need a display, encoders and, for sound,
//! an audio server) and runs in `ci.yml`'s `capture-runtime-windows` and
//! `capture-runtime-linux` jobs through `scripts/capture-runtime-check.sh`:
//!
//! ```text
//! HIPPIUS_CAPTURE_RUNTIME_REQUIRE=1 cargo test --test capture_recorder_runtime -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Two kinds of "cannot run here":
//! - What the CI job is meant to provide (an X display on Linux, GStreamer's
//!   encoders, `ffprobe`): with `HIPPIUS_CAPTURE_RUNTIME_REQUIRE=1` its
//!   absence FAILS the test, so a broken job setup cannot pass green.
//! - What a hosted runner may simply not have (Media Foundation's encoders
//!   on a Windows Server without the Server Media Foundation feature, an
//!   interactive desktop for WGC): the test prints a `RUNTIME-SKIP:` line
//!   and passes; the script turns each into a workflow warning.
//!
//! `HIPPIUS_CAPTURE_RUNTIME_AUDIO=1` says an audio server with a default
//! output and input is running (the Linux job's PulseAudio null sink): the
//! recording then asks for the microphone and system audio and must carry
//! one AAC track, and the meter must print levels.
//!
//! On macOS the recorder child has no recorder (the Swift helper records),
//! so every test returns at once there.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The crate denies `println!`; the log lines go straight to stdout (run
/// with `--nocapture` they land in the job's log in order).
macro_rules! say {
    ($($arg:tt)*) => {{
        let _ = writeln!(std::io::stdout().lock(), $($arg)*);
    }};
}

const BIN: &str = env!("CARGO_BIN_EXE_Hippius");
const REQUIRE: &str = "HIPPIUS_CAPTURE_RUNTIME_REQUIRE";
const AUDIO: &str = "HIPPIUS_CAPTURE_RUNTIME_AUDIO";
/// A directory to copy the recording into, for a human to look at.
const KEEP: &str = "HIPPIUS_CAPTURE_RUNTIME_KEEP";
/// What `scripts/capture-runtime-check.sh` turns into a warning.
const SKIP_MARK: &str = "RUNTIME-SKIP:";

/// A one-shot mode answers within this, or it hangs.
const ONE_SHOT: Duration = Duration::from_secs(30);
/// A streaming mode ends within this once stdin closes.
const ENDS_WITHIN: Duration = Duration::from_secs(10);

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// The recorder child records on Windows and Linux only.
fn has_recorder() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// A limit of the machine, not of the job: say so and pass.
fn skip(reason: &str) {
    say!("{SKIP_MARK} {reason}");
}

/// Something the CI job is meant to provide is missing: fail under
/// REQUIRE (a broken setup must not pass green), skip otherwise.
fn missing(reason: &str) {
    assert!(!flag(REQUIRE), "{reason} ({REQUIRE}=1, so this fails instead of skipping)");
    skip(reason);
}

fn recorder(args: &[&str]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.arg("--capture-recorder").args(args);
    cmd
}

/// What a finished process printed.
struct Finished {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Finished {
    fn first_json(&self) -> Value {
        let line = self.stdout.lines().next().unwrap_or_else(|| panic!("no output; stderr: {}", self.stderr));
        serde_json::from_str(line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}; stderr: {}", self.stderr))
    }

    fn assert_no_panic(&self) {
        assert!(!self.stderr.contains("panicked"), "the child panicked: {}", self.stderr);
    }
}

/// Read a pipe to the end on its own thread.
fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = pipe.read_to_string(&mut text);
        text
    })
}

/// Wait for `child` to end within `within`, or kill it and fail.
fn wait_within(child: &mut Child, within: Duration, what: &str) -> Option<i32> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(status) = child.try_wait().expect("wait") {
            return status.code();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{what} did not end within {within:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Run a one-shot mode with stdin closed.
fn one_shot(args: &[&str]) -> Finished {
    let mut child = recorder(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the recorder child");
    let out = drain(child.stdout.take().expect("stdout"));
    let err = drain(child.stderr.take().expect("stderr"));
    let code = wait_within(&mut child, ONE_SHOT, &format!("--capture-recorder {}", args.join(" ")));
    let finished = Finished {
        code,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    };
    say!(
        "--capture-recorder {} -> {:?}\n{}",
        args.join(" "),
        finished.code,
        finished.stdout.trim_end()
    );
    finished.assert_no_panic();
    finished
}

/// A child that streams lines: its stdin, its stdout as a channel of lines,
/// and its stderr collected for failure messages.
struct Streaming {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Option<std::thread::JoinHandle<String>>,
    name: String,
}

impl Streaming {
    fn start(args: &[&str]) -> Self {
        let mut child = recorder(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the recorder child");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Some(drain(child.stderr.take().expect("stderr")));
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
            stderr,
            name: format!("--capture-recorder {}", args.join(" ")),
        }
    }

    /// The next line within `within`, or `None` (timed out, or the child ended).
    fn next(&self, within: Duration) -> Option<String> {
        let line = self.lines.recv_timeout(within).ok()?;
        say!("{} < {line}", self.name);
        Some(line)
    }

    fn next_json(&mut self, within: Duration, waiting_for: &str) -> Value {
        let Some(line) = self.next(within) else {
            let stderr = self.finish_stderr();
            panic!(
                "{}: no line within {within:?} while waiting for {waiting_for}; stderr: {stderr}",
                self.name
            );
        };
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("{}: not JSON ({e}): {line}", self.name))
    }

    fn send(&mut self, line: &Value) {
        say!("{} > {line}", self.name);
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{line}").and_then(|()| stdin.flush()).expect("write to the child");
    }

    /// Close stdin (the app went away) and wait for the child to end.
    fn close(&mut self) -> Option<i32> {
        drop(self.stdin.take());
        let name = self.name.clone();
        let code = wait_within(&mut self.child, ENDS_WITHIN, &format!("{name} after stdin closed"));
        let stderr = self.finish_stderr();
        assert!(!stderr.contains("panicked"), "{name} panicked: {stderr}");
        code
    }

    fn finish_stderr(&mut self) -> String {
        if self.child.try_wait().ok().flatten().is_none() {
            // Still running: do not block on its stderr.
            return String::from("<still running>");
        }
        let text = self.stderr.take().map(|h| h.join().unwrap_or_default()).unwrap_or_default();
        if !text.is_empty() {
            say!("{} stderr:\n{}", self.name, text.trim_end());
        }
        text
    }
}

impl Drop for Streaming {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether `--probe` says this machine has both encoders. On Windows, the
/// absence of Media Foundation's (a Server without the Server Media
/// Foundation feature, an N edition) is the runner's limit, said as a skip;
/// on Linux the job installs GStreamer's, so their absence is the job's.
fn encoders_present() -> bool {
    let probe = one_shot(&["--probe"]).first_json();
    let present = if cfg!(windows) {
        probe["h264Encoder"] == json!(true) && probe["aacEncoder"] == json!(true)
    } else {
        probe["h264Encoder"].is_string() && probe["aacEncoder"].is_string()
    };
    if !present {
        if cfg!(windows) {
            skip(&format!(
                "Media Foundation's H.264 or AAC encoder is unavailable on this Windows (install the Server Media Foundation feature): {probe}"
            ));
        } else {
            missing(&format!(
                "GStreamer's encoders are missing (gstreamer1.0-plugins-ugly / gstreamer1.0-libav): {probe}"
            ));
        }
    }
    present
}

/// The screen to record or grab, or `None` with the reason said.
fn a_display() -> Option<tauri_project_lib::capture::targets::DisplayTarget> {
    if cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_none() {
        missing("no X display (run under xvfb-run)");
        return None;
    }
    let displays = match tauri_project_lib::capture::targets::list_displays() {
        Ok(displays) => displays,
        Err(e) => {
            let reason = format!("no display could be listed: {e}");
            if cfg!(windows) {
                skip(&reason);
            } else {
                missing(&reason);
            }
            return None;
        }
    };
    say!("displays: {displays:?}");
    let display = displays.iter().find(|d| d.is_primary).or_else(|| displays.first()).cloned();
    if display.is_none() {
        let reason = "the machine lists no display (no interactive desktop)";
        if cfg!(windows) {
            skip(reason);
        } else {
            missing(reason);
        }
    }
    display
}

/// `ffprobe`'s view of a file, or `None` when ffprobe is not installed.
fn ffprobe(path: &Path) -> Option<Value> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height:format=duration,format_name",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    say!("ffprobe: {}", text.trim_end());
    assert!(
        out.status.success(),
        "ffprobe could not read the recording: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(serde_json::from_str(&text).expect("ffprobe JSON"))
}

fn streams_of(probe: &Value, kind: &str) -> Vec<Value> {
    probe["streams"]
        .as_array()
        .map(|s| s.iter().filter(|s| s["codec_type"] == kind).cloned().collect())
        .unwrap_or_default()
}

/// The modes that need no encoder: they answer, in the app's shapes, and
/// never hang or panic.
mod modes {
    use super::*;

    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn probe_prints_one_json_object() {
        if !has_recorder() {
            return;
        }
        let run = one_shot(&["--probe"]);
        assert_eq!(run.code, Some(0));
        let probe = run.first_json();
        if cfg!(windows) {
            assert!(probe["build"].is_u64(), "{probe}");
            for key in ["osSupported", "h264Encoder", "aacEncoder", "hardwareH264"] {
                assert!(probe[key].is_boolean(), "{key} in {probe}");
            }
            assert_eq!(
                probe["osSupported"],
                json!(true),
                "the runner's Windows is below the 19041 floor: {probe}"
            );
        } else {
            assert_eq!(probe["gstreamer"], json!(true), "GStreamer did not start: {probe}");
            assert_eq!(probe["session"], json!("x11"), "{probe}");
            let missing_elements = probe["missing"].as_array().cloned().unwrap_or_default();
            if !missing_elements.is_empty() {
                missing(&format!("GStreamer elements are missing: {missing_elements:?}"));
            }
        }
    }

    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn device_lists_are_json_arrays() {
        if !has_recorder() {
            return;
        }
        for mode in ["--list-microphones", "--list-cameras"] {
            let run = one_shot(&[mode]);
            assert_eq!(run.code, Some(0), "{mode}: {}", run.stderr);
            let list = run.first_json();
            let list = list.as_array().unwrap_or_else(|| panic!("{mode} is not an array: {list}"));
            for device in list {
                assert!(device["id"].is_string() && device["name"].is_string(), "{mode}: {device}");
            }
        }
    }

    /// A recording that is not there gives the empty line, so the card keeps
    /// its start screenshot.
    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn a_missing_recording_has_no_poster() {
        if !has_recorder() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("not there.mp4");
        let run = one_shot(&["--poster", gone.to_str().unwrap(), "1", "5"]);
        assert_eq!(run.code, Some(0));
        let line = run.first_json();
        assert_eq!(line["frames"], json!([]), "{line}");
        assert_eq!(line["duration"].as_f64(), Some(0.0), "{line}");
    }

    /// The bar's level meter: `ready` and levels while it runs (with an audio
    /// server), or one failed line when there is no microphone; either way
    /// it ends when stdin closes.
    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn the_meter_ends_when_stdin_closes() {
        if !has_recorder() {
            return;
        }
        let mut meter = Streaming::start(&["--meter"]);
        let first = meter.next_json(Duration::from_secs(10), "the meter's first line");
        if first["event"] == "ready" {
            let level = meter.next_json(Duration::from_secs(5), "a level");
            assert_eq!(level["event"], json!("level"), "{level}");
            assert!(level["rms"].as_f64().is_some_and(|r| (0.0..=1.5).contains(&r)), "{level}");
            assert_eq!(meter.close(), Some(0), "the meter must exit 0 when stdin closes");
        } else {
            assert_eq!(first["ok"], json!(false), "{first}");
            assert!(first["error"].is_string(), "{first}");
            assert!(!flag(AUDIO), "an audio server is running but the meter failed: {first}");
            skip(&format!("no microphone to meter on this machine: {first}"));
            assert_eq!(meter.close(), Some(1));
        }
    }

    /// The bar's live device lists: both lists at once, then nothing until
    /// a device changes, and the child ends when stdin closes.
    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn watching_devices_prints_the_lists_and_ends_when_stdin_closes() {
        if !has_recorder() {
            return;
        }
        let mut watch = Streaming::start(&["--watch-devices"]);
        let lists = watch.next_json(Duration::from_secs(10), "the device lists");
        assert!(lists["cameras"].is_array() && lists["microphones"].is_array(), "{lists}");
        assert_eq!(watch.close(), Some(0), "--watch-devices must exit 0 when stdin closes");
    }

    /// The screenshot path in this process: a display grab is that display's
    /// size (xcap on Windows, `GetImage` on X11).
    #[test]
    #[ignore = "needs a display: scripts/capture-runtime-check.sh"]
    fn a_screenshot_of_a_display_is_its_size() {
        use tauri_project_lib::capture::screenshot::{Selection, capture_image};
        if !has_recorder() {
            return;
        }
        let Some(display) = a_display() else {
            return;
        };
        let image = capture_image(Selection::Screen { display_id: display.id }).expect("grab the display");
        say!("screenshot {}x{} of {display:?}", image.width(), image.height());
        assert!(image.width() > 0 && image.height() > 0);
        if (display.scale_factor - 1.0).abs() < f64::EPSILON {
            assert_eq!((image.width(), image.height()), (display.width, display.height));
        }
    }
}

/// The modes that encode: the self-test through the real writer, and a real
/// screen recording through the protocol the app speaks.
mod recording {
    use super::*;

    /// How much longer than the time this test measured as recording the
    /// file may be. The recorder stamps pause, resume and stop when it reads
    /// each command (one pipe hop after this test's clock, a few ms) and the
    /// last picture lasts at least one 33 ms frame. A hosted Windows runner
    /// has also read 0.54 s over (3.54 s for 3.00 s), so the margin is three
    /// quarters of the 1 s pause: a pause left in the file still fails, and
    /// so does a file that starts before `started` (a hosted Windows runner
    /// takes 1.5 to 2.2 s to make the H.264 encoder).
    const LONGER_BY_AT_MOST: f64 = 0.75;
    /// How much shorter: the same pipe hops the other way, and a frame.
    const SHORTER_BY_AT_MOST: f64 = 0.25;

    /// Whether a file `duration` s long is the `recorded` s this test
    /// measured, with the pause cut out.
    fn pause_cut(duration: f64, recorded: f64) -> bool {
        (recorded - SHORTER_BY_AT_MOST..=recorded + LONGER_BY_AT_MOST).contains(&duration)
    }

    #[test]
    #[ignore = "runs the built recorder child: scripts/capture-runtime-check.sh"]
    fn the_self_test_records_through_the_real_writer() {
        if !has_recorder() || !encoders_present() {
            return;
        }
        let run = one_shot(&["--self-test"]);
        let report = run.first_json();
        assert_eq!(report["ok"], json!(true), "self-test failed: {report}; stderr: {}", run.stderr);
        assert_eq!(run.code, Some(0));
    }

    /// The app's own session, by hand: start the screen, pause for a second,
    /// resume, stop. The file must hold one H.264 track (and one AAC track
    /// when sound was asked for), as long as the time between `started` and
    /// the pause plus the time between `resumed` and the stop (about 3 s: the
    /// pause cut out, measured rather than assumed, so a busy runner's slow
    /// sleep cannot fail it), and the card's poster must read stills from it.
    #[test]
    #[ignore = "records the screen: scripts/capture-runtime-check.sh"]
    fn a_screen_recording_with_a_pause_plays_back() {
        if !has_recorder() || !encoders_present() {
            return;
        }
        let Some(display) = a_display() else {
            return;
        };
        let sound = flag(AUDIO);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("runtime recording.mp4");

        let mut child = Streaming::start(&[]);
        let ready = child.next_json(Duration::from_secs(10), "ready");
        assert_eq!(ready["event"], json!("ready"), "{ready}");
        child.send(&json!({
            "cmd": "start",
            "id": 1,
            "output": file,
            "displayId": display.id,
            "microphone": sound,
            "systemAudio": sound,
        }));
        let started = child.next_json(Duration::from_secs(30), "started");
        if started["ok"] != json!(true) {
            let stderr = {
                child.close();
                child.finish_stderr()
            };
            panic!("the recording did not start: {started}; stderr: {stderr}");
        }
        assert_eq!(started["event"], json!("started"), "{started}");
        assert_eq!(started["id"], json!(1));
        let (width, height) = (started["width"].as_u64().unwrap_or(0), started["height"].as_u64().unwrap_or(0));
        assert!(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0, "{started}");

        let recording_from = Instant::now();
        std::thread::sleep(Duration::from_millis(1500));
        let paused_at = Instant::now();
        child.send(&json!({ "cmd": "pause", "id": 2 }));
        assert_eq!(child.next_json(Duration::from_secs(5), "paused")["event"], json!("paused"));
        std::thread::sleep(Duration::from_secs(1));
        child.send(&json!({ "cmd": "resume", "id": 3 }));
        assert_eq!(child.next_json(Duration::from_secs(5), "resumed")["event"], json!("resumed"));
        let resumed_at = Instant::now();
        std::thread::sleep(Duration::from_millis(1500));
        let recorded = (paused_at - recording_from + resumed_at.elapsed()).as_secs_f64();
        child.send(&json!({ "cmd": "stop", "id": 4 }));
        say!("recorded {recorded:.2} s around a {:.2} s pause", (resumed_at - paused_at).as_secs_f64());
        let stopped = child.next_json(Duration::from_secs(40), "stopped");
        assert_eq!(stopped["event"], json!("stopped"), "{stopped}");
        assert_eq!(child.close(), Some(0), "the recorder must exit 0 after stop and stdin closing");

        let size = std::fs::metadata(&file).map_or(0, |m| m.len());
        say!("recording: {} bytes at {}", size, file.display());
        assert!(size > 0, "no file was written");
        if let Some(keep) = std::env::var_os(KEEP) {
            let _ = std::fs::create_dir_all(&keep);
            let _ = std::fs::copy(&file, Path::new(&keep).join("runtime-recording.mp4"));
        }

        match ffprobe(&file) {
            Some(probe) => {
                let video = streams_of(&probe, "video");
                let audio = streams_of(&probe, "audio");
                assert_eq!(video.len(), 1, "one video track: {probe}");
                assert_eq!(video[0]["codec_name"], json!("h264"), "{probe}");
                assert_eq!(
                    (video[0]["width"].as_u64(), video[0]["height"].as_u64()),
                    (Some(width), Some(height)),
                    "the file's picture is the size `started` said: {probe}"
                );
                if sound {
                    assert_eq!(audio.len(), 1, "one mixed audio track: {probe}");
                    assert_eq!(audio[0]["codec_name"], json!("aac"), "{probe}");
                } else {
                    assert!(audio.is_empty(), "no sound was asked for: {probe}");
                }
                let duration: f64 = probe["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
                assert!(
                    pause_cut(duration, recorded),
                    "{duration:.2} s long, expected the {recorded:.2} s recorded: {probe}"
                );
            }
            None => missing("ffprobe is not installed, so the recording's tracks were not checked"),
        }

        // The card's picture comes from the file.
        let poster = one_shot(&["--poster", file.to_str().unwrap(), "0.5", "1.5", "2.5"]);
        assert_eq!(poster.code, Some(0));
        let line = poster.first_json();
        let frames = line["frames"].as_array().cloned().unwrap_or_default();
        assert!(!frames.is_empty(), "no still read from the recording: {line}; stderr: {}", poster.stderr);
        let poster_duration = line["duration"].as_f64().unwrap_or(0.0);
        assert!(
            pause_cut(poster_duration, recorded),
            "the poster reader says {poster_duration:.2} s, expected the {recorded:.2} s recorded"
        );
        for frame in &frames {
            use base64::Engine as _;
            let jpeg = base64::engine::general_purpose::STANDARD
                .decode(frame["jpeg"].as_str().unwrap_or_default())
                .expect("base64 JPEG");
            assert!(jpeg.starts_with(&[0xFF, 0xD8]), "not a JPEG");
            let image = image::load_from_memory(&jpeg).expect("the still decodes");
            say!("poster still at {}: {}x{}", frame["time"], image.width(), image.height());
            assert!(image.width().max(image.height()) <= 1120, "the long edge is capped at 1120");
        }
    }
}
