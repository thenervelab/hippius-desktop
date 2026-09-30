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

use super::bar::{CameraShape, CameraSize, CaptureOptions};
use super::session::CapturePhase;

/// The small bubble's window, in logical points.
pub const BUBBLE_SIZE: f64 = 200.0;
/// The large bubble's window, in logical points.
pub const LARGE_BUBBLE_SIZE: f64 = 340.0;
/// A bubble whose edge is within this of the usable area's edge is "in the
/// corner" (or against that side), and a resize keeps it there.
pub const SNAP_DISTANCE: f64 = 48.0;
/// No bubble is drawn smaller than this, however small the display.
const MIN_BUBBLE: f64 = 96.0;
/// Gap between the bubble and the usable area's bottom-left corner.
pub const BUBBLE_MARGIN: f64 = 32.0;
/// The stage is 16:9, at most this wide, and never wider than
/// [`STAGE_SHARE`] of the usable area.
pub const STAGE_MAX_WIDTH: f64 = 1280.0;
pub const STAGE_SHARE: f64 = 0.62;
/// The bottom of the usable area the capture bar block takes while choosing
/// (hint pill, sources panel and toolbar). The stage sits above it: it is at
/// a higher window level than the overlay, so anything it covers is hidden.
pub const BAR_BLOCK_HEIGHT: f64 = 250.0;
/// Gap between the stage and the top of the usable area or the bar block.
const STAGE_MARGIN: f64 = 16.0;
/// Gap between a bubble and the edges of the area it is placed in.
pub const AREA_BUBBLE_MARGIN: f64 = 16.0;

/// What the camera window and the recording pill are told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    /// The shape on screen, or `None` when no camera window is up.
    pub shape: Option<CameraShape>,
    /// The bubble was hidden from the pill; the recording carries on without it.
    pub hidden: bool,
    /// The chosen camera; `None` = the default. A platform id (the helper's
    /// `AVCaptureDevice.uniqueID` on macOS) or, from older builds, the
    /// webview's own `deviceId`.
    pub device_id: Option<String>,
    /// The chosen camera's name, which is how the webview finds it: its
    /// `deviceId`s are its own and never match a platform id.
    pub device_name: Option<String>,
    /// How big the bubble is; the page rounds a small or large bubble and
    /// draws a full one as a rounded 16:9 frame.
    pub size: CameraSize,
    /// A recording is starting or running (the page hides its size strip,
    /// which would otherwise be filmed each time the pointer crosses it).
    pub recording: bool,
    /// Whether the camera ends up in the video. False for a bubble over a
    /// window recording, which films that one window only.
    pub camera_filmed: bool,
}

/// Whether a capture in `phase` is recording, or about to (the countdown is
/// over and the recorder is starting).
#[must_use]
pub fn is_recording(phase: CapturePhase) -> bool {
    matches!(
        phase,
        CapturePhase::Capturing {
            kind: super::session::CaptureKind::Recording
        } | CapturePhase::Recording { .. }
            | CapturePhase::Paused { .. }
    )
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

impl Frame {
    fn centre(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// Whether `(x, y)` is inside, edges included.
    #[must_use]
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

/// The side of a round bubble of `size`; `None` for the full, 16:9 one.
#[must_use]
pub fn bubble_side(size: CameraSize) -> Option<f64> {
    match size {
        CameraSize::Small => Some(BUBBLE_SIZE),
        CameraSize::Large => Some(LARGE_BUBBLE_SIZE),
        CameraSize::Full => None,
    }
}

/// Where the camera window goes inside a display's usable area: the bubble in
/// the bottom-left corner (the card owns the bottom-right, the pill the
/// bottom-centre), the stage and a full-size bubble in the middle.
#[must_use]
pub fn frame(shape: CameraShape, size: CameraSize, area: Frame) -> Frame {
    let side = match (shape, bubble_side(size)) {
        // A display too small for the margins as well gets a smaller bubble,
        // never one hanging off its edge.
        (CameraShape::Bubble, Some(side)) => Some(
            side.min(area.width - 2.0 * BUBBLE_MARGIN)
                .min(area.height - 2.0 * BUBBLE_MARGIN)
                .max(MIN_BUBBLE),
        ),
        _ => None,
    };
    if let Some(side) = side {
        return Frame {
            x: area.x + BUBBLE_MARGIN,
            y: area.y + area.height - side - BUBBLE_MARGIN,
            width: side,
            height: side,
        };
    }
    // The stage lives above the capture bar block, never over it.
    let room = (area.height - BAR_BLOCK_HEIGHT - 2.0 * STAGE_MARGIN).max(MIN_BUBBLE);
    let width = (area.width * STAGE_SHARE)
        .min(STAGE_MAX_WIDTH)
        // A short, wide display: fit the height instead.
        .min(area.height * STAGE_SHARE * 16.0 / 9.0)
        .min(room * 16.0 / 9.0)
        .round();
    let height = (width * 9.0 / 16.0).round();
    let above_bar = area.height - BAR_BLOCK_HEIGHT;
    Frame {
        x: (area.x + (area.width - width) / 2.0).round(),
        // Centred in the room above the bar block.
        y: (area.y + ((above_bar - height) / 2.0).max(0.0)).round(),
        width,
        height,
    }
}

/// A bubble placed inside an area being recorded, in its bottom-left corner,
/// so an area recording films it. `area` is the drawn rectangle in the same
/// global points as the window. The bubble shrinks to fit a small area, but
/// never below the smallest bubble.
#[must_use]
pub fn bubble_in_area(size: CameraSize, area: Frame) -> Frame {
    let side = bubble_side(size)
        .unwrap_or(BUBBLE_SIZE)
        .min(area.width - 2.0 * AREA_BUBBLE_MARGIN)
        .min(area.height - 2.0 * AREA_BUBBLE_MARGIN)
        .max(MIN_BUBBLE);
    Frame {
        x: (area.x + AREA_BUBBLE_MARGIN).round(),
        y: (area.y + area.height - side - AREA_BUBBLE_MARGIN).round(),
        width: side,
        height: side,
    }
}

/// What a recording films, in the same global points as the camera window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Filmed {
    /// A whole display (`area`); a bubble placed there goes in the corner
    /// of its usable part (`usable`), as it does while choosing.
    Display { area: Frame, usable: Frame },
    /// A drawn area, or a window's frame.
    Region(Frame),
}

/// Where the bubble has to go when Record is pressed so it is in the video,
/// or `None` when it already is (wholly inside what is filmed, where the user
/// may have dragged it). A bubble outside, or half outside, is not filmed
/// (or is cut), so it moves to the bottom-left corner of what is filmed.
#[must_use]
pub fn bubble_for_recording(current: Option<Frame>, size: CameraSize, filmed: Filmed) -> Option<Frame> {
    let (inside, corner) = match filmed {
        Filmed::Display { area, usable } => (area, frame(CameraShape::Bubble, size, usable)),
        Filmed::Region(region) => (region, bubble_in_area(size, region)),
    };
    match current {
        Some(now) if within(now, inside) => None,
        _ => Some(corner),
    }
}

/// `inner` lies wholly inside `outer`, give or take a point of rounding.
fn within(inner: Frame, outer: Frame) -> bool {
    const SLACK: f64 = 1.0;
    inner.x >= outer.x - SLACK
        && inner.y >= outer.y - SLACK
        && inner.x + inner.width <= outer.x + outer.width + SLACK
        && inner.y + inner.height <= outer.y + outer.height + SLACK
}

/// The bubble resized to `side`, anchored where it is now.
///
/// A bubble against a corner (or one side) of the usable area stays against
/// it, so growing a bubble in the bottom-left corner grows it up and to the
/// right; one out in the open grows from its centre. Either way the result is
/// kept inside `area`, so a large bubble never hangs off the screen.
#[must_use]
pub fn resize_bubble(current: Frame, side: f64, area: Frame) -> Frame {
    let side = side.min(area.width).min(area.height);
    let (cx, cy) = current.centre();
    let near_left = current.x - area.x <= SNAP_DISTANCE;
    let near_right = (area.x + area.width) - (current.x + current.width) <= SNAP_DISTANCE;
    let near_top = current.y - area.y <= SNAP_DISTANCE;
    let near_bottom = (area.y + area.height) - (current.y + current.height) <= SNAP_DISTANCE;

    let x = if near_left && !near_right {
        current.x
    } else if near_right && !near_left {
        current.x + current.width - side
    } else {
        cx - side / 2.0
    };
    let y = if near_top && !near_bottom {
        current.y
    } else if near_bottom && !near_top {
        current.y + current.height - side
    } else {
        cy - side / 2.0
    };
    Frame {
        x: x.clamp(area.x, area.x + area.width - side).round(),
        y: y.clamp(area.y, area.y + area.height - side).round(),
        width: side,
        height: side,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_large_bubble_is_bigger_and_full_is_the_stage_frame() {
        let small = frame(CameraShape::Bubble, CameraSize::Small, AREA);
        let large = frame(CameraShape::Bubble, CameraSize::Large, AREA);
        assert_eq!((large.width, large.height), (LARGE_BUBBLE_SIZE, LARGE_BUBBLE_SIZE));
        assert!(large.width > small.width);
        // Both sit in the bottom-left corner.
        assert!((large.y + large.height - (small.y + small.height)).abs() < f64::EPSILON);
        assert_eq!(
            frame(CameraShape::Bubble, CameraSize::Full, AREA),
            frame(CameraShape::Stage, CameraSize::Small, AREA)
        );
        // Camera only is the stage whatever size was chosen.
        assert_eq!(
            frame(CameraShape::Stage, CameraSize::Large, AREA),
            frame(CameraShape::Stage, CameraSize::Small, AREA)
        );
    }

    #[test]
    fn a_bubble_never_outgrows_a_tiny_display() {
        let tiny = Frame {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 260.0,
        };
        let f = frame(CameraShape::Bubble, CameraSize::Large, tiny);
        assert!(f.y >= tiny.y && f.y + f.height <= tiny.height);
        assert!(f.x + f.width <= tiny.width);
    }

    fn bubble_at(x: f64, y: f64, side: f64) -> Frame {
        Frame {
            x,
            y,
            width: side,
            height: side,
        }
    }

    /// Growing the default bubble keeps it in its corner: up and to the right.
    #[test]
    fn a_bubble_in_the_bottom_left_corner_grows_up_and_right() {
        let small = frame(CameraShape::Bubble, CameraSize::Small, AREA);
        let large = resize_bubble(small, LARGE_BUBBLE_SIZE, AREA);
        assert!((large.x - small.x).abs() < 1.0, "left edge kept");
        assert!((large.y + large.height - (small.y + small.height)).abs() < 1.0, "bottom edge kept");
        // And back again lands exactly where it started.
        assert_eq!(resize_bubble(large, BUBBLE_SIZE, AREA), small);
    }

    #[test]
    fn a_bubble_in_the_top_right_corner_grows_down_and_left() {
        let small = bubble_at(AREA.x + AREA.width - BUBBLE_SIZE - 20.0, AREA.y + 20.0, BUBBLE_SIZE);
        let large = resize_bubble(small, LARGE_BUBBLE_SIZE, AREA);
        assert!((large.x + large.width - (small.x + small.width)).abs() < 1.0, "right edge kept");
        assert!((large.y - small.y).abs() < 1.0, "top edge kept");
    }

    #[test]
    fn a_bubble_in_the_open_grows_from_its_centre() {
        let small = bubble_at(600.0, 300.0, BUBBLE_SIZE);
        let large = resize_bubble(small, LARGE_BUBBLE_SIZE, AREA);
        assert!((large.x + large.width / 2.0 - 700.0).abs() < 1.0);
        assert!((large.y + large.height / 2.0 - 400.0).abs() < 1.0);
    }

    /// Growing near an edge, but not against it, must not push it off screen.
    #[test]
    fn a_resized_bubble_stays_on_the_display() {
        let small = bubble_at(AREA.x + AREA.width - BUBBLE_SIZE - 60.0, 400.0, BUBBLE_SIZE);
        let large = resize_bubble(small, LARGE_BUBBLE_SIZE, AREA);
        assert!(large.x + large.width <= AREA.x + AREA.width);
        assert!(large.y >= AREA.y && large.y + large.height <= AREA.y + AREA.height);
    }

    #[test]
    fn the_hover_test_includes_the_edges() {
        let f = bubble_at(10.0, 10.0, 100.0);
        assert!(f.contains(10.0, 10.0) && f.contains(110.0, 110.0) && f.contains(50.0, 60.0));
        assert!(!f.contains(9.0, 50.0) && !f.contains(50.0, 111.0));
    }
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
        let f = frame(CameraShape::Bubble, CameraSize::Small, AREA);
        assert_eq!((f.x, f.width, f.height), (BUBBLE_MARGIN, BUBBLE_SIZE, BUBBLE_SIZE));
        assert!((f.y + f.height + BUBBLE_MARGIN - (AREA.y + AREA.height)).abs() < f64::EPSILON);
    }

    /// A 13-inch MacBook: 1440 x 900 with a 875-point work area. The stage
    /// used to cover the bar block's hint and the top of the sources panel.
    #[test]
    fn the_stage_never_covers_the_capture_bar_block() {
        for area in [
            Frame {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 875.0,
            },
            AREA,
            Frame {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1055.0,
            },
            Frame {
                x: 0.0,
                y: 0.0,
                width: 1024.0,
                height: 600.0,
            },
        ] {
            for f in [
                frame(CameraShape::Stage, CameraSize::Small, area),
                frame(CameraShape::Bubble, CameraSize::Full, area),
            ] {
                assert!(
                    f.y + f.height <= area.y + area.height - BAR_BLOCK_HEIGHT,
                    "{f:?} covers the bar block of {area:?}"
                );
                assert!(f.y >= area.y, "{f:?} starts above {area:?}");
                assert!((f.width / f.height - 16.0 / 9.0).abs() < 0.02, "{f:?} is still 16:9");
            }
        }
    }

    #[test]
    fn in_area_mode_the_bubble_sits_inside_the_area_bottom_left() {
        let drawn = Frame {
            x: 400.0,
            y: 200.0,
            width: 800.0,
            height: 500.0,
        };
        let f = bubble_in_area(CameraSize::Small, drawn);
        assert_eq!((f.width, f.height), (BUBBLE_SIZE, BUBBLE_SIZE));
        assert!((f.x - (drawn.x + AREA_BUBBLE_MARGIN)).abs() < f64::EPSILON);
        assert!((f.y + f.height - (drawn.y + drawn.height - AREA_BUBBLE_MARGIN)).abs() < f64::EPSILON);
        let large = bubble_in_area(CameraSize::Large, drawn);
        assert!((large.width - LARGE_BUBBLE_SIZE).abs() < f64::EPSILON);
        assert!(large.y >= drawn.y && large.x + large.width <= drawn.x + drawn.width);
        // A small area gets a smaller bubble that still fits inside it.
        let small = Frame {
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 150.0,
        };
        let f = bubble_in_area(CameraSize::Large, small);
        assert!(f.width <= 150.0 - 2.0 * AREA_BUBBLE_MARGIN && f.width >= MIN_BUBBLE);
        assert!(small.contains(f.x, f.y) && small.contains(f.x + f.width, f.y + f.height));
        // Full is not a bubble shape for an area; it is placed as a small one.
        assert!((bubble_in_area(CameraSize::Full, drawn).width - BUBBLE_SIZE).abs() < f64::EPSILON);
    }

    /// The camera was not in a window recording while the bubble sat in
    /// the display's corner, outside the window. Record moves it in.
    #[test]
    fn record_moves_a_bubble_outside_what_is_filmed_into_its_corner() {
        let window = Frame {
            x: 311.0,
            y: 527.0,
            width: 920.0,
            height: 436.0,
        };
        let in_display_corner = frame(CameraShape::Bubble, CameraSize::Small, AREA);
        let moved = bubble_for_recording(Some(in_display_corner), CameraSize::Small, Filmed::Region(window)).expect("moved");
        assert_eq!(moved, bubble_in_area(CameraSize::Small, window));
        assert!(within(moved, window));
        // Already inside (placed there, or dragged there): it stays.
        assert_eq!(bubble_for_recording(Some(moved), CameraSize::Small, Filmed::Region(window)), None);
        // Half outside is cut by the crop: moved in as well.
        let straddling = Frame { x: window.x - 50.0, ..moved };
        assert!(bubble_for_recording(Some(straddling), CameraSize::Small, Filmed::Region(window)).is_some());
        // No known frame yet: placed.
        assert_eq!(
            bubble_for_recording(None, CameraSize::Large, Filmed::Region(window)),
            Some(bubble_in_area(CameraSize::Large, window))
        );
    }

    /// A screen recording of another display films nothing on this one.
    #[test]
    fn record_moves_a_bubble_onto_the_recorded_display() {
        let other = Frame {
            x: 1512.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let usable = Frame {
            y: 25.0,
            height: 1055.0,
            ..other
        };
        let here = frame(CameraShape::Bubble, CameraSize::Small, AREA);
        let moved = bubble_for_recording(Some(here), CameraSize::Small, Filmed::Display { area: other, usable });
        assert_eq!(moved, Some(frame(CameraShape::Bubble, CameraSize::Small, usable)));
        // On the recorded display already: it stays where the user put it.
        let dragged = Frame { x: 900.0, y: 300.0, ..here };
        let display = Frame {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        assert_eq!(
            bubble_for_recording(Some(dragged), CameraSize::Small, Filmed::Display { area: display, usable: AREA }),
            None
        );
    }

    #[test]
    fn the_camera_page_is_told_when_a_recording_is_under_way() {
        assert!(!is_recording(REC));
        assert!(is_recording(CapturePhase::Capturing {
            kind: CaptureKind::Recording
        }));
        assert!(is_recording(CapturePhase::Recording {
            elapsed_secs: 1,
            microphone: false
        }));
        assert!(is_recording(CapturePhase::Paused {
            elapsed_secs: 1,
            microphone: false
        }));
        for phase in [CapturePhase::Idle, CapturePhase::Finalizing] {
            assert!(!is_recording(phase));
        }
    }

    #[test]
    fn the_stage_is_centred_16_by_9_and_fits_the_display() {
        let f = frame(CameraShape::Stage, CameraSize::Small, AREA);
        assert!((f.width / f.height - 16.0 / 9.0).abs() < 0.01);
        assert!(f.width <= AREA.width * STAGE_SHARE + 1.0);
        assert!((f.x + f.width / 2.0 - (AREA.x + AREA.width / 2.0)).abs() <= 1.0);
        // Centred in the room above the bar block.
        assert!((f.y + f.height / 2.0 - (AREA.y + (AREA.height - BAR_BLOCK_HEIGHT) / 2.0)).abs() <= 1.0);
        // A huge display does not get a huge stage.
        let big = frame(
            CameraShape::Stage,
            CameraSize::Small,
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
            CameraSize::Small,
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
