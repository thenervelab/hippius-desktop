//! The menu bar's part in a recording, as macOS's own recording does it: the
//! elapsed time beside the Hippius icon while a recording runs, and a click
//! on the icon opens the popover and brings the recording's controls back.
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

/// Whether `phase` is a recording that is running or paused: the one time a
/// tray click also brings the recording's pill back.
#[must_use]
pub fn recording_running(phase: CapturePhase) -> bool {
    matches!(phase, CapturePhase::Recording { .. } | CapturePhase::Paused { .. })
}

/// Where a left click on the tray icon goes, all things considered. Rust
/// receives the click itself (`tray::panel::on_tray_icon_event`); it used to
/// arrive through a callback the main window's webview registered when it
/// made the icon, and a reload of that webview left the icon clicking into
/// nothing, so the popover stopped opening.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayClickRoute {
    /// Signed out while a recording runs: only its pill comes back (the
    /// popover has nothing to show, and the pill must never be unreachable).
    ShowRecordingControls,
    /// Nobody is signed in: the popover has nothing to show, so the main
    /// window comes forward on its sign-in screen.
    OpenMainWindow,
    /// The popover opens (or closes, if it is open). `recording`: a
    /// recording is running or paused, so its pill comes back as well and
    /// the popover is kept out of the video.
    TogglePanel { recording: bool },
}

impl TrayClickRoute {
    /// Whether this click brings the recording's pill back (without focus).
    #[must_use]
    pub fn shows_recording_controls(self) -> bool {
        matches!(self, Self::ShowRecordingControls | Self::TogglePanel { recording: true })
    }
}

/// The route for a left click. A signed-in click ALWAYS reaches the
/// popover, whatever the capture is doing: the popover is where Stop is not,
/// but everything else is, and routing a recording's click to the pill alone
/// left the menu bar icon doing nothing visible for the whole recording (the
/// pill was already on screen). A recording adds its pill to the popover; a
/// signed-out click opens the app, or only the pill mid-recording.
#[must_use]
pub fn tray_click_route(signed_in: bool, phase: CapturePhase) -> TrayClickRoute {
    let recording = recording_running(phase);
    match (signed_in, recording) {
        (true, recording) => TrayClickRoute::TogglePanel { recording },
        (false, true) => TrayClickRoute::ShowRecordingControls,
        (false, false) => TrayClickRoute::OpenMainWindow,
    }
}

/// The mark drawn on the tray icon while a recording runs (plan XP-15).
/// Windows shows no text beside a tray icon, so without it nothing on the
/// taskbar said a recording was running; macOS and Linux show the time as
/// the title and keep their icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayGlyph {
    /// The app's own icon, whatever the main window last set.
    None,
    /// A red dot: recording.
    Recording,
    /// An amber dot: paused.
    Paused,
}

/// Whether this system marks the tray icon itself (Windows only: the
/// others carry the time as the title).
pub const TRAY_ICON_MARKS_RECORDING: bool = cfg!(windows);

#[must_use]
pub fn tray_glyph_for(phase: CapturePhase) -> TrayGlyph {
    match phase {
        CapturePhase::Recording { .. } => TrayGlyph::Recording,
        CapturePhase::Paused { .. } => TrayGlyph::Paused,
        _ => TrayGlyph::None,
    }
}

/// The glyph a written text stands for, so the last write says which mark
/// is on the icon now (the title is `tray_title_for`'s, so its first
/// character names the phase).
#[must_use]
pub fn tray_glyph_of(text: &TrayText) -> TrayGlyph {
    if text.title.starts_with('◼') {
        TrayGlyph::Recording
    } else if text.title.starts_with('❚') {
        TrayGlyph::Paused
    } else {
        TrayGlyph::None
    }
}

/// What to do to the tray icon after a write that moves it from `was` to
/// `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconWrite {
    /// Leave the icon alone.
    Keep,
    /// Draw the mark. Done on every write while recording (once a second),
    /// so a sync icon the main window swaps in mid-recording is covered
    /// again within a second.
    Mark(TrayGlyph),
    /// The recording is over: put the app's icon back and let the main
    /// window re-apply its own (syncing, synced) icon.
    Release,
}

#[must_use]
pub fn icon_write(was: TrayGlyph, now: TrayGlyph) -> IconWrite {
    match (was, now) {
        (_, TrayGlyph::Recording | TrayGlyph::Paused) => IconWrite::Mark(now),
        (TrayGlyph::None, TrayGlyph::None) => IconWrite::Keep,
        (_, TrayGlyph::None) => IconWrite::Release,
    }
}

/// The side of the square the marked icon is drawn at: big enough for a
/// 200 % taskbar (32 px), small enough to rebuild nothing per second.
pub const GLYPH_ICON_SIZE: u32 = 64;

/// The app's tray icon (`base`, any size, RGBA) fitted into a
/// [`GLYPH_ICON_SIZE`] square, with a dot in the bottom-right corner for
/// `glyph` (red recording, amber paused), ringed in white so it reads on a
/// dark and a light taskbar. `None` for [`TrayGlyph::None`].
#[must_use]
pub fn marked_icon(base: &image::RgbaImage, glyph: TrayGlyph) -> Option<image::RgbaImage> {
    let fill = match glyph {
        TrayGlyph::None => return None,
        // The pill's own colours (#FF453A, amber-400).
        TrayGlyph::Recording => image::Rgba([0xFF, 0x45, 0x3A, 0xFF]),
        TrayGlyph::Paused => image::Rgba([0xFB, 0xBF, 0x24, 0xFF]),
    };
    let size = GLYPH_ICON_SIZE;
    let mut icon = image::RgbaImage::new(size, size);
    if base.width() > 0 && base.height() > 0 {
        // Fitted inside the square with its aspect kept, then centred.
        let scale = f64::from(size) / f64::from(base.width().max(base.height()));
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let (w, h) = (
            ((f64::from(base.width()) * scale).round() as u32).clamp(1, size),
            ((f64::from(base.height()) * scale).round() as u32).clamp(1, size),
        );
        let fitted = image::imageops::resize(base, w, h, image::imageops::FilterType::Triangle);
        image::imageops::overlay(&mut icon, &fitted, i64::from((size - w) / 2), i64::from((size - h) / 2));
    }
    let radius = f64::from(size) * 0.22;
    let ring = radius + f64::from(size) * 0.05;
    let centre = f64::from(size) - ring - 0.5;
    let white = image::Rgba([0xFF, 0xFF, 0xFF, 0xFF]);
    for y in 0..size {
        for x in 0..size {
            let d = (f64::from(x) - centre).hypot(f64::from(y) - centre);
            if d <= radius {
                icon.put_pixel(x, y, fill);
            } else if d <= ring {
                icon.put_pixel(x, y, white);
            }
        }
    }
    Some(icon)
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

    /// The popover never opened during a recording: the click went to the
    /// pill alone, which was already on screen, so the icon looked dead.
    /// A signed-in click reaches the popover in every phase; a recording only
    /// adds its pill.
    #[test]
    fn a_signed_in_click_opens_the_popover_even_while_recording() {
        for phase in [RECORDING, PAUSED] {
            let route = tray_click_route(true, phase);
            assert_eq!(route, TrayClickRoute::TogglePanel { recording: true }, "{phase:?}");
            assert!(route.shows_recording_controls(), "the pill comes back too ({phase:?})");
        }
        for phase in not_recording() {
            let route = tray_click_route(true, phase);
            assert_eq!(route, TrayClickRoute::TogglePanel { recording: false }, "{phase:?}");
            assert!(!route.shows_recording_controls(), "{phase:?}");
        }
    }

    #[test]
    fn a_signed_out_click_opens_the_app_or_only_the_pill() {
        for phase in not_recording() {
            assert_eq!(tray_click_route(false, phase), TrayClickRoute::OpenMainWindow, "{phase:?}");
        }
        for phase in [RECORDING, PAUSED] {
            let route = tray_click_route(false, phase);
            assert_eq!(route, TrayClickRoute::ShowRecordingControls);
            assert!(route.shows_recording_controls());
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
        assert_eq!(tray_click_route(true, after_shot), TrayClickRoute::TogglePanel { recording: false });

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
        assert_eq!(tray_click_route(true, after_recording), TrayClickRoute::TogglePanel { recording: false });
        // A cancelled or failed one too.
        for end in [CaptureEvent::Cancel, CaptureEvent::Failed] {
            let phase = transition(RECORDING, end).unwrap();
            assert_eq!(tray_click_route(true, phase), TrayClickRoute::TogglePanel { recording: false }, "{end:?}");
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

    /// Windows shows the tray's time in the tooltip, and a tooltip longer
    /// than 127 UTF-16 units (`NOTIFYICONDATAW.szTip`) is cut off or refused
    /// with no error. The longest one, a paused recording past 100 minutes,
    /// fits.
    #[test]
    fn every_tooltip_fits_windows_tray_limit() {
        for phase in [
            CapturePhase::Recording {
                elapsed_secs: 999 * 60 + 59,
                microphone: true,
            },
            CapturePhase::Paused {
                elapsed_secs: 999 * 60 + 59,
                microphone: false,
            },
            CapturePhase::Idle,
        ] {
            let tip = tray_text_for(phase).tooltip;
            assert!(tip.encode_utf16().count() <= 127, "{tip}");
        }
    }

    #[test]
    fn the_icon_is_marked_only_while_a_recording_runs() {
        assert_eq!(tray_glyph_for(RECORDING), TrayGlyph::Recording);
        assert_eq!(tray_glyph_for(PAUSED), TrayGlyph::Paused);
        for phase in not_recording() {
            assert_eq!(tray_glyph_for(phase), TrayGlyph::None, "{phase:?}");
        }
        // The written text names the same mark, so the last write says
        // which mark is on the icon.
        for phase in not_recording().into_iter().chain([RECORDING, PAUSED]) {
            assert_eq!(tray_glyph_of(&tray_text_for(phase)), tray_glyph_for(phase), "{phase:?}");
        }
    }

    /// Marked on every write while recording, put back once when it ends,
    /// and never touched through a screenshot.
    #[test]
    fn the_mark_is_redrawn_while_recording_and_released_once() {
        use TrayGlyph::{None as Plain, Paused as P, Recording as R};
        assert_eq!(icon_write(Plain, R), IconWrite::Mark(R));
        assert_eq!(icon_write(R, R), IconWrite::Mark(R), "covers a sync icon swapped in");
        assert_eq!(icon_write(R, P), IconWrite::Mark(P));
        assert_eq!(icon_write(P, Plain), IconWrite::Release);
        assert_eq!(icon_write(R, Plain), IconWrite::Release);
        assert_eq!(icon_write(Plain, Plain), IconWrite::Keep);
    }

    #[test]
    fn the_marked_icon_keeps_the_logo_and_adds_a_ringed_dot() {
        // A wide logo: opaque blue, 100 x 50.
        let base = image::RgbaImage::from_pixel(100, 50, image::Rgba([0x31, 0x67, 0xDD, 0xFF]));
        assert!(marked_icon(&base, TrayGlyph::None).is_none());
        let icon = marked_icon(&base, TrayGlyph::Recording).unwrap();
        assert_eq!(icon.dimensions(), (GLYPH_ICON_SIZE, GLYPH_ICON_SIZE));
        // Letterboxed, not stretched: the top rows stay clear.
        assert_eq!(icon.get_pixel(32, 2)[3], 0);
        // The logo's middle survives on the left.
        assert_eq!(*icon.get_pixel(10, 32), image::Rgba([0x31, 0x67, 0xDD, 0xFF]));
        // The dot sits in the bottom-right corner, in the pill's red.
        let near_corner = GLYPH_ICON_SIZE - 12;
        assert_eq!(*icon.get_pixel(near_corner, near_corner), image::Rgba([0xFF, 0x45, 0x3A, 0xFF]));
        let paused = marked_icon(&base, TrayGlyph::Paused).unwrap();
        assert_eq!(*paused.get_pixel(near_corner, near_corner), image::Rgba([0xFB, 0xBF, 0x24, 0xFF]));
        // The bundled icon decodes and marks.
        let bundled = image::load_from_memory(include_bytes!("../../icons/TrayIcon.png")).unwrap().to_rgba8();
        assert!(marked_icon(&bundled, TrayGlyph::Recording).is_some());
    }

    /// The tooltip carries the running time, since Windows has no tray title.
    #[test]
    fn the_tooltip_carries_the_time_where_there_is_no_title() {
        let text = tray_text_for(RECORDING);
        assert!(text.tooltip.contains("00:42"), "{}", text.tooltip);
        assert!(text.tooltip.contains("Click to show the recording controls"));
    }
}
