//! Pause cuts time out of a recording: the same rule as the Swift helper's
//! `place` (`macos/HippiusCapture/Sources/HippiusCapture.swift`), as a pure function of
//! sample times and pause intervals.
//!
//! Times are in the capture clock's own ticks (microseconds here; QPC units
//! on Windows and `CLOCK_MONOTONIC` on Linux once real sources land). A
//! sample that falls inside a pause is dropped; every later sample is moved
//! earlier by the length of every pause that ended before it. Video and audio
//! go through the same rule, so a pause never puts them out of step.
//!
//! An audio packet is placed by its start time, like the helper's: a packet
//! that starts before a pause is kept whole, one that starts inside it is
//! dropped. A packet is 10 to 20 ms, well under what anyone hears.

/// The pauses of one recording, in capture-clock time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Timeline {
    /// When the current pause began; `None` while recording.
    paused_at: Option<u64>,
    /// Finished pauses, `(start, end)`, in the order they happened.
    gaps: Vec<(u64, u64)>,
}

impl Timeline {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a pause at `now`. A second pause while paused changes nothing.
    pub fn pause(&mut self, now: u64) {
        if self.paused_at.is_none() {
            self.paused_at = Some(now);
        }
    }

    /// End the pause at `now`. Resuming while recording changes nothing.
    pub fn resume(&mut self, now: u64) {
        if let Some(start) = self.paused_at.take() {
            self.gaps.push((start, now.max(start)));
        }
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }

    /// Where a sample taken at `time` lands on the recording's timeline, or
    /// `None` for a sample inside a pause (dropped).
    #[must_use]
    pub fn place(&self, time: u64) -> Option<u64> {
        if let Some(start) = self.paused_at
            && time >= start
        {
            return None;
        }
        let mut offset = 0u64;
        for &(start, end) in &self.gaps {
            if time >= end {
                offset += end - start;
            } else if time >= start {
                return None;
            }
        }
        Some(time - offset)
    }

    /// Where the recording ends when it is stopped at `now`: now, or where
    /// the current pause began, less every finished pause, and never before
    /// the last frame written (`last_video`, already placed).
    #[must_use]
    pub fn end_time(&self, now: u64, last_video: Option<u64>) -> u64 {
        let raw = self.paused_at.unwrap_or(now);
        let cut: u64 = self.gaps.iter().filter(|(_, end)| *end <= raw).map(|(start, end)| end - start).sum();
        let end = raw.saturating_sub(cut);
        last_video.map_or(end, |last| end.max(last))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_no_pause_every_sample_keeps_its_time() {
        let t = Timeline::new();
        assert_eq!(t.place(0), Some(0));
        assert_eq!(t.place(1_000), Some(1_000));
        assert_eq!(t.end_time(5_000, Some(4_900)), 5_000);
    }

    #[test]
    fn a_sample_inside_a_pause_is_dropped_and_later_ones_close_the_gap() {
        let mut t = Timeline::new();
        t.pause(1_000);
        assert_eq!(t.place(999), Some(999), "taken before the pause");
        assert_eq!(t.place(1_000), None, "the pause's first instant is paused");
        assert_eq!(t.place(1_500), None);
        t.resume(3_000);
        assert_eq!(t.place(2_999), None, "inside the finished pause");
        assert_eq!(t.place(3_000), Some(1_000), "resumes where it paused");
        assert_eq!(t.place(4_000), Some(2_000));
    }

    #[test]
    fn a_pause_at_the_very_start_moves_the_whole_recording_back() {
        let mut t = Timeline::new();
        t.pause(0);
        assert_eq!(t.place(0), None);
        t.resume(2_000);
        assert_eq!(t.place(2_000), Some(0));
        assert_eq!(t.end_time(5_000, Some(2_900)), 3_000);
    }

    #[test]
    fn back_to_back_pauses_add_up() {
        let mut t = Timeline::new();
        t.pause(1_000);
        t.resume(2_000);
        t.pause(2_000);
        t.resume(2_500);
        t.pause(4_000);
        t.resume(6_000);
        assert_eq!(t.place(2_000), None, "the second pause starts on the first's last instant");
        assert_eq!(t.place(2_500), Some(1_000));
        assert_eq!(t.place(3_999), Some(2_499));
        assert_eq!(t.place(6_000), Some(2_500));
        assert_eq!(t.end_time(7_000, None), 3_500);
    }

    /// Placed by start time: the packet that begins before the pause is kept
    /// whole, the one that begins inside it is dropped, and the first after
    /// it follows straight on.
    #[test]
    fn audio_packets_straddling_a_pause_follow_their_start() {
        let mut t = Timeline::new();
        // 20 ms packets at 0, 20, 40 … ms (microseconds here).
        t.pause(30_000);
        t.resume(95_000);
        assert_eq!(t.place(20_000), Some(20_000), "starts before, ends inside: kept");
        assert_eq!(t.place(40_000), None, "starts inside: dropped");
        assert_eq!(t.place(80_000), None);
        assert_eq!(t.place(100_000), Some(35_000), "starts after: moved back by the pause");
        // Video and audio share the rule, so a frame at the same instant lands
        // at the same place.
        assert_eq!(t.place(100_000), t.place(100_000));
    }

    #[test]
    fn a_pause_longer_than_the_file_ends_it_where_the_pause_began() {
        let mut t = Timeline::new();
        t.pause(2_000);
        assert!(t.is_paused());
        // Stopped while still paused, much later.
        assert_eq!(t.end_time(3_600_000, Some(1_966)), 2_000);
        // Never before the last frame written.
        assert_eq!(t.end_time(3_600_000, Some(2_100)), 2_100);
    }

    #[test]
    fn pausing_twice_or_resuming_while_recording_changes_nothing() {
        let mut t = Timeline::new();
        t.resume(500);
        assert_eq!(t, Timeline::new());
        t.pause(1_000);
        t.pause(1_500);
        t.resume(2_000);
        assert_eq!(t.place(2_000), Some(1_000), "the first pause's start counts");
    }
}
