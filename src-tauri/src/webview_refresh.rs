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
//! platform. Under WebView2 only, a window on screen without focus
//! ([`Sight::Unfocused`]) is reloaded too, after [`RELOAD_UNFOCUSED_AFTER`]:
//! a Windows user can leave the main window open behind others for days, and
//! a support bundle showed WebView2 at 15 GB after six. That reload can be
//! seen, so it waits much longer and also needs the page to have had no input
//! for as long. Elsewhere a window on screen is never reloaded, since no other
//! engine leaks this way. A busy webview (a capture in progress, or a dialog
//! open on the page) is held: its clock keeps running, so it reloads at the
//! first look after it stops being busy rather than waiting the whole time
//! again.
//!
//! Rust owns the clock and the decision; the page asks every few minutes
//! (`webview_reload_due`), says how long it has had no input and whether a
//! dialog is open, and reloads itself when told to.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::capture::session::CapturePhase;

/// How long a webview must have been hidden or minimized before it is reloaded.
pub const RELOAD_AFTER: Duration = Duration::from_hours(2);

/// How long a WebView2 window on screen must have gone without focus and
/// without input before it is reloaded. Chosen with the product owner: long
/// enough that the user has plainly left it, short enough that a window left
/// open for days is reloaded a few times a day.
pub const RELOAD_UNFOCUSED_AFTER: Duration = Duration::from_hours(6);

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

/// How a webview is placed, as far as a reload goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sight {
    /// In use, or on screen where a reload would be seen for no gain.
    Watched,
    /// On screen without focus, under WebView2.
    Unfocused,
    /// Hidden or minimized.
    Hidden,
}

impl Sight {
    /// Where a webview stands, from its window's state.
    #[must_use]
    pub fn of(visible: bool, minimized: bool, focused: bool, engine: Engine) -> Self {
        if !visible || minimized {
            Self::Hidden
        } else if !focused && engine == Engine::WebView2 {
            Self::Unfocused
        } else {
            Self::Watched
        }
    }

    /// How long a webview must stay like this before it is reloaded.
    fn reload_after(self) -> Option<Duration> {
        match self {
            Self::Watched => None,
            Self::Unfocused => Some(RELOAD_UNFOCUSED_AFTER),
            Self::Hidden => Some(RELOAD_AFTER),
        }
    }
}

/// One look at a webview, from its window and its page.
#[derive(Debug)]
pub struct Look {
    /// How the window is placed.
    pub sight: Sight,
    /// How long the page has gone without keyboard, pointer or wheel input.
    /// Counts only for [`Sight::Unfocused`]: a hidden page gets no input, so
    /// there it could only be reset by a re-render, never by the user.
    pub input_idle: Duration,
    /// A capture is in progress, or the page has a dialog open; a reload
    /// would throw either away.
    pub busy: bool,
}

/// When each webview, by label, was first seen out of use without a break.
#[derive(Default)]
pub struct WebviewRefreshState {
    clocks: Mutex<HashMap<String, Instant>>,
}

/// Record how `label` looks now and decide whether it is due for a reload.
///
/// The first look that finds it out of use starts its clock; a look that finds
/// it watched clears it. An unfocused window's time out of use counts only
/// while its page has also had no input. A busy look leaves the clock alone.
/// A reload restarts the clock, so the page that comes back is not reloaded
/// again on the next look.
pub fn check<S: std::hash::BuildHasher>(clocks: &mut HashMap<String, Instant, S>, label: &str, look: Look, now: Instant) -> bool {
    let Some(after) = look.sight.reload_after() else {
        clocks.remove(label);
        return false;
    };
    let since = *clocks.entry(label.to_string()).or_insert(now);
    let mut unused_for = now.duration_since(since);
    if look.sight == Sight::Unfocused {
        unused_for = unused_for.min(look.input_idle);
    }
    if look.busy || unused_for < after {
        return false;
    }
    clocks.insert(label.to_string(), now);
    true
}

/// Asked by a long-lived page every few minutes: should it reload itself now?
/// `idle_ms` is how long the page has gone without input; `dialog_open` says a
/// dialog a reload would throw away is on the page.
#[tauri::command]
pub fn webview_reload_due(window: tauri::WebviewWindow, idle_ms: u64, dialog_open: bool) -> bool {
    let Some(state) = window.try_state::<crate::app_state::AppState>() else {
        return false;
    };
    let sight = Sight::of(
        window.is_visible().unwrap_or(true),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(true),
        Engine::CURRENT,
    );
    let look = Look {
        sight,
        input_idle: Duration::from_millis(idle_ms),
        busy: dialog_open || !matches!(state.capture.current(), CapturePhase::Idle),
    };
    let Ok(mut clocks) = state.webview_refresh.clocks.lock() else {
        return false;
    };
    let due = check(&mut clocks, window.label(), look, Instant::now());
    if due {
        tracing::info!(label = %window.label(), ?sight, "reloading a webview that has been out of use for hours");
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A look with no input for days, so only the window's own clock counts.
    fn look(sight: Sight) -> Look {
        Look {
            sight,
            input_idle: Duration::from_hours(100),
            busy: false,
        }
    }

    #[test]
    fn hidden_or_minimized_is_hidden_on_every_engine() {
        for engine in [Engine::WebView2, Engine::Other] {
            assert_eq!(Sight::of(false, false, false, engine), Sight::Hidden);
            assert_eq!(Sight::of(true, true, false, engine), Sight::Hidden);
        }
    }

    #[test]
    fn on_screen_without_focus_counts_only_under_webview2() {
        assert_eq!(Sight::of(true, false, false, Engine::WebView2), Sight::Unfocused);
        assert_eq!(Sight::of(true, false, false, Engine::Other), Sight::Watched);
        assert_eq!(Sight::of(true, false, true, Engine::WebView2), Sight::Watched);
    }

    #[test]
    fn a_hidden_webview_is_due_after_two_hours() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        assert!(!check(&mut clocks, "main", look(Sight::Hidden), start));
        assert!(!check(&mut clocks, "main", look(Sight::Hidden), start + Duration::from_hours(1)));
        assert!(check(&mut clocks, "main", look(Sight::Hidden), start + RELOAD_AFTER));
    }

    #[test]
    fn an_unfocused_webview_waits_six_hours_not_two() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Unfocused), start);
        assert!(!check(&mut clocks, "main", look(Sight::Unfocused), start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", look(Sight::Unfocused), start + RELOAD_UNFOCUSED_AFTER));
    }

    #[test]
    fn recent_input_holds_an_unfocused_reload() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Unfocused), start);
        let scrolled = Look {
            input_idle: Duration::from_mins(10),
            ..look(Sight::Unfocused)
        };
        assert!(!check(&mut clocks, "main", scrolled, start + RELOAD_UNFOCUSED_AFTER));
        let still = Look {
            input_idle: RELOAD_UNFOCUSED_AFTER,
            ..look(Sight::Unfocused)
        };
        assert!(check(&mut clocks, "main", still, start + RELOAD_UNFOCUSED_AFTER));
    }

    #[test]
    fn input_idle_does_not_hold_a_hidden_reload() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", look(Sight::Hidden), start);
        let rerendered = Look {
            input_idle: Duration::from_mins(1),
            ..look(Sight::Hidden)
        };
        assert!(check(&mut clocks, "tray-panel", rerendered, start + RELOAD_AFTER));
    }

    #[test]
    fn hidden_then_unfocused_keeps_one_clock() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Hidden), start);
        assert!(!check(&mut clocks, "main", look(Sight::Unfocused), start + Duration::from_hours(5)));
        assert!(check(&mut clocks, "main", look(Sight::Unfocused), start + RELOAD_UNFOCUSED_AFTER));
    }

    #[test]
    fn being_watched_restarts_the_clock() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Hidden), start);
        assert!(!check(&mut clocks, "main", look(Sight::Watched), start + Duration::from_mins(90)));
        assert!(!check(&mut clocks, "main", look(Sight::Hidden), start + RELOAD_AFTER));
    }

    #[test]
    fn a_busy_webview_is_held_and_reloads_as_soon_as_it_is_free() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Unfocused), start);
        let dialog = Look {
            busy: true,
            ..look(Sight::Unfocused)
        };
        assert!(!check(&mut clocks, "main", dialog, start + RELOAD_UNFOCUSED_AFTER));
        let later = Look {
            busy: true,
            ..look(Sight::Unfocused)
        };
        assert!(!check(&mut clocks, "main", later, start + RELOAD_UNFOCUSED_AFTER * 2));
        let free = start + RELOAD_UNFOCUSED_AFTER * 2 + Duration::from_mins(5);
        assert!(check(&mut clocks, "main", look(Sight::Unfocused), free));
    }

    #[test]
    fn a_capture_in_progress_holds_the_reload_until_it_ends() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Hidden), start);
        let busy = Look {
            busy: true,
            ..look(Sight::Hidden)
        };
        assert!(!check(&mut clocks, "main", busy, start + RELOAD_AFTER));
        assert!(check(
            &mut clocks,
            "main",
            look(Sight::Hidden),
            start + RELOAD_AFTER + Duration::from_mins(1)
        ));
    }

    #[test]
    fn a_reload_restarts_the_clock_so_it_happens_once() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", look(Sight::Hidden), start);
        assert!(check(&mut clocks, "tray-panel", look(Sight::Hidden), start + RELOAD_AFTER));
        let next = start + RELOAD_AFTER + Duration::from_mins(1);
        assert!(!check(&mut clocks, "tray-panel", look(Sight::Hidden), next));
    }

    #[test]
    fn each_webview_has_its_own_clock() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", look(Sight::Hidden), start);
        assert!(!check(&mut clocks, "tray-panel", look(Sight::Hidden), start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", look(Sight::Hidden), start + RELOAD_AFTER));
    }
}
