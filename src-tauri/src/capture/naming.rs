//! What a capture is called, and where in the drive it goes.

use chrono::NaiveDateTime;

use super::session::CaptureKind;

/// The folder captures were filed in inside another drive, before captures
/// had a drive of their own. Captures taken then are still in folders of this
/// name, and stay there.
pub const CAPTURES_FOLDER: &str = "Captures";

/// The captures drive's LABEL: what a new captures drive is called on the
/// server whatever its folder here is named. The web console and the browser
/// extension find the captures drive by this label (`Hippius Captures`, or
/// `Hippius Captures-N`), and a drive's key is derived from its label, so it
/// never follows the folder's name. Folders made before
/// [`CAPTURES_FOLDER_NAME`] carry this name on disk too.
pub const CAPTURES_DIR_NAME: &str = "Hippius Captures";

/// The folder on disk Hippius suggests for captures (in Documents), and the
/// one it makes inside a folder too broad to upload whole (the home folder,
/// Documents, a drive that is not a captures drive). A folder the user picks
/// is used as it is, whatever its name.
pub const CAPTURES_FOLDER_NAME: &str = "hippius-captures";

/// What a card calls the captures drive before it exists.
pub const DEFAULT_DRIVE_NAME: &str = CAPTURES_DIR_NAME;

/// The file name for a capture taken at `at` (local time).
///
/// Mirrors the macOS convention (`Screenshot 2026-09-22 at 14.03.11.png`) so a
/// capture reads like one the user already knows. The time uses `.` rather
/// than `:` because `:` is illegal in a Windows file name, and a name that
/// cannot be written on one platform cannot be downloaded on it either.
pub fn capture_file_name(kind: CaptureKind, at: NaiveDateTime) -> String {
    let (stem, ext) = match kind {
        CaptureKind::Screenshot => ("Screenshot", "png"),
        CaptureKind::Recording => ("Recording", "mp4"),
    };
    format!("{stem} {} at {}.{ext}", at.format("%Y-%m-%d"), at.format("%H.%M.%S"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(h: u32, m: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, 22).unwrap().and_hms_opt(h, m, s).unwrap()
    }

    #[test]
    fn names_a_screenshot_like_the_os_does() {
        assert_eq!(
            capture_file_name(CaptureKind::Screenshot, at(14, 3, 11)),
            "Screenshot 2026-09-22 at 14.03.11.png"
        );
    }

    #[test]
    fn names_a_recording_as_an_mp4() {
        assert_eq!(
            capture_file_name(CaptureKind::Recording, at(9, 0, 5)),
            "Recording 2026-09-22 at 09.00.05.mp4"
        );
    }

    /// A name Windows cannot write is a file a Windows user cannot download.
    #[test]
    fn never_contains_a_character_windows_forbids() {
        for kind in [CaptureKind::Screenshot, CaptureKind::Recording] {
            let name = capture_file_name(kind, at(23, 59, 59));
            assert!(!name.contains([':', '/', '\\', '*', '?', '"', '<', '>', '|']), "{name}");
        }
    }
}
