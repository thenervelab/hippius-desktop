//! macOS recording: the Swift ScreenCaptureKit helper, driven over the
//! recorder protocol by the shared [`HelperRecorder`](super::helper).
//!
//! The helper ships inside the app as `Contents/MacOS/HippiusCapture`, put
//! there and signed by `macos/finalize-macos-release.sh` (see
//! `macos/embed-capture-helper.sh`). Release builds look only there. Debug
//! builds also look under `macos/HippiusCapture/.build/` so `pnpm tauri:dev`
//! works after a one-shot `macos/build-capture-helper.sh`.
//!
//! This module only says where the helper is and what this Mac can do; the
//! session itself (handshake, ids, deaths, salvage) is `super::helper`'s.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::{RecordOptions, Recorder, helper};
use crate::capture::screenshot::Selection;
use crate::error::{AppError, Result};

const HELPER_NAME: &str = "HippiusCapture";

/// ScreenCaptureKit system audio needs macOS 13+; no recording below that.
pub fn os_supports_recording() -> bool {
    macos_at_least(13, 0)
}

/// Whether this build carries the recording helper where it looks for it
/// (see [`helper_candidates`]). A local `tauri build` that skipped
/// `macos/embed-capture-helper.sh` has none.
pub fn helper_present() -> bool {
    helper_path().is_some()
}

/// ScreenCaptureKit draws click rings from macOS 15.
pub fn show_clicks_supported() -> bool {
    macos_at_least(15, 0)
}

/// The microphone joins the recording from macOS 15.
pub fn microphone_supported() -> bool {
    macos_at_least(15, 0)
}

/// The program that records: the Swift helper, when this build has one.
pub fn helper_command() -> Option<Command> {
    helper_path().map(Command::new)
}

/// The Mac's microphones, from the helper (`--list-microphones` prints them as
/// JSON and exits). Empty when the helper is missing or recording the
/// microphone is not supported here.
pub fn list_microphones() -> Vec<super::Microphone> {
    if !microphone_supported() {
        return Vec::new();
    }
    helper_command().map_or_else(Vec::new, |helper| helper::list_devices(helper, "--list-microphones"))
}

/// The Mac's cameras, from the helper (`--list-cameras`), so the bar can offer
/// them before the camera window has opened one. Empty without the helper.
pub fn list_cameras() -> Vec<super::MediaDevice> {
    if !macos_at_least(13, 0) {
        return Vec::new();
    }
    helper_command().map_or_else(Vec::new, |helper| helper::list_devices(helper, "--list-cameras"))
}

pub fn start(selection: Selection, dest: &Path, mut options: RecordOptions) -> Result<Box<dyn Recorder>> {
    if !macos_at_least(13, 0) {
        return Err(AppError::Validation("Screen recording needs macOS 13 or later.".into()));
    }
    let helper = helper_command().ok_or_else(|| AppError::Other("The screen-recording helper is missing from this build.".into()))?;
    // The helper encodes, so it gets the watermark as an atlas of every size
    // (`capture::watermark::atlas`), read once at its start and removed as
    // soon as it has answered. A write that fails records without one and
    // says so, as an unknown plan would.
    let atlas = options.watermark.then(|| watermark_atlas_path(dest));
    if let Some(path) = &atlas {
        match std::fs::write(path, crate::capture::watermark::atlas()) {
            Ok(()) => options.watermark_atlas = Some(path.clone()),
            Err(e) => tracing::warn!(error = %e, "the watermark could not be handed to the recording helper"),
        }
    }
    let started = helper::start(helper, selection, dest, options);
    if let Some(path) = &atlas {
        let _ = std::fs::remove_file(path);
    }
    started
}

/// Where the watermark's atlas waits for the helper: hidden, beside the
/// recording, in the capture's own private folder.
fn watermark_atlas_path(dest: &Path) -> PathBuf {
    dest.with_file_name(".hippius-watermark")
}

/// Where the helper may be, in the order to look. A shipped app has it in
/// one place only: beside the main binary in `Contents/MacOS`. Debug builds
/// also try the Swift package's own build products, so a dev run works
/// after `macos/build-capture-helper.sh`; release builds never probe the CI
/// checkout path that `CARGO_MANIFEST_DIR` would bake in.
fn helper_candidates(exe_dir: Option<&Path>, dev_package: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = exe_dir {
        out.push(dir.join(HELPER_NAME));
    }
    if let Some(pkg) = dev_package {
        let build = pkg.join(".build");
        out.push(build.join("release").join(HELPER_NAME));
        out.push(build.join("apple").join("Products").join("Release").join(HELPER_NAME));
        out.push(build.join("out").join("Products").join("Release").join(HELPER_NAME));
        out.push(build.join("debug").join(HELPER_NAME));
    }
    out
}

fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    #[cfg(debug_assertions)]
    let dev_package = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("macos").join("HippiusCapture"));
    #[cfg(not(debug_assertions))]
    let dev_package: Option<PathBuf> = None;
    helper_candidates(exe_dir, dev_package.as_deref()).into_iter().find(|p| p.is_file())
}

/// Whether this Mac runs at least `major.minor`. The version is read once,
/// in the cache the permission checks share ([`permissions::macos_version`]).
///
/// [`permissions::macos_version`]: crate::capture::permissions::macos_version
pub(crate) fn macos_at_least(major: u64, minor: u64) -> bool {
    crate::capture::permissions::macos_version().is_some_and(|v| v >= (major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn the_helper_is_looked_for_beside_the_app_first_and_in_the_package_only_for_dev() {
        let exe = Path::new("/Applications/Hippius.app/Contents/MacOS");
        let shipped = helper_candidates(Some(exe), None);
        assert_eq!(shipped, vec![exe.join("HippiusCapture")]);

        let pkg = Path::new("/src/macos/HippiusCapture");
        let dev = helper_candidates(Some(exe), Some(pkg));
        assert_eq!(dev[0], exe.join("HippiusCapture"));
        assert!(dev.contains(&pkg.join(".build/release/HippiusCapture")));
        assert!(dev.contains(&pkg.join(".build/apple/Products/Release/HippiusCapture")));
    }

    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }

    /// Drives the real helper end to end through this recorder:
    /// `cargo test --lib records_pauses_and_stops_for_real -- --ignored`
    /// after `macos/build-capture-helper.sh`, from a terminal allowed to
    /// record the screen. Leaves the file in the temp dir for a player.
    #[test]
    #[ignore = "records the screen: needs the helper built and Screen Recording permission"]
    fn records_pauses_and_stops_for_real() {
        let out = std::env::temp_dir().join("hippius-real-recording.mp4");
        let _ = std::fs::remove_file(&out);
        // SAFETY: CoreGraphics' main display id, no preconditions.
        let display_id = unsafe { CGMainDisplayID() };
        let mut recorder = start(Selection::Screen { display_id }, &out, RecordOptions::default()).expect("started");
        thread::sleep(Duration::from_millis(1500));
        recorder.pause().expect("paused");
        thread::sleep(Duration::from_millis(1500));
        recorder.resume().expect("resumed");
        thread::sleep(Duration::from_millis(1500));
        assert!(recorder.take_death().is_none(), "nothing died");
        let elapsed = recorder.elapsed_secs();
        let path = recorder.stop().expect("stopped");
        let size = std::fs::metadata(&path).unwrap().len();
        assert_eq!(path, out);
        assert!(size > helper::MIN_PARTIAL_BYTES, "{size} bytes");
        assert!((2..=4).contains(&elapsed), "the pause is not counted: {elapsed}");
    }

    /// Mute, unmute and a microphone switch through this recorder against
    /// the real helper, mid-recording, and the file is still saved:
    /// `cargo test --lib mutes_and_switches_the_microphone_for_real -- --ignored`
    /// on macOS 15+ with the helper built, from a terminal allowed to record
    /// the screen and the microphone. Set `HIPPIUS_TEST_SECOND_MIC` to
    /// another microphone's id (`HippiusCapture --list-microphones`) to switch
    /// to it as well. Leaves the file in the temp dir for a player.
    #[test]
    #[ignore = "records the screen and the microphone: needs the helper built and both permissions"]
    fn mutes_and_switches_the_microphone_for_real() {
        let out = std::env::temp_dir().join("hippius-real-microphone.mp4");
        let _ = std::fs::remove_file(&out);
        // SAFETY: CoreGraphics' main display id, no preconditions.
        let display_id = unsafe { CGMainDisplayID() };
        let options = RecordOptions {
            microphone: true,
            ..RecordOptions::default()
        };
        let mut recorder = start(Selection::Screen { display_id }, &out, options).expect("started");
        assert!(recorder.microphone(), "this Mac records the microphone (macOS 15+)");
        thread::sleep(Duration::from_millis(1500));
        recorder.set_microphone_muted(true).expect("muted");
        thread::sleep(Duration::from_millis(1500));
        recorder.set_microphone_muted(false).expect("unmuted");
        thread::sleep(Duration::from_secs(1));
        if let Ok(second) = std::env::var("HIPPIUS_TEST_SECOND_MIC") {
            recorder.switch_microphone(Some(second)).expect("switched");
            thread::sleep(Duration::from_millis(1500));
        }
        let refused = recorder.switch_microphone(Some("no-such-microphone".into())).unwrap_err();
        assert!(refused.to_string().contains("not connected"), "{refused}");
        recorder.switch_microphone(None).expect("back to the default");
        thread::sleep(Duration::from_secs(1));
        assert!(recorder.take_death().is_none(), "nothing died");
        let path = recorder.stop().expect("stopped");
        assert!(std::fs::metadata(&path).unwrap().len() > helper::MIN_PARTIAL_BYTES);
    }

    /// The helper trims the camera stage's margin and rounded corners by a
    /// fixed amount (`stageInset`) worked out from the page's classes. If the
    /// stage's padding or radius changes, the trim must be worked out again
    /// or the corners come back black.
    #[test]
    fn the_stage_trim_matches_the_stage_page() {
        let swift = include_str!("../../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        let page = include_str!("../../../../app/capture-camera/page.tsx");
        let shape = include_str!("../../../../app/capture-camera/cameraDevices.ts");
        assert!(
            swift.contains("let stageInset: CGFloat = 12"),
            "HippiusCapture.swift lost its stage inset"
        );
        assert!(
            page.contains("fixed inset-0 p-1.5") && shape.contains("\"h-full w-full rounded-[18px]\""),
            "the camera stage's margin (p-1.5) or corner radius (rounded-[18px]) changed; \
             recompute stageInset in macos/HippiusCapture/Sources/HippiusCapture.swift"
        );
    }
}
