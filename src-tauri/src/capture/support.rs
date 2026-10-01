//! What the capture surfaces may offer on this platform, decided in Rust so
//! the frontend never checks the platform itself (CLAUDE.md). Flattened into
//! both `capture_support` and the overlay's `OverlayContext`.
//!
//! macOS, Windows and Linux on X11 use the overlay, offer every mode and the
//! screenshot timer. Wayland cannot draw over the screen, so a screenshot
//! there is the desktop's own screenshot tool (`SystemPicker`): Hippius
//! offers no mode and no timer, and says so in `systemPickerNote`. The
//! shortcut is the plugin's on macOS and Windows; Linux gets its own in
//! Phase 6 of `docs/plans/2026-10-01-capture-windows-linux.md`, and until
//! then `shortcut.unavailableMessage` says how to start a capture instead.

use serde::Serialize;

use super::rollout::Platform;
use super::session::CaptureMode;

/// How what to capture is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectionUi {
    /// Hippius's own overlay and capture bar on every display.
    Overlay,
    /// The desktop's own picker (xdg-desktop-portal on Wayland).
    SystemPicker,
}

/// The modes each kind may offer. Record's are also subject to
/// `recordingUnavailable`, as before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Modes {
    pub screenshot: Vec<CaptureMode>,
    pub recording: Vec<CaptureMode>,
}

/// How the capture shortcut is registered here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutVia {
    /// `tauri-plugin-global-shortcut` (macOS, Windows, and X11 later).
    Plugin,
    /// The GlobalShortcuts portal (KDE, GNOME 48+).
    Portal,
    /// A keyboard shortcut the user adds in the desktop's settings.
    DesktopSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSupport {
    pub supported: bool,
    pub via: ShortcutVia,
    /// Where there is no shortcut yet, what to use instead, in Rust's words;
    /// `None` where the shortcut works. Settings shows it in place of the
    /// shortcut controls.
    pub unavailable_message: Option<&'static str>,
}

/// Which Linux session this is: they capture in different ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinuxSession {
    X11,
    Wayland,
}

/// Everything the bar and Settings need to know about this platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surfaces {
    pub selection: SelectionUi,
    pub modes: Modes,
    /// Whether the screenshot timer is offered.
    pub screenshot_timer: bool,
    /// Whether a recording can carry the system's sound. The user still turns
    /// it on (`CaptureOptions::system_audio`, off by default); where this is
    /// false the bar does not offer it and a recording never asks for it.
    pub system_audio: bool,
    /// Why the microphone cannot be recorded, in Rust's words; `None` when it
    /// can. The bar shows it under the dimmed microphone row.
    pub microphone_unavailable_message: Option<&'static str>,
    pub shortcut: ShortcutSupport,
    /// With the system picker, the line that says the desktop's own tool
    /// chooses what is captured (the Capture menu and Settings show it);
    /// `None` with Hippius's overlay.
    pub system_picker_note: Option<&'static str>,
    /// `x11` or `wayland` on Linux; `None` elsewhere.
    pub linux_session: Option<LinuxSession>,
}

/// The microphone needs macOS 15 there.
pub const MIC_NEEDS_MACOS_15: &str = "Recording the microphone needs macOS 15 or later";
/// Elsewhere it comes with the platform's recorder.
pub const MIC_NOT_YET: &str = "Recording the microphone isn't available on this system yet";

/// Wayland: what the Capture menu and Settings say about the screenshot.
pub const WAYLAND_SCREENSHOT_NOTE: &str = "Your desktop's screenshot tool opens, so you can choose an area, a window or a whole screen there.";
/// Linux has no capture shortcut yet (Phase 6 of the parity plan).
pub const LINUX_SHORTCUT_NOT_YET: &str =
    "A capture shortcut isn't available on Linux yet. Use the Screenshot button in Hippius or the Capture button in the tray menu.";

const ALL_MODES: [CaptureMode; 3] = [CaptureMode::Area, CaptureMode::Window, CaptureMode::Screen];

/// What `platform` offers, given what this build can record.
#[must_use]
pub fn surfaces_for(platform: Platform, recording: bool, microphone: bool) -> Surfaces {
    let wayland = platform == Platform::LinuxWayland;
    Surfaces {
        // Wayland: no app may draw over the screen or see other windows, so
        // the desktop's own picker chooses.
        selection: if wayland { SelectionUi::SystemPicker } else { SelectionUi::Overlay },
        modes: Modes {
            // The desktop's tool offers its own area, window and screen;
            // Hippius offers none of its own there.
            screenshot: if wayland { Vec::new() } else { ALL_MODES.to_vec() },
            // The ScreenCast portal records a monitor or a window; an area
            // is not in v1 (spike L6).
            recording: if wayland {
                vec![CaptureMode::Window, CaptureMode::Screen]
            } else {
                ALL_MODES.to_vec()
            },
        },
        // The desktop's tool has its own delay, where it has one.
        screenshot_timer: !wayland,
        // ScreenCaptureKit can mix the system's sound into the one audio
        // track; the user turns it on in the bar's options.
        system_audio: platform == Platform::MacOs && recording,
        microphone_unavailable_message: match (microphone, platform) {
            (true, _) => None,
            (false, Platform::MacOs) => Some(MIC_NEEDS_MACOS_15),
            (false, _) => Some(MIC_NOT_YET),
        },
        shortcut: match platform {
            Platform::MacOs | Platform::Windows => ShortcutSupport {
                supported: true,
                via: ShortcutVia::Plugin,
                unavailable_message: None,
            },
            Platform::LinuxX11 => ShortcutSupport {
                supported: false,
                via: ShortcutVia::Plugin,
                unavailable_message: Some(LINUX_SHORTCUT_NOT_YET),
            },
            Platform::LinuxWayland => ShortcutSupport {
                supported: false,
                via: ShortcutVia::DesktopSettings,
                unavailable_message: Some(LINUX_SHORTCUT_NOT_YET),
            },
        },
        system_picker_note: wayland.then_some(WAYLAND_SCREENSHOT_NOTE),
        linux_session: match platform {
            Platform::LinuxX11 => Some(LinuxSession::X11),
            Platform::LinuxWayland => Some(LinuxSession::Wayland),
            Platform::MacOs | Platform::Windows => None,
        },
    }
}

/// How a capture starts: Hippius's overlay, or (a screenshot on Wayland)
/// straight to the desktop's screenshot tool with no Hippius window at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPlan {
    Overlay,
    SystemPicker,
}

/// The plan for a capture of `kind` with these surfaces. Recording on
/// Wayland will open the capture panel first (Phase 4), so only a
/// screenshot goes straight to the picker.
#[must_use]
pub fn start_plan(surfaces: &Surfaces, kind: super::session::CaptureKind) -> StartPlan {
    match (surfaces.selection, kind) {
        (SelectionUi::SystemPicker, super::session::CaptureKind::Screenshot) => StartPlan::SystemPicker,
        _ => StartPlan::Overlay,
    }
}

/// What this machine offers now.
#[must_use]
pub fn surfaces() -> Surfaces {
    surfaces_for(
        super::rollout::current_platform(),
        super::recording::recording_supported(),
        super::recording::microphone_supported(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the bar and Settings read.
    #[test]
    fn a_mac_that_records_serializes_for_the_frontend() {
        let v = serde_json::to_value(surfaces_for(Platform::MacOs, true, true)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "selection": "overlay",
                "modes": { "screenshot": ["area", "window", "screen"], "recording": ["area", "window", "screen"] },
                "screenshotTimer": true,
                "systemAudio": true,
                "microphoneUnavailableMessage": null,
                "shortcut": { "supported": true, "via": "plugin", "unavailableMessage": null },
                "systemPickerNote": null,
                "linuxSession": null,
            })
        );
    }

    /// The caption the bar used to hard-code is now Rust's, and it names
    /// macOS only on a Mac.
    #[test]
    fn the_microphone_line_names_the_system_it_is_on() {
        assert_eq!(
            surfaces_for(Platform::MacOs, true, false).microphone_unavailable_message,
            Some("Recording the microphone needs macOS 15 or later")
        );
        for platform in [Platform::Windows, Platform::LinuxX11, Platform::LinuxWayland] {
            let line = surfaces_for(platform, false, false).microphone_unavailable_message.unwrap();
            assert!(!line.contains("macOS"), "{platform:?}: {line}");
        }
    }

    /// Every platform that can draw over the screen keeps the overlay,
    /// every mode and the timer; only the shortcut and system audio differ.
    #[test]
    fn every_platform_but_wayland_keeps_the_overlay_and_every_mode() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            let s = surfaces_for(platform, false, false);
            assert_eq!(s.selection, SelectionUi::Overlay);
            assert_eq!(s.modes.screenshot, ALL_MODES);
            assert_eq!(s.modes.recording, ALL_MODES);
            assert!(s.screenshot_timer);
            assert!(s.system_picker_note.is_none());
            assert!(!s.system_audio, "{platform:?} records no system audio without recording");
        }
        assert!(surfaces_for(Platform::Windows, false, false).shortcut.supported);
        assert!(!surfaces_for(Platform::LinuxX11, false, false).shortcut.supported);
    }

    /// Wayland: the desktop's screenshot tool chooses, so Hippius offers no
    /// mode and no timer for a screenshot, and says why in its own words.
    #[test]
    fn wayland_hands_the_choice_to_the_desktop() {
        let s = surfaces_for(Platform::LinuxWayland, false, false);
        assert_eq!(s.selection, SelectionUi::SystemPicker);
        assert!(s.modes.screenshot.is_empty());
        assert_eq!(s.modes.recording, [CaptureMode::Window, CaptureMode::Screen], "no area recording in v1");
        assert!(!s.screenshot_timer);
        assert_eq!(s.system_picker_note, Some(WAYLAND_SCREENSHOT_NOTE));
        assert_eq!(s.linux_session, Some(LinuxSession::Wayland));
        assert_eq!(surfaces_for(Platform::LinuxX11, false, false).linux_session, Some(LinuxSession::X11));
        assert_eq!(surfaces_for(Platform::MacOs, true, true).linux_session, None);
    }

    /// Only a Wayland screenshot skips the overlay: X11 draws its own, and a
    /// Wayland recording will open the capture panel first.
    #[test]
    fn only_a_wayland_screenshot_goes_straight_to_the_picker() {
        use crate::capture::session::CaptureKind::{Recording, Screenshot};
        let wayland = surfaces_for(Platform::LinuxWayland, false, false);
        assert_eq!(start_plan(&wayland, Screenshot), StartPlan::SystemPicker);
        assert_eq!(start_plan(&wayland, Recording), StartPlan::Overlay);
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            let s = surfaces_for(platform, true, true);
            assert_eq!(start_plan(&s, Screenshot), StartPlan::Overlay, "{platform:?}");
        }
    }

    /// Linux has no capture shortcut yet; Settings shows what to use
    /// instead rather than a shortcut that would never fire.
    #[test]
    fn where_there_is_no_shortcut_settings_is_told_what_to_use() {
        for platform in [Platform::LinuxX11, Platform::LinuxWayland] {
            let shortcut = surfaces_for(platform, false, false).shortcut;
            assert!(!shortcut.supported);
            assert_eq!(shortcut.unavailable_message, Some(LINUX_SHORTCUT_NOT_YET));
        }
        for platform in [Platform::MacOs, Platform::Windows] {
            assert_eq!(surfaces_for(platform, false, false).shortcut.unavailable_message, None);
        }
        let v = serde_json::to_value(surfaces_for(Platform::LinuxWayland, false, false)).unwrap();
        assert_eq!(v["selection"], "systemPicker");
        assert_eq!(v["linuxSession"], "wayland");
        assert_eq!(v["shortcut"]["unavailableMessage"], LINUX_SHORTCUT_NOT_YET);
    }
}
