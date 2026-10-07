//! Hippius's own windows around a capture: which are kept out of screen
//! captures and how, and when the main window comes back during a
//! recording.
//!
//! **Out of the picture, but only Hippius's.** Content protection
//! (`NSWindow.sharingType = .none` on macOS, `WDA_EXCLUDEFROMCAPTURE` on
//! Windows) hides a window from EVERY capture, other apps' included: a
//! protected window is missing from a Google Meet or Zoom screen share,
//! which made the capture feature impossible to demo. On macOS the recording
//! helper leaves the app's own windows out itself (ScreenCaptureKit's
//! `excludingApplications`, which touches no other app's capture), so only
//! the selection overlays keep content protection there: they are on screen
//! while a screenshot is read, and the dimmed selection must not be in it.
//! The pill, the preview card and the tray popover show in other apps'
//! screen sharing; a visible card is taken off screen for the moment a
//! screenshot is read. Windows has no per-app exclusion for its recorder
//! (Windows.Graphics.Capture films what is on screen), so it keeps content
//! protection on all of them. Linux has none at all.
//!
//! **The main window during a recording.** It is hidden when a capture
//! starts so it is not in the shot, and stays hidden while a recording runs.
//! The user can still bring it back: the Dock icon (macOS sends "reopen",
//! but the pill counts as a visible window, so the old "no visible windows"
//! check never showed it), Cmd+Tab (only "did become active" arrives), and
//! the tray's Open Hippius (on Linux an item of the recording's own tray
//! menu, `tray_recording_menu`: a hidden window has no taskbar or dash entry
//! there and the tray sends no click). Once the user has it, the end of the recording
//! leaves it where it is and does not hand the keyboard back to the app
//! that was in front when the capture began.
//!
//! **Linux: the dock.** GNOME's dock (and Alt+Tab) raises the app's first
//! window, visible windows first, and on Wayland every Hippius window counts:
//! GTK 3 cannot mark a Wayland window "skip taskbar", so the pill and the
//! camera bubble are ordinary windows of the app. With the main window
//! hidden, a dock click raised the pill and nothing else happened. On X11
//! the dock does honour "skip taskbar", so the main window is minimized
//! instead of hidden there ([`main_away`]) and the dock's click is a plain
//! unminimize. On Wayland it stays hidden (a minimized Wayland window comes
//! back only through an activation the compositor refuses without fresh
//! input, so the tray's Open Hippius and the end of the recording could no
//! longer bring it back), and a capture window that takes the keyboard while
//! the pointer is not on it brings the main window
//! ([`capture_window_focus_shows_main`]).

use std::time::Duration;

use super::rollout::Platform;
use super::session::CapturePhase;

/// A Hippius window that can be on screen around a capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnWindow {
    /// A display's selection overlay, with the capture bar, countdown and
    /// hints on it.
    Overlay,
    /// The recording pill.
    Pill,
    /// The camera bubble's controls, over the bubble mid-recording
    /// (`bubble_controls`). The bubble itself is filmed; these never are.
    BubbleControls,
    /// The preview card in the corner.
    Card,
    /// The tray popover, opened during a recording (`recording`) or not.
    TrayPopover { recording: bool },
}

/// Whether `window` asks the system to keep it out of every capture. Where
/// this is false the window shows in other apps' screen sharing, and
/// Hippius's own captures leave it out by other means
/// ([`recorder_leaves_app_out`], and the card hidden before a screenshot).
#[must_use]
pub const fn content_protected(platform: Platform, window: OwnWindow) -> bool {
    match window {
        // On screen while a screenshot is read, on every platform.
        OwnWindow::Overlay => true,
        OwnWindow::Pill | OwnWindow::BubbleControls | OwnWindow::Card => !recorder_leaves_app_out(platform),
        OwnWindow::TrayPopover { recording } => recording && !recorder_leaves_app_out(platform),
    }
}

/// Whether the platform's recorder leaves the app's own windows out of a
/// screen or area recording by itself: the macOS helper filters out
/// Hippius with ScreenCaptureKit, except the windows named in
/// [`filmed_own_windows`].
#[must_use]
pub const fn recorder_leaves_app_out(platform: Platform) -> bool {
    matches!(platform, Platform::MacOs)
}

/// Whether a visible preview card must be taken off screen before a
/// screenshot is read: where it is not content protected.
#[must_use]
pub const fn hide_card_for_screenshot(platform: Platform) -> bool {
    !content_protected(platform, OwnWindow::Card)
}

/// The app's own windows a screen or area recording still films while the
/// rest of Hippius is left out: the main window (filmed like any app when the
/// user brings it into what is recorded) and the camera bubble.
#[must_use]
pub fn filmed_own_windows(main: Option<u32>, camera: Option<u32>) -> Vec<u32> {
    let mut ids: Vec<u32> = [main, camera].into_iter().flatten().filter(|id| *id > 0).collect();
    ids.dedup();
    ids
}

/// A recording is on (or being saved): the phases in which the main window
/// stays hidden unless the user brings it back.
#[must_use]
pub const fn recording_on(phase: CapturePhase) -> bool {
    matches!(
        phase,
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } | CapturePhase::Finalizing
    )
}

/// The Dock icon was clicked (macOS "reopen"): the main window comes
/// forward unless it is already on screen. Capture windows (the pill, the
/// card, the camera) are visible windows too, so AppKit's "has visible
/// windows" cannot decide this.
///
/// Not while something is being chosen or taken (`Selecting`, `Capturing`):
/// the overlays are up or the screen is being read, and a main window
/// shown under them would be in the screenshot or the recording's first
/// frames. The overlays take the keyboard back instead, as before.
#[must_use]
pub const fn reopen_shows_main(phase: CapturePhase, main_visible: bool, main_minimized: bool) -> bool {
    !choosing_or_taking(phase) && (!main_visible || main_minimized)
}

/// The overlays are up, or a capture is being read or started.
#[must_use]
pub const fn choosing_or_taking(phase: CapturePhase) -> bool {
    matches!(phase, CapturePhase::Selecting { .. } | CapturePhase::Capturing { .. })
}

/// Hippius became the active app (Cmd+Tab, a click on one of its windows,
/// its own popover taking focus). During a recording, with the main window
/// hidden, that is the user switching to Hippius, unless a mouse button is
/// down (a click on the pill, the card or the camera activates the app too)
/// or the tray popover is what took the focus.
#[must_use]
pub const fn activation_shows_main(phase: CapturePhase, main_visible: bool, mouse_down: bool, popover_visible: bool) -> bool {
    recording_on(phase) && !main_visible && !mouse_down && !popover_visible
}

/// The main window got the keyboard. During a recording that is the user
/// taking it back: the end of the recording must neither hide it, push it
/// behind, nor hand the keyboard to the app the capture started from.
#[must_use]
pub const fn focus_keeps_main(phase: CapturePhase) -> bool {
    recording_on(phase)
}

/// How the main window is kept out of a capture while one runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainAway {
    /// Hidden: off screen and out of the taskbar, dock and Alt+Tab.
    Hidden,
    /// Minimized: off screen (so not filmed) but still the app's window in
    /// the dock, whose click brings it back. X11 only: there the pill and the
    /// bubble are "skip taskbar", so a hidden main window left the dock with
    /// no window to raise.
    Minimized,
}

/// How `platform` puts the main window away when a capture starts.
#[must_use]
pub const fn main_away(platform: Platform) -> MainAway {
    match platform {
        Platform::LinuxX11 => MainAway::Minimized,
        Platform::MacOs | Platform::Windows | Platform::LinuxWayland => MainAway::Hidden,
    }
}

/// Whether the main window is on screen as the capture starts, the thing
/// the end of the capture puts back. A minimized window is "visible" to the
/// toolkit; on Linux it is left minimized afterwards rather than brought up.
/// (Elsewhere a minimized window has always been treated as shown, and
/// still is.)
#[must_use]
pub const fn main_on_screen(platform: Platform, visible: bool, minimized: bool) -> bool {
    match platform {
        Platform::LinuxX11 | Platform::LinuxWayland => visible && !minimized,
        Platform::MacOs | Platform::Windows => visible,
    }
}

/// How long after a capture window is mapped its first focus is the
/// compositor's doing (GNOME focuses a newly shown window), not the user's.
pub const MAPPED_FOCUS_GRACE: Duration = Duration::from_millis(1500);

/// A capture window (the pill, the camera bubble, its controls, the card)
/// took the keyboard on Wayland during a recording, with the main window
/// hidden. When the pointer is not on that window, no click on it did this:
/// the dock or Alt+Tab raised it in place of Hippius's main window, which
/// they cannot see (it is hidden, [`main_away`]). The main window comes
/// forward, as the macOS Dock and Cmd+Tab bring it.
///
/// Not a window the pointer is over (a click on Pause, a drag of the bubble),
/// not one just shown (`since_mapped` within [`MAPPED_FOCUS_GRACE`]: the
/// compositor focuses a new window itself), and only on Wayland (X11's dock
/// unminimizes the main window directly).
#[must_use]
pub fn capture_window_focus_shows_main(
    platform: Platform,
    phase: CapturePhase,
    main_on_screen: bool,
    pointer_over: bool,
    since_mapped: Option<Duration>,
) -> bool {
    let just_shown = since_mapped.is_some_and(|d| d < MAPPED_FOCUS_GRACE);
    matches!(platform, Platform::LinuxWayland) && recording_on(phase) && !main_on_screen && !pointer_over && !just_shown
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::session::CaptureKind;

    const RECORDING: CapturePhase = CapturePhase::Recording {
        elapsed_secs: 0,
        microphone: false,
    };

    /// macOS: only the overlays are hidden from other apps' screen sharing;
    /// the pill, the card and the popover show in a Meet share.
    #[test]
    fn macos_protects_only_the_overlays() {
        assert!(content_protected(Platform::MacOs, OwnWindow::Overlay));
        assert!(!content_protected(Platform::MacOs, OwnWindow::Pill));
        assert!(!content_protected(Platform::MacOs, OwnWindow::BubbleControls));
        assert!(!content_protected(Platform::MacOs, OwnWindow::Card));
        assert!(!content_protected(Platform::MacOs, OwnWindow::TrayPopover { recording: true }));
        assert!(!content_protected(Platform::MacOs, OwnWindow::TrayPopover { recording: false }));
        assert!(recorder_leaves_app_out(Platform::MacOs));
        assert!(hide_card_for_screenshot(Platform::MacOs));
    }

    /// Windows' recorder cannot leave windows out, so every capture window
    /// stays protected there, the popover only while recording.
    #[test]
    fn windows_keeps_content_protection() {
        for w in [
            OwnWindow::Overlay,
            OwnWindow::Pill,
            OwnWindow::BubbleControls,
            OwnWindow::Card,
            OwnWindow::TrayPopover { recording: true },
        ] {
            assert!(content_protected(Platform::Windows, w), "{w:?}");
        }
        assert!(!content_protected(Platform::Windows, OwnWindow::TrayPopover { recording: false }));
        assert!(!recorder_leaves_app_out(Platform::Windows));
        assert!(!hide_card_for_screenshot(Platform::Windows));
    }

    /// Linux has no content protection; nothing changes there (the overlay
    /// asks, and the request is a no-op; screenshots already clear the
    /// screen through `ui_in_grabs`).
    #[test]
    fn linux_is_unchanged() {
        for p in [Platform::LinuxX11, Platform::LinuxWayland] {
            assert!(content_protected(p, OwnWindow::Overlay));
            assert!(!recorder_leaves_app_out(p));
        }
    }

    #[test]
    fn the_recording_films_the_main_window_and_the_bubble_only() {
        assert_eq!(filmed_own_windows(Some(12), Some(40)), vec![12, 40]);
        assert_eq!(filmed_own_windows(None, Some(40)), vec![40]);
        assert_eq!(filmed_own_windows(Some(0), None), Vec::<u32>::new());
        assert_eq!(filmed_own_windows(Some(7), Some(7)), vec![7]);
    }

    /// The Dock shows the main window whenever it is not already up, even
    /// with the pill on screen (the bug: "has visible windows" was true).
    #[test]
    fn the_dock_brings_the_main_window_back() {
        for phase in [CapturePhase::Idle, RECORDING, CapturePhase::Finalizing] {
            assert!(reopen_shows_main(phase, false, false), "{phase:?}");
            assert!(reopen_shows_main(phase, true, true), "{phase:?}");
            assert!(!reopen_shows_main(phase, true, false), "{phase:?}");
        }
    }

    /// While the overlays are up (or a capture is being taken) the Dock
    /// leaves the main window hidden: shown under the overlays it would be
    /// in the shot, and the bar would seem to have vanished behind it.
    #[test]
    fn the_dock_leaves_a_capture_being_chosen_alone() {
        for phase in [
            CapturePhase::Selecting {
                kind: CaptureKind::Recording,
                mode: crate::capture::session::CaptureMode::Screen,
            },
            CapturePhase::Capturing {
                kind: CaptureKind::Screenshot,
            },
            CapturePhase::Capturing {
                kind: CaptureKind::Recording,
            },
        ] {
            assert!(!reopen_shows_main(phase, false, false), "{phase:?}");
        }
    }

    /// Cmd+Tab during a recording shows the main window; a click on the
    /// pill (button down) or the popover taking focus does not, and nothing
    /// changes outside a recording.
    #[test]
    fn switching_to_hippius_mid_recording_shows_it() {
        assert!(activation_shows_main(RECORDING, false, false, false));
        assert!(activation_shows_main(
            CapturePhase::Paused {
                elapsed_secs: 3,
                microphone: false
            },
            false,
            false,
            false
        ));
        assert!(!activation_shows_main(RECORDING, true, false, false));
        assert!(!activation_shows_main(RECORDING, false, true, false));
        assert!(!activation_shows_main(RECORDING, false, false, true));
        assert!(!activation_shows_main(CapturePhase::Idle, false, false, false));
        // Choosing, or a screenshot being read: the main window must stay out.
        assert!(!activation_shows_main(
            CapturePhase::Selecting {
                kind: CaptureKind::Screenshot,
                mode: crate::capture::session::CaptureMode::Area
            },
            false,
            false,
            false
        ));
        assert!(!activation_shows_main(
            CapturePhase::Capturing {
                kind: CaptureKind::Screenshot
            },
            false,
            false,
            false
        ));
    }

    #[test]
    fn taking_the_main_window_back_is_kept_only_mid_recording() {
        assert!(focus_keeps_main(RECORDING));
        assert!(focus_keeps_main(CapturePhase::Finalizing));
        assert!(!focus_keeps_main(CapturePhase::Idle));
        assert!(!focus_keeps_main(CapturePhase::Capturing {
            kind: CaptureKind::Recording
        }));
    }

    /// X11's dock honours "skip taskbar": the main window is minimized there
    /// so it stays the dock's one window. Wayland keeps hiding it (a
    /// minimized Wayland window cannot be brought back without the
    /// compositor's consent), and macOS and Windows are unchanged.
    #[test]
    fn only_x11_minimizes_the_main_window() {
        assert_eq!(main_away(Platform::LinuxX11), MainAway::Minimized);
        assert_eq!(main_away(Platform::LinuxWayland), MainAway::Hidden);
        assert_eq!(main_away(Platform::MacOs), MainAway::Hidden);
        assert_eq!(main_away(Platform::Windows), MainAway::Hidden);
    }

    /// A main window the user had minimized before the capture is not
    /// brought up at its end on Linux; macOS and Windows keep their rule.
    #[test]
    fn a_minimized_main_window_is_not_on_screen_on_linux() {
        for p in [Platform::LinuxX11, Platform::LinuxWayland] {
            assert!(main_on_screen(p, true, false), "{p:?}");
            assert!(!main_on_screen(p, true, true), "{p:?}");
            assert!(!main_on_screen(p, false, false), "{p:?}");
        }
        for p in [Platform::MacOs, Platform::Windows] {
            assert!(main_on_screen(p, true, true), "{p:?}");
            assert!(!main_on_screen(p, false, false), "{p:?}");
        }
    }

    /// The Wayland dock raises the pill or the bubble, with the pointer on
    /// the dock: that brings the hidden main window. A click on the pill
    /// (pointer on it), a window the compositor focused as it was shown, a
    /// main window already up, or a phase with no recording does not.
    #[test]
    fn the_wayland_dock_raising_a_capture_window_brings_the_main_window() {
        let long_ago = Some(Duration::from_secs(30));
        let wl = Platform::LinuxWayland;
        assert!(capture_window_focus_shows_main(wl, RECORDING, false, false, long_ago));
        assert!(capture_window_focus_shows_main(wl, CapturePhase::Finalizing, false, false, None));
        assert!(capture_window_focus_shows_main(
            wl,
            CapturePhase::Paused {
                elapsed_secs: 4,
                microphone: false
            },
            false,
            false,
            long_ago
        ));
        assert!(
            !capture_window_focus_shows_main(wl, RECORDING, false, true, long_ago),
            "a click on the pill"
        );
        assert!(!capture_window_focus_shows_main(wl, RECORDING, true, false, long_ago), "already up");
        assert!(
            !capture_window_focus_shows_main(wl, RECORDING, false, false, Some(Duration::from_millis(200))),
            "the compositor focused a window as it was shown"
        );
        assert!(capture_window_focus_shows_main(wl, RECORDING, false, false, Some(MAPPED_FOCUS_GRACE)));
        assert!(!capture_window_focus_shows_main(wl, CapturePhase::Idle, false, false, long_ago));
        assert!(!capture_window_focus_shows_main(
            wl,
            CapturePhase::Capturing {
                kind: CaptureKind::Recording
            },
            false,
            false,
            long_ago
        ));
        for p in [Platform::LinuxX11, Platform::MacOs, Platform::Windows] {
            assert!(!capture_window_focus_shows_main(p, RECORDING, false, false, long_ago), "{p:?}");
        }
    }
}
