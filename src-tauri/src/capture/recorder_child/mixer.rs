//! One audio track from every source: the Swift helper's `AudioMixer`
//! (`macos/HippiusCapture/Sources/main.swift`) in Rust, with the same
//! numbers, so a Windows or Linux recording sounds like a Mac one.
//!
//! Browsers and most players play only a file's first audio track, so the
//! microphone and the system audio are mixed into ONE stereo 48 kHz track
//! (decision 6 of `docs/plans/2026-10-01-capture-windows-linux.md`).
//!
//! Each source's packets arrive already converted to interleaved stereo
//! 48 kHz `f32` ([`super::pcm`]) and placed on the recording's timeline
//! (pauses cut, [`super::timeline`]), as a frame index from the start of the
//! recording. A packet that follows its source's last one within
//! [`RESYNC_SLACK`] is laid straight after it (a resampler's output never
//! lines up with its input timestamps to the frame); anything behind what
//! the source already wrote, or behind what was already handed out, is
//! dropped. The mix is handed out once every source has reached a frame, or
//! when one runs [`MAX_LAG`] ahead of another: WASAPI loopback delivers
//! nothing at all while the computer plays nothing, and that silence must
//! not hold the microphone back.
//!
//! Pure and single-threaded: the recorder's writer thread owns it.

/// The track's sample rate.
pub const SAMPLE_RATE: u32 = 48_000;
/// The microphone is lifted 6 dB: a built-in mic at speaking distance
/// records speech around -33 dBFS. [`limit`] keeps the peaks from clipping.
pub const MICROPHONE_GAIN: f32 = 2.0;
pub const SYSTEM_GAIN: f32 = 1.0;
/// 50 ms: timestamp jitter a source is allowed before it is re-placed.
pub const RESYNC_SLACK: i64 = 2_400;
/// 300 ms: how far one source may run ahead of a silent one.
pub const MAX_LAG: i64 = 14_400;
/// The most handed out at once, one second.
pub const MAX_CHUNK: i64 = 48_000;

/// Where a source's sound comes from; decides its gain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    System,
    Microphone,
}

impl Source {
    const fn gain(self) -> f32 {
        match self {
            Self::Microphone => MICROPHONE_GAIN,
            Self::System => SYSTEM_GAIN,
        }
    }
}

/// Mixed sound, ready for the encoder.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// First frame, counted from the start of the recording.
    pub start: i64,
    /// Interleaved left/right samples, limited to -1..=1.
    pub samples: Vec<f32>,
}

impl Chunk {
    #[must_use]
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
}

#[derive(Debug, Clone)]
struct Track {
    source: Source,
    /// Where this source's next frame goes.
    next: Option<i64>,
}

/// The mixer for one recording.
#[derive(Debug, Clone)]
pub struct Mixer {
    tracks: Vec<Track>,
    /// The mix from `flushed` on, one buffer per channel.
    left: Vec<f32>,
    right: Vec<f32>,
    flushed: i64,
}

/// The frame a time (microseconds from the start of the recording) falls
/// on, rounded.
#[must_use]
pub fn frame_at(micros: i64) -> i64 {
    // i128: an hour of microseconds times 48 000 overflows nothing, but a
    // clock that jumps must not panic.
    let scaled = i128::from(micros) * i128::from(SAMPLE_RATE);
    let rounded = if scaled >= 0 {
        (scaled + 500_000) / 1_000_000
    } else {
        (scaled - 500_000) / 1_000_000
    };
    i64::try_from(rounded).unwrap_or(if rounded > 0 { i64::MAX } else { i64::MIN })
}

/// The time (microseconds from the start) a frame index starts at.
#[must_use]
pub fn micros_at(frame: i64) -> i64 {
    let scaled = i128::from(frame) * 1_000_000 / i128::from(SAMPLE_RATE);
    i64::try_from(scaled).unwrap_or(i64::MAX)
}

impl Mixer {
    /// A mixer for `sources`, each listed once. No source = no audio track.
    #[must_use]
    pub fn new(sources: &[Source]) -> Self {
        let mut tracks: Vec<Track> = Vec::new();
        for &source in sources {
            if !tracks.iter().any(|t| t.source == source) {
                tracks.push(Track { source, next: None });
            }
        }
        Self {
            tracks,
            left: Vec::new(),
            right: Vec::new(),
            flushed: 0,
        }
    }

    #[must_use]
    pub fn has_sources(&self) -> bool {
        !self.tracks.is_empty()
    }

    /// Mix `samples` (interleaved stereo) from `source` in at `frame`. A
    /// source the mixer was not made with is ignored.
    pub fn add(&mut self, source: Source, frame: i64, samples: &[f32]) {
        let flushed = self.flushed;
        let Some(track) = self.tracks.iter_mut().find(|t| t.source == source) else {
            return;
        };
        let mut start = frame;
        if let Some(next) = track.next
            && (frame - next).abs() <= RESYNC_SLACK
        {
            // Continuous: trust the running count over the timestamp.
            start = next;
        }
        let frames = i64::try_from(samples.len() / 2).unwrap_or(0);
        // Never write behind what this source already wrote (a packet that
        // overlaps the one before it once a pause is cut) or behind what was
        // already handed out.
        let floor = track.next.unwrap_or(0).max(flushed);
        let skip = (floor - start).max(0);
        track.next = Some(track.next.unwrap_or(0).max(start + frames));
        if skip >= frames {
            return;
        }
        let gain = source.gain();
        let from = usize::try_from(start + skip - flushed).unwrap_or(0);
        let count = usize::try_from(frames - skip).unwrap_or(0);
        if self.left.len() < from + count {
            self.left.resize(from + count, 0.0);
            self.right.resize(from + count, 0.0);
        }
        let offset = usize::try_from(skip).unwrap_or(0);
        for i in 0..count {
            let at = 2 * (offset + i);
            self.left[from + i] += samples[at] * gain;
            self.right[from + i] += samples[at + 1] * gain;
        }
    }

    /// The mix every source has reached (or that a lagging one has fallen
    /// too far behind to hold up), or `None` when nothing is ready.
    pub fn take(&mut self) -> Option<Chunk> {
        let written = self.tracks.iter().map(|t| t.next.unwrap_or(self.flushed));
        let lowest = written.clone().min()?;
        let highest = written.max()?;
        let ready = lowest.max(highest - MAX_LAG);
        self.hand(ready)
    }

    /// Everything mixed so far, at the end of the recording.
    pub fn drain(&mut self) -> Option<Chunk> {
        let end = self.flushed + i64::try_from(self.left.len()).unwrap_or(0);
        self.hand(end)
    }

    fn hand(&mut self, ready: i64) -> Option<Chunk> {
        let count = (ready - self.flushed).min(MAX_CHUNK).min(i64::try_from(self.left.len()).unwrap_or(0));
        let count = usize::try_from(count).ok().filter(|c| *c > 0)?;
        let mut samples = Vec::with_capacity(count * 2);
        for (l, r) in self.left.drain(..count).zip(self.right.drain(..count)) {
            samples.push(limit(l));
            samples.push(limit(r));
        }
        let chunk = Chunk {
            start: self.flushed,
            samples,
        };
        self.flushed += i64::try_from(count).unwrap_or(0);
        Some(chunk)
    }
}

/// A soft limiter: untouched below 0.8, then eased towards 1 so a loud voice
/// over loud system audio rounds off instead of clipping.
#[must_use]
pub fn limit(x: f32) -> f32 {
    const KNEE: f32 = 0.8;
    let a = x.abs();
    if a <= KNEE {
        return x;
    }
    let over = (a - KNEE) / (1.0 - KNEE);
    let eased = KNEE + (1.0 - KNEE) * over.tanh();
    if x < 0.0 { -eased } else { eased }
}

/// Interleaved `f32` to the signed 16-bit PCM the AAC encoders take.
#[must_use]
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| {
            let v = (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round();
            #[allow(clippy::cast_possible_truncation)]
            let v = v as i16;
            v
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SWIFT: &str = include_str!("../../../../macos/HippiusCapture/Sources/main.swift");

    /// The Swift mixer's numbers; if they change there, they change here,
    /// or a Windows recording and a Mac recording sound different.
    #[test]
    fn the_numbers_are_the_swift_mixers() {
        for line in [
            "static let sampleRate: Double = 48_000",
            "static let microphoneGain: Float = 2.0",
            "static let systemGain: Float = 1.0",
            "static let resyncSlack: Int64 = 2_400",
            "static let maxLag: Int64 = 14_400",
            "static let maxChunk: Int64 = 48_000",
            "let knee: Float = 0.8",
        ] {
            assert!(SWIFT.contains(line), "main.swift no longer says `{line}`");
        }
    }

    fn tone(frames: usize, value: f32) -> Vec<f32> {
        vec![value; frames * 2]
    }

    #[test]
    fn one_source_is_handed_out_as_it_arrives_with_its_gain() {
        let mut mixer = Mixer::new(&[Source::Microphone]);
        mixer.add(Source::Microphone, 0, &tone(480, 0.1));
        let chunk = mixer.take().expect("ready");
        assert_eq!(chunk.start, 0);
        assert_eq!(chunk.frames(), 480);
        assert!((chunk.samples[0] - 0.2).abs() < 1e-6, "+6 dB on the mic");
        assert!(mixer.take().is_none(), "nothing more yet");
    }

    #[test]
    fn two_sources_wait_for_each_other_then_add_up() {
        let mut mixer = Mixer::new(&[Source::System, Source::Microphone]);
        mixer.add(Source::System, 0, &tone(960, 0.25));
        assert!(mixer.take().is_none(), "the mic has not reached any frame yet");
        mixer.add(Source::Microphone, 0, &tone(480, 0.1));
        let chunk = mixer.take().expect("both reached frame 480");
        assert_eq!(chunk.frames(), 480);
        assert!((chunk.samples[1] - 0.45).abs() < 1e-6, "0.25 + 0.1 * 2");
    }

    /// Loopback says nothing while nothing plays: the mic must not wait on
    /// it for more than 300 ms.
    #[test]
    fn a_silent_source_holds_the_other_back_by_at_most_300_ms() {
        let mut mixer = Mixer::new(&[Source::System, Source::Microphone]);
        mixer.add(Source::Microphone, 0, &tone(48_000, 0.1));
        let chunk = mixer.take().expect("the mic is a second ahead");
        assert_eq!(chunk.frames(), 48_000 - 14_400);
        // Loopback starts again later; its sound lands where it belongs.
        mixer.add(Source::System, 48_000, &tone(480, 0.25));
        let rest = mixer.take().expect("the rest of the mic");
        assert_eq!(rest.start, 33_600);
    }

    #[test]
    fn a_small_timestamp_wobble_continues_and_a_jump_leaves_silence() {
        let mut mixer = Mixer::new(&[Source::Microphone]);
        mixer.add(Source::Microphone, 0, &tone(480, 0.1));
        // 30 frames late is jitter: laid straight after.
        mixer.add(Source::Microphone, 510, &tone(480, 0.1));
        let chunk = mixer.take().unwrap();
        assert_eq!(chunk.frames(), 960);
        assert!(chunk.samples.iter().all(|s| (s - 0.2).abs() < 1e-6), "no gap");
        // A 100 ms jump is real: silence fills the gap.
        mixer.add(Source::Microphone, 960 + 4_800, &tone(480, 0.1));
        let chunk = mixer.take().unwrap();
        assert_eq!(chunk.start, 960);
        assert_eq!(chunk.frames(), 4_800 + 480);
        assert!(chunk.samples[..4_800 * 2].iter().all(|s| *s == 0.0));
    }

    #[test]
    fn overlaps_and_sound_behind_what_was_handed_out_are_dropped() {
        let mut mixer = Mixer::new(&[Source::Microphone]);
        mixer.add(Source::Microphone, 0, &tone(4_800, 0.1));
        let _ = mixer.take();
        // A packet from before the hand-out (a pause cut its start) adds
        // nothing to what is gone and only its new part to the rest.
        mixer.add(Source::Microphone, 0, &tone(9_600, 0.1));
        let chunk = mixer.take().unwrap();
        assert_eq!(chunk.start, 4_800);
        assert_eq!(chunk.frames(), 4_800);
        assert!(chunk.samples.iter().all(|s| (s - 0.2).abs() < 1e-6), "never added twice");
    }

    #[test]
    fn drain_hands_out_everything_and_chunks_stay_under_a_second() {
        let mut mixer = Mixer::new(&[Source::System, Source::Microphone]);
        mixer.add(Source::System, 0, &tone(100_000, 0.1));
        let mut total = 0;
        while let Some(chunk) = mixer.drain() {
            assert!(chunk.frames() <= 48_000);
            total += chunk.frames();
        }
        assert_eq!(total, 100_000);
    }

    #[test]
    fn a_mixer_without_sources_has_nothing() {
        let mut mixer = Mixer::new(&[]);
        assert!(!mixer.has_sources());
        mixer.add(Source::Microphone, 0, &tone(480, 0.1));
        assert!(mixer.take().is_none());
        assert!(mixer.drain().is_none());
    }

    #[test]
    fn the_limiter_leaves_quiet_sound_alone_and_never_clips() {
        assert!((limit(0.5) - 0.5).abs() < f32::EPSILON);
        assert!((limit(-0.8) + 0.8).abs() < f32::EPSILON);
        for x in [0.81_f32, 1.0, 1.6, 4.0, 100.0] {
            let y = limit(x);
            assert!(y > 0.8 && y <= 1.0, "{x} -> {y}");
            assert!((limit(-x) + y).abs() < f32::EPSILON, "symmetric");
        }
        assert!(limit(1.6) > limit(1.0), "still rises");
    }

    #[test]
    fn frames_and_times_convert_at_48_khz() {
        assert_eq!(frame_at(1_000_000), 48_000);
        assert_eq!(frame_at(20_000), 960);
        assert_eq!(frame_at(10), 0);
        assert_eq!(frame_at(11), 1, "rounded, not floored");
        assert_eq!(frame_at(-20_000), -960);
        assert_eq!(micros_at(48_000), 1_000_000);
        assert_eq!(micros_at(960), 20_000);
    }

    #[test]
    fn samples_become_16_bit_pcm_clamped() {
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.0, 0.5]), vec![0, 32_767, -32_767, 32_767, 16_384]);
    }
}
