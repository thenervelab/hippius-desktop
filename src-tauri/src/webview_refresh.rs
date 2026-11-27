//! Reloading a long-lived webview that has been out of sight for hours.
//!
//! On Windows, WebView2 keeps every distinct script it runs and never frees
//! it, and every Tauri event a webview receives is such a script
//! (tauri-apps/tauri#12724, tauri-apps/wry#1489). The main window and the
//! tray popover live for the whole run, so even a modest event rate adds up
//! over days. Fewer and steadier events slow that down; a reload is what gives
//! the memory back, because the leaked scripts belong to the page.
//!
//! The reload is only ever done where nobody can see it: the window is hidden
//! (the macOS tray, the popover between opens) or minimized, and has been for
//! [`RELOAD_AFTER`]. A window that is on screen but behind others is left
//! alone, since a reload there is visible. No capture may be in progress, and
//! the page itself refuses while a dialog is open (`useIdleWebviewReload`).
//!
//! Rust owns the clock and the decision; the page asks every few minutes
//! (`webview_reload_due`) and reloads itself when told to.
//!
//! When the web views are heavy (the watchdog's memory sample, see
//! `runtime_watchdog::WEBVIEW_HEAVY_BYTES`), an out-of-sight webview reloads
//! after [`RELOAD_AFTER_WHEN_HEAVY`] instead, at most once per
//! [`RELOAD_AFTER`]: the memory cannot be pinned on one window, so a window
//! that has just been reloaded and is still out of sight is not reloaded again
//! for memory another window holds.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::capture::session::CapturePhase;

/// How long a webview must have been out of sight before it is reloaded.
pub const RELOAD_AFTER: Duration = Duration::from_hours(2);
/// The same, while the web views are heavy.
pub const RELOAD_AFTER_WHEN_HEAVY: Duration = Duration::from_mins(10);

/// When each webview, by label, was first seen out of sight without a break,
/// and when it was last reloaded.
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
    out_of_sight_since: HashMap<String, Instant>,
    reloaded_at: HashMap<String, Instant>,
}

/// Whether a webview can be reloaded without anyone noticing.
#[must_use]
pub fn out_of_sight(visible: bool, minimized: bool) -> bool {
    !visible || minimized
}

/// Record where `label` is now and decide whether it is due for a reload.
///
/// The first check that finds it out of sight starts its clock; a check that
/// finds it on screen clears it. A reload restarts the clock, so the page that
/// comes back is not reloaded again on the next check.
///
/// `memory_heavy` shortens the wait to [`RELOAD_AFTER_WHEN_HEAVY`] for a
/// webview not reloaded within the last [`RELOAD_AFTER`].
pub fn check(clocks: &mut Clocks, label: &str, hidden: bool, capture_busy: bool, memory_heavy: bool, now: Instant) -> bool {
    if !hidden {
        clocks.out_of_sight_since.remove(label);
        return false;
    }
    let since = *clocks.out_of_sight_since.entry(label.to_string()).or_insert(now);
    let recently_reloaded = clocks.reloaded_at.get(label).is_some_and(|at| now.duration_since(*at) < RELOAD_AFTER);
    let wait = if memory_heavy && !recently_reloaded {
        RELOAD_AFTER_WHEN_HEAVY
    } else {
        RELOAD_AFTER
    };
    if capture_busy || now.duration_since(since) < wait {
        return false;
    }
    clocks.out_of_sight_since.insert(label.to_string(), now);
    clocks.reloaded_at.insert(label.to_string(), now);
    true
}

/// Asked by a long-lived page every few minutes: should it reload itself now?
#[tauri::command]
pub fn webview_reload_due(window: tauri::WebviewWindow) -> bool {
    let Some(state) = window.try_state::<crate::app_state::AppState>() else {
        return false;
    };
    let hidden = out_of_sight(window.is_visible().unwrap_or(true), window.is_minimized().unwrap_or(false));
    let capture_busy = !matches!(state.capture.current(), CapturePhase::Idle);
    let Ok(mut clocks) = state.webview_refresh.clocks.lock() else {
        return false;
    };
    let heavy = state.webview_refresh.memory_heavy.load(Ordering::Relaxed);
    let due = check(&mut clocks, window.label(), hidden, capture_busy, heavy, Instant::now());
    if due {
        tracing::info!(label = %window.label(), memory_heavy = heavy, "reloading a webview that has been out of sight");
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_or_minimized_is_out_of_sight_and_behind_others_is_not() {
        assert!(out_of_sight(false, false));
        assert!(out_of_sight(true, true));
        assert!(!out_of_sight(true, false));
    }

    #[test]
    fn a_webview_is_due_only_after_two_hours_out_of_sight() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        assert!(!check(&mut clocks, "main", true, false, false, start));
        assert!(!check(&mut clocks, "main", true, false, false, start + Duration::from_hours(1)));
        assert!(check(&mut clocks, "main", true, false, false, start + RELOAD_AFTER));
    }

    #[test]
    fn coming_back_on_screen_restarts_the_clock() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, false, start);
        assert!(!check(&mut clocks, "main", false, false, false, start + Duration::from_mins(90)));
        assert!(!check(&mut clocks, "main", true, false, false, start + RELOAD_AFTER));
    }

    #[test]
    fn a_capture_in_progress_holds_the_reload_until_it_ends() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, false, start);
        assert!(!check(&mut clocks, "main", true, true, false, start + RELOAD_AFTER));
        assert!(check(
            &mut clocks,
            "main",
            true,
            false,
            false,
            start + RELOAD_AFTER + Duration::from_mins(1)
        ));
    }

    #[test]
    fn a_reload_restarts_the_clock_so_it_happens_once() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", true, false, false, start);
        assert!(check(&mut clocks, "tray-panel", true, false, false, start + RELOAD_AFTER));
        assert!(!check(
            &mut clocks,
            "tray-panel",
            true,
            false,
            false,
            start + RELOAD_AFTER + Duration::from_mins(1)
        ));
    }

    #[test]
    fn each_webview_has_its_own_clock() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, false, start);
        assert!(!check(&mut clocks, "tray-panel", true, false, false, start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", true, false, false, start + RELOAD_AFTER));
    }
    #[test]
    fn heavy_web_views_reload_a_hidden_window_after_minutes() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, true, start);
        assert!(!check(&mut clocks, "main", true, false, true, start + Duration::from_mins(5)));
        assert!(check(&mut clocks, "main", true, false, true, start + RELOAD_AFTER_WHEN_HEAVY));
    }

    #[test]
    fn heavy_web_views_never_reload_a_window_on_screen_or_mid_capture() {
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "main", true, true, true, start);
        assert!(!check(&mut clocks, "main", true, true, true, start + Duration::from_hours(1)));
        assert!(!check(&mut clocks, "main", false, false, true, start + Duration::from_hours(1)));
    }

    #[test]
    fn a_window_reloaded_for_memory_waits_the_full_time_before_the_next() {
        // The memory may belong to a window on screen: the hidden one is
        // reloaded once, then waits the normal two hours even while heavy.
        let mut clocks = Clocks::default();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", true, false, true, start);
        let first = start + RELOAD_AFTER_WHEN_HEAVY;
        assert!(check(&mut clocks, "tray-panel", true, false, true, first));
        assert!(!check(&mut clocks, "tray-panel", true, false, true, first + RELOAD_AFTER_WHEN_HEAVY));
        assert!(!check(&mut clocks, "tray-panel", true, false, true, first + Duration::from_mins(90)));
        assert!(check(&mut clocks, "tray-panel", true, false, true, first + RELOAD_AFTER));
    }
}
