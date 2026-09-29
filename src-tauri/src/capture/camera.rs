//! The camera window, Loom style: a round bubble filmed over the screen, or,
//! with the screen turned off, a large "stage" that is itself what gets
//! recorded.
//!
//! The camera is drawn by a webview (`app/capture-camera`, `getUserMedia`),
//! not by the recording helper, so it is simply another window on screen and
//! ScreenCaptureKit films it like any other. That is also why it must NOT be
//! content-protected, unlike every other capture window.
//!
//! This module holds the decisions (whether a camera shows, in which shape,
//! and where); `commands.rs` opens and moves the window.

use serde::Serialize;

use super::bar::{CameraShape, CaptureOptions};
use super::session::CapturePhase;

/// The bubble's window, in logical points.
pub const BUBBLE_SIZE: f64 = 200.0;
/// Gap between the bubble and the usable area's bottom-left corner.
pub const BUBBLE_MARGIN: f64 = 32.0;
/// The stage is 16:9, at most this wide, and never wider than
/// [`STAGE_SHARE`] of the usable area.
pub const STAGE_MAX_WIDTH: f64 = 1280.0;
pub const STAGE_SHARE: f64 = 0.62;

/// What the camera window and the recording pill are told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    /// The shape on screen, or `None` when no camera window is up.
    pub shape: Option<CameraShape>,
    /// The bubble was hidden from the pill; the recording carries on without it.
    pub hidden: bool,
    /// The chosen camera (the webview's `deviceId`); `None` = the default.
    pub device_id: Option<String>,
}

/// Which camera window should be on screen now.
///
/// While choosing, it follows the bar's options live, so turning the camera
/// on shows the bubble at once and the user can place it before recording.
/// From the moment Record is pressed it follows `recording` instead, the shape
/// the recording started with: changing an option mid-recording must not pull
/// the camera out of the video. Once the recording stops, the window goes.
#[must_use]
pub fn wanted_shape(phase: CapturePhase, options: &CaptureOptions, recording: Option<CameraShape>, hidden: bool) -> Option<CameraShape> {
    let shape = match phase {
        CapturePhase::Selecting { kind, .. } => options.camera_shape(kind),
        CapturePhase::Capturing { .. } | CapturePhase::Recording { .. } | CapturePhase::Paused { .. } => recording,
        _ => None,
    }?;
    // The stage IS the recording, so it can never be hidden.
    (shape == CameraShape::Stage || !hidden).then_some(shape)
}

/// A window frame in logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the camera window goes inside a display's usable area: the bubble in
/// the bottom-left corner (the card owns the bottom-right, the pill the
/// bottom-centre), the stage in the middle.
#[must_use]
pub fn frame(shape: CameraShape, area: Frame) -> Frame {
    match shape {
        CameraShape::Bubble => Frame {
            x: area.x + BUBBLE_MARGIN,
            y: area.y + area.height - BUBBLE_SIZE - BUBBLE_MARGIN,
            width: BUBBLE_SIZE,
            height: BUBBLE_SIZE,
        },
        CameraShape::Stage => {
            let width = (area.width * STAGE_SHARE)
                .min(STAGE_MAX_WIDTH)
                // A short, wide display: fit the height instead.
                .min(area.height * STAGE_SHARE * 16.0 / 9.0)
                .round();
            let height = (width * 9.0 / 16.0).round();
            Frame {
                x: (area.x + (area.width - width) / 2.0).round(),
                y: (area.y + (area.height - height) / 2.0).round(),
                width,
                height,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::session::{CaptureKind, CaptureMode};

    fn opts(camera: bool, screen: bool) -> CaptureOptions {
        CaptureOptions {
            screen,
            camera,
            ..CaptureOptions::default()
        }
    }

    const REC: CapturePhase = CapturePhase::Selecting {
        kind: CaptureKind::Recording,
        mode: CaptureMode::Screen,
    };

    #[test]
    fn while_choosing_the_camera_follows_the_options() {
        assert_eq!(wanted_shape(REC, &opts(false, true), None, false), None);
        assert_eq!(wanted_shape(REC, &opts(true, true), None, false), Some(CameraShape::Bubble));
        assert_eq!(wanted_shape(REC, &opts(true, false), None, false), Some(CameraShape::Stage));
        let shot = CapturePhase::Selecting {
            kind: CaptureKind::Screenshot,
            mode: CaptureMode::Area,
        };
        assert_eq!(wanted_shape(shot, &opts(true, true), None, false), None);
    }

    /// Changing an option mid-recording must not take the camera out of the video.
    #[test]
    fn a_recording_keeps_the_camera_it_started_with() {
        let rec = CapturePhase::Recording {
            elapsed_secs: 4,
            microphone: false,
        };
        assert_eq!(
            wanted_shape(rec, &opts(false, true), Some(CameraShape::Bubble), false),
            Some(CameraShape::Bubble)
        );
        assert_eq!(wanted_shape(rec, &opts(true, true), None, false), None);
        let paused = CapturePhase::Paused {
            elapsed_secs: 4,
            microphone: false,
        };
        assert_eq!(
            wanted_shape(paused, &opts(true, true), Some(CameraShape::Bubble), false),
            Some(CameraShape::Bubble)
        );
    }

    #[test]
    fn the_camera_goes_once_the_recording_stops() {
        for phase in [CapturePhase::Idle, CapturePhase::Finalizing] {
            assert_eq!(wanted_shape(phase, &opts(true, true), Some(CameraShape::Bubble), false), None);
        }
    }

    #[test]
    fn a_bubble_can_be_hidden_but_the_stage_cannot() {
        let rec = CapturePhase::Recording {
            elapsed_secs: 1,
            microphone: true,
        };
        assert_eq!(wanted_shape(rec, &opts(true, true), Some(CameraShape::Bubble), true), None);
        assert_eq!(
            wanted_shape(rec, &opts(true, false), Some(CameraShape::Stage), true),
            Some(CameraShape::Stage)
        );
    }

    const AREA: Frame = Frame {
        x: 0.0,
        y: 25.0,
        width: 1512.0,
        height: 870.0,
    };

    #[test]
    fn the_bubble_sits_in_the_bottom_left_corner_of_the_usable_area() {
        let f = frame(CameraShape::Bubble, AREA);
        assert_eq!((f.x, f.width, f.height), (BUBBLE_MARGIN, BUBBLE_SIZE, BUBBLE_SIZE));
        assert!((f.y + f.height + BUBBLE_MARGIN - (AREA.y + AREA.height)).abs() < f64::EPSILON);
    }

    #[test]
    fn the_stage_is_centred_16_by_9_and_fits_the_display() {
        let f = frame(CameraShape::Stage, AREA);
        assert!((f.width / f.height - 16.0 / 9.0).abs() < 0.01);
        assert!(f.width <= AREA.width * STAGE_SHARE + 1.0);
        assert!((f.x + f.width / 2.0 - (AREA.x + AREA.width / 2.0)).abs() <= 1.0);
        assert!((f.y + f.height / 2.0 - (AREA.y + AREA.height / 2.0)).abs() <= 1.0);
        // A huge display does not get a huge stage.
        let big = frame(
            CameraShape::Stage,
            Frame {
                x: 0.0,
                y: 0.0,
                width: 5120.0,
                height: 2880.0,
            },
        );
        assert!(big.width <= STAGE_MAX_WIDTH);
        // A short, wide one does not get a stage taller than it.
        let wide = frame(
            CameraShape::Stage,
            Frame {
                x: 0.0,
                y: 0.0,
                width: 3440.0,
                height: 600.0,
            },
        );
        assert!(wide.height <= 600.0 * STAGE_SHARE + 1.0);
    }
}
