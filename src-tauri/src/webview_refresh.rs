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

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::capture::session::CapturePhase;

/// How long a webview must have been out of sight before it is reloaded.
pub const RELOAD_AFTER: Duration = Duration::from_hours(2);

/// When each webview, by label, was first seen out of sight without a break.
#[derive(Default)]
pub struct WebviewRefreshState {
    clocks: Mutex<HashMap<String, Instant>>,
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
pub fn check<S: std::hash::BuildHasher>(
    clocks: &mut HashMap<String, Instant, S>,
    label: &str,
    hidden: bool,
    capture_busy: bool,
    now: Instant,
) -> bool {
    if !hidden {
        clocks.remove(label);
        return false;
    }
    let since = *clocks.entry(label.to_string()).or_insert(now);
    if capture_busy || now.duration_since(since) < RELOAD_AFTER {
        return false;
    }
    clocks.insert(label.to_string(), now);
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
    let due = check(&mut clocks, window.label(), hidden, capture_busy, Instant::now());
    if due {
        tracing::info!(label = %window.label(), "reloading a webview that has been out of sight for hours");
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
        let mut clocks = HashMap::new();
        let start = Instant::now();
        assert!(!check(&mut clocks, "main", true, false, start));
        assert!(!check(&mut clocks, "main", true, false, start + Duration::from_hours(1)));
        assert!(check(&mut clocks, "main", true, false, start + RELOAD_AFTER));
    }

    #[test]
    fn coming_back_on_screen_restarts_the_clock() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, start);
        assert!(!check(&mut clocks, "main", false, false, start + Duration::from_mins(90)));
        assert!(!check(&mut clocks, "main", true, false, start + RELOAD_AFTER));
    }

    #[test]
    fn a_capture_in_progress_holds_the_reload_until_it_ends() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, start);
        assert!(!check(&mut clocks, "main", true, true, start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", true, false, start + RELOAD_AFTER + Duration::from_mins(1)));
    }

    #[test]
    fn a_reload_restarts_the_clock_so_it_happens_once() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "tray-panel", true, false, start);
        assert!(check(&mut clocks, "tray-panel", true, false, start + RELOAD_AFTER));
        assert!(!check(
            &mut clocks,
            "tray-panel",
            true,
            false,
            start + RELOAD_AFTER + Duration::from_mins(1)
        ));
    }

    #[test]
    fn each_webview_has_its_own_clock() {
        let mut clocks = HashMap::new();
        let start = Instant::now();
        check(&mut clocks, "main", true, false, start);
        assert!(!check(&mut clocks, "tray-panel", true, false, start + RELOAD_AFTER));
        assert!(check(&mut clocks, "main", true, false, start + RELOAD_AFTER));
    }
}
