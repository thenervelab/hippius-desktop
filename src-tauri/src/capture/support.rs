//! What the capture surfaces may offer on this platform, decided in Rust so
//! the frontend never checks the platform itself (CLAUDE.md). Flattened into
//! both `capture_support` and the overlay's `OverlayContext`.
//!
//! Today every platform that captures uses the overlay, offers every mode
//! and the screenshot timer, and registers its shortcut through the plugin.
//! Wayland (a system picker, no screenshot timer, a portal or desktop
//! setting for the shortcut) fills in the other values in later phases of
//! `docs/plans/2026-10-01-capture-windows-linux.md`.

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
    /// What to check when an iPhone is not in the camera or microphone menu,
    /// shown under a menu that lists no Continuity device; `None` where
    /// phones are not offered that way (Continuity is macOS only).
    pub continuity_hint: Option<&'static str>,
    pub shortcut: ShortcutSupport,
}

/// The microphone needs macOS 15 there.
pub const MIC_NEEDS_MACOS_15: &str = "Recording the microphone needs macOS 15 or later";
/// Elsewhere it comes with the platform's recorder.
pub const MIC_NOT_YET: &str = "Recording the microphone isn't available on this system yet";
/// The checks that bring an iPhone into the menus (Continuity Camera's own
/// requirements), and that it takes a moment to arrive.
pub const CONTINUITY_HINT: &str =
    "iPhone not listed? Keep it close by, signed in to the same Apple Account, with Wi-Fi and Bluetooth on. It can take a few seconds to appear.";

const ALL_MODES: [CaptureMode; 3] = [CaptureMode::Area, CaptureMode::Window, CaptureMode::Screen];

/// What `platform` offers, given what this build can record.
#[must_use]
pub fn surfaces_for(platform: Platform, recording: bool, microphone: bool) -> Surfaces {
    Surfaces {
        selection: SelectionUi::Overlay,
        modes: Modes {
            screenshot: ALL_MODES.to_vec(),
            recording: ALL_MODES.to_vec(),
        },
        screenshot_timer: true,
        // ScreenCaptureKit can mix the system's sound into the one audio
        // track; the user turns it on in the bar's options.
        system_audio: platform == Platform::MacOs && recording,
        microphone_unavailable_message: match (microphone, platform) {
            (true, _) => None,
            (false, Platform::MacOs) => Some(MIC_NEEDS_MACOS_15),
            (false, _) => Some(MIC_NOT_YET),
        },
        continuity_hint: (platform == Platform::MacOs).then_some(CONTINUITY_HINT),
        shortcut: match platform {
            Platform::MacOs | Platform::Windows => ShortcutSupport {
                supported: true,
                via: ShortcutVia::Plugin,
            },
            Platform::LinuxX11 => ShortcutSupport {
                supported: false,
                via: ShortcutVia::Plugin,
            },
            Platform::LinuxWayland => ShortcutSupport {
                supported: false,
                via: ShortcutVia::DesktopSettings,
            },
        },
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
                "continuityHint": CONTINUITY_HINT,
                "shortcut": { "supported": true, "via": "plugin" },
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

    /// No behaviour change yet: every platform keeps the overlay, every mode
    /// and the timer; only the shortcut and system audio differ.
    #[test]
    fn today_every_platform_keeps_the_overlay_and_every_mode() {
        for platform in Platform::ALL {
            let s = surfaces_for(platform, false, false);
            assert_eq!(s.selection, SelectionUi::Overlay);
            assert_eq!(s.modes.screenshot, ALL_MODES);
            assert_eq!(s.modes.recording, ALL_MODES);
            assert!(s.screenshot_timer);
            assert!(!s.system_audio, "{platform:?} records no system audio without recording");
        }
        assert!(surfaces_for(Platform::Windows, false, false).shortcut.supported);
        assert!(!surfaces_for(Platform::LinuxX11, false, false).shortcut.supported);
    }

    /// The iPhone hint is a Mac's alone: Windows and Linux have no
    /// Continuity, and the hint names checks that only apply to it.
    #[test]
    fn only_a_mac_offers_the_iphone_hint() {
        assert_eq!(surfaces_for(Platform::MacOs, true, true).continuity_hint, Some(CONTINUITY_HINT));
        for platform in [Platform::Windows, Platform::LinuxX11, Platform::LinuxWayland] {
            assert_eq!(surfaces_for(platform, true, true).continuity_hint, None, "{platform:?}");
        }
        assert!(!CONTINUITY_HINT.contains('\u{2014}'), "no em dashes in user copy");
    }
}
