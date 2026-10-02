//! `--watch-devices` in the recorder child: the bar's camera and microphone
//! lists, printed again whenever a device comes or goes, for as long as the
//! bar is up (`capture::device_watch` keeps the process and reads it). The
//! Swift helper's mode of the same name on macOS prints the same line:
//!
//! ```text
//! {"cameras":[...],"microphones":[...]}
//! ```
//!
//! A platform supplies the two lists and nudges ([`Wake::Changed`]) from its
//! own notifications (Windows: `IMMNotificationClient` and device-interface
//! arrival; Linux: GStreamer's device monitor). The loop here is shared and
//! tested on every machine: a burst of nudges (a USB headset adding its
//! microphone and its speakers) is reported once, a moment after it ends; a
//! slow poll backs the notifications up; nothing is printed when nothing
//! changed; and the watcher ends when its stdin closes (the bar closed, or
//! the app is gone) or after half an hour, whichever comes first.

use std::io::Write;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::Serialize;

/// What wakes the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    /// A platform notification: some device came, went or changed.
    Changed,
    /// Stop now (stdin closed).
    Stop,
}

/// How long the loop waits after a nudge for the burst to end.
pub const SETTLE: Duration = Duration::from_millis(300);
/// The slow poll behind the notifications (the Swift helper's too).
pub const POLL: Duration = Duration::from_secs(3);
/// Never outlive a forgotten watch by long.
pub const MAX_LIFE: Duration = Duration::from_mins(30);

/// The timings, so tests can run the loop quickly.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub settle: Duration,
    pub poll: Duration,
    pub max_life: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            settle: SETTLE,
            poll: POLL,
            max_life: MAX_LIFE,
        }
    }
}

/// The line, keys in the Swift helper's sorted order.
#[derive(Serialize)]
struct Lists<'a, T> {
    cameras: &'a [T],
    microphones: &'a [T],
}

/// The watcher's line for these lists.
#[must_use]
pub fn line<T: Serialize>(cameras: &[T], microphones: &[T]) -> String {
    serde_json::to_string(&Lists { cameras, microphones }).unwrap_or_else(|_| r#"{"cameras":[],"microphones":[]}"#.into())
}

/// Send [`Wake::Stop`] once stdin closes. The thread is left to the
/// process: it ends with it.
pub fn stop_on_stdin_close(wake: Sender<Wake>) {
    let _ = std::thread::Builder::new().name("watch-stdin".into()).spawn(move || {
        let mut sink = String::new();
        let stdin = std::io::stdin();
        while stdin.read_line(&mut sink).is_ok_and(|n| n > 0) {
            sink.clear();
        }
        let _ = wake.send(Wake::Stop);
    });
}

/// Print `current()` (the line for the lists as they are now) at once, then
/// again after every settled burst of nudges and every [`Timing::poll`],
/// whenever it differs from the last line printed. Returns when told to
/// stop, when every sender is gone, when `out` cannot be written (the app
/// stopped reading), or after [`Timing::max_life`].
pub fn serve(wake: &Receiver<Wake>, mut current: impl FnMut() -> String, mut out: impl Write, timing: Timing) {
    let born = Instant::now();
    let mut printed = String::new();
    let mut report = |out: &mut dyn Write| -> bool {
        let line = current();
        if line == printed {
            return true;
        }
        let ok = writeln!(out, "{line}").and_then(|()| out.flush()).is_ok();
        printed = line;
        ok
    };
    if !report(&mut out) {
        return;
    }
    loop {
        let left = timing.max_life.saturating_sub(born.elapsed());
        if left.is_zero() {
            return;
        }
        match wake.recv_timeout(timing.poll.min(left)) {
            Ok(Wake::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Wake::Changed) => {
                // Let the burst end: every nudge restarts the wait.
                loop {
                    match wake.recv_timeout(timing.settle) {
                        Ok(Wake::Changed) => {}
                        Ok(Wake::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => break,
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if !report(&mut out) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Dev {
        id: &'static str,
        name: &'static str,
        is_default: bool,
    }

    /// The line is what the app's `device_watch::parse_lists` reads.
    #[test]
    fn the_line_is_the_one_the_app_reads() {
        let cams = [Dev {
            id: "\\\\?\\usb#vid_046d",
            name: "Logitech BRIO",
            is_default: true,
        }];
        let mics = [
            Dev {
                id: "{0.0.1.00000000}.{a}",
                name: "Microphone (USB)",
                is_default: false,
            },
            Dev {
                id: "{0.0.1.00000000}.{b}",
                name: "Headset (Bluetooth)",
                is_default: true,
            },
        ];
        let text = line(&cams, &mics);
        assert!(text.starts_with(r#"{"cameras":[{"id":"#), "{text}");
        let lists = crate::capture::device_watch::parse_lists(&text).expect("the app reads it");
        assert_eq!(lists.cameras.len(), 1);
        assert_eq!(lists.microphones.len(), 2);
        assert_eq!(lists.microphones[0].name, "Headset (Bluetooth)", "the default first, as the app tidies");
        let empty = line::<Dev>(&[], &[]);
        assert_eq!(
            crate::capture::device_watch::parse_lists(&empty),
            Some(crate::capture::device_watch::DeviceLists::default())
        );
    }

    /// A writer the test can read while the loop runs.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    fn fast() -> Timing {
        Timing {
            settle: Duration::from_millis(40),
            poll: Duration::from_mins(1),
            max_life: Duration::from_mins(1),
        }
    }

    #[test]
    fn a_burst_of_changes_is_reported_once_and_an_unchanged_list_not_at_all() {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(1u32));
        let reads = Arc::new(Mutex::new(0u32));
        let out = Shared::default();
        let thread = std::thread::spawn({
            let (state, reads, out) = (Arc::clone(&state), Arc::clone(&reads), out.clone());
            move || {
                serve(
                    &rx,
                    || {
                        *reads.lock().unwrap() += 1;
                        format!("lists {}", state.lock().unwrap())
                    },
                    out,
                    fast(),
                );
            }
        });
        std::thread::sleep(Duration::from_millis(30));
        // A headset arrives: three nudges in quick succession.
        *state.lock().unwrap() = 2;
        for _ in 0..3 {
            tx.send(Wake::Changed).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(150));
        // A nudge that changed nothing a user would see.
        tx.send(Wake::Changed).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        tx.send(Wake::Stop).unwrap();
        thread.join().unwrap();
        assert_eq!(out.lines(), vec!["lists 1", "lists 2"]);
        assert_eq!(*reads.lock().unwrap(), 3, "read at start, once per settled burst");
    }

    #[test]
    fn the_slow_poll_catches_a_change_nobody_announced() {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new("a"));
        let out = Shared::default();
        let thread = std::thread::spawn({
            let (state, out) = (Arc::clone(&state), out.clone());
            move || {
                let timing = Timing {
                    poll: Duration::from_millis(30),
                    ..fast()
                };
                serve(&rx, || (*state.lock().unwrap()).to_string(), out, timing);
            }
        });
        std::thread::sleep(Duration::from_millis(20));
        *state.lock().unwrap() = "b";
        std::thread::sleep(Duration::from_millis(120));
        drop(tx);
        thread.join().unwrap();
        assert_eq!(out.lines(), vec!["a", "b"], "every sender gone ends the watch too");
    }

    #[test]
    fn a_forgotten_watch_ends_by_itself() {
        let (_tx, rx) = mpsc::channel();
        let started = Instant::now();
        let timing = Timing {
            max_life: Duration::from_millis(80),
            poll: Duration::from_millis(30),
            ..fast()
        };
        serve(&rx, || "x".into(), std::io::sink(), timing);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// The app stopped reading (its end of the pipe closed): stop rather
    /// than enumerate devices for nobody.
    #[test]
    fn a_closed_pipe_ends_the_watch() {
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (_tx, rx) = mpsc::channel::<Wake>();
        let started = Instant::now();
        serve(&rx, || "x".into(), Closed, fast());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
