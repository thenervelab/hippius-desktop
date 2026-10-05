//! What a capture is called, and where in the drive it goes.

use chrono::NaiveDateTime;

use super::session::CaptureKind;

/// The folder, inside the destination drive, that captures are filed under.
pub const CAPTURES_FOLDER: &str = "Captures";

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
