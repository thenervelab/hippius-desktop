//! The shortcut's one-step area screenshot, like macOS's Cmd+Shift+4 with
//! "copy the link" built in: the pointer turns into a crosshair at once, no
//! area is drawn in advance and there is no capture bar; releasing the drag
//! takes the shot, which is filed, uploaded and its link copied like any
//! other. Escape cancels; Space swaps to clicking a window, as the bar's
//! overlay does.
//!
//! Only the shortcut starts one. The Screenshot and Record buttons and the
//! tray keep the capture bar, with its options and its remembered area.
//!
//! Where Hippius draws no overlay (a Wayland screenshot goes to the desktop's
//! own screenshot tool), the shortcut opens that tool instead: it is already
//! one step there.

use super::session::{CaptureKind, CaptureMode};
use super::support::{SelectionUi, Surfaces};

/// What a start asks for once the request and the platform are weighed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartChoice {
    pub kind: CaptureKind,
    pub mode: CaptureMode,
    /// The one-step area screenshot: no bar, no area drawn in advance, no
    /// timer, and the shot is taken when the drag ends.
    pub instant: bool,
    /// Whether this start becomes the bar's "last used" kind and mode. An
    /// instant shot is not a choice made on the bar, so the next time the
    /// bar opens it opens where the user left it.
    pub remember: bool,
}

/// Whether these surfaces can take an area screenshot in one step: the
/// overlay draws the selection here and offers an area for screenshots.
#[must_use]
pub fn instant_area_offered(surfaces: &Surfaces) -> bool {
    surfaces.selection == SelectionUi::Overlay && (surfaces.modes.screenshot.is_empty() || surfaces.modes.screenshot.contains(&CaptureMode::Area))
}

/// The capture a start opens. `instant` (the shortcut) is an area
/// screenshot in one step where [`instant_area_offered`], and a plain
/// screenshot elsewhere (the desktop's own tool on Wayland). Otherwise the
/// bar opens on `requested`, or on the last kind and mode used, a recording
/// falling back to a screenshot where recording has gone (`recording_ok`).
#[must_use]
pub fn start_choice(
    surfaces: &Surfaces,
    instant: bool,
    requested: (Option<CaptureKind>, Option<CaptureMode>),
    last: (CaptureKind, CaptureMode),
    recording_ok: bool,
) -> StartChoice {
    if instant {
        let one_step = instant_area_offered(surfaces);
        let mode = super::support::offered_mode(surfaces, CaptureKind::Screenshot, CaptureMode::Area);
        return StartChoice {
            kind: CaptureKind::Screenshot,
            mode,
            instant: one_step,
            remember: false,
        };
    }
    let kind = match requested.0 {
        Some(k) => k,
        // Last time was a recording on a Mac that has since lost the helper.
        None if last.0 == CaptureKind::Recording && !recording_ok => CaptureKind::Screenshot,
        None => last.0,
    };
    let mode = super::support::offered_mode(surfaces, kind, requested.1.unwrap_or(last.1));
    StartChoice {
        kind,
        mode,
        instant: false,
        remember: (last.0, last.1) != (kind, mode),
    }
}

/// The countdown an instant shot runs: none. The screenshot timer belongs to
/// the bar, where it is set; a shortcut that waited would read as broken.
#[must_use]
pub const fn countdown_secs(instant: bool, otherwise: u8) -> u8 {
    if instant { 0 } else { otherwise }
}

/// Whether a mode switch (Space, or the bar) is remembered as the bar's
/// last mode: not during an instant shot, which never had a bar.
#[must_use]
pub const fn remembers_mode_switch(instant: bool) -> bool {
    !instant
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::rollout::Platform;
    use crate::capture::support::surfaces_for;

    fn overlay() -> Surfaces {
        surfaces_for(Platform::MacOs, true, true)
    }

    fn wayland() -> Surfaces {
        surfaces_for(Platform::LinuxWayland, true, true)
    }

    /// The shortcut is an area screenshot taken in one step, whatever the
    /// bar was last used for, and it does not move the bar's last choice.
    #[test]
    fn the_shortcut_is_a_one_step_area_screenshot() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            let s = surfaces_for(platform, true, true);
            let choice = start_choice(&s, true, (None, None), (CaptureKind::Recording, CaptureMode::Window), true);
            assert_eq!(
                choice,
                StartChoice {
                    kind: CaptureKind::Screenshot,
                    mode: CaptureMode::Area,
                    instant: true,
                    remember: false,
                },
                "{platform:?}"
            );
        }
    }

    /// A kind or mode sent with the shortcut's request cannot turn it back
    /// into the bar: instant wins.
    #[test]
    fn instant_ignores_a_requested_kind() {
        let choice = start_choice(
            &overlay(),
            true,
            (Some(CaptureKind::Recording), Some(CaptureMode::Screen)),
            (CaptureKind::Screenshot, CaptureMode::Area),
            true,
        );
        assert_eq!(
            (choice.kind, choice.mode, choice.instant),
            (CaptureKind::Screenshot, CaptureMode::Area, true)
        );
    }

    /// Wayland has no overlay: the shortcut takes a screenshot with the
    /// desktop's own tool, which is one step already, and no bar mode is
    /// remembered.
    #[test]
    fn wayland_shortcut_is_the_desktops_screenshot_tool() {
        let s = wayland();
        assert!(!instant_area_offered(&s));
        let choice = start_choice(&s, true, (None, None), (CaptureKind::Recording, CaptureMode::Screen), true);
        assert_eq!(choice.kind, CaptureKind::Screenshot);
        assert!(!choice.instant);
        assert!(!choice.remember);
        assert_eq!(
            super::super::support::start_plan(&s, choice.kind),
            super::super::support::StartPlan::SystemPicker
        );
    }

    /// The buttons keep the bar: a requested kind and mode open it there, and
    /// a change is remembered; no request opens it on the last one used.
    #[test]
    fn the_buttons_keep_the_bar() {
        let s = overlay();
        let asked = start_choice(
            &s,
            false,
            (Some(CaptureKind::Recording), Some(CaptureMode::Window)),
            (CaptureKind::Screenshot, CaptureMode::Area),
            true,
        );
        assert_eq!(
            asked,
            StartChoice {
                kind: CaptureKind::Recording,
                mode: CaptureMode::Window,
                instant: false,
                remember: true,
            }
        );
        let last = start_choice(&s, false, (None, None), (CaptureKind::Screenshot, CaptureMode::Screen), true);
        assert_eq!(
            (last.kind, last.mode, last.instant, last.remember),
            (CaptureKind::Screenshot, CaptureMode::Screen, false, false)
        );
    }

    /// The bar's last recording falls back to a screenshot on a Mac that can
    /// no longer record, as before.
    #[test]
    fn a_lost_recorder_opens_the_bar_on_screenshots() {
        let choice = start_choice(&overlay(), false, (None, None), (CaptureKind::Recording, CaptureMode::Area), false);
        assert_eq!(choice.kind, CaptureKind::Screenshot);
    }

    /// No timer on an instant shot; the bar keeps its own.
    #[test]
    fn an_instant_shot_has_no_countdown() {
        assert_eq!(countdown_secs(true, 5), 0);
        assert_eq!(countdown_secs(false, 5), 5);
        assert!(!remembers_mode_switch(true));
        assert!(remembers_mode_switch(false));
    }
}
