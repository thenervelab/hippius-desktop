//! Screen recording backends behind a single `Recorder` trait.
//!
//! macOS drives a small Swift helper (ScreenCaptureKit → H.264 MP4). Windows
//! will use `windows-capture` behind the same trait; until that ships, starting
//! a recording there returns a clear "not yet" error. Linux recording stays a
//! follow-up (screenshots are already deferred on Linux).

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod windows;

use std::path::Path;

use super::screenshot::Selection;
use crate::error::Result;

#[cfg(not(any(target_os = "macos", windows)))]
use crate::error::AppError;

/// Options that apply once, at the start of a recording.
#[derive(Debug, Clone, Copy)]
pub struct RecordOptions {
    /// Capture the default microphone into the MP4 when the platform can.
    pub microphone: bool,
}

impl Default for RecordOptions {
    fn default() -> Self {
        Self { microphone: true }
    }
}

/// A live recording session. One at a time; owned by `CaptureState`.
pub trait Recorder: Send {
    fn pause(&mut self) -> Result<()>;
    fn resume(&mut self) -> Result<()>;
    /// Finish the file and return its path. Consumes the recorder.
    fn stop(self: Box<Self>) -> Result<std::path::PathBuf>;
    /// Discard the file. Consumes the recorder.
    fn cancel(self: Box<Self>) -> Result<()>;
    /// Wall-clock seconds of recorded content (pauses do not advance this).
    fn elapsed_secs(&self) -> u64;
    fn microphone(&self) -> bool;
}

/// Whether this build can start a recording right now (OS + helper present).
pub fn recording_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::recording_supported()
    }
    #[cfg(windows)]
    {
        windows::recording_supported()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

/// Start recording `selection` into `dest` (an `.mp4` path).
pub fn start(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    #[cfg(target_os = "macos")]
    {
        macos::start(selection, dest, options)
    }
    #[cfg(windows)]
    {
        windows::start(selection, dest, options)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (selection, dest, options);
        Err(AppError::Validation("Screen recording isn't available on this system yet.".into()))
    }
}
