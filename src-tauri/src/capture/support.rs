//! What the capture surfaces may offer on this platform, decided in Rust so
//! the frontend never checks the platform itself (CLAUDE.md). Flattened into
//! both `capture_support` and the overlay's `OverlayContext`.
//!
//! macOS, Windows and Linux on X11 use the overlay, offer every mode and the
//! screenshot timer. Wayland cannot draw over the screen, so a screenshot
//! there is the desktop's own screenshot tool (`SystemPicker`): Hippius
//! offers no mode and no timer, and says so in `systemPickerNote`. A
//! Wayland recording opens the capture bar alone in a small window (the
//! panel: sources, window or screen, options) and Record hands the choice
//! to the desktop's screen-sharing dialog; its countdown runs in the pill
//! once the dialog is answered. The shortcut is the plugin's on macOS,
//! Windows and X11; on Wayland it is the GlobalShortcuts portal's where the
//! desktop has one, and elsewhere `shortcut.unavailableMessage` and
//! `shortcut.command` tell the user what to bind in the desktop's settings
//! ([`shortcut_for`]).
//!
//! A Wayland area recording is drawn after the dialog, on a picture of the
//! monitor the user chose (`area_pick`), so Area is offered there wherever
//! Wayland records. Camera only on Wayland has no window to film: the
//! recorder opens the camera itself ([`camera_by_recorder`]), offered only
//! where the probe found what that needs.

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
    /// `tauri-plugin-global-shortcut` (macOS, Windows, Linux on X11).
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
    /// Where Hippius cannot set the shortcut itself, what to do instead, in
    /// Rust's words; `None` where the shortcut works. Settings shows it in
    /// place of the shortcut controls.
    pub unavailable_message: Option<&'static str>,
    /// With `desktopSettings`, the command a shortcut in the desktop's own
    /// keyboard settings runs (`<this app> --capture`); `None` otherwise.
    pub command: Option<&'static str>,
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
    /// Whether the recording countdown is offered (everywhere).
    pub record_countdown: bool,
    /// Whether it counts in the pill once the desktop's dialog is answered,
    /// rather than on the overlay before Record (the system picker: a count
    /// before the dialog would end at a dialog, not at the recording).
    pub countdown_after_picker: bool,
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
    /// How the Record shortcut works here ([`record_shortcut_for`]).
    pub record_shortcut: ShortcutSupport,
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
/// The checks that bring an iPhone into the menus (Continuity Camera's own
/// requirements), and that it takes a moment to arrive.
pub const CONTINUITY_HINT: &str =
    "iPhone not listed? Keep it close by, signed in to the same Apple Account, with Wi-Fi and Bluetooth on. It can take a few seconds to appear.";

/// Wayland: what the Capture menu and Settings say about the screenshot.
pub const WAYLAND_SCREENSHOT_NOTE: &str = "Your desktop's screenshot tool opens, so you can choose an area, a window or a whole screen there.";

/// Windows records it, but its privacy settings keep desktop apps from it.
pub const MIC_BLOCKED_WINDOWS: &str =
    "Windows is blocking the microphone. Turn on microphone access for desktop apps in Settings, Privacy & security, Microphone.";

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
            // is a monitor cropped to what is drawn on its picture after the
            // dialog (`area_pick`), so it needs only a recorder.
            recording: if wayland && !recording {
                vec![CaptureMode::Window, CaptureMode::Screen]
            } else {
                ALL_MODES.to_vec()
            },
        },
        // The desktop's tool has its own delay, where it has one.
        screenshot_timer: !wayland,
        record_countdown: true,
        countdown_after_picker: wayland,
        // ScreenCaptureKit (macOS), WASAPI loopback (Windows) and the
        // default output's monitor (Linux) can mix the system's sound into
        // the one audio track; the user turns it on in the bar's options.
        system_audio: recording,
        microphone_unavailable_message: match (microphone, platform) {
            (true, _) => None,
            (false, Platform::MacOs) => Some(MIC_NEEDS_MACOS_15),
            (false, _) => Some(MIC_NOT_YET),
        },
        continuity_hint: (platform == Platform::MacOs).then_some(CONTINUITY_HINT),
        shortcut: shortcut_for(platform, super::shortcut_portal::PortalStatus::Missing),
        record_shortcut: record_shortcut_for(platform),
        system_picker_note: wayland.then_some(WAYLAND_SCREENSHOT_NOTE),
        linux_session: match platform {
            Platform::LinuxX11 => Some(LinuxSession::X11),
            Platform::LinuxWayland => Some(LinuxSession::Wayland),
            Platform::MacOs | Platform::Windows => None,
        },
    }
}

/// How the capture shortcut works on `platform`, given whether a Wayland
/// session has the GlobalShortcuts portal: the plugin's key grab everywhere
/// but Wayland; there the portal where it answers, else a shortcut the
/// user adds in the desktop's keyboard settings, running [`ShortcutSupport::command`].
#[must_use]
pub fn shortcut_for(platform: Platform, portal: super::shortcut_portal::PortalStatus) -> ShortcutSupport {
    match platform {
        Platform::MacOs | Platform::Windows | Platform::LinuxX11 => ShortcutSupport {
            supported: true,
            via: ShortcutVia::Plugin,
            unavailable_message: None,
            command: None,
        },
        Platform::LinuxWayland if portal.available() => ShortcutSupport {
            supported: true,
            via: ShortcutVia::Portal,
            unavailable_message: None,
            command: None,
        },
        Platform::LinuxWayland => ShortcutSupport {
            supported: false,
            via: ShortcutVia::DesktopSettings,
            unavailable_message: Some(super::desktop_shortcut::DESKTOP_SETTINGS_LINE),
            command: Some(super::desktop_shortcut::command()),
        },
    }
}

/// How the Record shortcut works on `platform`: the plugin's key grab
/// wherever the screenshot shortcut has it. On Wayland always a shortcut
/// the user adds in the desktop's keyboard settings, running
/// `<this app> --record`: the portal session binds only the screenshot
/// shortcut, and that command works on every Wayland desktop.
#[must_use]
pub fn record_shortcut_for(platform: Platform) -> ShortcutSupport {
    match platform {
        Platform::MacOs | Platform::Windows | Platform::LinuxX11 => ShortcutSupport {
            supported: true,
            via: ShortcutVia::Plugin,
            unavailable_message: None,
            command: None,
        },
        Platform::LinuxWayland => ShortcutSupport {
            supported: false,
            via: ShortcutVia::DesktopSettings,
            unavailable_message: Some(super::desktop_shortcut::RECORD_DESKTOP_SETTINGS_LINE),
            command: Some(super::desktop_shortcut::record_command()),
        },
    }
}

/// Whether `platform` can record the camera alone. Everywhere but Wayland
/// the stage window is filmed by its window id; Wayland gives an app no
/// window ids (and the portal's dialog would make the user pick Hippius's
/// own window), so there the recorder opens the camera itself
/// ([`camera_by_recorder`]) and camera only is offered when
/// `recorder_camera` says this machine has what that needs.
#[must_use]
pub const fn camera_only(platform: Platform, recorder_camera: bool) -> bool {
    match platform {
        Platform::LinuxWayland => recorder_camera,
        Platform::MacOs | Platform::Windows | Platform::LinuxX11 => true,
    }
}

/// Whether camera only on `platform` is recorded by the recorder opening
/// the camera (GStreamer, by the device the bubble showed) rather than by
/// filming the stage window. The stage page lets go of the camera first:
/// one owner per device.
#[must_use]
pub const fn camera_by_recorder(platform: Platform) -> bool {
    matches!(platform, Platform::LinuxWayland)
}

/// Whether the recording pill is filmed with the screen on `platform`:
/// Linux has no content protection (X11 cannot keep a window out of a
/// grab, Wayland's screen-sharing stream is the compositor's). The pill
/// stays small there and says so once ([`PILL_FILMED_NOTE`]).
#[must_use]
pub const fn pill_filmed(platform: Platform) -> bool {
    matches!(platform, Platform::LinuxX11 | Platform::LinuxWayland)
}

/// The pill's one-time line where it is filmed. Two short lines, sized for
/// the 380 pt pill.
pub const PILL_FILMED_NOTE: &str = "These controls show in screen recordings. They stay small; point at them to use them.";

/// How a capture starts: Hippius's overlay, or (a screenshot on Wayland)
/// straight to the desktop's screenshot tool with no Hippius window at all,
/// or (a recording on Wayland) the capture bar alone in a small window
/// whose Record opens the desktop's screen-sharing dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPlan {
    Overlay,
    SystemPicker,
    Panel,
}

/// The plan for a capture of `kind` with these surfaces.
#[must_use]
pub fn start_plan(surfaces: &Surfaces, kind: super::session::CaptureKind) -> StartPlan {
    match (surfaces.selection, kind) {
        (SelectionUi::SystemPicker, super::session::CaptureKind::Screenshot) => StartPlan::SystemPicker,
        (SelectionUi::SystemPicker, super::session::CaptureKind::Recording) => StartPlan::Panel,
        (SelectionUi::Overlay, _) => StartPlan::Overlay,
    }
}

/// The display id the panel's one window uses. Hippius sees no displays on
/// Wayland; the panel is not a display's overlay, and the recorder ignores
/// the id (the desktop's dialog chooses).
pub const PANEL_DISPLAY_ID: u32 = 0;

/// What Record in the panel asks the recorder for: a window or a whole
/// screen, chosen in the desktop's dialog, or an area, which is a screen
/// chosen there and then drawn on its picture (`area_pick`); its rectangle
/// is empty until then. The ids mean nothing there; only which kind of
/// selection it is reaches the portal.
#[must_use]
pub fn system_picker_selection(mode: CaptureMode) -> super::screenshot::Selection {
    match mode {
        CaptureMode::Window => super::screenshot::Selection::Window { window_id: 0 },
        CaptureMode::Area => super::screenshot::Selection::Area {
            display_id: PANEL_DISPLAY_ID,
            rect: super::geometry::LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        },
        CaptureMode::Screen => super::screenshot::Selection::Screen {
            display_id: PANEL_DISPLAY_ID,
        },
    }
}

/// Whether a recording of `selection` with these surfaces draws its area
/// after the desktop's dialog (`pickArea`): an area through the system
/// picker. Everywhere else the area was drawn on the overlay already.
#[must_use]
pub fn picks_area_after_dialog(surfaces: &Surfaces, selection: super::screenshot::Selection) -> bool {
    surfaces.selection == SelectionUi::SystemPicker && matches!(selection, super::screenshot::Selection::Area { .. })
}

/// `mode` if these surfaces offer it for `kind`, else what they do offer
/// (the whole screen first): a mode remembered from another session (an
/// area drawn on X11) must not open a Wayland panel on a mode it lacks.
#[must_use]
pub fn offered_mode(surfaces: &Surfaces, kind: super::session::CaptureKind, mode: CaptureMode) -> CaptureMode {
    let offered = match kind {
        super::session::CaptureKind::Screenshot => &surfaces.modes.screenshot,
        super::session::CaptureKind::Recording => &surfaces.modes.recording,
    };
    if offered.is_empty() || offered.contains(&mode) {
        return mode;
    }
    if offered.contains(&CaptureMode::Screen) {
        CaptureMode::Screen
    } else {
        offered[0]
    }
}

/// The countdown the overlay runs before it confirms a capture of `kind`:
/// the saved one, except where these surfaces offer none or count in the
/// pill after the desktop's dialog instead.
#[must_use]
pub fn countdown_secs(surfaces: &Surfaces, saved: u8, kind: super::session::CaptureKind) -> u8 {
    match kind {
        super::session::CaptureKind::Recording if !surfaces.record_countdown || surfaces.countdown_after_picker => 0,
        _ => saved,
    }
}

/// The countdown the pill runs once the desktop's dialog is answered: the
/// saved one with the system picker, none elsewhere (the overlay counted).
#[must_use]
pub fn countdown_after_picker(surfaces: &Surfaces, saved: u8, kind: super::session::CaptureKind) -> u8 {
    match kind {
        super::session::CaptureKind::Recording if surfaces.record_countdown && surfaces.countdown_after_picker => saved,
        _ => 0,
    }
}

/// What this machine offers now.
#[must_use]
pub fn surfaces() -> Surfaces {
    let platform = super::rollout::current_platform();
    let recording = super::recording::recording_supported();
    let mut surfaces = surfaces_for(platform, recording, super::recording::microphone_supported());
    surfaces.shortcut = shortcut_for(platform, super::shortcut_portal::status());
    if let Some(line) = microphone_blocked_line(platform, recording, || {
        super::permissions::windows_privacy_blocks(super::permissions::PrivacyDevice::Microphone)
    }) {
        surfaces.microphone_unavailable_message = Some(line);
    }
    surfaces
}

/// Where Windows records but its privacy settings block the microphone, the
/// mic row says so (and what to switch on) instead of "not available".
fn microphone_blocked_line(platform: Platform, recording: bool, blocked: impl FnOnce() -> bool) -> Option<&'static str> {
    (platform == Platform::Windows && recording && blocked()).then_some(MIC_BLOCKED_WINDOWS)
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
                "recordCountdown": true,
                "countdownAfterPicker": false,
                "systemAudio": true,
                "microphoneUnavailableMessage": null,
                "continuityHint": CONTINUITY_HINT,
                "shortcut": { "supported": true, "via": "plugin", "unavailableMessage": null, "command": null },
                "recordShortcut": { "supported": true, "via": "plugin", "unavailableMessage": null, "command": null },
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

    /// Every platform that records offers the system's sound; a Windows
    /// whose privacy settings block the microphone says so and how to fix it.
    #[test]
    fn windows_offers_system_audio_and_names_a_blocked_microphone() {
        for platform in Platform::ALL {
            assert!(surfaces_for(platform, true, true).system_audio, "{platform:?}");
            assert!(!surfaces_for(platform, false, true).system_audio, "{platform:?} without a recorder");
        }
        assert_eq!(microphone_blocked_line(Platform::Windows, true, || true), Some(MIC_BLOCKED_WINDOWS));
        assert_eq!(microphone_blocked_line(Platform::Windows, true, || false), None);
        assert_eq!(
            microphone_blocked_line(Platform::Windows, false, || true),
            None,
            "no recorder, no mic line"
        );
        assert_eq!(microphone_blocked_line(Platform::MacOs, true, || true), None);
        assert!(!MIC_BLOCKED_WINDOWS.contains('\u{2014}'), "no em dashes in Rust's copy");
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
        assert!(surfaces_for(Platform::LinuxX11, false, false).shortcut.supported);
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

    /// Wayland: the desktop's screenshot tool chooses, so Hippius offers no
    /// mode and no timer for a screenshot, and says why in its own words.
    #[test]
    fn wayland_hands_the_choice_to_the_desktop() {
        let s = surfaces_for(Platform::LinuxWayland, false, false);
        assert_eq!(s.selection, SelectionUi::SystemPicker);
        assert!(s.modes.screenshot.is_empty());
        assert_eq!(
            s.modes.recording,
            [CaptureMode::Window, CaptureMode::Screen],
            "no recorder, no area to crop"
        );
        assert_eq!(
            surfaces_for(Platform::LinuxWayland, true, true).modes.recording,
            ALL_MODES,
            "an area is a monitor cropped after the dialog"
        );
        assert!(!s.screenshot_timer);
        assert_eq!(s.system_picker_note, Some(WAYLAND_SCREENSHOT_NOTE));
        assert_eq!(s.linux_session, Some(LinuxSession::Wayland));
        assert_eq!(surfaces_for(Platform::LinuxX11, false, false).linux_session, Some(LinuxSession::X11));
        assert_eq!(surfaces_for(Platform::MacOs, true, true).linux_session, None);
    }

    /// Only Wayland skips the overlay: a screenshot goes straight to the
    /// desktop's tool, a recording to the panel. X11 draws its own overlay.
    #[test]
    fn wayland_goes_to_the_picker_or_the_panel() {
        use crate::capture::session::CaptureKind::{Recording, Screenshot};
        let wayland = surfaces_for(Platform::LinuxWayland, true, true);
        assert_eq!(start_plan(&wayland, Screenshot), StartPlan::SystemPicker);
        assert_eq!(start_plan(&wayland, Recording), StartPlan::Panel);
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            let s = surfaces_for(platform, true, true);
            assert_eq!(start_plan(&s, Screenshot), StartPlan::Overlay, "{platform:?}");
            assert_eq!(start_plan(&s, Recording), StartPlan::Overlay, "{platform:?}");
        }
    }

    /// The panel's Record asks the recorder for a window, a screen or an
    /// area (a screen whose area is drawn after the dialog); the desktop's
    /// dialog picks which. The countdown runs after the dialog (and the
    /// area), in the pill: a count before a dialog would end at the dialog.
    #[test]
    fn the_panel_asks_for_a_window_or_a_screen_without_a_countdown() {
        use crate::capture::screenshot::Selection;
        use crate::capture::session::CaptureKind::{Recording, Screenshot};
        assert_eq!(system_picker_selection(CaptureMode::Window), Selection::Window { window_id: 0 });
        assert_eq!(
            system_picker_selection(CaptureMode::Screen),
            Selection::Screen {
                display_id: PANEL_DISPLAY_ID
            }
        );
        let area = system_picker_selection(CaptureMode::Area);
        assert!(
            matches!(
                area,
                Selection::Area {
                    display_id: PANEL_DISPLAY_ID,
                    ..
                }
            ),
            "{area:?}"
        );
        let wayland = surfaces_for(Platform::LinuxWayland, true, true);
        assert!(picks_area_after_dialog(&wayland, area));
        assert!(!picks_area_after_dialog(&wayland, system_picker_selection(CaptureMode::Screen)));
        assert!(
            !picks_area_after_dialog(&surfaces_for(Platform::LinuxX11, true, true), area),
            "X11 draws its area on the overlay"
        );
        assert!(wayland.record_countdown, "offered: it counts in the pill");
        assert!(wayland.countdown_after_picker);
        assert_eq!(countdown_secs(&wayland, 3, Recording), 0, "nothing counts before the dialog");
        assert_eq!(countdown_after_picker(&wayland, 3, Recording), 3, "the pill counts after it");
        assert_eq!(countdown_secs(&wayland, 5, Screenshot), 5);
        assert_eq!(countdown_after_picker(&wayland, 5, Screenshot), 0);
        let x11 = surfaces_for(Platform::LinuxX11, true, true);
        assert!(x11.record_countdown);
        assert!(!x11.countdown_after_picker);
        assert_eq!(countdown_secs(&x11, 3, Recording), 3);
        assert_eq!(countdown_after_picker(&x11, 3, Recording), 0, "the overlay already counted");
    }

    /// A remembered area opens a Wayland recording that cannot crop on the
    /// whole screen; an offered mode is kept, and a kind with no modes of
    /// its own (Wayland's screenshot, the desktop's tool) is left as it was.
    #[test]
    fn a_mode_this_platform_lacks_falls_back_to_one_it_offers() {
        use crate::capture::session::CaptureKind::{Recording, Screenshot};
        let no_recorder = surfaces_for(Platform::LinuxWayland, false, false);
        assert_eq!(offered_mode(&no_recorder, Recording, CaptureMode::Area), CaptureMode::Screen);
        let wayland = surfaces_for(Platform::LinuxWayland, true, true);
        assert_eq!(offered_mode(&wayland, Recording, CaptureMode::Area), CaptureMode::Area);
        assert_eq!(offered_mode(&wayland, Recording, CaptureMode::Window), CaptureMode::Window);
        assert_eq!(offered_mode(&wayland, Screenshot, CaptureMode::Area), CaptureMode::Area);
        let x11 = surfaces_for(Platform::LinuxX11, true, true);
        assert_eq!(offered_mode(&x11, Recording, CaptureMode::Area), CaptureMode::Area);
    }

    /// Only Linux films the pill (no content protection), so only there it
    /// stays small and says so once; no em dash in the line.
    #[test]
    fn only_linux_films_the_pill() {
        assert!(!pill_filmed(Platform::MacOs));
        assert!(!pill_filmed(Platform::Windows));
        assert!(pill_filmed(Platform::LinuxX11));
        assert!(pill_filmed(Platform::LinuxWayland));
        assert!(!PILL_FILMED_NOTE.contains('\u{2014}'));
        assert!(PILL_FILMED_NOTE.len() < 100, "two short lines in the pill");
    }

    /// Camera only records the stage window by its id where there is one;
    /// Wayland has none, so there the recorder opens the camera, and camera
    /// only is offered only when this machine can do that.
    #[test]
    fn camera_only_films_the_stage_or_opens_the_camera_in_the_recorder() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            assert!(camera_only(platform, false), "{platform:?} films the stage");
            assert!(!camera_by_recorder(platform), "{platform:?}");
        }
        assert!(camera_only(Platform::LinuxWayland, true));
        assert!(!camera_only(Platform::LinuxWayland, false), "no camera source or decoder: not offered");
        assert!(camera_by_recorder(Platform::LinuxWayland));
    }

    /// The shortcut per platform: the plugin's key grab on macOS, Windows
    /// and X11; on Wayland the portal where the desktop has it, and the
    /// desktop's own keyboard settings (with the command to bind) where it
    /// does not or has not answered yet.
    #[test]
    fn each_session_gets_the_shortcut_route_that_works_there() {
        use crate::capture::shortcut_portal::PortalStatus;
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            let s = shortcut_for(platform, PortalStatus::Missing);
            assert!(s.supported, "{platform:?}");
            assert_eq!(s.via, ShortcutVia::Plugin, "{platform:?}");
            assert_eq!(s.unavailable_message, None);
            assert_eq!(s.command, None);
        }
        let portal = shortcut_for(Platform::LinuxWayland, PortalStatus::Available { configurable: true });
        assert!(portal.supported);
        assert_eq!(portal.via, ShortcutVia::Portal);
        assert_eq!(portal.command, None);
        for status in [PortalStatus::Missing, PortalStatus::Unknown] {
            let s = shortcut_for(Platform::LinuxWayland, status);
            assert!(!s.supported, "{status:?}");
            assert_eq!(s.via, ShortcutVia::DesktopSettings);
            assert_eq!(s.unavailable_message, Some(crate::capture::desktop_shortcut::DESKTOP_SETTINGS_LINE));
            assert!(s.command.is_some_and(|c| c.ends_with(" --capture")), "{s:?}");
        }
        let v = serde_json::to_value(surfaces_for(Platform::LinuxWayland, false, false)).unwrap();
        assert_eq!(v["selection"], "systemPicker");
        assert_eq!(v["linuxSession"], "wayland");
        assert_eq!(v["shortcut"]["via"], "desktopSettings");
        assert!(v["shortcut"]["command"].as_str().is_some_and(|c| c.ends_with(" --capture")));
    }

    /// The Record shortcut goes where the screenshot one does, except on
    /// Wayland, where it is always the desktop's keyboard settings with its
    /// own command: the portal session binds only the screenshot shortcut.
    #[test]
    fn the_record_shortcut_route_mirrors_the_screenshot_ones() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            assert_eq!(
                record_shortcut_for(platform),
                shortcut_for(platform, crate::capture::shortcut_portal::PortalStatus::Missing),
                "{platform:?}"
            );
        }
        let wayland = record_shortcut_for(Platform::LinuxWayland);
        assert!(!wayland.supported);
        assert_eq!(wayland.via, ShortcutVia::DesktopSettings);
        assert_eq!(
            wayland.unavailable_message,
            Some(crate::capture::desktop_shortcut::RECORD_DESKTOP_SETTINGS_LINE)
        );
        assert!(wayland.command.is_some_and(|c| c.ends_with(" --record")), "{wayland:?}");
        let v = serde_json::to_value(surfaces_for(Platform::LinuxWayland, true, true)).unwrap();
        assert_eq!(v["recordShortcut"]["via"], "desktopSettings");
    }
}
