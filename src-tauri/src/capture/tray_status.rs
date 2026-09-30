//! The menu bar's part in a recording, as macOS's own recording does it: the
//! elapsed time beside the Hippius icon while a recording runs, and a click
//! on the icon brings the recording's controls back.
//!
//! Rust is the only writer of the tray's title and the only judge of what a
//! tray click does during a capture. The title used to be written from the
//! main window's webview; `tray-icon` ignores a `None` title on macOS, so the
//! webview's "clear" never cleared and the last time stayed in the menu bar
//! after the recording was saved. Clearing therefore writes an EMPTY title
//! ([`TrayText::title`] is `""`, never absent).
//!
//! Pure, so every phase is pinned by a unit test; `commands::show_phase_in_tray`
//! applies it on every phase change.

use super::session::CapturePhase;

/// The tray icon's id: the frontend creates the icon under this id
/// (`TRAY_ID` in `app/lib/hooks/useTraySync.ts`), and Rust finds it by it.
pub const TRAY_ID: &str = "hippius-tray";

/// The tooltip when no recording is running (the icon's normal one).
pub const IDLE_TOOLTIP: &str = "Hippius Cloud";

/// "03:07": a recording's elapsed time, as the pill and the menu bar show it
/// (minutes keep counting past 59, the same as the pill's `mmss`).
#[must_use]
pub fn mmss(secs: u64) -> String {
    format!("{:02}:{:02}", secs / 60, secs % 60)
}

/// The text beside the tray icon, or `None` for none: only a running or
/// paused recording shows its time. Every other phase (choosing, saving,
/// idle) clears it, so the time goes the moment Stop is pressed.
#[must_use]
pub fn tray_title_for(phase: CapturePhase) -> Option<String> {
    match phase {
        CapturePhase::Recording { elapsed_secs, .. } => Some(format!("◼ {}", mmss(elapsed_secs))),
        CapturePhase::Paused { elapsed_secs, .. } => Some(format!("❚❚ {}", mmss(elapsed_secs))),
        _ => None,
    }
}

/// What to write to the tray for `phase`. The title is the only text on
/// macOS and Linux; Windows has no tray title, so the tooltip carries the
/// time there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayText {
    /// Empty = no title. Never `None`: see the module docs.
    pub title: String,
    pub tooltip: String,
}

#[must_use]
pub fn tray_text_for(phase: CapturePhase) -> TrayText {
    match (tray_title_for(phase), phase) {
        (Some(title), CapturePhase::Paused { elapsed_secs, .. }) => TrayText {
            title,
            tooltip: format!("Recording paused at {}. Click to show the recording controls.", mmss(elapsed_secs)),
        },
        (Some(title), CapturePhase::Recording { elapsed_secs, .. }) => TrayText {
            title,
            tooltip: format!("Recording {}. Click to show the recording controls.", mmss(elapsed_secs)),
        },
        _ => TrayText {
            title: String::new(),
            tooltip: IDLE_TOOLTIP.to_string(),
        },
    }
}

/// What a left click on the tray icon does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayClickAction {
    /// A recording is running or paused: show its pill (without taking focus
    /// from the app being recorded). The pill has Stop, so stopping stays one
    /// click away, and a stray click never ends a recording.
    ShowRecordingControls,
    /// Anything else: the normal tray popover.
    OpenPanel,
}

#[must_use]
pub fn tray_click_action(phase: CapturePhase) -> TrayClickAction {
    match phase {
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } => TrayClickAction::ShowRecordingControls,
        _ => TrayClickAction::OpenPanel,
    }
}

/// Where a left click on the tray icon goes, all things considered. Rust
/// receives the click itself (`tray::panel::on_tray_icon_event`); it used to
/// arrive through a callback the main window's webview registered when it
/// made the icon, and a reload of that webview left the icon clicking into
/// nothing, so the popover stopped opening.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayClickRoute {
    /// A recording is running or paused: its pill comes back.
    ShowRecordingControls,
    /// Nobody is signed in: the popover has nothing to show, so the main
    /// window comes forward on its sign-in screen.
    OpenMainWindow,
    /// The popover opens (or closes, if it is open).
    TogglePanel,
}

/// The route for a left click. A recording wins over everything (it cannot
/// outlive a sign-out, but its pill must never be unreachable); otherwise a
/// signed-out click opens the app and a signed-in one the popover, in every
/// other phase, a finished capture's Idle included.
#[must_use]
pub fn tray_click_route(signed_in: bool, phase: CapturePhase) -> TrayClickRoute {
    match (tray_click_action(phase), signed_in) {
        (TrayClickAction::ShowRecordingControls, _) => TrayClickRoute::ShowRecordingControls,
        (TrayClickAction::OpenPanel, false) => TrayClickRoute::OpenMainWindow,
        (TrayClickAction::OpenPanel, true) => TrayClickRoute::TogglePanel,
    }
}

/// Whether the tray needs writing: only when its text changes. The icon is
/// then left alone through a screenshot (every phase of one clears), and a
/// status item is not resized and re-hit-tested on phase changes that show
/// nothing. `last` is what was written last, `None` before the first write
/// (which matches an idle icon: no title and the normal tooltip).
#[must_use]
pub fn tray_needs_write(last: Option<&TrayText>, next: &TrayText) -> bool {
    match last {
        Some(last) => last != next,
        None => *next != tray_text_for(CapturePhase::Idle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::session::{CaptureKind, CaptureMode};

    const RECORDING: CapturePhase = CapturePhase::Recording {
        elapsed_secs: 42,
        microphone: true,
    };
    const PAUSED: CapturePhase = CapturePhase::Paused {
        elapsed_secs: 125,
        microphone: false,
    };

    /// Every phase that is not a live recording.
    fn not_recording() -> [CapturePhase; 6] {
        [
            CapturePhase::Idle,
            CapturePhase::Selecting {
                kind: CaptureKind::Recording,
                mode: CaptureMode::Area,
            },
            CapturePhase::Selecting {
                kind: CaptureKind::Screenshot,
                mode: CaptureMode::Screen,
            },
            CapturePhase::Capturing {
                kind: CaptureKind::Recording,
            },
            CapturePhase::Capturing {
                kind: CaptureKind::Screenshot,
            },
            CapturePhase::Finalizing,
        ]
    }

    #[test]
    fn mmss_pads_and_keeps_counting_minutes_past_the_hour() {
        assert_eq!(mmss(0), "00:00");
        assert_eq!(mmss(7), "00:07");
        assert_eq!(mmss(187), "03:07");
        assert_eq!(mmss(3725), "62:05");
    }

    #[test]
    fn a_running_or_paused_recording_shows_its_time() {
        assert_eq!(tray_title_for(RECORDING).as_deref(), Some("◼ 00:42"));
        assert_eq!(tray_title_for(PAUSED).as_deref(), Some("❚❚ 02:05"));
    }

    #[test]
    fn every_other_phase_clears_the_title() {
        for phase in not_recording() {
            assert_eq!(tray_title_for(phase), None, "{phase:?}");
        }
    }

    /// A `None` title is ignored by `tray-icon` on macOS, which is what left
    /// the time stuck beside the icon: clearing must write an empty title.
    #[test]
    fn clearing_writes_an_empty_title_and_the_normal_tooltip() {
        for phase in not_recording() {
            assert_eq!(
                tray_text_for(phase),
                TrayText {
                    title: String::new(),
                    tooltip: IDLE_TOOLTIP.to_string()
                },
                "{phase:?}"
            );
        }
    }

    /// Windows has no tray title: the tooltip is where the time is read there.
    #[test]
    fn the_tooltip_carries_the_time_for_windows() {
        let text = tray_text_for(RECORDING);
        assert_eq!(text.title, "◼ 00:42");
        assert!(text.tooltip.contains("00:42"), "{}", text.tooltip);
        assert!(tray_text_for(PAUSED).tooltip.contains("paused at 02:05"));
    }

    #[test]
    fn a_click_during_a_recording_shows_its_controls_and_never_stops_it() {
        assert_eq!(tray_click_action(RECORDING), TrayClickAction::ShowRecordingControls);
        assert_eq!(tray_click_action(PAUSED), TrayClickAction::ShowRecordingControls);
    }

    #[test]
    fn a_click_at_any_other_time_opens_the_popover() {
        for phase in not_recording() {
            assert_eq!(tray_click_action(phase), TrayClickAction::OpenPanel, "{phase:?}");
        }
    }

    #[test]
    fn a_click_is_routed_in_every_phase() {
        for phase in not_recording() {
            assert_eq!(tray_click_route(true, phase), TrayClickRoute::TogglePanel, "{phase:?}");
            assert_eq!(tray_click_route(false, phase), TrayClickRoute::OpenMainWindow, "{phase:?}");
        }
        for phase in [RECORDING, PAUSED] {
            assert_eq!(tray_click_route(true, phase), TrayClickRoute::ShowRecordingControls);
            assert_eq!(tray_click_route(false, phase), TrayClickRoute::ShowRecordingControls);
        }
    }

    /// The popover that stopped opening: after a capture the session is back
    /// at Idle, and a click there opens the popover like any other time.
    #[test]
    fn a_click_after_a_finished_capture_opens_the_popover() {
        use crate::capture::session::{CaptureEvent, transition};
        let shot = [
            CaptureEvent::Start {
                kind: CaptureKind::Screenshot,
                mode: CaptureMode::Area,
            },
            CaptureEvent::Selected,
            CaptureEvent::Captured,
        ];
        let after_shot = shot.iter().try_fold(CapturePhase::Idle, |p, &e| transition(p, e)).unwrap();
        assert_eq!(after_shot, CapturePhase::Idle);
        assert_eq!(tray_click_route(true, after_shot), TrayClickRoute::TogglePanel);

        let recording = [
            CaptureEvent::Start {
                kind: CaptureKind::Recording,
                mode: CaptureMode::Screen,
            },
            CaptureEvent::Selected,
            CaptureEvent::RecordingStarted { microphone: false },
            CaptureEvent::Stop,
            CaptureEvent::Captured,
        ];
        let after_recording = recording.iter().try_fold(CapturePhase::Idle, |p, &e| transition(p, e)).unwrap();
        assert_eq!(after_recording, CapturePhase::Idle);
        assert_eq!(tray_click_route(true, after_recording), TrayClickRoute::TogglePanel);
        // A cancelled or failed one too.
        for end in [CaptureEvent::Cancel, CaptureEvent::Failed] {
            let phase = transition(RECORDING, end).unwrap();
            assert_eq!(tray_click_route(true, phase), TrayClickRoute::TogglePanel, "{end:?}");
        }
    }

    #[test]
    fn the_tray_is_written_only_when_its_text_changes() {
        let idle = tray_text_for(CapturePhase::Idle);
        // A screenshot never touches the icon: every phase of it is idle text.
        assert!(!tray_needs_write(None, &idle));
        for phase in not_recording() {
            assert!(!tray_needs_write(Some(&idle), &tray_text_for(phase)), "{phase:?}");
        }
        // A recording writes its time each second, and clears once at the end.
        let t42 = tray_text_for(RECORDING);
        assert!(tray_needs_write(None, &t42));
        assert!(tray_needs_write(Some(&idle), &t42));
        assert!(!tray_needs_write(Some(&t42), &t42));
        assert!(tray_needs_write(Some(&t42), &idle));
    }
}
