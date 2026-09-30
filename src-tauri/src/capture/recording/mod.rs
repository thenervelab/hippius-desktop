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
use crate::error::{AppError, Result};

/// Free space a recording needs before it starts. A Retina recording runs to
/// a few GB an hour; below this the writer would fail part way through and
/// the user would learn at Stop.
pub const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Options that apply once, at the start of a recording.
#[derive(Debug, Clone, Default)]
pub struct RecordOptions {
    /// Capture a microphone into the MP4 when the platform can.
    pub microphone: bool,
    /// Which microphone; `None` is the system default.
    pub microphone_device: Option<String>,
    /// Draw a ring where the pointer clicks, when the platform can.
    pub show_clicks: bool,
}

/// A microphone or camera the bar's pickers offer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDevice {
    /// The platform's device id (AVCaptureDevice.uniqueID on macOS), or for a
    /// camera the webview named, its `deviceId`.
    pub id: String,
    pub name: String,
    /// The system's default input of this kind.
    #[serde(default)]
    pub is_default: bool,
}

pub type Microphone = MediaDevice;

/// A device list as the pickers show it: each device once (the helper
/// gathers them from more than one macOS API, which overlap), nameless or
/// id-less entries dropped, and the system default first so "Default" in the
/// menu is the device it will really be.
#[must_use]
pub fn tidy_devices(devices: Vec<MediaDevice>) -> Vec<MediaDevice> {
    let mut out: Vec<MediaDevice> = Vec::with_capacity(devices.len());
    for d in devices {
        let id = d.id.trim();
        let name = d.name.trim();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        match out.iter_mut().find(|seen| seen.id == id) {
            Some(seen) => seen.is_default |= d.is_default,
            None => out.push(MediaDevice {
                id: id.to_string(),
                name: name.to_string(),
                is_default: d.is_default,
            }),
        }
    }
    // Only one default: the first one reported wins.
    let mut default_seen = false;
    for d in &mut out {
        if d.is_default {
            d.is_default = !default_seen;
            default_seen = true;
        }
    }
    // Stable: the rest keep the order the system lists them in.
    out.sort_by_key(|d| !d.is_default);
    out
}

/// The microphones a recording can use; empty where recording the microphone
/// is not supported.
pub fn list_microphones() -> Vec<Microphone> {
    #[cfg(target_os = "macos")]
    {
        tidy_devices(macos::list_microphones())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// The cameras the system has, named as the system names them. Listed by the
/// helper on macOS so the bar can offer them before the camera window has
/// ever opened; empty elsewhere (the camera window names them there).
pub fn list_cameras() -> Vec<MediaDevice> {
    #[cfg(target_os = "macos")]
    {
        tidy_devices(macos::list_cameras())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Whether the platform can draw click rings into a recording.
pub fn show_clicks_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::show_clicks_supported()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Whether the platform can record the microphone with a recording.
pub fn microphone_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::microphone_supported()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
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
    /// The recording ended on its own (the stream stopped, the display went
    /// away, the backend crashed). Returned once; `stop` then hands back
    /// whatever was saved, so the caller should stop and deliver.
    fn take_death(&self) -> Option<AppError> {
        None
    }
}

/// Refuse to start with less than `MIN_FREE_BYTES` free where the recording
/// is written, with a message that says what to do.
pub fn ensure_room_to_record(dir: &Path) -> Result<()> {
    match free_bytes(dir) {
        Some(free) if free < MIN_FREE_BYTES => Err(not_enough_room(free)),
        _ => Ok(()),
    }
}

fn not_enough_room(free: u64) -> AppError {
    #[allow(clippy::cast_precision_loss)]
    let gb = free as f64 / (1024.0 * 1024.0 * 1024.0);
    AppError::Validation(format!(
        "Not enough free disk space to record: {gb:.1} GB left, and a recording needs at least 2 GB. Free up some space and try again."
    ))
}

/// Bytes free for an unprivileged writer on the volume holding `dir`; `None`
/// when the platform cannot say (the recording then goes ahead).
#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
    // f_bavail counts f_frsize units, not f_bsize (see sync::migrate).
    let stat = nix::sys::statvfs::statvfs(dir).ok()?;
    #[allow(clippy::unnecessary_cast)]
    Some(stat.fragment_size() as u64 * stat.blocks_available() as u64)
}

#[cfg(not(unix))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
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
    if let Some(dir) = dest.parent() {
        ensure_room_to_record(dir)?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, name: &str, is_default: bool) -> MediaDevice {
        MediaDevice {
            id: id.into(),
            name: name.into(),
            is_default,
        }
    }

    /// The helper merges AVFoundation's and Core Audio's lists, which name
    /// most devices twice; the menu must show each once.
    #[test]
    fn a_device_listed_twice_shows_once_and_keeps_its_default_mark() {
        let tidy = tidy_devices(vec![
            dev("BuiltInMicrophoneDevice", "MacBook Pro Microphone", false),
            dev("usb-1", "Yeti Stereo Microphone", false),
            dev("BuiltInMicrophoneDevice", "MacBook Pro Microphone", true),
        ]);
        assert_eq!(tidy.len(), 2);
        assert_eq!(tidy[0], dev("BuiltInMicrophoneDevice", "MacBook Pro Microphone", true));
    }

    #[test]
    fn the_default_device_comes_first_and_the_rest_keep_their_order() {
        let tidy = tidy_devices(vec![
            dev("a", "Studio Display Microphone", false),
            dev("b", "iPhone Microphone", false),
            dev("c", "AirPods Pro", true),
            dev("d", "BlackHole 2ch", false),
        ]);
        let names: Vec<&str> = tidy.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["AirPods Pro", "Studio Display Microphone", "iPhone Microphone", "BlackHole 2ch"]);
    }

    #[test]
    fn a_full_disk_is_refused_with_a_message_that_says_what_to_do() {
        let msg = not_enough_room(512 * 1024 * 1024).to_string();
        assert!(msg.contains("0.5 GB left"), "{msg}");
        assert!(msg.contains("at least 2 GB"), "{msg}");
    }

    #[test]
    fn a_volume_with_room_is_let_through() {
        // The temp dir's volume has room on any machine that can build this.
        let dir = tempfile::tempdir().unwrap();
        if free_bytes(dir.path()).is_some_and(|free| free >= MIN_FREE_BYTES) {
            assert!(ensure_room_to_record(dir.path()).is_ok());
        }
        // A path that does not exist cannot be measured and is not refused.
        assert!(ensure_room_to_record(Path::new("/definitely/not/here")).is_ok());
    }

    #[test]
    fn nameless_devices_are_dropped_and_only_one_is_default() {
        let tidy = tidy_devices(vec![
            dev("", "Ghost", true),
            dev("x", "  ", false),
            dev("a", " Mic A ", true),
            dev("b", "Mic B", true),
        ]);
        assert_eq!(tidy, vec![dev("a", "Mic A", true), dev("b", "Mic B", false)]);
    }
}
