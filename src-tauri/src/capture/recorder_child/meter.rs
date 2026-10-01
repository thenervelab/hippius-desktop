//! `--meter [deviceId]` in the recorder child: the capture bar's microphone
//! level, measured by the recorder rather than a webview (the reasons are in
//! `capture::mic_meter`). It speaks exactly what the Swift helper's meter
//! speaks, so `mic_meter` reads both the same:
//!
//! ```text
//! {"ok":true,"event":"ready"}
//! {"event":"level","rms":0.0123}   about every 50 ms
//! {"ok":false,"error":"..."}       then exit 1
//! ```
//!
//! and exits when stdin closes, so the app closing it (or dying) frees the
//! microphone at once. The meter holds the microphone only while the bar
//! chooses a recording; the recorder opens it after the meter is stopped,
//! so one device always has one owner.
//!
//! The level arithmetic is here, tested on every OS; Linux's capture is
//! `recorder_child::linux::meter`.

/// Frames per level line: 50 ms at 48 kHz, the Swift meter's interval.
pub const WINDOW_FRAMES: usize = 2_400;

/// Sums squares until a window is full, then hands out its RMS.
#[derive(Debug, Default, Clone)]
pub struct LevelWindow {
    sum_of_squares: f64,
    samples: usize,
    frames: usize,
}

impl LevelWindow {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Take `samples` (interleaved, `channels` per frame) and return the RMS
    /// of every window they completed, in order.
    pub fn push(&mut self, samples: &[f32], channels: usize) -> Vec<f64> {
        let channels = channels.max(1);
        let mut levels = Vec::new();
        for frame in samples.chunks(channels) {
            for &s in frame {
                let s = f64::from(s);
                if s.is_finite() {
                    self.sum_of_squares += s * s;
                }
            }
            self.samples += frame.len();
            self.frames += 1;
            if self.frames >= WINDOW_FRAMES {
                levels.push(self.take());
            }
        }
        levels
    }

    fn take(&mut self) -> f64 {
        #[allow(clippy::cast_precision_loss)]
        let rms = if self.samples > 0 {
            (self.sum_of_squares / self.samples as f64).sqrt()
        } else {
            0.0
        };
        *self = Self::default();
        rms
    }
}

/// One level line.
#[must_use]
pub fn level_line(rms: f64) -> String {
    serde_json::json!({ "event": "level", "rms": if rms.is_finite() { rms } else { 0.0 } }).to_string()
}

/// The meter could not open the microphone: said once, then the process
/// exits 1.
#[must_use]
pub fn failed_line(error: &str) -> String {
    serde_json::json!({ "ok": false, "error": error }).to_string()
}

/// What the meter says when no microphone opens. Rust's copy, said in the
/// app's log, never shown as a raw GStreamer error.
pub const NO_MICROPHONE: &str = "The microphone could not be opened.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::mic_meter::{MeterLine, parse_line};

    /// A full window of a steady 0.5 tone reads 0.5; a part window waits.
    #[test]
    fn a_window_of_samples_gives_its_rms() {
        let mut w = LevelWindow::new();
        assert!(w.push(&[0.5; WINDOW_FRAMES - 1], 1).is_empty());
        let levels = w.push(&[-0.5], 1);
        assert_eq!(levels.len(), 1);
        assert!((levels[0] - 0.5).abs() < 1e-9, "{levels:?}");
        // Stereo: frames, not samples, fill the window.
        let levels = w.push(&vec![0.25; WINDOW_FRAMES * 2], 2);
        assert_eq!(levels.len(), 1);
        assert!((levels[0] - 0.25).abs() < 1e-9);
    }

    /// Silence is zero, and a NaN from a broken driver does not poison the
    /// level.
    #[test]
    fn silence_and_garbage_read_as_quiet() {
        let mut w = LevelWindow::new();
        let mut samples = vec![0.0f32; WINDOW_FRAMES];
        samples[7] = f32::NAN;
        assert_eq!(w.push(&samples, 1), vec![0.0]);
    }

    /// The lines are what the app already reads from the Swift meter.
    #[test]
    fn the_lines_are_the_swift_meters() {
        assert_eq!(parse_line(&level_line(0.125)), MeterLine::Level(0.125));
        assert_eq!(parse_line(&level_line(f64::NAN)), MeterLine::Level(0.0));
        assert_eq!(parse_line(&failed_line(NO_MICROPHONE)), MeterLine::Failed(NO_MICROPHONE.into()));
        assert_eq!(parse_line(&crate::capture::recording::protocol::ready_line()), MeterLine::Ready);
    }
}
