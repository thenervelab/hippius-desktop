//! Reloading a long-lived webview that has been out of use for hours.
//!
//! On Windows, WebView2 keeps every distinct script it runs and never frees
//! it, and every Tauri event a webview receives is such a script
//! (tauri-apps/tauri#12724, tauri-apps/wry#1489). The main window and the
//! tray popover live for the whole run, so even a modest event rate adds up
//! over days. Fewer and steadier events slow that down; a reload is what gives
//! the memory back, because the leaked scripts belong to the page.
//!
//! A webview is reloaded when it is [`Sight::Hidden`] (the macOS tray, the
//! popover between opens, a minimized window) for [`RELOAD_AFTER`], on every
//! platform. Under WebView2 only, a window on screen ([`Sight::OnScreen`]) is
//! reloaded too, once its page has had no input for
//! [`RELOAD_ON_SCREEN_AFTER`]: a Windows user can leave the main window open
//! for days, behind other windows or in front of a locked screen, and a
//! support bundle showed WebView2 at 15 GB after six. Focus is deliberately
//! not asked: a window in front of a locked screen keeps it for days. That
//! reload can be seen, so it waits much longer and needs the page to have had
//! no input for as long. Elsewhere a window on screen is never reloaded, since
//! no other engine leaks this way.
//!
//! When the web views are heavy (the watchdog's memory sample, see
//! `runtime_watchdog::WEBVIEW_HEAVY_BYTES`), a hidden webview reloads after
//! [`RELOAD_AFTER_WHEN_HEAVY`] instead, at most once per [`RELOAD_AFTER`]: the
//! memory cannot be pinned on one window, so a window that has just been
//! reloaded and is still hidden is not reloaded again for memory another
//! window holds. A window on screen does not take the early path, since the
//! user would see a reload every few minutes.
//!
//! A busy webview (a capture in progress, or the page holding a dialog or
//! unsent text) is held: its clock keeps running, so it reloads at the first
//! look after it stops being busy rather than waiting the whole time again.
//!
//! Rust owns the clock and the decision; the page asks every few minutes
//! (`webview_reload_due`), says how long it has had no input and whether it is
//! busy, and reloads itself when told to.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::capture::session::CapturePhase;

/// How long a webview must have been hidden or minimized before it is reloaded.
pub const RELOAD_AFTER: Duration = Duration::from_hours(2);

/// The same, while the web views are heavy.
pub const RELOAD_AFTER_WHEN_HEAVY: Duration = Duration::from_mins(10);

/// How long a WebView2 window on screen must have gone without input before
/// it is reloaded. Chosen with the product owner: long enough that the user
/// has plainly left it, short enough that a window left open for days is
/// reloaded a few times a day.
pub const RELOAD_ON_SCREEN_AFTER: Duration = Duration::from_hours(6);

/// The web engine behind this build's webviews.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// Windows: keeps every event script for the life of the page.
    WebView2,
    /// WebKit on macOS and Linux.
    Other,
}

impl Engine {
    /// The engine this build runs on.
    pub const CURRENT: Self = if cfg!(windows) { Self::WebView2 } else { Self::Other };
}

/// Whether a webview's window can be seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sight {
    /// Visible and not minimized, focused or not.
    OnScreen,
    /// Hidden or minimized.
    Hidden,
}

impl Sight {
    /// Where a webview stands, from its window's state.
    #[must_use]
    pub fn of(visible: bool, minimized: bool) -> Self {
        if !visible || minimized { Self::Hidden } else { Self::OnScreen }
    }
}

/// One look at a webview, from its window and its page.
#[derive(Debug)]
pub struct Look {
    /// Whether the window can be seen.
    pub sight: Sight,
    /// The engine behind it; only WebView2 reloads a window on screen.
    pub engine: Engine,
    /// How long the page has gone without keyboard, pointer or wheel input.
    /// Counts only for [`Sight::OnScreen`]: a hidden page gets no input, so
    /// there it could only be reset by a re-render, never by the user.
    pub input_idle: Duration,
    /// A capture is in progress, or the page holds a dialog or unsent text;
    /// a reload would throw any of them away.
    pub busy: bool,
    /// The web views are heavy (the watchdog's memory sample).
    pub memory_heavy: bool,
}

impl Look {
    /// How long a webview must stay like this before it is reloaded, or
    /// `None` when it never is.
    fn wait(&self, recently_reloaded: bool) -> Option<Duration> {
        match self.sight {
            Sight::OnScreen => (self.engine == Engine::WebView2).then_some(RELOAD_ON_SCREEN_AFTER),
            Sight::Hidden if self.memory_heavy && !recently_reloaded => Some(RELOAD_AFTER_WHEN_HEAVY),
            Sight::Hidden => Some(RELOAD_AFTER),
        }
    }
}

/// When each webview, by label, was first seen out of use without a break,
/// when it was last reloaded, and whether the web views are heavy.
#[derive(Default)]
pub struct WebviewRefreshState {
    clocks: Mutex<Clocks>,
    memory_heavy: AtomicBool,
}

impl WebviewRefreshState {
    /// Set by the watchdog after each memory sample.
    pub fn set_memory_heavy(&self, heavy: bool) {
        self.memory_heavy.store(heavy, Ordering::Relaxed);
    }
}

/// The per-label clocks [`check`] keeps.
#[derive(Debug, Default)]
pub struct Clocks {
    unused_since: HashMap<String, Instant>,
    reloaded_at: HashMap<String, Instant>,
}

/// Record how `label` looks now and decide whether it is due for a reload.
///
/// The first look that finds it out of use starts its clock; a look that finds
/// it never due (on screen outside WebView2) clears it. A window on screen
/// counts as out of use only while its page has also had no input. A busy look
/// leaves the clock alone. A reload restarts the clock, so the page that comes
/// back is not reloaded again on the next look.
pub fn check(clocks: &mut Clocks, label: &str, look: &Look, now: Instant) -> bool {
    let recently_reloaded = clocks.reloaded_at.get(label).is_some_and(|at| now.duration_since(*at) < RELOAD_AFTER);
    let Some(wait) = look.wait(recently_reloaded) else {
        clocks.unused_since.remove(label);
        return false;
    };
    let since = *clocks.unused_since.entry(label.to_string()).or_insert(now);
    let mut unused_for = now.duration_since(since);
    if look.sight == Sight::OnScreen {
        unused_for = unused_for.min(look.input_idle);
    }
    if look.busy || unused_for < wait {
        return false;
    }
    clocks.unused_since.insert(label.to_string(), now);
    clocks.reloaded_at.insert(label.to_string(), now);
    true
}

/// Asked by a long-lived page every few minutes: should it reload itself now?
/// `idle_ms` is how long the page has gone without input; `page_busy` says the
/// page holds a dialog or unsent text a reload would throw away.
#[tauri::command]
pub fn webview_reload_due(window: tauri::WebviewWindow, idle_ms: u64, page_busy: bool) -> bool {
    let Some(state) = window.try_state::<crate::app_state::AppState>() else {
        return false;
    };
    let look = Look {
        sight: Sight::of(window.is_visible().unwrap_or(true), window.is_minimized().unwrap_or(false)),
        engine: Engine::CURRENT,
        input_idle: Duration::from_millis(idle_ms),
        busy: page_busy || !matches!(state.capture.current(), CapturePhase::Idle),
        memory_heavy: state.webview_refresh.memory_heavy.load(Ordering::Relaxed),
    };
    let Ok(mut clocks) = state.webview_refresh.clocks.lock() else {
        return false;
    };
    let due = check(&mut clocks, window.label(), &look, Instant::now());
    if due {
        tracing::info!(
            label = %window.label(),
            sight = ?look.sight,
            memory_heavy = look.memory_heavy,
            "reloading a webview that has been out of use"
        );
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A look under WebView2 with no input for days, so only the window's own
    /// clock counts.
    fn look(sight: Sight) -> Look {
        Look {
            sight,
            engine: Engine::WebView2,
            input_idle: Duration::from_hours(100),
            busy: false,
            memory_heavy: false,
        }
    }

    fn heavy(sight: Sight) -> Look {
        Look {
            memory_heavy: true,
            ..look(sight)
        }
    }

    #[test]
    fn hidden_or_minimized_is_hidden_and_anything_else_on_screen() {
        assert_eq!(Sight::of(false, false), Sight::Hidden);
        assert_eq!(Sight::of(true, true), Sight::Hidden);
        assert_eq!(Sight::of(true, false), Sight::OnScreen);
    }

    #[test]
    fn a_hidden_webview_is_due_after_two_hours_on_every_engine() {
        for engine in [Engine::WebView2, Engine::Other] {
            let hidden = Look {
                engine,
                ..look(Sight::Hidden)
            };
            let mut clocks = Clocks::default();
            let start = Instant::now();
            assert!(!check(&mut clocks, "main", &hidden, start));
            assert!(!check(&mut clocks, "main", &hidden, start + Duration::from_hours(1)));
            assert!(check(&mut clocks, "main", &hidden, start + RELOAD_AFTER));
        }
    }

    #[test]
    fn a_webview2_window_on_screen_waits_six_hours_not_two() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::OnScreen), start);
        assert!(!check(&mut clocks, "main", &look(Sight::OnScreen), start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", &look(Sight::OnScreen), start + RELOAD_ON_SCREEN_AFTER));
    }

    #[test]
    fn a_window_on_screen_outside_webview2_is_never_reloaded() {
        let on_screen = Look {
            engine: Engine::Other,
            ..look(Sight::OnScreen)
        };
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &on_screen, start);
        assert!(!check(&mut clocks, "main", &on_screen, start + RELOAD_ON_SCREEN_AFTER * 4));
    }

    #[test]
    fn recent_input_holds_a_reload_on_screen() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::OnScreen), start);
        let scrolled = Look {
            input_idle: Duration::from_mins(10),
            ..look(Sight::OnScreen)
        };
        assert!(!check(&mut clocks, "main", &scrolled, start + RELOAD_ON_SCREEN_AFTER));
        let still = Look {
            input_idle: RELOAD_ON_SCREEN_AFTER,
            ..look(Sight::OnScreen)
        };
        assert!(check(&mut clocks, "main", &still, start + RELOAD_ON_SCREEN_AFTER));
    }

    #[test]
    fn input_idle_does_not_hold_a_hidden_reload() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", &look(Sight::Hidden), start);
        let rerendered = Look {
            input_idle: Duration::from_mins(1),
            ..look(Sight::Hidden)
        };
        assert!(check(&mut clocks, "tray-panel", &rerendered, start + RELOAD_AFTER));
    }

    #[test]
    fn hidden_then_on_screen_keeps_one_clock() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::Hidden), start);
        assert!(!check(&mut clocks, "main", &look(Sight::OnScreen), start + Duration::from_hours(5)));
        assert!(check(&mut clocks, "main", &look(Sight::OnScreen), start + RELOAD_ON_SCREEN_AFTER));
    }

    #[test]
    fn being_on_screen_outside_webview2_restarts_the_clock() {
        let on_screen = Look {
            engine: Engine::Other,
            ..look(Sight::OnScreen)
        };
        let hidden = Look {
            engine: Engine::Other,
            ..look(Sight::Hidden)
        };
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &hidden, start);
        assert!(!check(&mut clocks, "main", &on_screen, start + Duration::from_mins(90)));
        assert!(!check(&mut clocks, "main", &hidden, start + RELOAD_AFTER));
    }

    #[test]
    fn a_busy_webview_is_held_and_reloads_as_soon_as_it_is_free() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::OnScreen), start);
        let busy = Look {
            busy: true,
            ..look(Sight::OnScreen)
        };
        assert!(!check(&mut clocks, "main", &busy, start + RELOAD_ON_SCREEN_AFTER));
        assert!(!check(&mut clocks, "main", &busy, start + RELOAD_ON_SCREEN_AFTER * 2));
        let free = start + RELOAD_ON_SCREEN_AFTER * 2 + Duration::from_mins(5);
        assert!(check(&mut clocks, "main", &look(Sight::OnScreen), free));
    }

    #[test]
    fn a_capture_in_progress_holds_the_reload_until_it_ends() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::Hidden), start);
        let busy = Look {
            busy: true,
            ..look(Sight::Hidden)
        };
        assert!(!check(&mut clocks, "main", &busy, start + RELOAD_AFTER));
        let later = start + RELOAD_AFTER + Duration::from_mins(1);
        assert!(check(&mut clocks, "main", &look(Sight::Hidden), later));
    }

    #[test]
    fn a_reload_restarts_the_clock_so_it_happens_once() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", &look(Sight::Hidden), start);
        assert!(check(&mut clocks, "tray-panel", &look(Sight::Hidden), start + RELOAD_AFTER));
        let next = start + RELOAD_AFTER + Duration::from_mins(1);
        assert!(!check(&mut clocks, "tray-panel", &look(Sight::Hidden), next));
    }

    #[test]
    fn each_webview_has_its_own_clock() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &look(Sight::Hidden), start);
        assert!(!check(&mut clocks, "tray-panel", &look(Sight::Hidden), start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", &look(Sight::Hidden), start + RELOAD_AFTER));
    }

    #[test]
    fn heavy_web_views_reload_a_hidden_window_after_minutes() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", &heavy(Sight::Hidden), start);
        assert!(!check(&mut clocks, "main", &heavy(Sight::Hidden), start + Duration::from_mins(5)));
        assert!(check(&mut clocks, "main", &heavy(Sight::Hidden), start + RELOAD_AFTER_WHEN_HEAVY));
    }

    #[test]
    fn heavy_web_views_never_hurry_a_window_on_screen_or_mid_capture() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        let capturing = Look {
            busy: true,
            ..heavy(Sight::Hidden)
        };
        check(&mut clocks, "main", &capturing, start);
        assert!(!check(&mut clocks, "main", &capturing, start + Duration::from_hours(1)));
        check(&mut clocks, "tray-panel", &heavy(Sight::OnScreen), start);
        assert!(!check(
            &mut clocks,
            "tray-panel",
            &heavy(Sight::OnScreen),
            start + Duration::from_hours(1)
        ));
    }

    #[test]
    fn a_window_reloaded_for_memory_waits_the_full_time_before_the_next() {
        // The memory may belong to a window on screen: the hidden one is
        // reloaded once, then waits the normal two hours even while heavy.
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", &heavy(Sight::Hidden), start);
        let first = start + RELOAD_AFTER_WHEN_HEAVY;
        assert!(check(&mut clocks, "tray-panel", &heavy(Sight::Hidden), first));
        assert!(!check(&mut clocks, "tray-panel", &heavy(Sight::Hidden), first + RELOAD_AFTER_WHEN_HEAVY));
        assert!(!check(&mut clocks, "tray-panel", &heavy(Sight::Hidden), first + Duration::from_mins(90)));
        assert!(check(&mut clocks, "tray-panel", &heavy(Sight::Hidden), first + RELOAD_AFTER));
    }
}
