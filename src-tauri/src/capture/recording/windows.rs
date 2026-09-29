//! Windows recording backend (stub).
//!
//! Phase 3 of the plan wires `windows-capture` (Windows.Graphics.Capture +
//! Media Foundation) behind the same `Recorder` trait. Until then, the Capture
//! menu's Record items are hidden on Windows via `capture_support.recording`,
//! and a direct IPC still gets a clear error rather than a black hole.

use std::path::Path;

use super::{RecordOptions, Recorder};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

pub fn recording_supported() -> bool {
    false
}

pub fn start(_selection: Selection, _dest: &Path, _options: RecordOptions) -> Result<Box<dyn Recorder>> {
    Err(AppError::Validation("Screen recording on Windows is coming in a later update.".into()))
}
