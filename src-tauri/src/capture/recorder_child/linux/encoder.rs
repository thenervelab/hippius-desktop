//! The file: an encoding pipeline fed from Rust through two `appsrc`s (the
//! pictures at the recording's size, the one mixed sound track), into H.264,
//! AAC and fragmented MP4 (`linux_plan::encode`). Times are set on every
//! buffer by the writer, so pause retiming is Rust's and nothing here is
//! live. At Stop the finished file is rewritten with its index first
//! (`linux_plan::faststart`, no re-encoding); the fragments only had to
//! survive a killed recorder.

use std::path::{Path, PathBuf};
use std::time::Instant;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use super::super::frame::nv12_len;
use super::super::linux_plan::{self, EncodePlan, Encoders};
use super::super::pipeline::Encoder;
use super::capture::bus_error;
use super::say;

/// Pictures the encoder may have waiting before new ones are dropped: a
/// software encoder that cannot keep up loses frames, not memory.
const MAX_QUEUED_FRAMES: u64 = 8;
/// How long finishing the file may take.
const FINISH_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(30);
/// How long rewriting the finished file with its index first may take (a
/// copy of the file on the same disk, nothing re-encoded). Past it the
/// fragmented file is kept: it plays, only less well in browsers.
pub const REMUX_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(60);

/// 100 ns units (the writer's) to a clock time.
fn clock(hns: i64) -> gst::ClockTime {
    gst::ClockTime::from_nseconds(u64::try_from(hns).unwrap_or(0).saturating_mul(100))
}

pub struct GstEncoder {
    pipeline: gst::Pipeline,
    output: PathBuf,
    audio_track: bool,
    video: gst_app::AppSrc,
    audio: Option<gst_app::AppSrc>,
    frame_bytes: u64,
    finished: bool,
    last_drop_note: Option<Instant>,
    /// Which encoder is writing, for the self-test's report.
    pub video_encoder: &'static str,
}

impl GstEncoder {
    /// The writing pipeline for `size`, trying `candidates` in order.
    ///
    /// # Errors
    /// No encoder would start, or the file could not be created.
    pub fn create(output: &Path, size: (u32, u32), candidates: &[Encoders], audio: bool) -> Result<Self, String> {
        let path = output.to_str().ok_or("the recording's path is not UTF-8")?;
        let mut last = String::from("no H.264 encoder is installed");
        for encoders in candidates {
            let plan = EncodePlan {
                width: size.0,
                height: size.1,
                encoders: *encoders,
                audio,
                output: path.to_string(),
            };
            match Self::open(&plan) {
                Ok(encoder) => return Ok(encoder),
                Err(e) => {
                    say(&format!("{} could not start, trying the next encoder: {e}", encoders.video.factory()));
                    last = e;
                    // A failed attempt may have created the file.
                    let _ = std::fs::remove_file(output);
                }
            }
        }
        Err(format!("The recording could not start its video encoder: {last}"))
    }

    fn open(plan: &EncodePlan) -> Result<Self, String> {
        let element = gst::parse::launch(&linux_plan::encode(plan)).map_err(|e| e.to_string())?;
        let pipeline = element
            .downcast::<gst::Pipeline>()
            .map_err(|_| "the writer is not a pipeline".to_string())?;
        let src = |name: &str| {
            pipeline
                .by_name(name)
                .and_then(|e| e.downcast::<gst_app::AppSrc>().ok())
                .ok_or_else(|| format!("the writer has no {name} source"))
        };
        let video = src(linux_plan::VIDEO_SRC)?;
        let audio = if plan.audio { Some(src(linux_plan::AUDIO_SRC)?) } else { None };
        for s in std::iter::once(&video).chain(audio.as_ref()) {
            // Unbounded and never blocking: the writer thread must not stall
            // on one track while the muxer waits for the other.
            s.set_max_bytes(0);
            s.set_block(false);
        }
        if pipeline.set_state(gst::State::Playing).is_err() {
            let detail = bus_error(&pipeline).unwrap_or_else(|| "it did not start".into());
            let _ = pipeline.set_state(gst::State::Null);
            return Err(detail);
        }
        Ok(Self {
            pipeline,
            output: PathBuf::from(&plan.output),
            audio_track: plan.audio,
            video,
            audio,
            frame_bytes: u64::try_from(nv12_len(plan.width, plan.height)).unwrap_or(u64::MAX),
            finished: false,
            last_drop_note: None,
            video_encoder: plan.encoders.video.factory(),
        })
    }

    fn failed(&self) -> Result<(), String> {
        match bus_error(&self.pipeline) {
            Some(detail) => Err(format!("the encoder failed: {detail}")),
            None => Ok(()),
        }
    }

    fn push(src: &gst_app::AppSrc, bytes: Vec<u8>, start: i64, duration: i64) -> Result<(), String> {
        let mut buffer = gst::Buffer::from_mut_slice(bytes);
        if let Some(b) = buffer.get_mut() {
            b.set_pts(clock(start));
            b.set_duration(clock(duration));
        }
        src.push_buffer(buffer)
            .map(|_| ())
            .map_err(|e| format!("the encoder stopped taking data: {e:?}"))
    }
}

impl Encoder for GstEncoder {
    fn video(&mut self, nv12: &[u8], start: i64, duration: i64) -> Result<(), String> {
        self.failed()?;
        if self.video.current_level_bytes() > self.frame_bytes.saturating_mul(MAX_QUEUED_FRAMES) {
            if self.last_drop_note.is_none_or(|t| t.elapsed().as_secs() >= 5) {
                self.last_drop_note = Some(Instant::now());
                say("the video encoder is behind; a picture was dropped");
            }
            return Ok(());
        }
        Self::push(&self.video, nv12.to_vec(), start, duration)
    }

    fn audio(&mut self, pcm: &[i16], start: i64, duration: i64) -> Result<(), String> {
        let Some(audio) = &self.audio else { return Ok(()) };
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        Self::push(audio, bytes, start, duration)
    }

    fn finish(&mut self) -> Result<(), String> {
        self.failed()?;
        let _ = self.video.end_of_stream();
        if let Some(audio) = &self.audio {
            let _ = audio.end_of_stream();
        }
        let ended = self
            .pipeline
            .bus()
            .and_then(|bus| bus.timed_pop_filtered(FINISH_WITHIN, &[gst::MessageType::Eos, gst::MessageType::Error]));
        let result = match ended.as_ref().map(|m| gst::MessageRef::view(m)) {
            Some(gst::MessageView::Eos(_)) => Ok(()),
            Some(gst::MessageView::Error(err)) => Err(format!("the file could not be finished: {}", err.error())),
            _ => Err("Finishing the recording took too long; what was written is kept.".into()),
        };
        let _ = self.pipeline.set_state(gst::State::Null);
        self.finished = true;
        if result.is_ok() {
            match faststart_in_place(&self.output, self.audio_track) {
                Ok(()) => say("the recording was rewritten with its index first"),
                Err(e) => say(&format!("the recording keeps its fragments: {e}")),
            }
        }
        result
    }
}

/// Rewrite the finished recording at `output` with its index first
/// (`linux_plan::faststart`), replacing it only once the rewrite is whole
/// and checked; on any failure the fragmented file stays as it was.
///
/// # Errors
/// The rewrite failed, took too long or came out wrong.
pub fn faststart_in_place(output: &Path, audio: bool) -> Result<(), String> {
    let (remuxed, samples) = linux_plan::remux_paths(output);
    let text = |p: &Path| p.to_str().map(str::to_string).ok_or("the recording's path is not UTF-8");
    let description = linux_plan::faststart(&text(output)?, &text(&remuxed)?, &text(&samples)?, audio);
    let ran = run_to_end(&description, REMUX_WITHIN);
    // mp4mux removes its samples file itself; this covers a failed run.
    let _ = std::fs::remove_file(&samples);
    let checked = ran.and_then(|()| {
        let mut file = std::fs::File::open(&remuxed).map_err(|e| e.to_string())?;
        let boxes = linux_plan::top_level_boxes(&mut file).map_err(|e| e.to_string())?;
        if linux_plan::index_first(&boxes) {
            Ok(())
        } else {
            Err("the rewritten file does not have its index first".to_string())
        }
    });
    if let Err(e) = checked {
        let _ = std::fs::remove_file(&remuxed);
        return Err(e);
    }
    std::fs::rename(&remuxed, output).map_err(|e| {
        let _ = std::fs::remove_file(&remuxed);
        format!("the rewritten file could not replace the recording: {e}")
    })
}

/// Run a pipeline that ends by itself (a file in, a file out) to its end.
fn run_to_end(description: &str, within: gst::ClockTime) -> Result<(), String> {
    let pipeline = gst::parse::launch(description)
        .map_err(|e| e.to_string())?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "not a pipeline".to_string())?;
    if pipeline.set_state(gst::State::Playing).is_err() {
        let detail = bus_error(&pipeline).unwrap_or_else(|| "it did not start".into());
        let _ = pipeline.set_state(gst::State::Null);
        return Err(detail);
    }
    let ended = pipeline
        .bus()
        .and_then(|bus| bus.timed_pop_filtered(within, &[gst::MessageType::Eos, gst::MessageType::Error]));
    let result = match ended.as_ref().map(|m| gst::MessageRef::view(m)) {
        Some(gst::MessageView::Eos(_)) => Ok(()),
        Some(gst::MessageView::Error(err)) => Err(err.error().to_string()),
        _ => Err("it took too long".into()),
    };
    let _ = pipeline.set_state(gst::State::Null);
    result
}

impl Drop for GstEncoder {
    /// Dropped unfinished (Cancel): stop without writing the file's end.
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.pipeline.set_state(gst::State::Null);
        }
    }
}
