//! What the recorder's writer thread does with placed samples, apart from
//! the encoder, so it can be tested on any OS against a fake one.
//!
//! Every sample reaching here is already on the recording's timeline
//! (microseconds of the capture clock, pauses cut out by
//! [`super::timeline`]). The first picture is time zero: sound from before
//! it is dropped, so the file starts on a picture, as the Swift helper's
//! does. Pictures are held until the next arrives ([`super::pacing::Hold`]);
//! sound from every source goes through the one [`Mixer`] and leaves as one
//! stereo track. The encoder gets times in 100-nanosecond units (Media
//! Foundation's), worked out from frame counts for sound so a long
//! recording never drifts by rounding.

use super::mixer::{self, Mixer, Source};
use super::pacing::{Hold, Timed};
use std::sync::Arc;

/// Where finished samples go: a Media Foundation sink writer on Windows, a
/// recording fake in tests.
pub trait Encoder {
    /// One NV12 picture, `start` and `duration` in 100 ns units from zero.
    ///
    /// # Errors
    /// The encoder failed and takes nothing more.
    fn video(&mut self, nv12: &[u8], start: i64, duration: i64) -> Result<(), String>;
    /// Interleaved stereo 16-bit PCM at 48 kHz, `start` and `duration` in
    /// 100 ns units from zero.
    ///
    /// # Errors
    /// The encoder failed and takes nothing more.
    fn audio(&mut self, pcm: &[i16], start: i64, duration: i64) -> Result<(), String>;
    /// Write the file's end.
    ///
    /// # Errors
    /// The file could not be finished.
    fn finish(&mut self) -> Result<(), String>;
}

/// The samples of one recording on their way to the encoder.
pub struct Pipeline<E: Encoder> {
    encoder: E,
    hold: Hold<Arc<Vec<u8>>>,
    mixer: Mixer,
    /// The capture-clock time of the first picture: time zero.
    origin: Option<u64>,
    frames_written: u64,
    /// The Free plan's watermark, blended into each picture as it arrives
    /// (`capture::watermark`), after anything else was drawn into it.
    watermark: Option<crate::capture::watermark::Nv12Stamp>,
}

/// Microseconds to 100 ns units.
fn hns(micros: u64) -> i64 {
    i64::try_from(micros).unwrap_or(i64::MAX / 10).saturating_mul(10)
}

/// A frame index at 48 kHz to 100 ns units, exactly.
fn frame_hns(frame: i64) -> i64 {
    let v = i128::from(frame) * 10_000_000 / i128::from(mixer::SAMPLE_RATE);
    i64::try_from(v).unwrap_or(i64::MAX)
}

impl<E: Encoder> Pipeline<E> {
    /// A pipeline mixing `sources` into the file's one audio track (none =
    /// no audio track).
    pub fn new(encoder: E, sources: &[Source]) -> Self {
        Self {
            encoder,
            hold: Hold::new(),
            mixer: Mixer::new(sources),
            origin: None,
            frames_written: 0,
            watermark: None,
        }
    }

    /// Watermark every picture from now on: `stamp` is made for the
    /// recording's size, so it is worked out once, not per picture.
    pub fn set_watermark(&mut self, stamp: crate::capture::watermark::Nv12Stamp) {
        self.watermark = Some(stamp);
    }

    #[must_use]
    pub fn origin(&self) -> Option<u64> {
        self.origin
    }

    /// When the held picture was taken, on the capture clock: what
    /// [`super::timeline::Timeline::end_time`] calls the last video.
    #[must_use]
    pub fn last_video(&self) -> Option<u64> {
        Some(self.hold.held_since()? + self.origin?)
    }

    #[must_use]
    pub fn frames_written(&self) -> u64 {
        self.frames_written
    }

    /// The recording starts at `origin` (capture clock, placed): the moment
    /// the encoder is ready and Start is answered. The encoder is made from
    /// the first picture, which can take seconds on a slow machine; that
    /// wait is not part of the recording, so a picture taken during it is
    /// the opening picture at zero (the newest one wins) and sound from
    /// before `origin` is dropped. Without a call the first picture is zero.
    pub fn start_at(&mut self, origin: u64) {
        self.origin.get_or_insert(origin);
    }

    /// A picture taken at `time`.
    ///
    /// # Errors
    /// The encoder failed.
    pub fn video(&mut self, time: u64, mut nv12: Vec<u8>) -> Result<(), String> {
        let origin = *self.origin.get_or_insert(time);
        let at = match time.checked_sub(origin) {
            Some(at) => at,
            // Taken before the start (while the encoder was being made):
            // the opening picture, until one after the start has come.
            None if self.frames_written == 0 && self.hold.held_since().is_none_or(|t| t == 0) => 0,
            None => return Ok(()),
        };
        if let Some(stamp) = &self.watermark {
            stamp.apply(&mut nv12);
        }
        match self.hold.push(Arc::new(nv12), at) {
            Some(timed) => self.write_video(&timed),
            None => Ok(()),
        }
    }

    /// Sound from `source` starting at `time`, interleaved stereo 48 kHz.
    ///
    /// # Errors
    /// The encoder failed.
    pub fn audio(&mut self, source: Source, time: u64, samples: &[f32]) -> Result<(), String> {
        // Nothing before the first picture: the file starts on one.
        let Some(origin) = self.origin else {
            return Ok(());
        };
        let micros = i64::try_from(time).unwrap_or(i64::MAX) - i64::try_from(origin).unwrap_or(i64::MAX);
        self.mixer.add(source, mixer::frame_at(micros), samples);
        while let Some(chunk) = self.mixer.take() {
            self.write_audio(&chunk)?;
        }
        Ok(())
    }

    /// Time passes with no picture: rewrite a still one now and then, so a
    /// still screen keeps the file growing. `now` is the capture clock's
    /// time placed on the timeline (`None` while paused: nothing to do).
    ///
    /// # Errors
    /// The encoder failed.
    pub fn tick(&mut self, now: Option<u64>) -> Result<(), String> {
        let (Some(now), Some(origin)) = (now, self.origin) else {
            return Ok(());
        };
        match self.hold.repeat(now.saturating_sub(origin)) {
            Some(timed) => self.write_video(&timed),
            None => Ok(()),
        }
    }

    /// The recording ends at `end` (capture clock, placed): the held
    /// picture lasts until then, the mixer is drained, the file finished.
    ///
    /// # Errors
    /// Nothing was ever captured, or the encoder failed.
    pub fn finish(&mut self, end: u64) -> Result<(), String> {
        let Some(origin) = self.origin else {
            return Err("The recording stopped before anything was captured.".into());
        };
        if let Some(timed) = self.hold.finish(end.saturating_sub(origin)) {
            self.write_video(&timed)?;
        }
        while let Some(chunk) = self.mixer.drain() {
            self.write_audio(&chunk)?;
        }
        self.encoder.finish()
    }

    fn write_video(&mut self, timed: &Timed<Arc<Vec<u8>>>) -> Result<(), String> {
        self.frames_written += 1;
        self.encoder.video(&timed.frame, hns(timed.start), hns(timed.duration))
    }

    fn write_audio(&mut self, chunk: &mixer::Chunk) -> Result<(), String> {
        let frames = i64::try_from(chunk.frames()).unwrap_or(0);
        let start = frame_hns(chunk.start);
        let duration = frame_hns(chunk.start + frames) - start;
        self.encoder.audio(&mixer::to_i16(&chunk.samples), start, duration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records what the encoder was handed.
    #[derive(Default)]
    struct Fake {
        video: Vec<(i64, i64)>,
        audio: Vec<(i64, i64, usize)>,
        finished: bool,
        fail_video_after: Option<usize>,
        /// The pictures themselves, as the encoder got them.
        pictures: Vec<Vec<u8>>,
    }

    impl Encoder for &mut Fake {
        fn video(&mut self, nv12: &[u8], start: i64, duration: i64) -> Result<(), String> {
            if self.fail_video_after.is_some_and(|n| self.video.len() >= n) {
                return Err("encoder gone".into());
            }
            self.video.push((start, duration));
            self.pictures.push(nv12.to_vec());
            Ok(())
        }
        fn audio(&mut self, pcm: &[i16], start: i64, duration: i64) -> Result<(), String> {
            self.audio.push((start, duration, pcm.len()));
            Ok(())
        }
        fn finish(&mut self) -> Result<(), String> {
            self.finished = true;
            Ok(())
        }
    }

    fn packet(ms: usize) -> Vec<f32> {
        vec![0.1; ms * 48 * 2]
    }

    #[test]
    fn the_file_starts_on_the_first_picture_and_ends_at_stop() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[Source::Microphone]);
        // Sound before the first picture is dropped.
        p.audio(Source::Microphone, 1_000_000, &packet(20)).unwrap();
        p.video(1_050_000, vec![0; 6]).unwrap();
        p.audio(Source::Microphone, 1_050_000, &packet(20)).unwrap();
        p.video(1_083_333, vec![0; 6]).unwrap();
        p.finish(3_050_000).unwrap();
        assert_eq!(fake.video, vec![(0, 333_330), (333_330, 19_666_670)]);
        assert!(fake.finished);
        let (start, duration, len) = fake.audio[0];
        assert_eq!((start, duration, len), (0, 200_000, 960 * 2), "20 ms from zero");
    }

    /// A Free plan recording's every picture reaches the encoder with the
    /// watermark in it, the repeated last one included, and only the corner
    /// changes; without a stamp the pictures pass untouched.
    #[test]
    fn a_watermarked_recording_stamps_every_picture() {
        let (w, h) = (640u32, 360u32);
        let blank = vec![16u8; w as usize * h as usize * 3 / 2];
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[]);
        p.set_watermark(crate::capture::watermark::Nv12Stamp::new(w, h).unwrap());
        p.video(1_000_000, blank.clone()).unwrap();
        p.video(1_033_333, blank.clone()).unwrap();
        p.finish(2_000_000).unwrap();
        assert_eq!(fake.pictures.len(), 2);
        for picture in &fake.pictures {
            assert_ne!(picture, &blank, "stamped");
            let first = picture.iter().zip(&blank).position(|(a, b)| a != b).unwrap();
            assert!(first / w as usize > h as usize / 2, "only the bottom of the picture changes");
        }

        let mut plain = Fake::default();
        let mut p = Pipeline::new(&mut plain, &[]);
        p.video(1_000_000, blank.clone()).unwrap();
        p.finish(2_000_000).unwrap();
        assert_eq!(plain.pictures, vec![blank]);
    }

    /// The encoder took 2 s to make from the first picture: the file starts
    /// when Start was answered, on the newest picture from that wait, and
    /// the wait itself is not in the file.
    #[test]
    fn the_time_spent_making_the_encoder_is_not_recorded() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[Source::Microphone]);
        p.start_at(3_000_000);
        // Taken while the encoder was being made: the newest is the opening
        // picture, and sound from then is dropped.
        p.video(1_000_000, vec![1; 6]).unwrap();
        p.audio(Source::Microphone, 2_000_000, &packet(20)).unwrap();
        p.video(2_900_000, vec![2; 6]).unwrap();
        p.video(3_100_000, vec![3; 6]).unwrap();
        p.audio(Source::Microphone, 3_100_000, &packet(20)).unwrap();
        p.finish(4_000_000).unwrap();
        assert_eq!(fake.video, vec![(0, 1_000_000), (1_000_000, 9_000_000)], "1 s long, not 3");
        let (start, duration, _) = *fake.audio.last().unwrap();
        assert_eq!(start + duration, 1_200_000, "sound from 3.1 s lands at 0.1 s");
    }

    /// Once a picture after the start is in, a late one from before it is
    /// dropped rather than moved to zero.
    #[test]
    fn a_picture_from_before_the_start_is_dropped_once_the_file_moved_on() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[]);
        p.start_at(1_000_000);
        p.video(1_100_000, vec![0; 6]).unwrap();
        p.video(1_200_000, vec![0; 6]).unwrap();
        p.video(900_000, vec![0; 6]).unwrap();
        p.finish(1_300_000).unwrap();
        assert_eq!(fake.video, vec![(1_000_000, 1_000_000), (2_000_000, 1_000_000)]);
    }

    #[test]
    fn a_still_screen_is_written_again_every_second() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[]);
        p.video(500, vec![0; 6]).unwrap();
        p.tick(Some(800_000)).unwrap();
        p.tick(Some(1_000_500)).unwrap();
        p.tick(None).unwrap();
        p.tick(Some(2_000_500)).unwrap();
        assert_eq!(p.last_video(), Some(2_000_500));
        p.finish(2_500_500).unwrap();
        assert_eq!(fake.video, vec![(0, 10_000_000), (10_000_000, 10_000_000), (20_000_000, 5_000_000)]);
        assert!(fake.audio.is_empty(), "no source, no audio track");
    }

    /// An hour of 20 ms packets lands exactly on an hour: the sound's clock
    /// is the frame count, never a sum of rounded durations.
    #[test]
    fn an_hour_of_sound_does_not_drift() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[Source::System]);
        p.video(0, vec![0; 6]).unwrap();
        let one = packet(20);
        for i in 0..180_000u64 {
            p.audio(Source::System, i * 20_000, &one).unwrap();
        }
        p.finish(3_600_000_000).unwrap();
        let (start, duration, _) = *fake.audio.last().unwrap();
        assert_eq!(start + duration, 36_000_000_000, "exactly one hour in 100 ns units");
        let total: i64 = fake.audio.iter().map(|a| a.1).sum();
        assert_eq!(total, 36_000_000_000);
    }

    #[test]
    fn mic_and_system_audio_leave_as_one_track() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[Source::System, Source::Microphone]);
        p.video(0, vec![0; 6]).unwrap();
        p.audio(Source::System, 0, &packet(20)).unwrap();
        p.audio(Source::Microphone, 0, &packet(20)).unwrap();
        p.finish(20_000).unwrap();
        let total: usize = fake.audio.iter().map(|a| a.2).sum();
        assert_eq!(total, 960 * 2, "one stereo track, not two");
    }

    #[test]
    fn nothing_captured_is_an_error_and_an_encoder_failure_comes_back() {
        let mut fake = Fake::default();
        let mut p = Pipeline::new(&mut fake, &[]);
        assert!(p.finish(1_000).is_err());

        let mut failing = Fake {
            fail_video_after: Some(0),
            ..Fake::default()
        };
        let mut p = Pipeline::new(&mut failing, &[]);
        p.video(0, vec![0; 6]).unwrap();
        assert_eq!(p.video(40_000, vec![0; 6]), Err("encoder gone".into()));
    }
}
