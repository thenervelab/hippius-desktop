//! The capture bar: what it remembers, where it appears, and what its
//! Capture button means.
//!
//! The bar is the macOS ⌘⇧5-style toolbar drawn by the overlay on ONE display:
//! screenshot or record an area, a window or a whole screen, an Options menu,
//! and a Capture / Record button. Everything it decides lives here, as pure
//! functions, so the overlay only draws.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::geometry::LogicalRect;
use super::screenshot::Selection;
use super::session::{CaptureKind, CaptureMode};
use super::targets::DisplayTarget;
use crate::error::Result;

/// Seconds a screenshot may wait before it is taken. Anything else a stored
/// value or a caller says is read as no timer, rather than an arbitrary wait.
pub const TIMER_CHOICES: [u8; 3] = [0, 5, 10];

/// Seconds a recording may count down before it starts. The default, 3, keeps
/// the first seconds of the video from being the pointer leaving the Record
/// button; 0 is for people who would rather trim than wait.
pub const RECORD_COUNTDOWN_CHOICES: [u8; 3] = [0, 3, 5];

/// A recording counts down this long unless the user chose otherwise, and a
/// stored value the bar does not offer reads as this.
pub const RECORDING_COUNTDOWN_SECS: u8 = 3;

/// How the camera appears in a recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraShape {
    /// A small round window over the screen, filmed with it; draggable.
    Bubble,
    /// Camera only: a large window in the middle that is itself recorded.
    Stage,
}

/// How big the camera bubble is, chosen from the bubble's own hover strip.
///
/// `Full` is the stage's frame (large, centred, 16:9) but still filmed WITH
/// the screen, the way Loom's "full screen camera" covers the screen for a
/// moment. Camera only (screen off) is always the stage, whatever this says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraSize {
    Large,
    Full,
    /// Also what an unknown stored value reads as, so a row written by a
    /// newer build still opens the bar (serde wants that variant last).
    #[default]
    #[serde(other)]
    Small,
}

/// What the bar remembers between captures, on this device.
///
/// Device-wide rather than per account: a timer, the microphone and the last
/// mode are the habits of the person at the machine, not of a drive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptureOptions {
    /// Screenshot timer: 0, 5 or 10 seconds.
    pub timer_secs: u8,
    /// Record a microphone with a recording (macOS 15+).
    pub microphone: bool,
    /// Which microphone (a platform device id); `None` is the system default.
    pub microphone_device: Option<String>,
    /// Record the screen. Off means camera only.
    pub screen: bool,
    /// Show the camera: a bubble filmed with the screen, or on its own.
    pub camera: bool,
    /// Which camera (the webview's `deviceId`); `None` is the default one.
    pub camera_device: Option<String>,
    /// The bubble's size (small, large or full); see [`CameraSize`].
    pub camera_size: CameraSize,
    /// Draw a ring where the pointer clicks in a recording (macOS 15+).
    pub show_clicks: bool,
    /// Record what the computer plays, mixed with the microphone into one
    /// track. Off by default, as in Loom: with speakers it also records the
    /// voice a second time, as an echo.
    pub system_audio: bool,
    /// The bar opens on what was used last.
    pub last_kind: CaptureKind,
    pub last_mode: CaptureMode,
    /// Mint a public link after the upload and put it on the clipboard. Off
    /// = the capture is only filed in the drive; the card can still make a
    /// link afterwards.
    pub copy_link: bool,
    /// Recording countdown: 0, 3 or 5 seconds.
    pub record_countdown_secs: u8,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            timer_secs: 0,
            microphone: true,
            microphone_device: None,
            screen: true,
            camera: false,
            camera_device: None,
            camera_size: CameraSize::Small,
            show_clicks: false,
            system_audio: false,
            last_kind: CaptureKind::Screenshot,
            last_mode: CaptureMode::Area,
            copy_link: true,
            record_countdown_secs: RECORDING_COUNTDOWN_SECS,
        }
    }
}

impl CaptureOptions {
    /// The same options with the timer snapped to a choice the bar offers.
    /// A recording with neither the screen nor the camera records nothing, so
    /// turning the screen off turns the camera on.
    #[must_use]
    pub fn normalized(self) -> Self {
        Self {
            timer_secs: if TIMER_CHOICES.contains(&self.timer_secs) { self.timer_secs } else { 0 },
            record_countdown_secs: if RECORD_COUNTDOWN_CHOICES.contains(&self.record_countdown_secs) {
                self.record_countdown_secs
            } else {
                RECORDING_COUNTDOWN_SECS
            },
            camera: self.camera || !self.screen,
            ..self
        }
    }

    /// The same options limited to what this system can record. Camera only
    /// records the camera window by its system window number, which only the
    /// macOS recorder can take, so elsewhere the screen stays on.
    #[must_use]
    pub fn for_system(self, camera_only_supported: bool) -> Self {
        let screen = self.screen || !camera_only_supported;
        Self { screen, ..self }.normalized()
    }

    /// The camera window a capture of `kind` shows while choosing and while
    /// recording, if any: a bubble filmed with the screen, or a stage that is
    /// itself what gets recorded (camera only). Screenshots never show one.
    #[must_use]
    pub fn camera_shape(&self, kind: CaptureKind) -> Option<CameraShape> {
        let options = self.clone().normalized();
        match (kind, options.camera, options.screen) {
            (CaptureKind::Recording, true, true) => Some(CameraShape::Bubble),
            (CaptureKind::Recording, true, false) => Some(CameraShape::Stage),
            _ => None,
        }
    }

    /// Seconds to count down after Capture / Record is pressed.
    #[must_use]
    pub fn countdown_secs(&self, kind: CaptureKind) -> u8 {
        match kind {
            CaptureKind::Screenshot => self.clone().normalized().timer_secs,
            CaptureKind::Recording => self.clone().normalized().record_countdown_secs,
        }
    }

    /// Whether the camera, if on, ends up in the video. The stage is always
    /// filmed (it IS the recording); the bubble is moved inside what is
    /// recorded when Record is pressed. A window recording films that one
    /// window, so the bubble is in it only where the recorder can add the
    /// camera window to it ([`window_recording_adds_camera`]).
    #[must_use]
    pub fn camera_filmed(&self, kind: CaptureKind, mode: CaptureMode) -> bool {
        match self.camera_shape(kind) {
            Some(CameraShape::Stage) => true,
            Some(CameraShape::Bubble) => mode != CaptureMode::Window || window_recording_adds_camera(),
            None => false,
        }
    }
}

/// Whether the recorder films the camera window with a window recording
/// (`cameraWindowId`) on `platform`: the macOS helper filters both windows
/// into one stream, the Windows and X11 recorder children draw the bubble
/// into the window's pictures. Wayland gives an app no window ids, so the
/// bubble cannot be found there.
#[must_use]
pub const fn window_recording_adds_camera_on(platform: super::rollout::Platform) -> bool {
    !matches!(platform, super::rollout::Platform::LinuxWayland)
}

/// [`window_recording_adds_camera_on`] for this session.
#[must_use]
pub fn window_recording_adds_camera() -> bool {
    window_recording_adds_camera_on(super::rollout::current_platform())
}

const OPTIONS_KEY: &str = "capture_options_v1";

/// The saved options, or the defaults. A row that no longer parses reads as
/// the defaults: the bar must open, whatever an older build left behind.
pub async fn load_options(pool: &SqlitePool) -> Result<CaptureOptions> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, OPTIONS_KEY).await?;
    Ok(raw
        .and_then(|v| serde_json::from_str::<CaptureOptions>(&v).ok())
        .unwrap_or_default()
        .normalized())
}

pub async fn save_options(pool: &SqlitePool, options: CaptureOptions) -> Result<()> {
    let json = serde_json::to_string(&options.clone().normalized())?;
    crate::utils::preferences::save_user_preference_internal(pool, OPTIONS_KEY, &json).await
}

const LAST_AREAS_KEY: &str = "capture_last_areas_v1";

/// The last area drawn on each display, by display id, so the next area
/// capture opens with it drawn. Kept in Rust with the other device-wide
/// habits rather than in the overlay's storage.
pub type RememberedAreas = std::collections::BTreeMap<u32, LogicalRect>;

/// The remembered areas; an unreadable row reads as none.
pub async fn load_areas(pool: &SqlitePool) -> Result<RememberedAreas> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, LAST_AREAS_KEY).await?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

/// Remember `rect` as the last area drawn on `display_id`.
pub async fn remember_area(pool: &SqlitePool, display_id: u32, rect: LogicalRect) -> Result<()> {
    let mut areas = load_areas(pool).await?;
    areas.insert(display_id, rect);
    // Displays come and go; a handful is plenty (another display's goes
    // first, lowest id first: ids carry no age).
    while areas.len() > MAX_REMEMBERED_AREAS {
        let Some(&oldest) = areas.keys().find(|&&id| id != display_id) else {
            break;
        };
        areas.remove(&oldest);
    }
    let json = serde_json::to_string(&areas)?;
    crate::utils::preferences::save_user_preference_internal(pool, LAST_AREAS_KEY, &json).await
}

const MAX_REMEMBERED_AREAS: usize = 8;

/// A remembered area fitted to a display of `width` x `height` points: kept
/// whole when it fits, moved back on screen when it hangs off an edge, shrunk
/// when the display is now smaller. `None` when it is too small to be one.
#[must_use]
pub fn fit_area(rect: LogicalRect, width: f64, height: f64) -> Option<LogicalRect> {
    const MIN_SIDE: f64 = 8.0;
    if !(rect.width.is_finite() && rect.height.is_finite() && rect.x.is_finite() && rect.y.is_finite()) {
        return None;
    }
    let w = rect.width.min(width);
    let h = rect.height.min(height);
    if w < MIN_SIDE || h < MIN_SIDE {
        return None;
    }
    Some(LogicalRect {
        x: rect.x.clamp(0.0, width - w),
        y: rect.y.clamp(0.0, height - h),
        width: w,
        height: h,
    })
}

/// The display the bar goes on: the one under the pointer, so the bar appears
/// where the user is looking; else the primary display; else the first.
///
/// `cursor` is in the displays' own space (points on macOS, physical pixels on
/// Windows), which is how `targets::list_displays` reports them.
#[must_use]
pub fn bar_display(displays: &[DisplayTarget], cursor: Option<(f64, f64)>) -> Option<u32> {
    display_under(displays, cursor)
        .or_else(|| displays.iter().find(|d| d.is_primary).map(|d| d.id))
        .or_else(|| displays.first().map(|d| d.id))
}

/// The display the pointer is on, or `None` when the pointer is unknown or
/// on none of them. `cursor` is in the displays' own space, as for
/// [`bar_display`].
#[must_use]
pub fn display_under(displays: &[DisplayTarget], cursor: Option<(f64, f64)>) -> Option<u32> {
    let (x, y) = cursor?;
    displays
        .iter()
        .find(|d| x >= f64::from(d.x) && x < f64::from(d.x) + f64::from(d.width) && y >= f64::from(d.y) && y < f64::from(d.y) + f64::from(d.height))
        .map(|d| d.id)
}

/// How the displays changed while a capture was open.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DisplayChange {
    /// Unplugged (or turned off): their overlays close.
    pub gone: Vec<u32>,
    /// Plugged in: they get an overlay while choosing.
    pub added: Vec<u32>,
}

/// What changed between two display lists, or `None` when nothing did. A
/// display that moved or changed resolution counts as changed too (the card
/// and pill are placed from the cached usable areas), with nothing gone or
/// added.
#[must_use]
pub fn display_change(before: &[DisplayTarget], now: &[DisplayTarget]) -> Option<DisplayChange> {
    if before == now {
        return None;
    }
    let ids = |list: &[DisplayTarget]| list.iter().map(|d| d.id).collect::<Vec<_>>();
    let (was, is) = (ids(before), ids(now));
    Some(DisplayChange {
        gone: was.iter().copied().filter(|id| !is.contains(id)).collect(),
        added: is.iter().copied().filter(|id| !was.contains(id)).collect(),
    })
}

/// The held area, if its display is still connected. An area on a display
/// that is gone can never be captured, so it is dropped rather than refused
/// at the Capture button.
#[must_use]
pub fn pending_after(pending: Option<Selection>, displays: &[DisplayTarget]) -> Option<Selection> {
    match pending {
        Some(Selection::Area { display_id, .. }) if !displays.iter().any(|d| d.id == display_id) => None,
        other => other,
    }
}

/// Why the Capture button cannot capture yet, in words the bar shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ConfirmError {
    #[error("Drag to choose an area first.")]
    NoArea,
    #[error("Click a window to choose it.")]
    NeedsWindowClick,
}

/// What pressing Capture / Record (or Return) takes.
///
/// An area is whatever rectangle is drawn, on whichever display it is on; a
/// screen is the display under the pointer, as a click would take it (the
/// keyboard is on the bar's overlay, which need not be the display the user
/// is pointing at), else the one the button was pressed on; a window is
/// chosen by clicking it, so the button alone cannot pick one.
///
/// # Errors
///
/// [`ConfirmError`] when there is nothing to take yet.
pub fn resolve_confirm(
    mode: CaptureMode,
    pending_area: Option<Selection>,
    pressed_on_display: u32,
    under_pointer: Option<u32>,
) -> std::result::Result<Selection, ConfirmError> {
    match mode {
        CaptureMode::Area => match pending_area {
            Some(area @ Selection::Area { .. }) => Ok(area),
            _ => Err(ConfirmError::NoArea),
        },
        CaptureMode::Screen => Ok(Selection::Screen {
            display_id: under_pointer.unwrap_or(pressed_on_display),
        }),
        CaptureMode::Window => Err(ConfirmError::NeedsWindowClick),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: u32, x: i32, y: i32, width: u32, height: u32, is_primary: bool) -> DisplayTarget {
        DisplayTarget {
            id,
            name: format!("Display {id}"),
            x,
            y,
            width,
            height,
            scale_factor: 2.0,
            is_primary,
        }
    }

    #[test]
    fn the_bar_goes_where_the_pointer_is() {
        let displays = [display(1, 0, 0, 1440, 900, true), display(2, 1440, 0, 1920, 1080, false)];
        assert_eq!(bar_display(&displays, Some((2000.0, 500.0))), Some(2));
        assert_eq!(bar_display(&displays, Some((10.0, 10.0))), Some(1));
    }

    #[test]
    fn a_display_left_of_the_primary_has_negative_coordinates() {
        let displays = [display(1, 0, 0, 1440, 900, true), display(2, -1920, -180, 1920, 1080, false)];
        assert_eq!(bar_display(&displays, Some((-100.0, 20.0))), Some(2));
    }

    #[test]
    fn without_a_pointer_the_bar_goes_on_the_primary_display() {
        let displays = [display(2, 1440, 0, 1920, 1080, false), display(1, 0, 0, 1440, 900, true)];
        assert_eq!(bar_display(&displays, None), Some(1));
        assert_eq!(bar_display(&displays, Some((99_999.0, 0.0))), Some(1));
        assert_eq!(bar_display(&[display(7, 0, 0, 10, 10, false)], None), Some(7));
        assert_eq!(bar_display(&[], Some((0.0, 0.0))), None);
    }

    #[test]
    fn an_unplugged_display_is_gone_and_a_new_one_added() {
        let a = display(1, 0, 0, 1440, 900, true);
        let b = display(2, 1440, 0, 1920, 1080, false);
        let c = display(3, -1920, 0, 1920, 1080, false);
        assert_eq!(display_change(&[a.clone(), b.clone()], &[a.clone(), b.clone()]), None);
        assert_eq!(
            display_change(&[a.clone(), b.clone()], &[a.clone(), c.clone()]),
            Some(DisplayChange {
                gone: vec![2],
                added: vec![3]
            })
        );
        // A resolution change changes nothing's membership but still counts.
        let mut bigger = a.clone();
        bigger.width = 1728;
        assert_eq!(display_change(std::slice::from_ref(&a), &[bigger]), Some(DisplayChange::default()));
    }

    #[test]
    fn an_area_on_a_display_that_is_gone_is_dropped() {
        let rect = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let on_two = Some(Selection::Area { display_id: 2, rect });
        let only_one = [display(1, 0, 0, 1440, 900, true)];
        assert_eq!(pending_after(on_two, &only_one), None);
        let on_one = Some(Selection::Area { display_id: 1, rect });
        assert_eq!(pending_after(on_one, &only_one), on_one);
        assert_eq!(pending_after(None, &only_one), None);
    }

    #[test]
    fn capture_takes_the_drawn_area_or_the_screen_the_button_is_on() {
        let area = Selection::Area {
            display_id: 2,
            rect: LogicalRect {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 200.0,
            },
        };
        assert_eq!(resolve_confirm(CaptureMode::Area, Some(area), 1, None), Ok(area));
        // The pointer never moves an area to another display.
        assert_eq!(resolve_confirm(CaptureMode::Area, Some(area), 1, Some(1)), Ok(area));
        assert_eq!(resolve_confirm(CaptureMode::Area, None, 1, None), Err(ConfirmError::NoArea));
        assert_eq!(
            resolve_confirm(CaptureMode::Area, Some(Selection::Screen { display_id: 1 }), 1, None),
            Err(ConfirmError::NoArea)
        );
        assert_eq!(
            resolve_confirm(CaptureMode::Screen, None, 3, None),
            Ok(Selection::Screen { display_id: 3 })
        );
        assert_eq!(
            resolve_confirm(CaptureMode::Window, Some(area), 1, Some(1)),
            Err(ConfirmError::NeedsWindowClick)
        );
    }

    /// Return in entire-screen mode takes the display the user points at,
    /// as a click would, not the one whose overlay has the keyboard.
    #[test]
    fn return_takes_the_screen_under_the_pointer() {
        let displays = [display(1, 0, 0, 1440, 900, true), display(2, 1440, 0, 1920, 1080, false)];
        let under = display_under(&displays, Some((2000.0, 300.0)));
        assert_eq!(under, Some(2));
        assert_eq!(
            resolve_confirm(CaptureMode::Screen, None, 1, under),
            Ok(Selection::Screen { display_id: 2 })
        );
        // Pointer unknown or between displays: the display the key was pressed on.
        assert_eq!(display_under(&displays, None), None);
        assert_eq!(display_under(&displays, Some((5000.0, 5000.0))), None);
        assert_eq!(bar_display(&displays, Some((5000.0, 5000.0))), Some(1));
        assert_eq!(
            resolve_confirm(CaptureMode::Screen, None, 1, None),
            Ok(Selection::Screen { display_id: 1 })
        );
    }

    #[test]
    fn a_recording_always_counts_down_and_a_screenshot_only_with_a_timer() {
        let mut options = CaptureOptions::default();
        assert_eq!(options.countdown_secs(CaptureKind::Screenshot), 0);
        assert_eq!(options.countdown_secs(CaptureKind::Recording), RECORDING_COUNTDOWN_SECS);
        options.timer_secs = 10;
        assert_eq!(options.countdown_secs(CaptureKind::Screenshot), 10);
        assert_eq!(options.countdown_secs(CaptureKind::Recording), RECORDING_COUNTDOWN_SECS);
    }

    #[test]
    fn the_recording_countdown_is_0_3_or_5_and_anything_else_reads_as_3() {
        for (stored, read) in [(0, 0), (3, 3), (5, 5), (4, 3), (10, 3), (255, 3)] {
            let o = CaptureOptions {
                record_countdown_secs: stored,
                ..CaptureOptions::default()
            };
            assert_eq!(o.countdown_secs(CaptureKind::Recording), read, "{stored}");
            assert_eq!(o.normalized().record_countdown_secs, read, "{stored}");
        }
        // The screenshot timer is its own choice.
        let o = CaptureOptions {
            record_countdown_secs: 0,
            timer_secs: 5,
            ..CaptureOptions::default()
        };
        assert_eq!(o.countdown_secs(CaptureKind::Screenshot), 5);
    }

    /// Camera only records a window by its macOS window number; off macOS
    /// the screen must stay on, whatever was saved.
    #[test]
    fn camera_only_is_turned_back_into_screen_where_it_cannot_record() {
        let camera_only = CaptureOptions {
            screen: false,
            camera: true,
            ..CaptureOptions::default()
        };
        assert!(!camera_only.clone().for_system(true).screen);
        let fixed = camera_only.for_system(false);
        assert!(fixed.screen && fixed.camera);
        assert_eq!(fixed.camera_shape(CaptureKind::Recording), Some(CameraShape::Bubble));
    }

    #[test]
    fn a_window_recording_films_the_bubble_where_the_recorder_adds_it() {
        let bubble = CaptureOptions {
            camera: true,
            ..CaptureOptions::default()
        };
        assert!(bubble.camera_filmed(CaptureKind::Recording, CaptureMode::Screen));
        assert!(bubble.camera_filmed(CaptureKind::Recording, CaptureMode::Area));
        assert_eq!(
            bubble.camera_filmed(CaptureKind::Recording, CaptureMode::Window),
            window_recording_adds_camera()
        );
        #[cfg(any(target_os = "macos", windows))]
        assert!(bubble.camera_filmed(CaptureKind::Recording, CaptureMode::Window));
        {
            use crate::capture::rollout::Platform;
            for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
                assert!(window_recording_adds_camera_on(platform), "{platform:?}");
            }
            assert!(!window_recording_adds_camera_on(Platform::LinuxWayland), "no window ids on Wayland");
        }
        let stage = CaptureOptions {
            screen: false,
            ..bubble.clone()
        };
        assert!(stage.camera_filmed(CaptureKind::Recording, CaptureMode::Window));
        assert!(!CaptureOptions::default().camera_filmed(CaptureKind::Recording, CaptureMode::Screen));
        assert!(!bubble.camera_filmed(CaptureKind::Screenshot, CaptureMode::Screen));
    }

    #[test]
    fn a_remembered_area_is_fitted_to_the_display_it_opens_on() {
        let r = |x, y, width, height| LogicalRect { x, y, width, height };
        assert_eq!(fit_area(r(10.0, 20.0, 300.0, 200.0), 1440.0, 900.0), Some(r(10.0, 20.0, 300.0, 200.0)));
        // Hanging off the right and bottom: moved back on.
        assert_eq!(
            fit_area(r(1300.0, 800.0, 300.0, 200.0), 1440.0, 900.0),
            Some(r(1140.0, 700.0, 300.0, 200.0))
        );
        // Bigger than a display that is now smaller: shrunk to it.
        assert_eq!(fit_area(r(0.0, 0.0, 2000.0, 1200.0), 1440.0, 900.0), Some(r(0.0, 0.0, 1440.0, 900.0)));
        assert_eq!(fit_area(r(0.0, 0.0, 2.0, 200.0), 1440.0, 900.0), None);
        assert_eq!(fit_area(r(f64::NAN, 0.0, 200.0, 200.0), 1440.0, 900.0), None);
    }

    #[tokio::test]
    async fn areas_are_remembered_per_display() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        let r = |x| LogicalRect {
            x,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        assert!(load_areas(&pool).await.unwrap().is_empty());
        remember_area(&pool, 1, r(1.0)).await.unwrap();
        remember_area(&pool, 2, r(2.0)).await.unwrap();
        remember_area(&pool, 1, r(3.0)).await.unwrap();
        let areas = load_areas(&pool).await.unwrap();
        assert_eq!(areas.get(&1), Some(&r(3.0)));
        assert_eq!(areas.get(&2), Some(&r(2.0)));
        for id in 10..30 {
            remember_area(&pool, id, r(0.0)).await.unwrap();
        }
        let areas = load_areas(&pool).await.unwrap();
        assert!(areas.len() <= MAX_REMEMBERED_AREAS);
        assert!(areas.contains_key(&29), "the newest is kept");
    }

    #[test]
    fn the_camera_shows_only_for_recordings_and_camera_only_is_a_stage() {
        let mut o = CaptureOptions::default();
        assert_eq!(o.camera_shape(CaptureKind::Recording), None);
        o.camera = true;
        assert_eq!(o.camera_shape(CaptureKind::Recording), Some(CameraShape::Bubble));
        assert_eq!(o.camera_shape(CaptureKind::Screenshot), None);
        o.screen = false;
        assert_eq!(o.camera_shape(CaptureKind::Recording), Some(CameraShape::Stage));
    }

    /// Screen off and camera off would record nothing.
    #[test]
    fn turning_the_screen_off_turns_the_camera_on() {
        let o = CaptureOptions {
            screen: false,
            camera: false,
            ..CaptureOptions::default()
        };
        assert!(o.normalized().camera);
    }

    #[test]
    fn an_unknown_timer_reads_as_none() {
        let options = CaptureOptions {
            timer_secs: 7,
            ..CaptureOptions::default()
        };
        assert_eq!(options.clone().normalized().timer_secs, 0);
        assert_eq!(options.countdown_secs(CaptureKind::Screenshot), 0);
    }

    /// A size this build does not know (written by a newer one, or edited by
    /// hand) reads as small rather than failing the whole row.
    #[test]
    fn an_unknown_camera_size_reads_as_small() {
        let o: CaptureOptions = serde_json::from_value(serde_json::json!({ "cameraSize": "huge", "camera": true })).unwrap();
        assert_eq!(o.camera_size, CameraSize::Small);
        assert!(o.camera, "the rest of the row still loads");
        let o: CaptureOptions = serde_json::from_value(serde_json::json!({ "cameraSize": "full" })).unwrap();
        assert_eq!(o.normalized().camera_size, CameraSize::Full);
        // A row saved before sizes existed opens on the small bubble.
        let o: CaptureOptions = serde_json::from_value(serde_json::json!({ "camera": true })).unwrap();
        assert_eq!(o.camera_size, CameraSize::Small);
    }

    /// The overlay reads these names; a partial or older row still loads.
    #[test]
    fn options_round_trip_and_fill_missing_fields() {
        let json = serde_json::to_value(CaptureOptions::default()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "timerSecs": 0, "microphone": true, "microphoneDevice": null,
                "screen": true, "camera": false, "cameraDevice": null,
                "cameraSize": "small", "showClicks": false, "systemAudio": false,
                "lastKind": "screenshot", "lastMode": "area",
                "copyLink": true, "recordCountdownSecs": 3
            })
        );
        let partial: CaptureOptions = serde_json::from_value(serde_json::json!({ "timerSecs": 5 })).unwrap();
        assert_eq!(partial.timer_secs, 5);
        assert_eq!(partial.last_mode, CaptureMode::Area);
        // A row saved before these existed keeps copying links and counting 3.
        assert!(partial.copy_link);
        assert_eq!(partial.record_countdown_secs, RECORDING_COUNTDOWN_SECS);
        // A row saved before the switch existed records no system audio.
        assert!(!partial.system_audio);
    }

    #[tokio::test]
    async fn options_persist_and_a_broken_row_reads_as_defaults() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");

        assert_eq!(load_options(&pool).await.unwrap(), CaptureOptions::default());
        let chosen = CaptureOptions {
            timer_secs: 10,
            microphone: false,
            microphone_device: Some("BuiltInMicrophoneDevice".into()),
            screen: true,
            camera: true,
            camera_device: Some("abc123".into()),
            camera_size: CameraSize::Large,
            show_clicks: true,
            system_audio: true,
            last_kind: CaptureKind::Recording,
            last_mode: CaptureMode::Window,
            copy_link: false,
            record_countdown_secs: 5,
        };
        save_options(&pool, chosen.clone()).await.unwrap();
        assert_eq!(load_options(&pool).await.unwrap(), chosen);

        crate::utils::preferences::save_user_preference_internal(&pool, OPTIONS_KEY, "not json")
            .await
            .unwrap();
        assert_eq!(load_options(&pool).await.unwrap(), CaptureOptions::default());
    }
}
