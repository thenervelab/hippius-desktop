//! Detection of macOS Gatekeeper "App Translocation".
//!
//! When a quarantined app bundle is launched from outside `/Applications`
//! (straight from a mounted DMG, or from `~/Downloads`), Gatekeeper runs it
//! from a randomized, read-only path under `…/AppTranslocation/<UUID>/d/`.
//! macOS keys TCC folder-access consent to the app's on-disk identity, so a
//! translocated launch can never persist a Desktop/Documents grant — the
//! permission prompt reappears on every launch (the user-reported "asks 10
//! times" symptom). Surfacing this lets the UI tell the user to move Hippius
//! into `/Applications`, which clears quarantine and stops the re-prompting.
//!
//! The check is deliberately a path-segment test, not a call into the private
//! `Security.framework` `SecTranslocate*` API: no FFI, no `unsafe`, and it
//! stays unit-testable on every platform.

use std::ffi::OsStr;
use std::path::{Component, Path};

use tracing::warn;

/// Path component Gatekeeper injects into a translocated launch path.
const TRANSLOCATION_MARKER: &str = "AppTranslocation";

/// Whether `exe` sits under a Gatekeeper App Translocation mount.
///
/// Matches a whole path *component* equal to `AppTranslocation`, never a
/// substring, so an unrelated path such as `/Apps/MyAppTranslocationTool/bin`
/// is not a false positive. Pure and OS-agnostic — a non-macOS path never
/// contains the segment — which is what keeps it testable off macOS.
fn path_is_translocated(exe: &Path) -> bool {
    let marker = OsStr::new(TRANSLOCATION_MARKER);
    for component in exe.components() {
        if let Component::Normal(name) = component
            && name == marker
        {
            return true;
        }
    }
    false
}

/// Resolve the running executable and report whether it is translocated.
///
/// Returns `false` when the executable path can't be resolved — staying silent
/// on bad data is preferable to nagging the user with an unverifiable warning.
pub(crate) fn current_exe_is_translocated() -> bool {
    match std::env::current_exe() {
        Ok(exe) => path_is_translocated(&exe),
        Err(err) => {
            warn!(%err, "could not resolve current executable path; assuming not translocated");
            false
        }
    }
}

/// Whether the running app bundle is under Gatekeeper App Translocation.
///
/// The frontend calls this once on mount (race-free, unlike a fire-and-forget
/// startup event) and renders a "move Hippius to /Applications" notice when it
/// returns `true`. Always `false` off macOS, where translocation does not exist.
#[tauri::command]
pub fn is_app_translocated() -> bool {
    current_exe_is_translocated()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::path::PathBuf;

    #[test]
    fn translocated_path_detected() {
        let exe = Path::new("/private/var/folders/ab/cd1234ef/T/AppTranslocation/0F2A-UUID/d/Hippius.app/Contents/MacOS/Hippius");
        assert!(path_is_translocated(exe));
    }

    #[test]
    fn applications_path_not_translocated() {
        let exe = Path::new("/Applications/Hippius.app/Contents/MacOS/Hippius");
        assert!(!path_is_translocated(exe));
    }

    #[test]
    fn substring_in_a_segment_is_not_a_false_positive() {
        // A directory that merely *contains* the marker as a substring must not
        // trip the check — this is the whole reason for matching components.
        let exe = Path::new("/Users/me/MyAppTranslocationTool/bin/app");
        assert!(!path_is_translocated(exe));
    }

    #[test]
    fn empty_and_root_paths_are_not_translocated() {
        assert!(!path_is_translocated(Path::new("")));
        assert!(!path_is_translocated(Path::new("/")));
    }

    proptest! {
        /// The marker as its own component always trips detection, regardless
        /// of the surrounding segments. Segments are relative (no separators),
        /// so each `push` appends — `PathBuf::push` replaces the whole path on
        /// an absolute argument, which would otherwise wipe the marker.
        #[test]
        fn marker_component_always_detected(
            prefix in proptest::collection::vec("[a-z]{1,8}", 0..5),
            suffix in proptest::collection::vec("[a-z]{1,8}", 0..5),
        ) {
            let mut path = PathBuf::from("/");
            for segment in &prefix {
                path.push(segment);
            }
            path.push(TRANSLOCATION_MARKER);
            for segment in &suffix {
                path.push(segment);
            }
            prop_assert!(path_is_translocated(&path));
        }

        /// A path whose segments never *equal* the marker never trips detection,
        /// even when a segment contains it as a substring.
        #[test]
        fn non_marker_segments_never_detected(
            segments in proptest::collection::vec("[a-zA-Z]{1,12}", 0..8),
        ) {
            let mut path = PathBuf::from("/");
            for segment in &segments {
                // Suffix guarantees no segment can equal the 16-char marker.
                path.push(format!("{segment}X"));
            }
            // Exercise the substring trap explicitly alongside the random ones.
            path.push("MyAppTranslocationTool");
            prop_assert!(!path_is_translocated(&path));
        }
    }
}
