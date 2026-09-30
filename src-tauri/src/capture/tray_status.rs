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
}
