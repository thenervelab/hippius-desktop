//! When a captured picture becomes a frame of the file, and for how long.
//!
//! Windows.Graphics.Capture sends a picture whenever the screen changes, as
//! often as the display refreshes (60, 120, 144 Hz) and not at all while it
//! is still. The file wants at most 30 frames a second, each lasting until
//! the next. So:
//!
//! - [`Gate`] lets a picture through only when it is at least a frame
//!   (33 ms, with 2 ms of slack for timestamp jitter) after the last one let
//!   through; the rest are dropped before any pixel is copied.
//! - [`Hold`] keeps the newest picture back until the next arrives, so each
//!   frame is written with its true duration, and repeats it at Stop so a
//!   still screen does not end the video early (the Swift helper's rule).
//!   While nothing changes it also re-writes the held picture once a second
//!   ([`REPEAT_AFTER`]), so a recording of a still screen keeps writing
//!   fragments and a killed recorder still leaves the time it ran.
//!
//! Times are microseconds on the recording's timeline (pauses already cut).

/// Frames per second of the file.
pub const FPS: u64 = 30;
/// The shortest gap between two frames, less timestamp slack.
pub const MIN_GAP: u64 = 1_000_000 / FPS - 2_000;
/// A still picture is written again after this long.
pub const REPEAT_AFTER: u64 = 1_000_000;

/// Drops pictures that arrive faster than [`FPS`].
#[derive(Debug, Clone, Default)]
pub struct Gate {
    last: Option<u64>,
}

impl Gate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a picture taken at `time` becomes a frame. A picture from
    /// before the last one (clock jitter) is dropped too.
    pub fn accept(&mut self, time: u64) -> bool {
        match self.last {
            Some(last) if time < last.saturating_add(MIN_GAP) => false,
            _ => {
                self.last = Some(time);
                true
            }
        }
    }
}

/// A frame ready to write: the picture, when it starts, how long it lasts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timed<T> {
    pub frame: T,
    pub start: u64,
    pub duration: u64,
}

/// The newest picture, held back until its duration is known.
#[derive(Debug, Clone, Default)]
pub struct Hold<T> {
    held: Option<(T, u64)>,
}

/// The shortest duration a frame is written with.
const ONE_FRAME: u64 = 1_000_000 / FPS;

impl<T: Clone> Hold<T> {
    #[must_use]
    pub fn new() -> Self {
        Self { held: None }
    }

    /// When the held picture starts, if one is held.
    #[must_use]
    pub fn held_since(&self) -> Option<u64> {
        self.held.as_ref().map(|(_, t)| *t)
    }

    /// Hold `frame` (taken at `time`) and hand back the one held before it,
    /// lasting until `time`. A picture not after the held one replaces it.
    pub fn push(&mut self, frame: T, time: u64) -> Option<Timed<T>> {
        let previous = self.held.take();
        self.held = Some((frame, time));
        match previous {
            Some((frame, start)) if time > start => Some(Timed {
                frame,
                start,
                duration: time - start,
            }),
            _ => None,
        }
    }

    /// Nothing new for [`REPEAT_AFTER`]: hand back the held picture lasting
    /// until `now` and keep holding it from `now`.
    pub fn repeat(&mut self, now: u64) -> Option<Timed<T>> {
        let (frame, start) = self.held.as_ref()?;
        if now < start.saturating_add(REPEAT_AFTER) {
            return None;
        }
        let out = Timed {
            frame: frame.clone(),
            start: *start,
            duration: now - start,
        };
        self.held = Some((frame.clone(), now));
        Some(out)
    }

    /// The recording ends at `end`: the held picture lasts until then (at
    /// least one frame).
    pub fn finish(&mut self, end: u64) -> Option<Timed<T>> {
        let (frame, start) = self.held.take()?;
        Some(Timed {
            frame,
            start,
            duration: end.saturating_sub(start).max(ONE_FRAME),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_144_hz_display_is_written_at_30_frames_a_second() {
        let mut gate = Gate::new();
        let kept = (0..144u64).map(|i| i * 1_000_000 / 144).filter(|t| gate.accept(*t)).count();
        assert!((29..=31).contains(&kept), "{kept} frames in a second");
    }

    #[test]
    fn a_30_fps_source_with_jitter_loses_nothing() {
        let mut gate = Gate::new();
        // 33.3 ms apart, each a millisecond early or late.
        let times = [0u64, 32_400, 67_600, 99_000, 134_300];
        assert!(times.iter().all(|t| gate.accept(*t)));
    }

    #[test]
    fn a_picture_from_before_the_last_one_is_dropped() {
        let mut gate = Gate::new();
        assert!(gate.accept(100_000));
        assert!(!gate.accept(90_000));
        assert!(gate.accept(140_000));
    }

    #[test]
    fn each_frame_lasts_until_the_next_and_the_last_until_stop() {
        let mut hold = Hold::new();
        assert_eq!(hold.push("a", 0), None);
        assert_eq!(
            hold.push("b", 40_000),
            Some(Timed {
                frame: "a",
                start: 0,
                duration: 40_000
            })
        );
        assert_eq!(
            hold.finish(2_000_000),
            Some(Timed {
                frame: "b",
                start: 40_000,
                duration: 1_960_000
            }),
            "a still screen does not end the video early"
        );
        assert_eq!(hold.finish(3_000_000), None);
    }

    #[test]
    fn a_still_screen_is_rewritten_once_a_second() {
        let mut hold = Hold::new();
        let _ = hold.push("still", 0);
        assert_eq!(hold.repeat(999_999), None);
        assert_eq!(
            hold.repeat(1_000_000),
            Some(Timed {
                frame: "still",
                start: 0,
                duration: 1_000_000
            })
        );
        assert_eq!(hold.held_since(), Some(1_000_000));
        // The next real picture follows on from the repeat.
        assert_eq!(hold.push("moved", 1_200_000).map(|t| (t.start, t.duration)), Some((1_000_000, 200_000)));
    }

    #[test]
    fn a_stop_straight_after_a_frame_still_gives_it_one_frame() {
        let mut hold = Hold::new();
        let _ = hold.push(1, 500_000);
        assert_eq!(hold.finish(500_000).map(|t| t.duration), Some(ONE_FRAME));
    }

    #[test]
    fn a_picture_at_the_same_instant_replaces_the_held_one() {
        let mut hold = Hold::new();
        let _ = hold.push("first", 10);
        assert_eq!(hold.push("second", 10), None);
        assert_eq!(hold.finish(10).map(|t| t.frame), Some("second"));
    }
}
