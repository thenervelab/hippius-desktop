//! Linux recording: the app's own executable as `--capture-recorder`,
//! driven by the shared [`HelperRecorder`](super::helper). The recorder
//! itself (X11 or the ScreenCast portal, PulseAudio / PipeWire, GStreamer)
//! lives in `capture::recorder_child::linux`; this side only says whether
//! this machine can record, lists the microphones and starts it.
//!
//! Whether Record is offered at all is still `capture::rollout`'s: Linux
//! recording stays on staging until its checklist passes on real sessions
//! (Phase 4 of `docs/plans/2026-10-01-capture-windows-linux.md`).

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use super::{MediaDevice, RecordOptions, Recorder, RecordingUnavailable, helper};
use crate::capture::recorder_child::linux_plan::Probe;
use crate::capture::rollout::{Platform, current_platform};
use crate::capture::screenshot::Selection;
use crate::error::Result;

/// How long the probe may take: the first GStreamer run after an install
/// builds the plugin registry, which can take several seconds.
const PROBE_WITHIN: Duration = Duration::from_secs(20);
/// How long the user may take in the desktop's screen-sharing dialog.
const PICKER_WITHIN: Duration = Duration::from_mins(5);

/// This build has a Linux recorder.
pub const fn recording_supported() -> bool {
    true
}

fn wayland() -> bool {
    current_platform() == Platform::LinuxWayland
}

/// What the recorder child says this machine has, asked once per launch
/// (`--probe`) on a thread of its own and cached. A probe that could not
/// run reads as nothing installed: Record shows disabled with the codec
/// line rather than failing at Stop.
fn machine() -> Probe {
    static PROBE: OnceLock<Probe> = OnceLock::new();
    PROBE
        .get_or_init(|| {
            let found = run_probe().unwrap_or_default();
            tracing::info!(?found, "linux recording probe");
            if !found.missing.is_empty() {
                tracing::warn!(missing = ?found.missing, "screen recording needs GStreamer elements this system lacks");
            }
            found
        })
        .clone()
}

fn run_probe() -> Option<Probe> {
    let mut program = helper_command().ok()?;
    program.arg("--probe").stdin(Stdio::null()).stderr(Stdio::null());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("capture-probe".into())
        .spawn(move || {
            let _ = tx.send(program.output());
        })
        .ok()?;
    let out = rx.recv_timeout(PROBE_WITHIN).ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find_map(|line| serde_json::from_str::<Probe>(line.trim()).ok())
}

/// Why this machine cannot record, once the lane allows Linux recording:
/// no ScreenCast portal on Wayland, or GStreamer elements missing.
pub fn unavailable() -> Option<RecordingUnavailable> {
    machine().unavailable(wayland())
}

/// Whether the recorder can open a camera itself (camera only on
/// Wayland), from the launch's probe.
pub fn camera_available() -> bool {
    wayland() && machine().records_camera(true)
}

/// The codec line for this machine: only the packages it lacks, in its
/// distribution's names (worked out once from the launch's probe), or the
/// line that names every package when the probe cannot tell.
pub fn codecs_missing_line() -> &'static str {
    use crate::capture::recorder_child::linux_plan::{codecs_missing_line, distro_family, missing_packages};
    static LINE: OnceLock<String> = OnceLock::new();
    LINE.get_or_init(|| {
        let os_release = std::fs::read_to_string("/etc/os-release")
            .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
            .unwrap_or_default();
        missing_packages(&machine(), distro_family(&os_release))
            .and_then(|packages| codecs_missing_line(&packages))
            .unwrap_or_else(|| RecordingUnavailable::CodecsMissing.message().to_string())
    })
}

/// The microphones, from the child (`--list-microphones`: PipeWire or
/// PulseAudio inputs without the monitors, the default marked).
pub fn list_microphones() -> Vec<MediaDevice> {
    helper_command().map_or_else(|_| Vec::new(), |program| helper::list_devices(program, "--list-microphones"))
}

/// The cameras, from the child (`--list-cameras`: V4L2 and PipeWire
/// cameras by the names WebKitGTK also shows).
pub fn list_cameras() -> Vec<MediaDevice> {
    helper_command().map_or_else(|_| Vec::new(), |program| helper::list_devices(program, "--list-cameras"))
}

/// The microphone meter: the child in `--meter` mode on `device` (a
/// PulseAudio source name; none = the default input).
pub fn meter_command(device: Option<&str>) -> Option<Command> {
    let mut command = helper_command().ok()?;
    command.arg("--meter");
    if let Some(id) = device.filter(|id| !id.is_empty()) {
        command.arg(id);
    }
    Some(command)
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
    // On Wayland `started` waits for the user to choose in the desktop's
    // dialog.
    let within = if wayland() { PICKER_WITHIN } else { Duration::from_secs(30) };
    helper::start_within(helper_command()?, selection, dest, options, within)
}
