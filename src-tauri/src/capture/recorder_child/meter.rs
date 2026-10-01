//! `--meter [deviceId]`: the capture bar's microphone level, measured in the
//! recorder child instead of a webview (`capture::mic_meter` says why), on
//! every platform whose recorder can open a microphone.
//!
//! The same lines the Swift helper's `Meter.swift` prints, so the app reads
//! both with one parser (`mic_meter::parse_line`):
//!
//! ```text
//! {"ok":true,"event":"ready"}
//! {"event":"level","rms":0.0123}     about every 50 ms
//! {"ok":false,"error":"..."}         then exit 1
//! ```
//!
//! Stdin closing is the stop signal (the app closed it, or died), so the
//! microphone is let go at once and the recorder can open it next: one owner
//! per device. The platform part only opens the device and hands over
//! samples; the window, the lines and the stop are here, tested everywhere.

use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// How often a level is printed (the Swift helper's `LevelMeter.interval`).
pub const INTERVAL: Duration = Duration::from_millis(50);

/// Sums the squares of the samples since the last level, and says the RMS
/// once [`INTERVAL`] has passed.
#[derive(Debug, Default)]
pub struct LevelWindow {
    sum_of_squares: f64,
    count: u64,
    /// When the window opened, in microseconds on the caller's clock.
    started: Option<u64>,
}

impl LevelWindow {
    /// Add `samples` (float, -1 to 1, any channel layout) taken at `now_us`.
    /// Returns the window's RMS when it has run for [`INTERVAL`], and opens
    /// the next one.
    pub fn add(&mut self, samples: &[f32], now_us: u64) -> Option<f64> {
        let started = *self.started.get_or_insert(now_us);
        for s in samples {
            let s = f64::from(*s);
            if s.is_finite() {
                self.sum_of_squares += s * s;
                self.count += 1;
            }
        }
        let interval = u64::try_from(INTERVAL.as_micros()).unwrap_or(u64::MAX);
        if now_us.saturating_sub(started) < interval {
            return None;
        }
        #[allow(clippy::cast_precision_loss)]
        let rms = if self.count > 0 {
            (self.sum_of_squares / self.count as f64).sqrt()
        } else {
            0.0
        };
        *self = Self {
            started: Some(now_us),
            ..Self::default()
        };
        Some(rms)
    }
}

/// `{"event":"level","rms":0.0123}`
#[must_use]
pub fn level_line(rms: f64) -> String {
    serde_json::json!({ "event": "level", "rms": rms }).to_string()
}

/// `{"ok":false,"error":"..."}`: the meter could not run, and why.
#[must_use]
pub fn failed_line(error: &str) -> String {
    serde_json::json!({ "ok": false, "error": error }).to_string()
}

/// Reads the opened microphone until `stop`, handing each packet of float
/// samples to the sink. An `Err` is the device going away.
pub type Reader = Box<dyn FnOnce(&AtomicBool, &mut dyn FnMut(&[f32])) -> Result<(), String>>;

/// Run the meter: open the device with `open` (on this thread, so a COM
/// apartment the caller entered holds), say `ready`, print a level every
/// [`INTERVAL`] until `input` closes, and return the exit code (0 when
/// stopped, 1 when the device could not be opened or went away).
pub fn serve<I, O>(input: I, mut out: O, open: impl FnOnce() -> Result<Reader, String>) -> i32
where
    I: BufRead + Send + 'static,
    O: Write,
{
    let reader = match open() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = writeln!(out, "{}", failed_line(&e)).and_then(|()| out.flush());
            return 1;
        }
    };
    let _ = writeln!(out, "{}", crate::capture::recording::protocol::ready_line()).and_then(|()| out.flush());
    let stop = Arc::new(AtomicBool::new(false));
    {
        // Stdin closing is the stop signal. The thread is left to end with
        // the process if stdin never closes before the reader fails.
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            for _ in input.lines().map_while(Result::ok) {}
            stop.store(true, Ordering::SeqCst);
        });
    }
    let clock = super::Clock::start();
    let mut window = LevelWindow::default();
    let mut sink = |samples: &[f32]| {
        if let Some(rms) = window.add(samples, clock.now()) {
            let _ = writeln!(out, "{}", level_line(rms)).and_then(|()| out.flush());
        }
    };
    match reader(&stop, &mut sink) {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(out, "{}", failed_line(&e)).and_then(|()| out.flush());
            1
        }
    }
}

/// The device id after `--meter`, if one was given (the next argument, when
/// it is not another flag and not empty).
#[must_use]
pub fn device_arg(args: &[String]) -> Option<String> {
    let at = args.iter().position(|a| a == "--meter")?;
    args.get(at + 1).filter(|a| !a.is_empty() && !a.starts_with("--")).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::mic_meter::{MeterLine, parse_line};
    use std::io::BufReader;

    #[test]
    fn a_window_reports_its_rms_once_the_interval_has_passed() {
        let mut w = LevelWindow::default();
        assert_eq!(w.add(&[0.5, -0.5], 0), None);
        assert_eq!(w.add(&[0.5, -0.5], 49_999), None);
        let rms = w.add(&[0.5, -0.5], 50_000).expect("a level");
        assert!((rms - 0.5).abs() < 1e-9, "{rms}");
        // The next window starts empty.
        assert_eq!(w.add(&[], 60_000), None);
        assert_eq!(w.add(&[], 100_000), Some(0.0), "silence, not the last level");
    }

    #[test]
    fn non_finite_samples_do_not_poison_the_level() {
        let mut w = LevelWindow::default();
        w.add(&[f32::NAN, f32::INFINITY, 0.1], 0);
        let rms = w.add(&[0.1], 50_000).unwrap();
        assert!((rms - 0.1).abs() < 1e-6, "{rms}");
    }

    /// The lines are the Swift helper's, read by the app's one parser.
    #[test]
    fn the_lines_read_back_as_the_apps_meter_lines() {
        assert_eq!(parse_line(&level_line(0.25)), MeterLine::Level(0.25));
        assert_eq!(parse_line(&failed_line("No microphone.")), MeterLine::Failed("No microphone.".into()));
        assert_eq!(parse_line(&crate::capture::recording::protocol::ready_line()), MeterLine::Ready);
    }

    #[test]
    fn the_device_is_the_argument_after_the_flag() {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(device_arg(&args(&["--capture-recorder", "--meter"])), None);
        assert_eq!(
            device_arg(&args(&["--capture-recorder", "--meter", "{0.0.1.00000000}.{abc}"])),
            Some("{0.0.1.00000000}.{abc}".into())
        );
        assert_eq!(device_arg(&args(&["--meter", "--other"])), None);
        assert_eq!(device_arg(&args(&["--meter", ""])), None);
        assert_eq!(device_arg(&args(&["--capture-recorder"])), None);
    }

    /// A device that cannot open says why and exits 1, without `ready`.
    #[test]
    fn a_device_that_cannot_open_says_why() {
        let (stdin, _keep) = std::io::pipe().unwrap();
        let mut out = Vec::new();
        let code = serve(BufReader::new(stdin), &mut out, || Err("No microphone was found.".into()));
        assert_eq!(code, 1);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), [failed_line("No microphone was found.")]);
    }

    /// Levels flow until stdin closes; then the reader is told to stop and
    /// the meter exits 0, letting go of the microphone.
    #[test]
    fn levels_flow_until_stdin_closes() {
        let (stdin, app_end) = std::io::pipe().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let closer = std::thread::spawn(move || {
            // Close stdin once a few levels have gone out.
            let _ = rx.recv_timeout(Duration::from_secs(5));
            drop(app_end);
        });
        let mut out = Vec::new();
        let code = serve(BufReader::new(stdin), &mut out, move || {
            let reader: Reader = Box::new(move |stop, sink| {
                let mut sent = 0;
                while !stop.load(Ordering::SeqCst) {
                    sink(&[0.1; 480]);
                    std::thread::sleep(Duration::from_millis(10));
                    sent += 1;
                    if sent == 20 {
                        let _ = tx.send(());
                    }
                }
                Ok(())
            });
            Ok(reader)
        });
        closer.join().unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<MeterLine> = text.lines().map(parse_line).collect();
        assert_eq!(lines[0], MeterLine::Ready);
        assert!(lines.len() >= 2, "{text}");
        for line in &lines[1..] {
            let MeterLine::Level(rms) = line else { panic!("{line:?}") };
            assert!((rms - 0.1).abs() < 1e-6);
        }
    }

    #[test]
    fn a_device_that_goes_away_ends_the_meter_with_its_reason() {
        let (stdin, _keep) = std::io::pipe().unwrap();
        let mut out = Vec::new();
        let code = serve(BufReader::new(stdin), &mut out, || {
            let reader: Reader = Box::new(|_, _| Err("the device went away".into()));
            Ok(reader)
        });
        assert_eq!(code, 1);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(parse_line(text.lines().last().unwrap()), MeterLine::Failed("the device went away".into()));
    }
}
