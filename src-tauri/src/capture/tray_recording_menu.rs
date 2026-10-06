//! The tray menu while a recording runs on Linux.
//!
//! Linux's tray (AppIndicator / StatusNotifierItem) sends an app no click:
//! a click on the icon only opens its menu, and many panels (KDE's, most
//! GNOME extensions) show no text beside the icon either. So while a
//! recording runs, Rust swaps the menu for the recording's own controls
//! (Stop, Pause or Resume, Show recording controls, Open Hippius), marks the icon like
//! Windows does (`tray_status::TRAY_ICON_MARKS_RECORDING`), and still writes
//! the time as the indicator's label for the panels that show one.
//!
//! Open Hippius stays in that menu: the main window is hidden when a
//! capture starts, and a hidden window has no taskbar or dash entry on
//! Linux, so without it the app could not be reached until the recording
//! stopped. Shown, the main window is filmed like any other app the user
//! brings into what is recorded, as on macOS (`own_windows`). When
//! the recording ends the main window is told (`capture_tray_icon_released`)
//! and puts back its own icon and its own menu (`useTraySync.ts`): only it
//! can rebuild the items whose actions live in its page.
//!
//! The menu is written only when what it offers changes (start, pause,
//! resume, end), never on the once-a-second time tick, so an open menu is
//! not rebuilt under the pointer. Pure, tested on every OS; `commands.rs`
//! applies it.

use super::own_windows::choosing_or_taking;
use super::session::CapturePhase;
use super::tray_status::TrayGlyph;

/// Whether this system swaps the tray menu while recording (Linux only:
/// macOS and Windows reach the popover and the pill with a click).
pub const TRAY_MENU_FOLLOWS_RECORDING: bool = cfg!(target_os = "linux");

/// The menu item ids. Prefixed so the app-wide menu listener never mistakes
/// another menu's item (the main window's own, the popover's) for one.
pub const STOP_ID: &str = "capture-tray-stop";
pub const PAUSE_ID: &str = "capture-tray-pause";
pub const RESUME_ID: &str = "capture-tray-resume";
pub const SHOW_ID: &str = "capture-tray-show-controls";
pub const OPEN_ID: &str = "capture-tray-open-hippius";

/// One item of the recording's menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Item {
    pub id: &'static str,
    pub text: &'static str,
}

/// What the menu offers while the recording is in `glyph`'s state: empty
/// when no recording runs (the main window's menu is back by then).
#[must_use]
pub fn items_for(glyph: TrayGlyph) -> Vec<Item> {
    let stop = Item {
        id: STOP_ID,
        text: "Stop recording",
    };
    let show = Item {
        id: SHOW_ID,
        text: "Show recording controls",
    };
    let open = Item {
        id: OPEN_ID,
        text: "Open Hippius",
    };
    match glyph {
        TrayGlyph::Recording => vec![
            stop,
            Item {
                id: PAUSE_ID,
                text: "Pause recording",
            },
            show,
            open,
        ],
        TrayGlyph::Paused => vec![
            stop,
            Item {
                id: RESUME_ID,
                text: "Resume recording",
            },
            show,
            open,
        ],
        TrayGlyph::None => Vec::new(),
    }
}

/// What to do to the menu after a tray write that moves the recording from
/// `was` to `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuWrite {
    /// Nothing the menu offers changed (a time tick, or no recording).
    Keep,
    /// Put up the recording's menu for this state.
    Set(TrayGlyph),
    /// The recording ended: the main window puts its own menu back.
    Release,
}

#[must_use]
pub fn menu_write(was: TrayGlyph, now: TrayGlyph) -> MenuWrite {
    match (was, now) {
        (was, now) if was == now => MenuWrite::Keep,
        (_, TrayGlyph::None) => MenuWrite::Release,
        (_, now) => MenuWrite::Set(now),
    }
}

/// What a click on one of the recording's items does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Stop,
    Pause,
    Resume,
    ShowControls,
    OpenMain,
}

/// The action for a menu item id, or `None` for any other menu's item.
#[must_use]
pub fn action_for(id: &str) -> Option<Action> {
    match id {
        STOP_ID => Some(Action::Stop),
        PAUSE_ID => Some(Action::Pause),
        RESUME_ID => Some(Action::Resume),
        SHOW_ID => Some(Action::ShowControls),
        OPEN_ID => Some(Action::OpenMain),
        _ => None,
    }
}

/// What the app does for a click on one of the recording's items, given
/// the phase the session is in when the click arrives. The menu on screen
/// can be a beat behind the session (opened just before a pause from the
/// pill, or kept open across the end of the recording), so the item is
/// read for what the user meant against the phase now: Pause on an already
/// paused recording and Resume on a running one do nothing rather than
/// fail, and every item does nothing once no recording runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Stop,
    Pause,
    Resume,
    /// Bring the pill back on screen (shown if hidden, raised if covered).
    ShowControls,
    /// Bring the main window forward, the tray's form of the macOS Dock
    /// click during a recording.
    OpenMain,
    /// Nothing to do: logged, never an error the user sees.
    Ignore,
}

#[must_use]
pub fn effect_for(action: Action, phase: CapturePhase) -> Effect {
    let recording = matches!(phase, CapturePhase::Recording { .. });
    let paused = matches!(phase, CapturePhase::Paused { .. });
    match action {
        // Wanted in any phase (a menu kept open past the recording's end
        // still means "show me the app"), except while something is being
        // chosen or taken: the main window would be in the shot.
        Action::OpenMain if choosing_or_taking(phase) => Effect::Ignore,
        Action::OpenMain => Effect::OpenMain,
        _ if !recording && !paused => Effect::Ignore,
        Action::Stop => Effect::Stop,
        Action::ShowControls => Effect::ShowControls,
        Action::Pause if recording => Effect::Pause,
        Action::Resume if paused => Effect::Resume,
        Action::Pause | Action::Resume => Effect::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stop first (the one most looked for), then pause or resume as the
    /// recording is, then the pill.
    #[test]
    fn the_menu_offers_what_the_recording_can_do_now() {
        let texts = |g| items_for(g).iter().map(|i| i.text).collect::<Vec<_>>();
        assert_eq!(
            texts(TrayGlyph::Recording),
            ["Stop recording", "Pause recording", "Show recording controls", "Open Hippius"]
        );
        assert_eq!(
            texts(TrayGlyph::Paused),
            ["Stop recording", "Resume recording", "Show recording controls", "Open Hippius"]
        );
        assert!(items_for(TrayGlyph::None).is_empty());
    }

    /// The menu changes only when what it offers does: the time ticking
    /// once a second would otherwise rebuild an open menu under the pointer.
    #[test]
    fn the_menu_is_rewritten_only_when_the_recording_changes_state() {
        use TrayGlyph::{None, Paused, Recording};
        assert_eq!(menu_write(None, None), MenuWrite::Keep);
        assert_eq!(menu_write(Recording, Recording), MenuWrite::Keep);
        assert_eq!(menu_write(None, Recording), MenuWrite::Set(Recording));
        assert_eq!(menu_write(Recording, Paused), MenuWrite::Set(Paused));
        assert_eq!(menu_write(Paused, Recording), MenuWrite::Set(Recording));
        assert_eq!(menu_write(Paused, None), MenuWrite::Release);
        assert_eq!(menu_write(Recording, None), MenuWrite::Release);
    }

    /// Every item answers to its own id and nothing else does, so another
    /// menu's click (the main window's Quit) never stops a recording.
    #[test]
    fn only_the_recordings_items_act() {
        for glyph in [TrayGlyph::Recording, TrayGlyph::Paused] {
            for item in items_for(glyph) {
                assert!(action_for(item.id).is_some(), "{}", item.id);
            }
        }
        assert_eq!(action_for(STOP_ID), Some(Action::Stop));
        assert_eq!(action_for(PAUSE_ID), Some(Action::Pause));
        assert_eq!(action_for(RESUME_ID), Some(Action::Resume));
        assert_eq!(action_for(SHOW_ID), Some(Action::ShowControls));
        assert_eq!(action_for(OPEN_ID), Some(Action::OpenMain));
        assert_eq!(action_for("tray-ctx-quit"), None);
        assert_eq!(action_for("tray-ctx-open-hippius"), None);
    }

    /// Every item reaches the session while a recording runs; a menu a beat
    /// behind the session never fails or acts twice, and nothing acts once
    /// the recording is over.
    #[test]
    fn each_item_acts_on_the_recording_as_it_is_now() {
        let recording = CapturePhase::Recording {
            elapsed_secs: 12,
            microphone: true,
        };
        let paused = CapturePhase::Paused {
            elapsed_secs: 12,
            microphone: true,
        };
        assert_eq!(effect_for(Action::Stop, recording), Effect::Stop);
        assert_eq!(effect_for(Action::Stop, paused), Effect::Stop);
        assert_eq!(effect_for(Action::Pause, recording), Effect::Pause);
        assert_eq!(effect_for(Action::Resume, paused), Effect::Resume);
        assert_eq!(effect_for(Action::ShowControls, recording), Effect::ShowControls);
        assert_eq!(effect_for(Action::ShowControls, paused), Effect::ShowControls);
        // A stale item: already paused, already running.
        assert_eq!(effect_for(Action::Pause, paused), Effect::Ignore);
        assert_eq!(effect_for(Action::Resume, recording), Effect::Ignore);
        // The recording ended while the menu was open (Open Hippius still
        // opens the app, tested on its own).
        for phase in [CapturePhase::Idle, CapturePhase::Finalizing] {
            for action in [Action::Stop, Action::Pause, Action::Resume, Action::ShowControls] {
                assert_eq!(effect_for(action, phase), Effect::Ignore, "{action:?} in {phase:?}");
            }
        }
    }

    /// The ids the menu is built with are the ids the listener routes, end
    /// to end: build every item for both states, route its id, and get an
    /// effect that is not Ignore while recording.
    #[test]
    fn every_built_item_routes_to_the_session() {
        let recording = CapturePhase::Recording {
            elapsed_secs: 1,
            microphone: false,
        };
        let paused = CapturePhase::Paused {
            elapsed_secs: 1,
            microphone: false,
        };
        for (glyph, phase) in [(TrayGlyph::Recording, recording), (TrayGlyph::Paused, paused)] {
            for item in items_for(glyph) {
                let action = action_for(item.id).expect("a recording item");
                assert_ne!(effect_for(action, phase), Effect::Ignore, "{} in {glyph:?}", item.id);
            }
        }
    }

    /// The bug: during a recording the main window is hidden and the tray's
    /// menu is the recording's, so Linux had no way back to the app until
    /// the recording stopped. Open Hippius is in the menu and opens it while
    /// recording, paused, saving, or from a menu left open past the end; it
    /// does nothing while the overlays are up or the screen is being read.
    #[test]
    fn open_hippius_reaches_the_main_window_during_a_recording() {
        for glyph in [TrayGlyph::Recording, TrayGlyph::Paused] {
            assert!(items_for(glyph).iter().any(|i| i.id == OPEN_ID), "{glyph:?}");
        }
        let recording = CapturePhase::Recording {
            elapsed_secs: 3,
            microphone: false,
        };
        let paused = CapturePhase::Paused {
            elapsed_secs: 3,
            microphone: false,
        };
        for phase in [recording, paused, CapturePhase::Finalizing, CapturePhase::Idle] {
            assert_eq!(effect_for(Action::OpenMain, phase), Effect::OpenMain, "{phase:?}");
        }
        for phase in [
            CapturePhase::Selecting {
                kind: crate::capture::session::CaptureKind::Recording,
                mode: crate::capture::session::CaptureMode::Screen,
            },
            CapturePhase::Capturing {
                kind: crate::capture::session::CaptureKind::Recording,
            },
        ] {
            assert_eq!(effect_for(Action::OpenMain, phase), Effect::Ignore, "{phase:?}");
        }
    }
}
