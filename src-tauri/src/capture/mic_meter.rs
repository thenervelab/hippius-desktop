//! The capture bar's microphone level meter, measured by the recording helper
//! (`HippiusCapture --meter [deviceId]`), never by a webview.
//!
//! **Why not `getUserMedia` in the overlay.** WebKit lets one page per
//! process capture at a time: a page that starts capturing mutes the camera
//! and microphone of every other page (`WebProcessProxy::
//! muteCaptureInPagesExcept`, Cocoa only), and a muted page stays muted, its
//! camera black, until it calls `getUserMedia` again. Every Tauri window is a
//! page of the same process, and the camera bubble has to be a webview
//! because it is filmed. So the meter and the bubble took the devices from
//! each other: whichever opened last won, the other went black or flat, and
//! the meter closing at the countdown did not give the camera back. WebKit's
//! microphone also runs Apple's voice processing, which alters what every
//! other process hears from that microphone (the recording helper included)
//! while it is open and for a few seconds after.
//!
//! **One owner at a time.** The meter runs only while a recording is being
//! chosen ([`meter_may_run`]); the session moving on stops it before the
//! recorder opens the microphone (`commands::emit_phase`), and a meter that
//! starts while the phase moves is stopped by the start's own re-check, so
//! the two never overlap. Levels are sent as `capture_mic_level` (0 to 1).

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Deserialize;

use super::session::{CaptureKind, CapturePhase};

/// Event carrying the meter's level, 0 (silence) to 1 (loud speech).
pub const LEVEL_EVENT: &str = "capture_mic_level";

/// Quieter than this (dBFS) reads as silence; louder than the top, as full.
const FLOOR_DB: f64 = -60.0;
const TOP_DB: f64 = -10.0;

/// Whether the meter may hold the microphone in `phase`: only while a
/// recording is being chosen. From the countdown's end on the microphone is
/// the recorder's.
pub fn meter_may_run(phase: CapturePhase) -> bool {
    matches!(
        phase,
        CapturePhase::Selecting {
            kind: CaptureKind::Recording,
            ..
        }
    )
}

/// How loud an RMS (of float samples, -1 to 1) reads on the meter, on a
/// decibel scale so a quiet voice still moves it.
pub fn level_from_rms(rms: f64) -> f64 {
    if !(rms > 0.0) {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db - FLOOR_DB) / (TOP_DB - FLOOR_DB)).clamp(0.0, 1.0)
}

/// One line from the helper in meter mode.
#[derive(Debug, PartialEq)]
pub enum MeterLine {
    Ready,
    Level(f64),
    Failed(String),
    Other,
}

#[derive(Deserialize)]
struct RawLine {
    ok: Option<bool>,
    event: Option<String>,
    rms: Option<f64>,
    error: Option<String>,
}

pub fn parse_line(line: &str) -> MeterLine {
    let Ok(raw) = serde_json::from_str::<RawLine>(line) else {
        return MeterLine::Other;
    };
    if raw.ok == Some(false) {
        return MeterLine::Failed(raw.error.unwrap_or_default());
    }
    match (raw.event.as_deref(), raw.rms) {
        (Some("level"), Some(rms)) if rms.is_finite() => MeterLine::Level(rms),
        (Some("ready"), _) => MeterLine::Ready,
        _ => MeterLine::Other,
    }
}

struct Running {
    child: Child,
    device: Option<String>,
    generation: u64,
}

/// The meter process, at most one. Each start gets a new generation; the
/// reader of an older one drops its lines, so a meter switched to another
/// microphone never shows the old one's level.
#[derive(Default)]
pub struct MicMeter {
    running: Mutex<Option<Running>>,
    /// The generation whose levels are shown; 0 = none.
    current: Arc<AtomicU64>,
    next: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MicMeter {
    /// Measure `device` (the helper's id; `None` = the system default) with
    /// the process `command` builds, sending each level to `on_level`.
    /// Already measuring that device: nothing changes. Returns the
    /// generation, which [`stop_if`](Self::stop_if) takes.
    pub fn start(
        &self,
        device: Option<String>,
        command: impl FnOnce() -> Option<Command>,
        on_level: impl Fn(f64) + Send + 'static,
    ) -> Result<u64, String> {
        let mut running = lock(&self.running);
        if let Some(live) = running.as_mut()
            && live.device == device
            && matches!(live.child.try_wait(), Ok(None))
        {
            return Ok(live.generation);
        }
        if let Some(old) = running.take() {
            self.current.store(0, Ordering::SeqCst);
            end(old.child);
        }
        let mut command = command().ok_or_else(|| "The microphone meter is not available here.".to_string())?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("The microphone meter could not start: {e}"))?;
        let generation = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.current.store(generation, Ordering::SeqCst);
        if let Some(stdout) = child.stdout.take() {
            let current = Arc::clone(&self.current);
            let reader = std::thread::Builder::new()
                .name("capture-mic-meter".into())
                .spawn(move || read_levels(stdout, generation, &current, on_level));
            if let Err(e) = reader {
                self.current.store(0, Ordering::SeqCst);
                end(child);
                return Err(format!("The microphone meter could not start: {e}"));
            }
        }
        *running = Some(Running { child, device, generation });
        Ok(generation)
    }

    /// Stop the meter, whichever is running.
    pub fn stop(&self) {
        let taken = lock(&self.running).take();
        if let Some(old) = taken {
            self.current.store(0, Ordering::SeqCst);
            end(old.child);
        }
    }

    /// Stop the meter only if `generation` is still the one running: a
    /// stop from an unmounted meter must not end the meter that replaced it
    /// (the two calls can arrive in either order).
    pub fn stop_if(&self, generation: u64) {
        let mut running = lock(&self.running);
        if running.as_ref().is_some_and(|r| r.generation == generation) {
            let old = running.take().expect("checked above");
            self.current.store(0, Ordering::SeqCst);
            end(old.child);
        }
    }

    /// Whether a meter process holds the microphone.
    pub fn is_running(&self) -> bool {
        lock(&self.running).as_mut().is_some_and(|r| matches!(r.child.try_wait(), Ok(None)))
    }
}

/// Close the helper's stdin (its stop signal), kill it in case it is stuck
/// opening a device, and reap it off the caller's thread.
fn end(mut child: Child) {
    drop(child.stdin.take());
    let _ = child.kill();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

fn read_levels(stdout: impl std::io::Read, generation: u64, current: &AtomicU64, on_level: impl Fn(f64)) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match parse_line(&line) {
            MeterLine::Level(rms) => {
                if current.load(Ordering::SeqCst) != generation {
                    break;
                }
                on_level(level_from_rms(rms));
            }
            MeterLine::Failed(reason) => {
                tracing::warn!(%reason, "microphone meter could not open the microphone");
            }
            MeterLine::Ready | MeterLine::Other => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::session::CaptureMode;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn the_meter_holds_the_microphone_only_while_a_recording_is_chosen() {
        let choosing = CapturePhase::Selecting {
            kind: CaptureKind::Recording,
            mode: CaptureMode::Area,
        };
        assert!(meter_may_run(choosing));
        let shot = CapturePhase::Selecting {
            kind: CaptureKind::Screenshot,
            mode: CaptureMode::Area,
        };
        assert!(!meter_may_run(shot));
        for phase in [
            CapturePhase::Idle,
            CapturePhase::Capturing {
                kind: CaptureKind::Recording,
            },
            CapturePhase::Recording {
                elapsed_secs: 1,
                microphone: true,
            },
            CapturePhase::Paused {
                elapsed_secs: 1,
                microphone: true,
            },
            CapturePhase::Finalizing,
        ] {
            assert!(!meter_may_run(phase), "{phase:?} belongs to the recorder");
        }
    }

    /// Same scale as the old webview meter (-60 dBFS silent, -10 dBFS full).
    #[test]
    fn levels_are_on_a_decibel_scale() {
        assert_eq!(level_from_rms(0.0), 0.0);
        assert_eq!(level_from_rms(f64::NAN), 0.0);
        assert_eq!(level_from_rms(0.001), 0.0);
        assert!((level_from_rms(0.01) - 0.4).abs() < 1e-9);
        assert_eq!(level_from_rms(0.5), 1.0);
    }

    #[test]
    fn helper_lines_are_read() {
        assert_eq!(parse_line(r#"{"ok":true,"event":"ready"}"#), MeterLine::Ready);
        assert_eq!(parse_line(r#"{"rms":0.25,"event":"level"}"#), MeterLine::Level(0.25));
        assert_eq!(
            parse_line(r#"{"ok":false,"error":"No microphone was found."}"#),
            MeterLine::Failed("No microphone was found.".into())
        );
        assert_eq!(parse_line("not json"), MeterLine::Other);
    }

    #[cfg(unix)]
    fn fake_helper() -> Option<Command> {
        let mut c = Command::new("sh");
        c.args([
            "-c",
            r#"echo '{"ok":true,"event":"ready"}'; while true; do echo '{"event":"level","rms":0.1}'; sleep 0.02; done"#,
        ]);
        Some(c)
    }

    #[cfg(unix)]
    fn levels() -> (mpsc::Sender<f64>, mpsc::Receiver<f64>) {
        mpsc::channel()
    }

    #[cfg(unix)]
    #[test]
    fn a_running_meter_sends_levels_and_stops() {
        let meter = MicMeter::default();
        let (tx, rx) = levels();
        let generation = meter
            .start(None, fake_helper, move |l| {
                let _ = tx.send(l);
            })
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(meter.is_running());
        meter.stop_if(generation);
        assert!(!meter.is_running());
        std::thread::sleep(Duration::from_millis(100));
        while rx.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(150));
        assert!(rx.try_recv().is_err(), "a stopped meter sends nothing more");
    }

    #[cfg(unix)]
    #[test]
    fn the_same_microphone_keeps_its_meter_and_another_replaces_it() {
        let meter = MicMeter::default();
        let first = meter.start(Some("a".into()), fake_helper, |_| {}).unwrap();
        let again = meter
            .start(Some("a".into()), || panic!("the same microphone must not respawn"), |_| {})
            .unwrap();
        assert_eq!(first, again);
        let (tx, rx) = levels();
        let second = meter
            .start(Some("b".into()), fake_helper, move |l| {
                let _ = tx.send(l);
            })
            .unwrap();
        assert_ne!(first, second);
        // The first meter's late stop (its page unmounted after the new one
        // started) leaves the new one running.
        meter.stop_if(first);
        assert!(meter.is_running());
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        meter.stop();
        assert!(!meter.is_running());
    }

    #[test]
    fn no_helper_means_no_meter() {
        let meter = MicMeter::default();
        assert!(meter.start(None, || None, |_| {}).is_err());
        assert!(!meter.is_running());
    }
}
