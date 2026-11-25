//! Restarting the app when its background work has died or stopped.
//!
//! Nearly everything the app does in the background (sync, the chain, update
//! checks, every async command) runs on Tauri's tokio runtime. When that
//! runtime stops making progress the windows stay open, so the app looks
//! alive while nothing behind it works, and on Windows the web views keep
//! growing until the computer runs out of memory. The classic case is a panic
//! in tokio's I/O driver (on Windows, error 1450 "Insufficient system
//! resources" from the completion port when memory runs low): the worker that
//! polled the driver dies, and timers and sockets stop with it.
//!
//! Two signals, watched from a plain OS thread that does not depend on the
//! runtime:
//! - **A heartbeat**: a task on the runtime counts up every
//!   [`HEARTBEAT_EVERY`]. If the count stops for [`STALL_AFTER`], the runtime
//!   is stuck. A gap in the watchdog's own ticks (the computer slept, or the
//!   process was suspended) restarts that count, so a laptop waking up is
//!   never mistaken for a stall.
//! - **A fatal runtime panic**: the panic hook (`diagnostics.rs`) reports
//!   panics whose message says the runtime itself broke ([`is_runtime_fatal`]).
//!   Those restart at once: the runtime has lost a worker and the tasks queued
//!   on it, even when the heartbeat happens to keep going.
//!
//! Recovery is a restart (`AppHandle::request_restart`, through the event
//! loop, which is still alive), with a direct relaunch if that has not
//! happened within [`HARD_RELAUNCH_AFTER`]. It waits while a screen recording
//! or the screenshot editor holds work only a restart would lose (up to
//! [`MAX_DEFER`], after which that work is gone anyway). After
//! [`MAX_RESTARTS`] restarts within [`RESTART_WINDOW`] it stops restarting and
//! tells the user instead, so a machine that breaks the runtime again right
//! away does not restart in a loop. Every decision is logged and written to
//! `crash.log`.
//!
//! The panic hook has no `AppHandle`, so the heartbeat count, the fatal panic
//! and the watchdog thread's handle are process globals: the one deliberate
//! exception to "state lives in `AppState`".
//!
//! The same thread also writes the hourly memory line (`process_memory.rs`)
//! and tells `webview_refresh` when the web views are heavy, so both keep
//! working while the runtime is stuck.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use tauri::Manager;

use crate::updates::RestartBlockerKind;

/// How often the runtime's heartbeat task counts up.
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(10);
/// How often the watchdog thread looks.
pub const WATCH_EVERY: Duration = Duration::from_secs(30);
/// How long the heartbeat may stay silent, while the computer is awake,
/// before the runtime counts as stuck. Long enough that a burst of heavy work
/// on every worker does not trip it, short enough that a dead backend is not
/// left running for long.
pub const STALL_AFTER: Duration = Duration::from_mins(5);
/// A watchdog tick that took longer than this means the computer slept or
/// the process was suspended: the silence that follows is not a stall.
pub const SLEEP_GAP: Duration = Duration::from_secs(90);
/// At most this many restarts within [`RESTART_WINDOW`]; after that the user
/// is told instead.
pub const MAX_RESTARTS: usize = 2;
pub const RESTART_WINDOW: Duration = Duration::from_hours(1);
/// How long a recording or the editor may hold a restart back.
pub const MAX_DEFER: Duration = Duration::from_hours(1);
/// If the process is still here this long after asking for a restart, the
/// event loop did not get there: relaunch directly.
pub const HARD_RELAUNCH_AFTER: Duration = Duration::from_mins(1);

/// Bumped by the heartbeat task on the runtime.
static BEATS: AtomicU64 = AtomicU64::new(0);
/// The first panic that broke the runtime, if any.
static FATAL_PANIC: Mutex<Option<String>> = Mutex::new(None);
/// The watchdog thread, so a fatal panic can wake it at once.
static WATCHER: OnceLock<std::thread::Thread> = OnceLock::new();

/// Whether a panic message means the async runtime itself is broken, rather
/// than one task failing (which tokio contains to that task).
#[must_use]
pub fn is_runtime_fatal(payload: &str) -> bool {
    // tokio's `runtime/io/driver.rs`: the I/O driver's poll failed. The
    // worker that held the driver dies with it, and so do timers.
    payload.contains("when polling the I/O driver") || payload.contains("failed to wake I/O driver")
}

/// Called by the panic hook for every panic. Records a runtime-fatal one and
/// wakes the watchdog; returns whether it was fatal.
pub fn note_panic(payload: &str) -> bool {
    if !is_runtime_fatal(payload) {
        return false;
    }
    if let Ok(mut slot) = FATAL_PANIC.lock()
        && slot.is_none()
    {
        *slot = Some(payload.to_string());
    }
    if let Some(thread) = WATCHER.get() {
        thread.unpark();
    }
    true
}

fn fatal_panic() -> Option<String> {
    FATAL_PANIC.lock().ok().and_then(|slot| slot.clone())
}

/// Watches the heartbeat count across the watchdog's ticks.
#[derive(Debug, Default)]
pub struct StallDetector {
    last_beats: u64,
    silent_for: Duration,
}

impl StallDetector {
    /// One watchdog tick: `beats` is the heartbeat count now, `mono` and
    /// `wall` how long the tick took by the monotonic and the wall clock
    /// (`None` when the wall clock went backwards). Returns how long the
    /// heartbeat has been silent once that reaches [`STALL_AFTER`].
    ///
    /// Both clocks are read because they disagree about sleep: macOS's
    /// monotonic clock stops while asleep and the wall clock does not, and a
    /// wall clock can be set. Either one showing a gap counts as a gap.
    pub fn observe(&mut self, beats: u64, mono: Duration, wall: Option<Duration>) -> Option<Duration> {
        if beats != self.last_beats {
            self.last_beats = beats;
            self.silent_for = Duration::ZERO;
            return None;
        }
        let slept = wall.is_none_or(|w| w > SLEEP_GAP) || mono > SLEEP_GAP;
        if slept {
            // Count from the wake-up: the runtime's timers catch up within a
            // tick if it is healthy.
            self.silent_for = Duration::ZERO;
            return None;
        }
        self.silent_for += mono;
        (self.silent_for >= STALL_AFTER).then_some(self.silent_for)
    }
}

/// Why the watchdog wants a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// The heartbeat has been silent this long while the computer was awake.
    Stalled(Duration),
    /// The runtime panicked in a way it does not recover from.
    FatalPanic(String),
}

impl Trigger {
    fn describe(&self) -> String {
        match self {
            Self::Stalled(silent) => format!("the async runtime has not run for {} s", silent.as_secs()),
            Self::FatalPanic(payload) => format!("the async runtime panicked: {payload}"),
        }
    }
}

/// What to do about a trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Restart,
    /// Wait: a restart now would lose this.
    Wait(RestartBlockerKind),
    /// Restarted too often lately: tell the user instead.
    GiveUp,
}

/// Decide what to do about a trigger.
///
/// `blockers` is what a restart would cut off now (`updates::restart_blockers`),
/// `waited` how long this trigger has already been held, and `recent` how many
/// watchdog restarts happened within [`RESTART_WINDOW`]. Only a recording and
/// an open editor hold a restart back: their work lives only in this process.
/// Transfers do not, because nothing moves on a dead runtime and sync picks up
/// where it left off after the restart.
#[must_use]
pub fn decide(blockers: &[RestartBlockerKind], waited: Duration, recent: usize) -> Decision {
    if recent >= MAX_RESTARTS {
        return Decision::GiveUp;
    }
    if waited < MAX_DEFER
        && let Some(kind) = blockers
            .iter()
            .copied()
            .find(|k| matches!(k, RestartBlockerKind::Recording | RestartBlockerKind::EditorOpen))
    {
        return Decision::Wait(kind);
    }
    Decision::Restart
}

/// How many of `history` (unix seconds) fall within [`RESTART_WINDOW`] of `now`.
#[must_use]
pub fn restarts_within_window(history: &[u64], now: u64) -> usize {
    history.iter().filter(|&&t| t <= now && now - t < RESTART_WINDOW.as_secs()).count()
}

/// The restart history: one unix-seconds line per watchdog restart. It must
/// outlive the process (the restart is the point), so it is a file.
const HISTORY_NAME: &str = "watchdog-restarts";
/// Only the latest few are kept.
const HISTORY_KEEP: usize = 10;

/// Read the history file. A missing or unreadable file is an empty history.
#[must_use]
pub fn read_history(path: &std::path::Path) -> Vec<u64> {
    std::fs::read_to_string(path)
        .map(|text| text.lines().filter_map(|l| l.trim().parse().ok()).collect())
        .unwrap_or_default()
}

/// Add `now` to the history file, keeping the latest [`HISTORY_KEEP`].
pub fn record_restart(path: &std::path::Path, now: u64) {
    let mut history = read_history(path);
    history.push(now);
    let start = history.len().saturating_sub(HISTORY_KEEP);
    let text = history[start..].iter().fold(String::new(), |mut text, t| {
        text.push_str(&t.to_string());
        text.push('\n');
        text
    });
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, text) {
        tracing::warn!(error = %e, "watchdog: could not record the restart");
    }
}

/// `~/.hippius/logs/watchdog-restarts`, beside `crash.log` so a support
/// bundle shows it. `None` in tests and without a home folder.
fn history_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
    dirs::home_dir().map(|home| home.join(".hippius").join("logs").join(HISTORY_NAME))
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Write one line to `crash.log`, synchronously: the restart that follows
/// ends the process before the non-blocking log writer may have flushed.
fn crash_note(what: &str, detail: &str) {
    if cfg!(test) {
        return;
    }
    let Some(path) = dirs::home_dir().map(|h| h.join(".hippius").join("logs").join(crate::diagnostics::CRASH_LOG_NAME)) else {
        return;
    };
    crate::diagnostics::append_crash_record(
        &path,
        &crate::diagnostics::crash_record(what, detail, "runtime_watchdog", "hippius-watchdog", ""),
    );
}

/// The memory line: sampled every [`MEMORY_SAMPLE_EVERY`], logged at start and
/// then every [`MEMORY_LOG_EVERY`], and once whenever the web views cross
/// [`WEBVIEW_HEAVY_BYTES`].
pub const MEMORY_SAMPLE_EVERY: Duration = Duration::from_mins(10);
pub const MEMORY_LOG_EVERY: Duration = Duration::from_hours(1);
/// The first line waits this long, so the web views exist by then.
pub const MEMORY_FIRST_LOG_AFTER: Duration = Duration::from_mins(1);
/// Web views holding more private memory than this, summed, are "heavy": a
/// hidden or minimized window then reloads after minutes rather than hours
/// (`webview_refresh::RELOAD_AFTER_WHEN_HEAVY`). A fresh app's web views
/// hold a few hundred MB; the growth this exists for reached many GB.
pub const WEBVIEW_HEAVY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Whether a sample's web views are over [`WEBVIEW_HEAVY_BYTES`].
#[must_use]
pub fn webviews_heavy(sample: &crate::process_memory::Sample) -> bool {
    sample.webviews.is_some_and(|(usage, _)| usage.private_bytes > WEBVIEW_HEAVY_BYTES)
}

/// When to sample and log memory, by the watchdog's own clock.
#[derive(Debug)]
struct MemorySchedule {
    started: Instant,
    last_sample: Option<Instant>,
    last_log: Option<Instant>,
    heavy: bool,
}

impl MemorySchedule {
    fn new(now: Instant) -> Self {
        Self {
            started: now,
            last_sample: None,
            last_log: None,
            heavy: false,
        }
    }

    fn tick(&mut self, app: &tauri::AppHandle, now: Instant) {
        if now.duration_since(self.started) < MEMORY_FIRST_LOG_AFTER {
            return;
        }
        if self.last_sample.is_some_and(|t| now.duration_since(t) < MEMORY_SAMPLE_EVERY) {
            return;
        }
        self.last_sample = Some(now);
        let sample = crate::process_memory::sample();
        let heavy = webviews_heavy(&sample);
        let line = crate::process_memory::summary_line(&sample);
        if heavy && !self.heavy {
            tracing::warn!("{line} (web views are heavy: hidden windows reload sooner)");
            self.last_log = Some(now);
        } else if self.last_log.is_none_or(|t| now.duration_since(t) >= MEMORY_LOG_EVERY) {
            tracing::info!("{line}");
            self.last_log = Some(now);
        }
        self.heavy = heavy;
        if let Some(state) = app.try_state::<crate::app_state::AppState>() {
            state.webview_refresh.set_memory_heavy(heavy);
        }
    }
}

/// Start the heartbeat task and the watchdog thread. Call once, from setup,
/// after `AppState` is managed.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async {
        let mut every = tokio::time::interval(HEARTBEAT_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            BEATS.fetch_add(1, Ordering::Relaxed);
        }
    });
    let spawned = std::thread::Builder::new().name("hippius-watchdog".into()).spawn(move || run(&app));
    if let Err(e) = spawned {
        tracing::error!(error = %e, "watchdog: could not start its thread");
    }
}

fn run(app: &tauri::AppHandle) {
    let _ = WATCHER.set(std::thread::current());
    let mut detector = StallDetector::default();
    let mut memory = MemorySchedule::new(Instant::now());
    // The trigger being acted on and when it was first seen.
    let mut pending: Option<(Trigger, Instant)> = None;
    let mut logged_wait: Option<RestartBlockerKind> = None;
    loop {
        let (mono_start, wall_start) = (Instant::now(), SystemTime::now());
        std::thread::park_timeout(WATCH_EVERY);
        let mono = mono_start.elapsed();
        let wall = SystemTime::now().duration_since(wall_start).ok();
        memory.tick(app, Instant::now());

        let stalled = detector.observe(BEATS.load(Ordering::Relaxed), mono, wall);
        let trigger = fatal_panic().map(Trigger::FatalPanic).or(stalled.map(Trigger::Stalled));
        let Some(trigger) = trigger else {
            // The heartbeat came back before anything was done: nothing to do.
            if let Some((old, _)) = pending.take() {
                tracing::info!(reason = %old.describe(), "watchdog: the async runtime recovered on its own");
            }
            logged_wait = None;
            continue;
        };
        let first_seen = if let Some((_, at)) = &pending {
            *at
        } else {
            tracing::error!(reason = %trigger.describe(), "watchdog: the app's background work has stopped");
            crash_note("WATCHDOG", &trigger.describe());
            Instant::now()
        };
        pending = Some((trigger.clone(), first_seen));

        let blockers = app
            .try_state::<crate::app_state::AppState>()
            .map(|state| holding_kinds(&state))
            .unwrap_or_default();
        let history = history_path().map(|p| read_history(&p)).unwrap_or_default();
        match decide(&blockers, first_seen.elapsed(), restarts_within_window(&history, unix_now())) {
            Decision::Wait(kind) => {
                if logged_wait != Some(kind) {
                    tracing::warn!(?kind, "watchdog: holding the restart until this ends");
                    logged_wait = Some(kind);
                }
            }
            Decision::GiveUp => {
                give_up(app, &trigger);
                return;
            }
            Decision::Restart => {
                restart(app, &trigger);
                return;
            }
        }
    }
}

/// The restart blockers [`decide`] can act on, read the way the update
/// dialog reads them. Transfers are left out on purpose: [`decide`] ignores
/// them, and reading them takes the sync engine's lock, which a stuck task
/// may hold.
fn holding_kinds(state: &crate::app_state::AppState) -> Vec<RestartBlockerKind> {
    crate::updates::restart_blockers_from(crate::updates::RestartFacts {
        capture: state.capture.current(),
        editor_open: state.capture.editor_open(),
        files_moving: false,
        upload_preparing: false,
    })
    .into_iter()
    .map(|b| b.kind)
    .collect()
}

/// Restart the app: through the event loop, and directly if that stalls.
fn restart(app: &tauri::AppHandle, trigger: &Trigger) {
    let reason = trigger.describe();
    tracing::error!(%reason, "watchdog: restarting the app");
    crash_note("WATCHDOG-RESTART", &reason);
    if let Some(path) = history_path() {
        record_restart(&path, unix_now());
    }
    // A debug build is often paused in a debugger or run by `tauri dev`,
    // where a relaunch would start the wrong thing.
    if cfg!(debug_assertions) && std::env::var("HIPPIUS_WATCHDOG_RESTART").as_deref() != Ok("1") {
        tracing::warn!("watchdog: debug build, not restarting (HIPPIUS_WATCHDOG_RESTART=1 to allow)");
        return;
    }
    let fallback = app.clone();
    let _ = std::thread::Builder::new().name("hippius-watchdog-relaunch".into()).spawn(move || {
        std::thread::sleep(HARD_RELAUNCH_AFTER);
        tracing::error!("watchdog: the restart did not happen; relaunching directly");
        crash_note("WATCHDOG-RELAUNCH", "the event loop did not finish the restart");
        tauri::process::restart(&fallback.env());
    });
    app.request_restart();
}

/// Restarted too often: say so once and leave the choice to the user.
fn give_up(app: &tauri::AppHandle, trigger: &Trigger) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let reason = trigger.describe();
    tracing::error!(%reason, restarts = MAX_RESTARTS, "watchdog: restarted too often lately; asking the user instead");
    crash_note("WATCHDOG-GAVE-UP", &reason);
    let quit = app
        .dialog()
        .message(
            "Hippius Drive stopped working in the background and restarting it did not help. \
             Quit Hippius Drive and open it again. If this keeps happening, restart your computer or contact support.",
        )
        .title("Hippius Drive stopped working")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Not now".into()))
        .blocking_show();
    if quit {
        app.exit(0);
        // A quit can wait on work that will never finish on a dead runtime.
        std::thread::sleep(HARD_RELAUNCH_AFTER);
        std::process::exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = WATCH_EVERY;

    #[test]
    fn the_io_driver_panic_is_fatal_and_an_ordinary_one_is_not() {
        assert!(is_runtime_fatal(
            "unexpected error when polling the I/O driver: Os { code: 1450, kind: Uncategorized, message: \"Insufficient system resources exist to complete the requested service.\" }"
        ));
        assert!(is_runtime_fatal("failed to wake I/O driver: Os { code: 1450 }"));
        assert!(!is_runtime_fatal("called `Option::unwrap()` on a `None` value"));
        assert!(!is_runtime_fatal("index out of bounds"));
    }

    #[test]
    fn a_beating_heart_is_never_a_stall() {
        let mut d = StallDetector::default();
        for beat in 1..100 {
            assert_eq!(d.observe(beat, TICK, Some(TICK)), None);
        }
    }

    #[test]
    fn five_minutes_of_silence_while_awake_is_a_stall() {
        let mut d = StallDetector::default();
        d.observe(7, TICK, Some(TICK));
        let ticks_to_stall = STALL_AFTER.as_secs() / TICK.as_secs();
        for _ in 1..ticks_to_stall {
            assert_eq!(d.observe(7, TICK, Some(TICK)), None);
        }
        assert_eq!(d.observe(7, TICK, Some(TICK)), Some(STALL_AFTER));
    }

    #[test]
    fn a_beat_ends_the_silence() {
        let mut d = StallDetector::default();
        for _ in 0..9 {
            d.observe(1, TICK, Some(TICK));
        }
        assert_eq!(d.observe(2, TICK, Some(TICK)), None);
        for _ in 0..9 {
            assert_eq!(d.observe(2, TICK, Some(TICK)), None, "the count started again at the beat");
        }
    }

    #[test]
    fn sleep_or_suspension_restarts_the_count() {
        // Silent for four minutes, then the computer sleeps for an hour:
        // on wake-up the count starts from zero.
        let mut d = StallDetector::default();
        for _ in 0..8 {
            d.observe(3, TICK, Some(TICK));
        }
        // macOS: the monotonic clock stopped, the wall clock did not.
        assert_eq!(d.observe(3, TICK, Some(Duration::from_hours(1))), None);
        for _ in 0..8 {
            assert_eq!(d.observe(3, TICK, Some(TICK)), None, "the sleep must not count toward a stall");
        }
        // Windows: both clocks ran through the sleep.
        assert_eq!(d.observe(3, Duration::from_hours(1), Some(Duration::from_hours(1))), None);
        // The wall clock was set backwards.
        assert_eq!(d.observe(3, TICK, None), None);
        for _ in 0..9 {
            assert_eq!(d.observe(3, TICK, Some(TICK)), None);
        }
        assert!(d.observe(3, TICK, Some(TICK)).is_some(), "a real stall after waking is still caught");
    }

    #[test]
    fn a_recording_or_the_editor_holds_the_restart_but_transfers_do_not() {
        use RestartBlockerKind::{EditorOpen, Recording, Transfer};
        assert_eq!(decide(&[], Duration::ZERO, 0), Decision::Restart);
        assert_eq!(decide(&[Transfer], Duration::ZERO, 0), Decision::Restart);
        assert_eq!(decide(&[Transfer, Recording], Duration::ZERO, 0), Decision::Wait(Recording));
        assert_eq!(decide(&[EditorOpen], Duration::from_mins(5), 1), Decision::Wait(EditorOpen));
    }

    #[test]
    fn a_hold_ends_after_an_hour() {
        assert_eq!(decide(&[RestartBlockerKind::Recording], MAX_DEFER, 0), Decision::Restart);
    }

    #[test]
    fn two_restarts_in_an_hour_is_the_limit() {
        assert_eq!(decide(&[], Duration::ZERO, 1), Decision::Restart);
        assert_eq!(decide(&[], Duration::ZERO, MAX_RESTARTS), Decision::GiveUp);
        assert_eq!(decide(&[RestartBlockerKind::Recording], Duration::ZERO, MAX_RESTARTS), Decision::GiveUp);
    }

    #[test]
    fn only_restarts_within_the_last_hour_count() {
        let now = 1_000_000;
        let history = [now - 4000, now - 3599, now - 10, now + 50];
        assert_eq!(restarts_within_window(&history, now), 2, "an hour ago and a future stamp do not count");
        assert_eq!(restarts_within_window(&[], now), 0);
    }

    #[test]
    fn the_history_survives_in_its_file_and_keeps_the_latest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join(HISTORY_NAME);
        assert!(read_history(&path).is_empty(), "no file is no history");
        for t in 1..=12 {
            record_restart(&path, t);
        }
        assert_eq!(read_history(&path), (3..=12).collect::<Vec<u64>>());
        std::fs::write(&path, "garbage\n5\n").unwrap();
        assert_eq!(read_history(&path), vec![5], "an unreadable line is skipped");
    }

    #[test]
    fn heavy_means_the_web_views_not_the_app() {
        use crate::process_memory::{Sample, Usage};
        let usage = |private_bytes| Usage {
            private_bytes,
            working_set_bytes: 0,
        };
        assert!(!webviews_heavy(&Sample::default()), "unmeasured is not heavy");
        assert!(!webviews_heavy(&Sample {
            app: Some(usage(10 * WEBVIEW_HEAVY_BYTES)),
            webviews: Some((usage(WEBVIEW_HEAVY_BYTES), 3)),
        }));
        assert!(webviews_heavy(&Sample {
            app: None,
            webviews: Some((usage(WEBVIEW_HEAVY_BYTES + 1), 3)),
        }));
    }

    /// The panic hook reports through `note_panic`: an ordinary panic leaves
    /// the watchdog alone, the I/O driver's is recorded for it.
    #[test]
    fn a_fatal_panic_is_recorded_for_the_watchdog() {
        assert!(!note_panic("boom"));
        assert!(note_panic("unexpected error when polling the I/O driver: Os { code: 1450 }"));
        assert!(fatal_panic().is_some_and(|p| p.contains("I/O driver")));
    }
}
