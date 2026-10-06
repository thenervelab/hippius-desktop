//! `--poster <video> <seconds>...` on Windows: stills from the finished MP4
//! with Media Foundation's Source Reader, for the capture card's picture
//! (the shared rules and the line are [`super::super::poster`]).
//!
//! The reader decodes to NV12, the H.264 decoder's own output, so Media
//! Foundation never runs a colour converter on every decoded frame; only the
//! one frame kept is turned into RGB, in Rust. A seek lands on the key frame
//! before the asked time (the recorder writes one every two seconds), and
//! frames are read forward until one within the tolerance arrives, which is
//! at most about sixty decodes a still.

use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFMediaType, IMFSample, IMFSourceReader, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE,
    MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_SUBTYPE, MF_PD_DURATION, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_SOURCE_READER_MEDIASOURCE, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED, MF_SOURCE_READERF_ENDOFSTREAM, MFCreateAttributes, MFCreateMediaType,
    MFCreateSourceReaderFromURL, MFMediaType_Video, MFVideoArea, MFVideoFormat_NV12,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::core::{GUID, HSTRING};

use super::super::poster::{self, StillSource, TOLERANCE_SECS};
use super::com;

/// Media Foundation's time unit: 100 ns.
const HNS_PER_SEC: f64 = 10_000_000.0;
/// Frames read forward from a seek before giving up on a time (two seconds
/// of key-frame interval at 30 fps, with room to spare).
const MAX_READS: u32 = 150;

/// Print the line for `args` (`... --poster <video> <seconds>...`).
/// Returns the process's exit code.
#[must_use]
pub fn run(args: &[String]) -> i32 {
    let line = match poster::parse_args(args) {
        Some((path, times)) => {
            let _com = com::Apartment::enter();
            let _media = com::MediaFoundation::start();
            match Reader::open(&path) {
                Ok(mut reader) => poster::read(&mut reader, &times),
                Err(e) => {
                    let _ = super::writeln_stderr(&format!("poster: the recording could not be opened: {e}"));
                    poster::empty_line()
                }
            }
        }
        None => poster::empty_line(),
    };
    super::super::print_line(&line)
}

/// The picture's layout as the decoder hands it over.
#[derive(Debug, Clone, Copy)]
struct Layout {
    /// The visible picture.
    width: u32,
    height: u32,
    /// Bytes from one luma row to the next (0: not said, the buffer decides).
    pitch: u32,
}

struct Reader {
    source: IMFSourceReader,
    duration: f64,
    layout: Option<Layout>,
}

/// The video stream, as the reader's `dwStreamIndex`.
const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

impl Reader {
    fn open(path: &str) -> windows::core::Result<Self> {
        // SAFETY: Media Foundation calls on objects created here, on this
        // thread, inside the apartment and MF start the caller holds.
        unsafe {
            let mut attributes: Option<IMFAttributes> = None;
            MFCreateAttributes(&raw mut attributes, 1)?;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path), attributes.as_ref())?;
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
            reader.SetStreamSelection(VIDEO, true)?;
            let wanted: IMFMediaType = MFCreateMediaType()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            reader.SetCurrentMediaType(VIDEO, None, &wanted)?;
            let duration = reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .ok()
                .and_then(|v| u64::try_from(&v).ok())
                .map_or(0.0, |hns| hns as f64 / HNS_PER_SEC);
            let mut this = Self {
                source: reader,
                duration,
                layout: None,
            };
            this.layout = this.current_layout();
            Ok(this)
        }
    }

    /// What the reader's output type says about the picture now.
    fn current_layout(&self) -> Option<Layout> {
        // SAFETY: reads of the reader's own current media type.
        unsafe {
            let kind = self.source.GetCurrentMediaType(VIDEO).ok()?;
            let packed = kind.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
            let (mut width, mut height) = ((packed >> 32) as u32, (packed & 0xFFFF_FFFF) as u32);
            // The decoder's frame is padded to 16 rows; the aperture is the
            // picture.
            let mut area = MFVideoArea::default();
            let bytes = std::slice::from_raw_parts_mut((&raw mut area).cast::<u8>(), std::mem::size_of::<MFVideoArea>());
            if kind.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes, None).is_ok()
                && area.OffsetX.value == 0
                && area.OffsetY.value == 0
                && area.Area.cx > 0
                && area.Area.cy > 0
            {
                width = width.min(area.Area.cx as u32);
                height = height.min(area.Area.cy as u32);
            }
            // A negative stride is a bottom-up RGB layout; NV12 is never one.
            let pitch = kind.GetUINT32(&MF_MT_DEFAULT_STRIDE).map_or(0, |s| (s as i32).max(0) as u32);
            Some(Layout { width, height, pitch })
        }
    }

    /// Read forward until a frame at or after `target - TOLERANCE` (hns).
    /// The last frame read is kept, so a time at the very end still gives
    /// the last picture.
    fn sample_near(&mut self, target: i64) -> Option<IMFSample> {
        let tolerance = (TOLERANCE_SECS * HNS_PER_SEC) as i64;
        let mut kept: Option<IMFSample> = None;
        for _ in 0..MAX_READS {
            let mut flags = 0u32;
            let mut stamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            // SAFETY: every out-pointer is a live local.
            let read = unsafe {
                self.source
                    .ReadSample(VIDEO, 0, None, Some(&raw mut flags), Some(&raw mut stamp), Some(&raw mut sample))
            };
            if read.is_err() {
                break;
            }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                self.layout = self.current_layout();
            }
            if let Some(sample) = sample {
                let close = stamp + tolerance >= target;
                kept = Some(sample);
                if close {
                    break;
                }
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        kept
    }

    fn picture(&self, sample: &IMFSample) -> Option<image::RgbImage> {
        let layout = self.layout?;
        // SAFETY: the buffer is locked for exactly the copy and unlocked
        // before it is dropped; `len` bytes from `data` are valid while
        // locked, as Lock documents.
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer().ok()?;
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&raw mut data, None, Some(&raw mut len)).ok()?;
            let bytes = if data.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(data, len as usize).to_vec()
            };
            let _ = buffer.Unlock();
            let pitch = if layout.pitch >= layout.width { layout.pitch } else { layout.width } as usize;
            // NV12 is a luma plane and a half-height chroma plane: the rows
            // the buffer holds, padding included.
            let rows = bytes.len() * 2 / 3 / pitch.max(1);
            poster::nv12_to_rgb(&bytes, pitch, rows, layout.width, layout.height)
        }
    }
}

impl StillSource for Reader {
    fn duration(&self) -> f64 {
        self.duration
    }

    fn still_at(&mut self, secs: f64) -> Option<image::RgbImage> {
        let target = (secs * HNS_PER_SEC) as i64;
        let at = PROPVARIANT::from(target);
        // SAFETY: GUID_NULL is 100 ns units; the PROPVARIANT lives across
        // the call.
        unsafe { self.source.SetCurrentPosition(&GUID::zeroed(), &raw const at) }.ok()?;
        let sample = self.sample_near(target)?;
        self.picture(&sample)
    }
}
