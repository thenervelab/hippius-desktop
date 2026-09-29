//! The capture bar: what it remembers, where it appears, and what its
//! Capture button means.
//!
//! The bar is the macOS ⌘⇧5-style toolbar drawn by the overlay on ONE display:
//! screenshot or record an area, a window or a whole screen, an Options menu,
//! and a Capture / Record button. Everything it decides lives here, as pure
//! functions, so the overlay only draws.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::screenshot::Selection;
use super::session::{CaptureKind, CaptureMode};
use super::targets::DisplayTarget;
use crate::error::Result;

/// Seconds a screenshot may wait before it is taken. Anything else a stored
/// value or a caller says is read as no timer, rather than an arbitrary wait.
pub const TIMER_CHOICES: [u8; 3] = [0, 5, 10];

/// A recording always counts down this long, so the first seconds of the video
/// are not the user moving the pointer away from the Record button.
pub const RECORDING_COUNTDOWN_SECS: u8 = 3;

/// What the bar remembers between captures, on this device.
///
/// Device-wide rather than per account: a timer, the microphone and the last
/// mode are the habits of the person at the machine, not of a drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptureOptions {
    /// Screenshot timer: 0, 5 or 10 seconds.
    pub timer_secs: u8,
    /// Record the default microphone with a recording (macOS 15+).
    pub microphone: bool,
    /// Draw a ring where the pointer clicks in a recording (macOS 15+).
    pub show_clicks: bool,
    /// The bar opens on what was used last.
    pub last_kind: CaptureKind,
    pub last_mode: CaptureMode,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            timer_secs: 0,
            microphone: true,
            show_clicks: false,
            last_kind: CaptureKind::Screenshot,
            last_mode: CaptureMode::Area,
        }
    }
}

impl CaptureOptions {
    /// The same options with the timer snapped to a choice the bar offers.
    #[must_use]
    pub fn normalized(self) -> Self {
        Self {
            timer_secs: if TIMER_CHOICES.contains(&self.timer_secs) { self.timer_secs } else { 0 },
            ..self
        }
    }

    /// Seconds to count down after Capture / Record is pressed.
    #[must_use]
    pub fn countdown_secs(&self, kind: CaptureKind) -> u8 {
        match kind {
            CaptureKind::Screenshot => self.normalized().timer_secs,
            CaptureKind::Recording => RECORDING_COUNTDOWN_SECS,
        }
    }
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
    let json = serde_json::to_string(&options.normalized())?;
    crate::utils::preferences::save_user_preference_internal(pool, OPTIONS_KEY, &json).await
}

/// The display the bar goes on: the one under the pointer, so the bar appears
/// where the user is looking; else the primary display; else the first.
///
/// `cursor` is in the displays' own space (points on macOS, physical pixels on
/// Windows), which is how `targets::list_displays` reports them.
#[must_use]
pub fn bar_display(displays: &[DisplayTarget], cursor: Option<(f64, f64)>) -> Option<u32> {
    let under_cursor = cursor.and_then(|(x, y)| {
        displays.iter().find(|d| {
            x >= f64::from(d.x) && x < f64::from(d.x) + f64::from(d.width) && y >= f64::from(d.y) && y < f64::from(d.y) + f64::from(d.height)
        })
    });
    under_cursor
        .or_else(|| displays.iter().find(|d| d.is_primary))
        .or_else(|| displays.first())
        .map(|d| d.id)
}

/// Why the Capture button cannot capture yet, in words the bar shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ConfirmError {
    #[error("Drag to choose an area first.")]
    NoArea,
    #[error("Click a window to choose it.")]
    NeedsWindowClick,
}

/// What pressing Capture / Record takes.
///
/// An area is whatever rectangle is drawn, on whichever display it is on; a
/// screen is the display the button was pressed on; a window is chosen by
/// clicking it, so the button alone cannot pick one.
///
/// # Errors
///
/// [`ConfirmError`] when there is nothing to take yet.
pub fn resolve_confirm(mode: CaptureMode, pending_area: Option<Selection>, pressed_on_display: u32) -> std::result::Result<Selection, ConfirmError> {
    match mode {
        CaptureMode::Area => match pending_area {
            Some(area @ Selection::Area { .. }) => Ok(area),
            _ => Err(ConfirmError::NoArea),
        },
        CaptureMode::Screen => Ok(Selection::Screen {
            display_id: pressed_on_display,
        }),
        CaptureMode::Window => Err(ConfirmError::NeedsWindowClick),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;

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
        assert_eq!(resolve_confirm(CaptureMode::Area, Some(area), 1), Ok(area));
        assert_eq!(resolve_confirm(CaptureMode::Area, None, 1), Err(ConfirmError::NoArea));
        assert_eq!(
            resolve_confirm(CaptureMode::Area, Some(Selection::Screen { display_id: 1 }), 1),
            Err(ConfirmError::NoArea)
        );
        assert_eq!(resolve_confirm(CaptureMode::Screen, None, 3), Ok(Selection::Screen { display_id: 3 }));
        assert_eq!(resolve_confirm(CaptureMode::Window, Some(area), 1), Err(ConfirmError::NeedsWindowClick));
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
    fn an_unknown_timer_reads_as_none() {
        let options = CaptureOptions {
            timer_secs: 7,
            ..CaptureOptions::default()
        };
        assert_eq!(options.normalized().timer_secs, 0);
        assert_eq!(options.countdown_secs(CaptureKind::Screenshot), 0);
    }

    /// The overlay reads these names; a partial or older row still loads.
    #[test]
    fn options_round_trip_and_fill_missing_fields() {
        let json = serde_json::to_value(CaptureOptions::default()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "timerSecs": 0, "microphone": true, "showClicks": false,
                "lastKind": "screenshot", "lastMode": "area"
            })
        );
        let partial: CaptureOptions = serde_json::from_value(serde_json::json!({ "timerSecs": 5 })).unwrap();
        assert_eq!(partial.timer_secs, 5);
        assert_eq!(partial.last_mode, CaptureMode::Area);
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
            show_clicks: true,
            last_kind: CaptureKind::Recording,
            last_mode: CaptureMode::Window,
        };
        save_options(&pool, chosen).await.unwrap();
        assert_eq!(load_options(&pool).await.unwrap(), chosen);

        crate::utils::preferences::save_user_preference_internal(&pool, OPTIONS_KEY, "not json")
            .await
            .unwrap();
        assert_eq!(load_options(&pool).await.unwrap(), CaptureOptions::default());
    }
}
