//! A test source: a moving bar at 30 fps and a 440 Hz tone at 48 kHz, paced
//! in real time on the capture clock. It lets the recorder child be driven
//! end to end (`start`, `pause`, `resume`, `stop`, `cancel`, stdin closing)
//! on any machine, with no screen, microphone or permission.
//!
//! Only a `start` with `"synthetic": true` gets it; the app's own sessions
//! never send that.

use std::time::Duration;

use super::{Clock, Sample};

/// Frames per second, as a screen recording is encoded.
pub const FPS: u64 = 30;
/// Audio sample rate and packet length (20 ms), as WASAPI and PulseAudio
/// deliver them.
pub const SAMPLE_RATE: u32 = 48_000;
pub const PACKET_MICROS: u64 = 20_000;
/// The picture the source draws.
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;

const FRAME_MICROS: u64 = 1_000_000 / FPS;
const TONE_HZ: f64 = 440.0;

/// Moving frames and a tone, due at their own times on `clock`.
pub struct Synthetic {
    clock: Clock,
    next_frame: u64,
    next_packet: u64,
    frames: u64,
    samples_out: u64,
}

impl Synthetic {
    #[must_use]
    pub fn new(clock: Clock) -> Self {
        let now = clock.now();
        Self {
            clock,
            next_frame: now,
            next_packet: now,
            frames: 0,
            samples_out: 0,
        }
    }

    /// The next sample, waiting until it is due. Never ends by itself.
    pub fn next_sample(&mut self) -> Sample {
        let video_first = self.next_frame <= self.next_packet;
        let due = if video_first { self.next_frame } else { self.next_packet };
        let now = self.clock.now();
        if due > now {
            std::thread::sleep(Duration::from_micros(due - now));
        }
        if video_first {
            let sample = Sample::Video {
                time: due,
                bar_x: self.bar_x(),
            };
            self.frames += 1;
            self.next_frame += FRAME_MICROS;
            sample
        } else {
            let samples = tone(self.samples_out, packet_len());
            self.samples_out += u64::from(packet_len());
            self.next_packet += PACKET_MICROS;
            Sample::Audio { time: due, samples }
        }
    }

    /// Where the bar is in this frame: it crosses the picture once a second.
    fn bar_x(&self) -> u32 {
        let step = u64::from(WIDTH) / FPS;
        #[allow(clippy::cast_possible_truncation)]
        let x = ((self.frames % FPS) * step) as u32;
        x
    }
}

#[allow(clippy::cast_possible_truncation)]
const fn packet_len() -> u32 {
    (SAMPLE_RATE as u64 * PACKET_MICROS / 1_000_000) as u32
}

/// `len` samples of the tone, starting at sample `from`, at half scale.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
fn tone(from: u64, len: u32) -> Vec<f32> {
    (0..u64::from(len))
        .map(|i| {
            let t = (from + i) as f64 / f64::from(SAMPLE_RATE);
            (0.5 * (2.0 * std::f64::consts::PI * TONE_HZ * t).sin()) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packet_is_twenty_milliseconds_of_a_half_scale_tone() {
        assert_eq!(packet_len(), 960);
        let samples = tone(0, packet_len());
        let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((0.45..=0.5).contains(&peak), "{peak}");
    }

    #[test]
    fn frames_and_packets_come_in_time_order_at_their_rates() {
        let mut source = Synthetic::new(Clock::start());
        let mut last = 0;
        let (mut frames, mut packets) = (0, 0);
        for _ in 0..20 {
            let time = match source.next_sample() {
                Sample::Video { time, .. } => {
                    frames += 1;
                    time
                }
                Sample::Audio { time, samples } => {
                    assert_eq!(samples.len(), 960);
                    packets += 1;
                    time
                }
            };
            assert!(time >= last, "time order");
            last = time;
        }
        // 20 samples cover about 200 ms: 6 or 7 frames at 30 fps, 10 or 11
        // packets at 20 ms, plus the pair due at the very start.
        assert!((6..=8).contains(&frames), "{frames} frames");
        assert!((11..=14).contains(&packets), "{packets} packets");
    }
}
