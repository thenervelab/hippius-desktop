//! The camera bubble's own controls while a recording runs: a small strip
//! over the bubble, shown while the pointer is on it, that changes the
//! bubble's size and pauses or resumes the recording (Loom style). Pure
//! decisions, tested on every OS; `commands.rs` opens, places and shows the
//! window.
//!
//! **Never in the video.** The bubble is filmed (its window is in the
//! recording on purpose), so anything drawn in the bubble's own window is in
//! the file: the size strip it has while choosing is hidden from Record on,
//! and an earlier WebKit pause button over the hovered picture was filmed.
//! These controls are therefore a window of their own
//! (`capture-bubble-controls`), placed over the bubble, which every recorder
//! leaves out:
//! - **macOS**: the helper films a screen or area with ScreenCaptureKit
//!   leaving out every Hippius window but the ones it is told to film (the
//!   main window and the bubble, `own_windows::filmed_own_windows`), windows
//!   opened later included; a window recording films only that window and
//!   the bubble (`SCContentFilter(display:including:)`).
//! - **Windows**: the window is content protected
//!   (`WDA_EXCLUDEFROMCAPTURE`, `own_windows::content_protected`), and a
//!   window recording composites only the bubble's own window.
//! - **Linux**: nothing keeps a window out (the pill itself is filmed
//!   there), so there are no bubble controls ([`supported`]).
//!
//! **Hover from Rust.** The bubble is never the key window, and macOS does
//! not reliably send hover to a webview in a window that is not key, so the
//! camera's pointer watch (`spawn_camera_hover_watch`) asks where the pointer
//! is and decides here ([`shown`]). The strip sits inside the bubble, so the
//! pointer on the strip is still on the bubble and the strip stays.

use super::bar::{CameraShape, CameraSize};
use super::camera::Frame;
use super::live_controls::is_live;
use super::rollout::Platform;
use super::session::CapturePhase;
use super::support::pill_filmed;

/// The controls' window, in points: the strip (three sizes and pause, 28 pt
/// buttons) with a line above it naming the button under the pointer.
pub const WIDTH: f64 = 148.0;
pub const HEIGHT: f64 = 60.0;

/// The page's margin around the bubble's frame (`p-1.5` in
/// `app/capture-camera/page.tsx`): the window is that much larger than the
/// picture on every side.
const PAGE_MARGIN: f64 = 6.0;
/// How far above the bottom of a round bubble the strip sits, as a share of
/// its height: high enough that the strip's ends stay inside the circle.
const ROUND_LIFT: f64 = 0.16;
/// How far above the bottom of the 16:9 frame the strip sits, in points.
const FULL_LIFT: f64 = 10.0;

/// Whether `platform` has bubble controls at all: only where a window can be
/// kept out of the recording, which is where the pill is not filmed.
#[must_use]
pub const fn supported(platform: Platform) -> bool {
    !pill_filmed(platform)
}

/// Whether the controls may be on screen now: a recording running or
/// paused, with a bubble (not the camera-only stage, which is the
/// recording) that is not hidden.
#[must_use]
pub fn offered(platform: Platform, phase: CapturePhase, camera: Option<CameraShape>, hidden: bool) -> bool {
    supported(platform) && is_live(phase) && camera == Some(CameraShape::Bubble) && !hidden
}

/// Where the controls' window goes over the bubble's window (`bubble`):
/// centred across it, its bottom just above the bottom of the picture.
#[must_use]
pub fn frame(bubble: Frame, size: CameraSize) -> Frame {
    let picture_bottom = bubble.y + bubble.height - PAGE_MARGIN;
    let picture_height = (bubble.height - 2.0 * PAGE_MARGIN).max(0.0);
    let lift = if size == CameraSize::Full {
        FULL_LIFT
    } else {
        picture_height * ROUND_LIFT
    };
    Frame {
        x: bubble.x + (bubble.width - WIDTH) / 2.0,
        y: picture_bottom - lift - HEIGHT,
        width: WIDTH,
        height: HEIGHT,
    }
}

/// Whether the bubble moved or changed size since the last look (`before`):
/// it is being dragged or gliding to a new size.
#[must_use]
pub fn moved(before: Option<Frame>, now: Frame) -> bool {
    const SLACK: f64 = 0.5;
    before.is_some_and(|b| {
        (b.x - now.x).abs() > SLACK || (b.y - now.y).abs() > SLACK || (b.width - now.width).abs() > SLACK || (b.height - now.height).abs() > SLACK
    })
}

/// Whether the controls show: offered, the pointer on the bubble, and the
/// bubble still. While the bubble moves they are taken away (they would be
/// left behind) and come back where it stops, if the pointer is still on it.
#[must_use]
pub const fn shown(offered: bool, pointer_over: bool, moving: bool) -> bool {
    offered && pointer_over && !moving
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: CapturePhase = CapturePhase::Recording {
        elapsed_secs: 3,
        microphone: false,
    };
    const PAUSED: CapturePhase = CapturePhase::Paused {
        elapsed_secs: 3,
        microphone: false,
    };

    /// Only where the controls' window can be kept out of the video.
    #[test]
    fn only_platforms_that_keep_the_window_out_of_the_video_have_bubble_controls() {
        assert!(supported(Platform::MacOs));
        assert!(supported(Platform::Windows));
        assert!(!supported(Platform::LinuxX11));
        assert!(!supported(Platform::LinuxWayland));
    }

    #[test]
    fn the_controls_are_offered_on_a_shown_bubble_while_recording_or_paused() {
        let bubble = Some(CameraShape::Bubble);
        assert!(offered(Platform::MacOs, LIVE, bubble, false));
        assert!(
            offered(Platform::Windows, PAUSED, bubble, false),
            "pause must be undoable from the bubble"
        );
        assert!(!offered(Platform::MacOs, LIVE, bubble, true), "hidden from the pill");
        assert!(
            !offered(Platform::MacOs, LIVE, Some(CameraShape::Stage), false),
            "the stage is the recording"
        );
        assert!(!offered(Platform::MacOs, LIVE, None, false));
        assert!(!offered(Platform::LinuxX11, LIVE, bubble, false), "filmed on Linux");
        for phase in [
            CapturePhase::Idle,
            CapturePhase::Finalizing,
            CapturePhase::Selecting {
                kind: crate::capture::session::CaptureKind::Recording,
                mode: crate::capture::session::CaptureMode::Screen,
            },
        ] {
            assert!(
                !offered(Platform::MacOs, phase, bubble, false),
                "{phase:?}: the bubble's own strip does it while choosing"
            );
        }
    }

    /// The strip is inside the picture for every size, so the pointer on the
    /// strip is on the bubble and the controls stay.
    #[test]
    fn the_strip_sits_inside_the_bubble_at_every_size() {
        for (side, size) in [(200.0, CameraSize::Small), (340.0, CameraSize::Large)] {
            let bubble = Frame {
                x: 40.0,
                y: 500.0,
                width: side,
                height: side,
            };
            let f = frame(bubble, size);
            assert!((f.x + f.width / 2.0 - (bubble.x + side / 2.0)).abs() < 1e-9, "centred");
            assert!(f.x >= bubble.x + PAGE_MARGIN && f.x + f.width <= bubble.x + side - PAGE_MARGIN);
            assert!(f.y >= bubble.y + PAGE_MARGIN && f.y + f.height <= bubble.y + side - PAGE_MARGIN);
            // The strip (the bottom 36 pt of the window) stays inside the
            // circle at both of its bottom corners.
            let radius = (side - 2.0 * PAGE_MARGIN) / 2.0;
            let cy = bubble.y + side / 2.0;
            let strip_half: f64 = 133.0 / 2.0;
            let corner = strip_half.hypot(f.y + f.height - cy);
            assert!(corner <= radius, "{size:?}: the strip's corner is outside the circle");
            for x in [f.x, f.x + f.width] {
                assert!(bubble.contains(x, f.y) && bubble.contains(x, f.y + f.height));
            }
        }
        let full = Frame {
            x: 100.0,
            y: 100.0,
            width: 960.0,
            height: 540.0,
        };
        let f = frame(full, CameraSize::Full);
        assert!((f.y + f.height - (full.y + full.height - PAGE_MARGIN - FULL_LIFT)).abs() < 1e-9);
    }

    #[test]
    fn the_controls_go_while_the_bubble_moves_and_come_back_where_it_stops() {
        let a = Frame {
            x: 10.0,
            y: 10.0,
            width: 200.0,
            height: 200.0,
        };
        assert!(!moved(None, a), "the first look is not a move");
        assert!(!moved(Some(a), a));
        assert!(!moved(Some(a), Frame { x: 10.2, ..a }), "rounding is not a move");
        assert!(moved(Some(a), Frame { x: 40.0, ..a }), "dragged");
        assert!(
            moved(
                Some(a),
                Frame {
                    width: 340.0,
                    height: 340.0,
                    ..a
                }
            ),
            "resized"
        );

        assert!(shown(true, true, false));
        assert!(!shown(true, true, true), "taken away while it moves");
        assert!(!shown(true, false, false), "only on hover");
        assert!(!shown(false, true, false), "never where it is not offered");
    }
}
