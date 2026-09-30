//! Linux recording: the app's own executable as `--capture-recorder`,
//! driven by the shared [`HelperRecorder`](super::helper).
//!
//! The recorder itself (the ScreenCast portal or X11, into GStreamer) is
//! Phase 4 of `docs/plans/2026-10-01-capture-windows-linux.md`. Until it
//! lands, recording is unavailable here and the child refuses a real `start`.

use std::path::Path;
use std::process::Command;

use super::{RecordOptions, Recorder, RecordingUnavailable, helper};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

/// Whether this build records the screen on Linux. False until the recorder
/// child can.
pub fn recording_supported() -> bool {
    false
}

/// The program that records: this executable in recorder mode.
///
/// # Errors
///
/// The running executable's path could not be read.
pub fn helper_command() -> Result<Command> {
    helper::own_recorder_command()
}

pub fn start(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    if !recording_supported() {
        return Err(AppError::Validation(RecordingUnavailable::UnsupportedPlatform.message().into()));
    }
    helper::start(helper_command()?, selection, dest, options)
}
