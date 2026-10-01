//! Windows recording: the app's own executable as `--capture-recorder`,
//! driven by the shared [`HelperRecorder`](super::helper). The recorder
//! itself (Windows.Graphics.Capture, WASAPI, Media Foundation) lives in
//! `capture::recorder_child::windows`; this side only says whether this
//! machine can record and starts it.
//!
//! Whether Record is offered at all is still `capture::rollout`'s: Windows
//! recording stays on staging until its hardware checklist passes (Phase 2
//! of `docs/plans/2026-10-01-capture-windows-linux.md`).

use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

use super::{MediaDevice, RecordOptions, Recorder, helper};
use crate::capture::recorder_child::windows::probe::{self, Probe};
use crate::capture::screenshot::Selection;
use crate::error::Result;

/// This build has a Windows recorder.
pub const fn recording_supported() -> bool {
    true
}

/// Windows.Graphics.Capture's controls and `WDA_EXCLUDEFROMCAPTURE` need
/// Windows 10 version 2004 (build 19041); below it recording is `osTooOld`.
pub fn os_supports_recording() -> bool {
    use crate::capture::permissions::{windows_build, windows_excludes_from_capture};
    windows_excludes_from_capture(windows_build())
}

/// What Media Foundation offers here, asked once per launch. Asked on a
/// thread of its own: the caller may be the UI thread, whose COM apartment
/// Media Foundation must not change.
fn machine() -> Probe {
    static PROBE: OnceLock<Probe> = OnceLock::new();
    *PROBE.get_or_init(|| {
        let found = std::thread::spawn(probe::probe).join().unwrap_or(Probe {
            build: None,
            os_supported: false,
            h264_encoder: false,
            aac_encoder: false,
            hardware_h264: false,
        });
        tracing::info!(?found, "windows recording probe");
        found
    })
}

/// Both encoders are present (a Windows N edition without the Media
/// Feature Pack has neither).
pub fn encoders_present() -> bool {
    machine().encoders()
}

/// The microphone can be recorded unless Windows' privacy settings block
/// desktop apps from it.
pub fn microphone_supported() -> bool {
    !crate::capture::permissions::windows_privacy_blocks(crate::capture::permissions::PrivacyDevice::Microphone)
}

/// The microphones, from the child (`--list-microphones`: WASAPI capture
/// endpoints, the default marked).
pub fn list_microphones() -> Vec<MediaDevice> {
    helper_command().map_or_else(|_| Vec::new(), |program| helper::list_devices(program, "--list-microphones"))
}

/// The program that records: this executable in recorder mode, with no
/// console window of its own (a debug build is a console program).
///
/// # Errors
///
/// The running executable's path could not be read.
pub fn helper_command() -> Result<Command> {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`: no console flashes up for the child.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut program = helper::own_recorder_command()?;
    program.creation_flags(CREATE_NO_WINDOW);
    Ok(program)
}

pub fn start(selection: Selection, dest: &Path, options: RecordOptions) -> Result<Box<dyn Recorder>> {
    helper::start(helper_command()?, selection, dest, options)
}
