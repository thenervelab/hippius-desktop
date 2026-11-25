//! Restarting the app when its async runtime has died (Windows).
//!
//! When Windows runs out of system resources, Tokio's I/O driver panics
//! ("unexpected error when polling the I/O driver", OS error 1450) and the
//! runtime stops running tasks. The process lives on: the window still shows,
//! but every async command and every background loop (sync, the update check,
//! the chain subscription) is dead, and the webview keeps the memory it holds.
//! A support bundle showed four days in that state, with the log silent after
//! the panic. The panic hook cannot fix this: it runs on the panicking worker
//! thread and only records the panic.
//!
//! A task on the runtime bumps a counter every [`BEAT_EVERY`]; a plain OS
//! thread reads it every [`CHECK_EVERY`]. When the counter has stood still for
//! [`DEAD_AFTER`] of on-time checks, the runtime is declared dead and the app
//! restarts through Tauri's event loop, which runs on the main thread and does
//! not need the runtime.
//!
//! Windows only, by decision: the failure and its reports are Windows-only,
//! and a restart is a visible act we keep to where it is needed. The decision
//! logic ([`Watch`]) compiles everywhere under test so it runs on every CI
//! runner.

use std::time::Duration;

/// How often the runtime proves it is alive. Arbitrary: often enough that
/// [`DEAD_AFTER`] covers many beats, rarely enough to cost nothing.
pub const BEAT_EVERY: Duration = Duration::from_secs(10);

/// How often the watchdog thread looks at the beat. Longer than [`BEAT_EVERY`],
/// so a live runtime has always beaten between two checks.
pub const CHECK_EVERY: Duration = Duration::from_secs(15);

/// How long the beat may stand still before the runtime counts as dead.
/// A runtime that cannot run a timer task for five minutes is unusable
/// whatever the cause. The restart loses work in flight (a recording, a
/// sync), which is accepted over a window that does nothing. Arbitrary.
pub const DEAD_AFTER: Duration = Duration::from_mins(5);

/// How long a requested restart may take before the process exits instead.
/// The restart runs the app's exit handlers, and one of them can wait on the
/// dead runtime; an exited app is still better than a window that does
/// nothing while holding its memory. Arbitrary, well above a normal restart.
#[cfg(windows)]
const RESTART_GRACE: Duration = Duration::from_secs(30);

/// What one look at the beat concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The runtime has beaten recently enough, or there is no evidence yet.
    Alive,
    /// The beat has stood still for [`DEAD_AFTER`] of on-time checks.
    Dead,
}

/// The watchdog's memory between checks.
#[derive(Debug, Default)]
pub struct Watch {
    /// The beat counter as last seen.
    last_beat: u64,
    /// How long the counter has stood still, counting only on-time checks.
    stale_for: Duration,
}

impl Watch {
    /// Look at the beat counter, `since_last_check` after the previous look.
    ///
    /// A check more than twice [`CHECK_EVERY`] late means the watchdog thread
    /// itself was not running, as across a system sleep. The runtime was
    /// frozen too, so the gap is no evidence against it: it starts the count
    /// again instead of adding to it.
    pub fn observe(&mut self, beat: u64, since_last_check: Duration) -> Verdict {
        if beat != self.last_beat {
            self.last_beat = beat;
            self.stale_for = Duration::ZERO;
            return Verdict::Alive;
        }
        if since_last_check > CHECK_EVERY * 2 {
            self.stale_for = Duration::ZERO;
            return Verdict::Alive;
        }
        self.stale_for += since_last_check;
        if self.stale_for >= DEAD_AFTER { Verdict::Dead } else { Verdict::Alive }
    }
}

/// Start the beat on the async runtime and the watchdog thread beside it.
///
/// Call once, from setup. Does not block.
#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    let beats = Arc::new(AtomicU64::new(0));

    let beat = Arc::clone(&beats);
    // Detached: it beats for the life of the process and stops only when the
    // runtime does, which is what the watchdog looks for.
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(BEAT_EVERY);
        loop {
            tick.tick().await;
            // Relaxed: the counter orders no other memory; the watchdog only
            // compares one value with the next.
            beat.fetch_add(1, Ordering::Relaxed);
        }
    });

    let spawned = std::thread::Builder::new()
        .name("runtime-watchdog".into())
        .spawn(move || watch(&app, &beats));
    if let Err(error) = spawned {
        tracing::error!(%error, "runtime watchdog: could not start its thread");
    }
}

/// The watchdog thread: wait for a dead runtime, then restart the app.
#[cfg(windows)]
fn watch(app: &tauri::AppHandle, beats: &std::sync::atomic::AtomicU64) {
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    let mut watch = Watch::default();
    let mut last_check = Instant::now();
    loop {
        std::thread::sleep(CHECK_EVERY);
        let now = Instant::now();
        let verdict = watch.observe(beats.load(Ordering::Relaxed), now.duration_since(last_check));
        last_check = now;
        if verdict == Verdict::Dead {
            break;
        }
    }

    let detail = format!("async runtime stopped: no beat for {}s; restarting the app", DEAD_AFTER.as_secs());
    tracing::error!("{detail}");
    // The crash file is written synchronously, so it survives the exit below
    // even when the non-blocking log writer does not get to flush.
    if let Some(path) = crate::diagnostics::crash_log_path() {
        let record = crate::diagnostics::crash_record("RUNTIME STOPPED", &detail, "runtime_watchdog", "runtime-watchdog", "");
        crate::diagnostics::append_crash_record(&path, &record);
    }

    app.request_restart();
    std::thread::sleep(RESTART_GRACE);
    tracing::error!("runtime watchdog: the restart did not finish; exiting");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks `every` apart it takes for a still beat to be declared dead.
    fn checks_to_dead(every: Duration) -> u32 {
        u32::try_from(DEAD_AFTER.as_secs() / every.as_secs()).expect("a few dozen checks fit in u32")
    }

    /// Feed `checks` checks, `every` apart, that all see `beat`; the last verdict.
    fn stand_still(watch: &mut Watch, beat: u64, every: Duration, checks: u32) -> Verdict {
        let mut verdict = Verdict::Alive;
        for _ in 0..checks {
            verdict = watch.observe(beat, every);
        }
        verdict
    }

    #[test]
    fn a_beat_that_stands_still_for_dead_after_is_dead() {
        let mut watch = Watch::default();
        let checks = checks_to_dead(CHECK_EVERY);
        assert_eq!(watch.observe(1, CHECK_EVERY), Verdict::Alive);
        assert_eq!(stand_still(&mut watch, 1, CHECK_EVERY, checks - 1), Verdict::Alive);
        assert_eq!(watch.observe(1, CHECK_EVERY), Verdict::Dead);
    }

    #[test]
    fn a_runtime_that_never_beat_is_dead_too() {
        let mut watch = Watch::default();
        assert_eq!(stand_still(&mut watch, 0, CHECK_EVERY, checks_to_dead(CHECK_EVERY)), Verdict::Dead);
    }

    #[test]
    fn a_new_beat_starts_the_count_again() {
        let mut watch = Watch::default();
        let checks = checks_to_dead(CHECK_EVERY);
        stand_still(&mut watch, 0, CHECK_EVERY, checks - 1);
        assert_eq!(watch.observe(1, CHECK_EVERY), Verdict::Alive);
        assert_eq!(stand_still(&mut watch, 1, CHECK_EVERY, checks - 1), Verdict::Alive);
    }

    #[test]
    fn a_check_over_twice_late_is_a_system_sleep_and_starts_the_count_again() {
        let mut watch = Watch::default();
        let checks = checks_to_dead(CHECK_EVERY);
        stand_still(&mut watch, 0, CHECK_EVERY, checks - 1);
        assert_eq!(watch.observe(0, CHECK_EVERY * 2 + Duration::from_secs(1)), Verdict::Alive);
        assert_eq!(stand_still(&mut watch, 0, CHECK_EVERY, checks - 1), Verdict::Alive);
        assert_eq!(watch.observe(0, CHECK_EVERY), Verdict::Dead);
    }

    #[test]
    fn a_check_up_to_twice_late_still_counts_in_full() {
        let mut watch = Watch::default();
        let late = CHECK_EVERY * 2;
        assert_eq!(stand_still(&mut watch, 0, late, checks_to_dead(late) - 1), Verdict::Alive);
        assert_eq!(watch.observe(0, late), Verdict::Dead);
    }
}
