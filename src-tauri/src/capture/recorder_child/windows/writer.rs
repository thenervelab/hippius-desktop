//! The file: a Media Foundation sink writer making a fragmented MP4
//! (`MFTranscodeContainerType_FMPEG4`), so a recorder that is killed still
//! leaves a file that plays up to its last fragment, with H.264 High video
//! and one AAC track, matching the Swift helper's files:
//!
//! - video: NV12 in (converted by [`super::super::frame`]), H.264 High out,
//!   a keyframe every 2 s (60 frames), bit rate from
//!   [`sizing::video_bit_rate`], tagged BT.709 limited range;
//! - audio: 16-bit stereo PCM at 48 kHz in (from the mixer), AAC at
//!   160 kbps out.
//!
//! Every sample time is set by the caller (the pipeline), so pauses are
//! already cut. A hardware H.264 encoder is used where the GPU has one; if
//! the sink writer cannot be set up with it, it is set up again with
//! Microsoft's software encoder (WARP in a VM, a driver that refuses NV12).

use std::path::Path;

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFMediaType, IMFSinkWriter, MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE,
    MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
    MF_MT_YUV_MATRIX, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSCODE_CONTAINERTYPE, MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateAttributes,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio, MFMediaType_Video, MFNominalRange_16_235,
    MFTranscodeContainerType_FMPEG4, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFVideoPrimaries_BT709,
    MFVideoTransFunc_709, MFVideoTransferMatrix_BT709, eAVEncH264VProfile_High,
};
use windows::core::{HSTRING, PCWSTR};

use super::super::pipeline::Encoder;
use super::super::{mixer, pacing, sizing};

/// AAC at 160 kbps, in the encoder's units (bytes a second).
const AAC_BYTES_PER_SECOND: u32 = 20_000;
/// A keyframe every 2 s at 30 fps, the Swift helper's interval.
const KEYFRAME_EVERY: u32 = 60;

/// Two 32-bit values in one `UINT64` attribute (frame size, rate, ratio).
const fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

fn err(what: &str, e: &windows::core::Error) -> String {
    format!("{what}: {e}")
}

/// One recording's sink writer.
pub struct MfWriter {
    writer: IMFSinkWriter,
    video: u32,
    audio: Option<u32>,
    finished: bool,
}

// SAFETY: the sink writer is created on, and only ever used from, the
// writer thread that owns this value; it is moved into that thread once,
// before any call is made through it, and Media Foundation objects are
// free-threaded (MTA).
unsafe impl Send for MfWriter {}

impl MfWriter {
    /// A writer for a `width` x `height` (even) recording at `path`, with an
    /// audio track when `audio`. Tries the hardware encoder first.
    pub fn create(path: &Path, width: u32, height: u32, audio: bool) -> Result<Self, String> {
        match Self::create_with(path, width, height, audio, true) {
            Ok(writer) => Ok(writer),
            Err(hardware) => {
                let _ = super::writeln_stderr(&format!("hardware encoder unavailable, using the software one: {hardware}"));
                let _ = std::fs::remove_file(path);
                Self::create_with(path, width, height, audio, false)
            }
        }
    }

    fn create_with(path: &Path, width: u32, height: u32, audio: bool, hardware: bool) -> Result<Self, String> {
        // SAFETY: every call below is a plain Media Foundation call on
        // objects created here; pointers passed are to live locals.
        unsafe {
            let mut attributes: Option<IMFAttributes> = None;
            MFCreateAttributes(&raw mut attributes, 2).map_err(|e| err("attributes", &e))?;
            let attributes = attributes.ok_or("no attributes")?;
            attributes
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_FMPEG4)
                .map_err(|e| err("container", &e))?;
            attributes
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, u32::from(hardware))
                .map_err(|e| err("hardware", &e))?;
            let url = HSTRING::from(path.as_os_str());
            let writer = MFCreateSinkWriterFromURL(PCWSTR(url.as_ptr()), None, &attributes).map_err(|e| err("the recording file", &e))?;

            let video = writer.AddStream(&video_out(width, height)?).map_err(|e| err("the H.264 stream", &e))?;
            writer
                .SetInputMediaType(video, &video_in(width, height)?, None)
                .map_err(|e| err("the H.264 encoder", &e))?;
            let audio = if audio {
                let stream = writer.AddStream(&audio_out()?).map_err(|e| err("the AAC stream", &e))?;
                writer
                    .SetInputMediaType(stream, &audio_in()?, None)
                    .map_err(|e| err("the AAC encoder", &e))?;
                Some(stream)
            } else {
                None
            };
            writer.BeginWriting().map_err(|e| err("starting the file", &e))?;
            Ok(Self {
                writer,
                video,
                audio,
                finished: false,
            })
        }
    }

    fn write(&self, stream: u32, bytes: &[u8], start: i64, duration: i64) -> Result<(), String> {
        let len = u32::try_from(bytes.len()).map_err(|_| "a sample larger than 4 GB")?;
        // SAFETY: the buffer is locked for exactly `len` bytes, written once
        // within that length and unlocked before it is handed on.
        unsafe {
            let buffer = MFCreateMemoryBuffer(len).map_err(|e| err("a sample buffer", &e))?;
            let mut data: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&raw mut data, None, None).map_err(|e| err("locking a sample", &e))?;
            if data.is_null() {
                let _ = buffer.Unlock();
                return Err("a sample buffer had no memory".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
            buffer.Unlock().map_err(|e| err("unlocking a sample", &e))?;
            buffer.SetCurrentLength(len).map_err(|e| err("sizing a sample", &e))?;
            let sample = MFCreateSample().map_err(|e| err("a sample", &e))?;
            sample.AddBuffer(&buffer).map_err(|e| err("filling a sample", &e))?;
            sample.SetSampleTime(start).map_err(|e| err("timing a sample", &e))?;
            sample.SetSampleDuration(duration.max(1)).map_err(|e| err("timing a sample", &e))?;
            self.writer.WriteSample(stream, &sample).map_err(|e| err("writing a sample", &e))
        }
    }
}

impl Encoder for MfWriter {
    fn video(&mut self, nv12: &[u8], start: i64, duration: i64) -> Result<(), String> {
        self.write(self.video, nv12, start, duration)
    }

    fn audio(&mut self, pcm: &[i16], start: i64, duration: i64) -> Result<(), String> {
        let Some(stream) = self.audio else {
            return Ok(());
        };
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.write(stream, &bytes, start, duration)
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        // SAFETY: plain call on the writer this value owns.
        unsafe { self.writer.Finalize() }.map_err(|e| err("finishing the file", &e))
    }
}

fn media_type() -> Result<IMFMediaType, String> {
    // SAFETY: plain constructor.
    unsafe { MFCreateMediaType() }.map_err(|e| err("a media type", &e))
}

/// BT.709 limited range, as the Swift helper tags its files.
fn tag_colour(t: &IMFMediaType) -> windows::core::Result<()> {
    // SAFETY: attribute setters on a media type created here.
    unsafe {
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
    }
}

fn video_common(t: &IMFMediaType, width: u32, height: u32) -> windows::core::Result<()> {
    #[allow(clippy::cast_possible_truncation)]
    let fps = pacing::FPS as u32;
    // SAFETY: attribute setters on a media type created here.
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    }
    tag_colour(t)
}

fn video_out(width: u32, height: u32) -> Result<IMFMediaType, String> {
    let t = media_type()?;
    let set = || -> windows::core::Result<()> {
        video_common(&t, width, height)?;
        // SAFETY: attribute setters on a media type created here.
        unsafe {
            t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            t.SetUINT32(&MF_MT_AVG_BITRATE, sizing::video_bit_rate(width, height))?;
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            t.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, KEYFRAME_EVERY)
        }
    };
    set().map_err(|e| err("the H.264 format", &e))?;
    Ok(t)
}

fn video_in(width: u32, height: u32) -> Result<IMFMediaType, String> {
    let t = media_type()?;
    let set = || -> windows::core::Result<()> {
        video_common(&t, width, height)?;
        // SAFETY: attribute setters on a media type created here.
        unsafe {
            t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            t.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;
            t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)
        }
    };
    set().map_err(|e| err("the NV12 format", &e))?;
    Ok(t)
}

fn audio_common(t: &IMFMediaType) -> windows::core::Result<()> {
    // SAFETY: attribute setters on a media type created here.
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, mixer::SAMPLE_RATE)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
    }
}

fn audio_out() -> Result<IMFMediaType, String> {
    let t = media_type()?;
    let set = || -> windows::core::Result<()> {
        audio_common(&t)?;
        // SAFETY: attribute setters on a media type created here.
        unsafe {
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
            // Raw AAC, as an MP4 carries it.
            t.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)
        }
    };
    set().map_err(|e| err("the AAC format", &e))?;
    Ok(t)
}

fn audio_in() -> Result<IMFMediaType, String> {
    let t = media_type()?;
    let set = || -> windows::core::Result<()> {
        audio_common(&t)?;
        // SAFETY: attribute setters on a media type created here.
        unsafe {
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, mixer::SAMPLE_RATE * 4)
        }
    };
    set().map_err(|e| err("the PCM format", &e))?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_rates_pack_high_then_low() {
        assert_eq!(pack(1920, 1080), 1920 * (1u64 << 32) + 1080);
        assert_eq!(pack(30, 1), 30 * (1u64 << 32) + 1);
    }

    /// The Microsoft AAC encoder takes only 12 000, 16 000, 20 000 or
    /// 24 000 bytes a second; 20 000 is the Swift helper's 160 kbps.
    #[test]
    fn the_aac_rate_is_one_the_encoder_takes_and_the_macs() {
        assert!([12_000, 16_000, 20_000, 24_000].contains(&AAC_BYTES_PER_SECOND));
        assert_eq!(AAC_BYTES_PER_SECOND * 8, 160_000);
    }
}
