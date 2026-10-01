//! `--self-test`: the real Media Foundation writer, fed the synthetic
//! source, checked by reading the file back. For the Windows CI lane, where
//! a hosted runner has no desktop for WGC but does have Media Foundation.
//!
//! It records 3 s, pauses 1 s, records 2 s more and stops, all through the
//! same [`Pipeline`] and timeline as a real recording, then opens the file
//! with `IMFSourceReader` and checks: about 5 s long (the pause cut out),
//! one H.264 video stream and one AAC audio stream, an even picture size.
//! It runs on the clock, so it takes about six seconds.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Media::MediaFoundation::{
    IMFSourceReader, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_PD_DURATION, MF_SOURCE_READER_MEDIASOURCE, MFAudioFormat_AAC,
    MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video, MFVideoFormat_H264,
};
use windows::core::{HSTRING, PCWSTR};

use super::super::frame::{self, Bgra};
use super::super::mixer::Source;
use super::super::pipeline::Pipeline;
use super::super::synthetic::{self, Synthetic};
use super::super::timeline::Timeline;
use super::super::{Clock, Sample};
use super::{com, writer::MfWriter};

/// The picture the test records.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;

/// What `--self-test` prints.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub duration_secs: f64,
    pub video: bool,
    pub audio: bool,
    pub width: u32,
    pub height: u32,
    pub problems: Vec<String>,
}

/// Record, read back, judge.
pub fn run() -> Report {
    let _com = com::Apartment::enter();
    let _media = com::MediaFoundation::start();
    let path = std::env::temp_dir().join(format!("hippius-recorder-self-test-{}.mp4", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut report = match record(&path) {
        Ok(()) => read_back(&path),
        Err(e) => Report {
            ok: false,
            duration_secs: 0.0,
            video: false,
            audio: false,
            width: 0,
            height: 0,
            problems: vec![e],
        },
    };
    if (report.duration_secs - 5.0).abs() > 0.3 {
        report.problems.push(format!("{:.2} s long, expected 5 s", report.duration_secs));
    }
    if !report.video {
        report.problems.push("no H.264 video stream".into());
    }
    if !report.audio {
        report.problems.push("no AAC audio stream".into());
    }
    if report.width % 2 != 0 || report.height % 2 != 0 || report.width == 0 {
        report.problems.push(format!("picture {}x{} is not even", report.width, report.height));
    }
    report.ok = report.problems.is_empty();
    let _ = std::fs::remove_file(&path);
    report
}

/// 3 s, a 1 s pause, 2 s, through the real writer.
fn record(path: &Path) -> Result<(), String> {
    let writer = MfWriter::create(path, WIDTH, HEIGHT, true)?;
    let mut pipeline = Pipeline::new(writer, &[Source::Microphone]);
    let clock = Clock::start();
    let mut source = Synthetic::new(clock);
    let mut timeline = Timeline::new();
    let started = Instant::now();
    let mut paused = false;
    let mut resumed = false;
    let mut picture = Vec::new();
    let mut nv12 = Vec::new();
    while started.elapsed() < Duration::from_secs(6) {
        let elapsed = started.elapsed();
        if !paused && elapsed >= Duration::from_secs(3) {
            timeline.pause(clock.now());
            paused = true;
        }
        if paused && !resumed && elapsed >= Duration::from_secs(4) {
            timeline.resume(clock.now());
            resumed = true;
        }
        match source.next_sample() {
            Sample::Video { time, bar_x } => {
                let Some(placed) = timeline.place(time) else {
                    continue;
                };
                draw(&mut picture, bar_x);
                frame::to_nv12(
                    Bgra {
                        data: &picture,
                        width: synthetic::WIDTH,
                        height: synthetic::HEIGHT,
                        stride: synthetic::WIDTH as usize * 4,
                    },
                    WIDTH,
                    HEIGHT,
                    &mut nv12,
                );
                pipeline.video(placed, std::mem::take(&mut nv12))?;
            }
            Sample::Audio { time, samples } => {
                let Some(placed) = timeline.place(time) else {
                    continue;
                };
                let stereo: Vec<f32> = samples.iter().flat_map(|s| [*s, *s]).collect();
                pipeline.audio(Source::Microphone, placed, &stereo)?;
            }
        }
    }
    let end = timeline.end_time(clock.now(), pipeline.last_video());
    pipeline.finish(end)
}

/// The synthetic source's moving bar, in BGRA.
fn draw(picture: &mut Vec<u8>, bar_x: u32) {
    let (w, h) = (synthetic::WIDTH as usize, synthetic::HEIGHT as usize);
    picture.clear();
    picture.resize(w * h * 4, 0x20);
    let bar = bar_x as usize..(bar_x as usize + 40).min(w);
    for row in picture.chunks_exact_mut(w * 4) {
        for x in bar.clone() {
            row[x * 4..x * 4 + 4].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        }
    }
    let _ = h;
}

/// Open the file and say what is in it.
fn read_back(path: &Path) -> Report {
    let mut report = Report {
        ok: false,
        duration_secs: 0.0,
        video: false,
        audio: false,
        width: 0,
        height: 0,
        problems: Vec::new(),
    };
    let url = HSTRING::from(path.as_os_str());
    // SAFETY: Media Foundation calls on a reader created here, inside this
    // thread's apartment, with MF started.
    unsafe {
        let reader: IMFSourceReader = match MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), None) {
            Ok(reader) => reader,
            Err(e) => {
                report.problems.push(format!("the file does not open: {e}"));
                return report;
            }
        };
        #[allow(clippy::cast_sign_loss)]
        let media_source = MF_SOURCE_READER_MEDIASOURCE.0 as u32;
        if let Ok(value) = reader.GetPresentationAttribute(media_source, &MF_PD_DURATION)
            && let Ok(hns) = u64::try_from(&value)
        {
            #[allow(clippy::cast_precision_loss)]
            let secs = hns as f64 / 10_000_000.0;
            report.duration_secs = secs;
        }
        let mut index = 0u32;
        while let Ok(media_type) = reader.GetNativeMediaType(index, 0) {
            let major = media_type.GetGUID(&MF_MT_MAJOR_TYPE).unwrap_or_default();
            let subtype = media_type.GetGUID(&MF_MT_SUBTYPE).unwrap_or_default();
            if major == MFMediaType_Video && subtype == MFVideoFormat_H264 {
                report.video = true;
                if let Ok(size) = media_type.GetUINT64(&MF_MT_FRAME_SIZE) {
                    #[allow(clippy::cast_possible_truncation)]
                    {
                        report.width = (size >> 32) as u32;
                        report.height = size as u32;
                    }
                }
            } else if major == MFMediaType_Audio && subtype == MFAudioFormat_AAC {
                if report.audio {
                    report.problems.push("more than one audio stream".into());
                }
                report.audio = true;
            }
            index += 1;
        }
    }
    report
}

#[cfg(test)]
mod tests {
    /// The real Media Foundation writer, on the Windows CI lane and on any
    /// Windows dev machine: a paused take comes back 5 s long with one
    /// H.264 and one AAC stream. Skipped where Windows has no encoders (a
    /// Server or N edition without Media Foundation), which `--probe`
    /// reports as `mediaFeaturePackMissing`.
    #[test]
    fn the_real_writer_records_a_paused_take_that_reads_back() {
        if !super::super::probe::probe().encoders() {
            return;
        }
        let report = super::run();
        assert!(report.ok, "{report:?}");
    }
}
