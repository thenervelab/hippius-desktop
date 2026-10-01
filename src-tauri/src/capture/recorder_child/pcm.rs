//! A device's PCM to the mixer's interleaved stereo 48 kHz `f32`.
//!
//! WASAPI is asked for 48 kHz stereo float with its own converter on
//! (`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`), so most packets need nothing but a
//! copy. When a driver refuses that, the device's own mix format is taken
//! and converted here: 16, 24 (in 24 or 32 bits) or 32-bit integers or
//! 32-bit floats, any channel count (mono goes to both sides, more than two
//! keep the front pair), any rate (linear interpolation, its position
//! carried from packet to packet so packet edges do not click).
//!
//! Pure, so it is tested on every OS; a headset at 16 or 44.1 kHz is the
//! case it exists for.

use super::mixer::SAMPLE_RATE;

/// How a device's samples are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    F32,
    I16,
    /// 24-bit integers packed in three bytes.
    I24,
    /// 32-bit containers: full 32-bit integers, or 24 valid bits in the top
    /// of 32 (both read the same once scaled by 2^31).
    I32,
}

impl SampleFormat {
    #[must_use]
    pub const fn bytes(self) -> usize {
        match self {
            Self::I16 => 2,
            Self::I24 => 3,
            Self::F32 | Self::I32 => 4,
        }
    }
}

/// A device's stream format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub sample: SampleFormat,
    pub channels: u16,
    pub rate: u32,
}

impl Format {
    /// What the mixer takes; a device delivering this needs only a copy.
    pub const MIXER: Self = Self {
        sample: SampleFormat::F32,
        channels: 2,
        rate: SAMPLE_RATE,
    };

    #[must_use]
    pub const fn frame_bytes(self) -> usize {
        self.sample.bytes() * self.channels as usize
    }
}

/// `WAVE_FORMAT_PCM`, `WAVE_FORMAT_IEEE_FLOAT` and `WAVE_FORMAT_EXTENSIBLE`,
/// the tags a WASAPI mix format carries.
pub const WAVE_FORMAT_PCM: u16 = 1;
pub const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
pub const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// A `WAVEFORMATEX` as this converter reads it: the tag, the container
/// bits per sample, the channels and rate, and for an extensible format
/// whether its sub-format is float. `None` for anything else (compressed
/// formats never reach a shared-mode capture client).
#[must_use]
pub fn format_from_wave(tag: u16, bits: u16, channels: u16, rate: u32, float_subformat: bool) -> Option<Format> {
    let is_float = match tag {
        WAVE_FORMAT_IEEE_FLOAT => true,
        WAVE_FORMAT_PCM => false,
        WAVE_FORMAT_EXTENSIBLE => float_subformat,
        _ => return None,
    };
    let sample = match (is_float, bits) {
        (true, 32) => SampleFormat::F32,
        (false, 16) => SampleFormat::I16,
        (false, 24) => SampleFormat::I24,
        (false, 32) => SampleFormat::I32,
        _ => return None,
    };
    (channels > 0 && rate > 0).then_some(Format { sample, channels, rate })
}

/// Turns one source's packets into the mixer's format, keeping the
/// resampler's place between packets.
#[derive(Debug, Clone)]
pub struct Converter {
    format: Format,
    /// Where the next output frame falls, in input frames, counted from the
    /// first frame of the packet being converted (it may be negative: then
    /// it lies between the last packet's final frame and this one's first).
    position: f64,
    /// The previous packet's last frame, for interpolating across the edge.
    last: Option<(f32, f32)>,
}

impl Converter {
    #[must_use]
    pub fn new(format: Format) -> Self {
        Self {
            format,
            position: 0.0,
            last: None,
        }
    }

    #[must_use]
    pub const fn format(&self) -> Format {
        self.format
    }

    /// `bytes` (whole frames in the device's format) as interleaved stereo
    /// 48 kHz. A trailing partial frame is ignored.
    pub fn convert(&mut self, bytes: &[u8]) -> Vec<f32> {
        let stereo = self.to_stereo(bytes);
        if self.format.rate == SAMPLE_RATE || self.format.rate == 0 {
            return stereo;
        }
        self.resample(&stereo)
    }

    /// `frames` of silence in the device's format, converted (WASAPI's
    /// `AUDCLNT_BUFFERFLAGS_SILENT` packets carry no data to read).
    pub fn silence(&mut self, frames: usize) -> Vec<f32> {
        let zeros = vec![0u8; frames * self.format.frame_bytes()];
        self.convert(&zeros)
    }

    fn to_stereo(&self, bytes: &[u8]) -> Vec<f32> {
        let format = self.format;
        let frame = format.frame_bytes();
        if frame == 0 {
            return Vec::new();
        }
        let size = format.sample.bytes();
        let mut out = Vec::with_capacity(bytes.len() / frame * 2);
        for chunk in bytes.chunks_exact(frame) {
            let left = read(format.sample, &chunk[..size]);
            let right = if format.channels > 1 {
                read(format.sample, &chunk[size..2 * size])
            } else {
                left
            };
            out.push(left);
            out.push(right);
        }
        out
    }

    /// Linear interpolation from the device's rate to 48 kHz.
    fn resample(&mut self, stereo: &[f32]) -> Vec<f32> {
        let frames = stereo.len() / 2;
        if frames == 0 {
            return Vec::new();
        }
        let step = f64::from(self.format.rate) / f64::from(SAMPLE_RATE);
        let at = |i: isize, last: Option<(f32, f32)>| -> (f32, f32) {
            if i < 0 {
                last.unwrap_or((stereo[0], stereo[1]))
            } else {
                let i = i.unsigned_abs().min(frames - 1);
                (stereo[2 * i], stereo[2 * i + 1])
            }
        };
        let mut out = Vec::with_capacity((frames as f64 / step) as usize * 2 + 4);
        let mut pos = self.position;
        // The last input frame interpolates towards the next packet's first,
        // so stop one short of it and carry the position over.
        #[allow(clippy::cast_precision_loss)]
        let end = (frames - 1) as f64;
        while pos < end {
            let base = pos.floor();
            #[allow(clippy::cast_possible_truncation)]
            let i = base as isize;
            #[allow(clippy::cast_possible_truncation)]
            let t = (pos - base) as f32;
            let (l0, r0) = at(i, self.last);
            let (l1, r1) = at(i + 1, self.last);
            out.push(l0 + (l1 - l0) * t);
            out.push(r0 + (r1 - r0) * t);
            pos += step;
        }
        #[allow(clippy::cast_precision_loss)]
        let consumed = frames as f64;
        self.position = pos - consumed;
        self.last = Some((stereo[2 * (frames - 1)], stereo[2 * (frames - 1) + 1]));
        out
    }
}

fn read(sample: SampleFormat, b: &[u8]) -> f32 {
    match sample {
        SampleFormat::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        SampleFormat::I16 => f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
        SampleFormat::I24 => {
            let v = i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8;
            #[allow(clippy::cast_precision_loss)]
            let f = v as f32 / 8_388_608.0;
            f
        }
        SampleFormat::I32 => {
            let v = i32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            #[allow(clippy::cast_precision_loss)]
            let f = v as f32 / 2_147_483_648.0;
            f
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn the_mixers_own_format_is_copied() {
        let mut c = Converter::new(Format::MIXER);
        let samples = [0.1, -0.2, 0.3, -0.4];
        assert_eq!(c.convert(&f32_bytes(&samples)), samples.to_vec());
    }

    #[test]
    fn mono_goes_to_both_sides_and_extra_channels_are_dropped() {
        let mut mono = Converter::new(Format {
            sample: SampleFormat::I16,
            channels: 1,
            rate: 48_000,
        });
        let bytes: Vec<u8> = [16_384i16, -16_384].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(mono.convert(&bytes), vec![0.5, 0.5, -0.5, -0.5]);

        let mut surround = Converter::new(Format {
            sample: SampleFormat::F32,
            channels: 6,
            rate: 48_000,
        });
        let frame = [0.1, 0.2, 0.9, 0.9, 0.9, 0.9];
        assert_eq!(surround.convert(&f32_bytes(&frame)), vec![0.1, 0.2]);
    }

    #[test]
    fn integer_formats_scale_to_one() {
        let mut c24 = Converter::new(Format {
            sample: SampleFormat::I24,
            channels: 1,
            rate: 48_000,
        });
        // 0x400000 = half scale; 0xC00000 = minus half.
        let out = c24.convert(&[0x00, 0x00, 0x40, 0x00, 0x00, 0xC0]);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);

        let mut c32 = Converter::new(Format {
            sample: SampleFormat::I32,
            channels: 1,
            rate: 48_000,
        });
        let out = c32.convert(&(1i32 << 30).to_le_bytes());
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn a_partial_trailing_frame_is_ignored() {
        let mut c = Converter::new(Format::MIXER);
        let mut bytes = f32_bytes(&[0.1, 0.2]);
        bytes.extend_from_slice(&[1, 2, 3]);
        assert_eq!(c.convert(&bytes).len(), 2);
    }

    /// A 16 kHz headset: three times the frames out, packet after packet,
    /// with no step at the packet edges.
    #[test]
    fn a_16_khz_headset_comes_out_at_48_khz_without_clicks_at_packet_edges() {
        let format = Format {
            sample: SampleFormat::F32,
            channels: 1,
            rate: 16_000,
        };
        let mut c = Converter::new(format);
        // A ramp across ten 10 ms packets.
        let mut out = Vec::new();
        for packet in 0..10 {
            let samples: Vec<f32> = (0..160).map(|i| (packet * 160 + i) as f32 / 1600.0).collect();
            out.extend(c.convert(&f32_bytes(&samples)));
        }
        let frames = out.len() / 2;
        assert!((4_790..=4_800).contains(&frames), "{frames} frames for 100 ms");
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        let widest = left.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(widest < 0.001, "a step of {widest} somewhere: a click");
    }

    #[test]
    fn a_44_1_khz_stream_keeps_its_length() {
        let format = Format {
            sample: SampleFormat::I16,
            channels: 2,
            rate: 44_100,
        };
        let mut c = Converter::new(format);
        let mut frames = 0;
        // One second in 10 ms packets.
        for _ in 0..100 {
            frames += c.convert(&vec![0u8; 441 * 4]).len() / 2;
        }
        assert!((47_990..=48_000).contains(&frames), "{frames}");
    }

    #[test]
    fn wasapi_mix_formats_are_read() {
        assert_eq!(format_from_wave(WAVE_FORMAT_EXTENSIBLE, 32, 2, 48_000, true), Some(Format::MIXER));
        assert_eq!(
            format_from_wave(WAVE_FORMAT_EXTENSIBLE, 32, 2, 44_100, false).map(|f| f.sample),
            Some(SampleFormat::I32),
            "24 valid bits in 32 read as 32"
        );
        assert_eq!(
            format_from_wave(WAVE_FORMAT_PCM, 16, 1, 16_000, false),
            Some(Format {
                sample: SampleFormat::I16,
                channels: 1,
                rate: 16_000
            })
        );
        assert_eq!(format_from_wave(WAVE_FORMAT_IEEE_FLOAT, 64, 2, 48_000, false), None, "no doubles");
        assert_eq!(format_from_wave(0x55, 16, 2, 48_000, false), None, "MP3 never reaches us");
        assert_eq!(format_from_wave(WAVE_FORMAT_PCM, 16, 0, 48_000, false), None);
    }

    #[test]
    fn silence_is_converted_like_sound() {
        let mut c = Converter::new(Format {
            sample: SampleFormat::I16,
            channels: 1,
            rate: 24_000,
        });
        let out = c.silence(240);
        assert!((478..=480).contains(&(out.len() / 2)));
        assert!(out.iter().all(|s| *s == 0.0));
    }
}
