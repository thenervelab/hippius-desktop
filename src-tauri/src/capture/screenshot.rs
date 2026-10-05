//! Taking the screenshot and writing it to a private temp file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::geometry::LogicalRect;

/// What the user chose in the overlay.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "target", rename_all = "camelCase")]
pub enum Selection {
    /// A dragged rectangle, in `display_id`'s local logical points.
    #[serde(rename_all = "camelCase")]
    Area { display_id: u32, rect: LogicalRect },
    #[serde(rename_all = "camelCase")]
    Window { window_id: u32 },
    #[serde(rename_all = "camelCase")]
    Screen { display_id: u32 },
}

/// Where captures wait between being taken and being uploaded.
///
/// Under `~/.hippius`, not the OS temp dir: a capture is plaintext, and a
/// crash between capture and upload should leave it somewhere this app can
/// find and clear, not in a directory it never looks at again.
pub fn capture_tmp_root() -> crate::error::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| crate::error::AppError::Other("No home directory".into()))?;
    Ok(home.join(".hippius").join("capture-tmp"))
}

/// Every capture directory starts with this.
const DIR_PREFIX: &str = "capture-";

/// A fresh directory for ONE capture, so its file can carry its real name
/// (the upload takes the name from the file) without colliding with another.
///
/// Both the root and the directory are the user's alone (0700): a capture is
/// plaintext pixels of whatever was on screen.
pub fn fresh_capture_dir(root: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    owner_only(root)?;
    let dir = tempfile::Builder::new().prefix(DIR_PREFIX).tempdir_in(root)?;
    owner_only(dir.path())?;
    // Kept, not dropped: delivery removes it once the upload has landed, and
    // a failed upload leaves it for Retry.
    Ok(dir.keep())
}

#[cfg(unix)]
fn owner_only(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Windows: the profile folder is already the user's alone.
#[cfg(not(unix))]
fn owner_only(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// An empty capture directory left this long is from a crash or an abandoned
/// start, and is removed at launch.
pub const ORPHAN_AGE: std::time::Duration = std::time::Duration::from_hours(24);

/// A directory holding only leftovers (a poster still, partial fragments)
/// is kept this long before it goes.
pub const LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_hours(7 * 24);

/// What a capture directory holds, as far as removing it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirContents {
    Empty,
    /// Nothing anyone would want back: the card's poster still, fragments.
    OnlyLeftovers,
    /// A capture (a non-empty `.mp4`, `.mov` or `.png` that is not the
    /// poster). The recorder keeps a playable MP4 when the app dies
    /// mid-recording; such a directory is NEVER removed automatically.
    Media,
}

/// What `dir` holds (see [`DirContents`]). Unreadable reads as media, so a
/// directory that cannot be inspected is kept.
pub fn dir_contents(dir: &Path) -> DirContents {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return DirContents::Media;
    };
    let mut any = false;
    for entry in entries.flatten() {
        any = true;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let size = entry.metadata().map_or(1, |m| m.len());
        if ["mp4", "mov", "png"].contains(&ext.as_str()) && name != "poster.png" && size > 0 {
            return DirContents::Media;
        }
    }
    if any { DirContents::OnlyLeftovers } else { DirContents::Empty }
}

/// Whether a capture-tmp entry can be removed at launch: one of ours (a
/// directory named `capture-…`), not the file of a card still showing, and
/// either empty for [`ORPHAN_AGE`] or only leftovers for [`LEFTOVER_AGE`].
/// A directory with a capture in it is never removed, and one whose age is
/// unknown stays.
#[must_use]
pub fn is_orphan(name: &str, is_dir: bool, age: Option<std::time::Duration>, referenced: bool, contents: DirContents) -> bool {
    if !is_dir || !name.starts_with(DIR_PREFIX) || referenced {
        return false;
    }
    let Some(age) = age else { return false };
    match contents {
        DirContents::Empty => age >= ORPHAN_AGE,
        DirContents::OnlyLeftovers => age >= LEFTOVER_AGE,
        DirContents::Media => false,
    }
}

/// Remove the orphaned capture directories under `root`; returns how many.
/// `referenced` are directories something still points at.
pub fn reclaim_orphans(root: &Path, now: std::time::SystemTime, referenced: &[PathBuf]) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
        let name = entry.file_name();
        let referenced = referenced.iter().any(|r| r == &path);
        let contents = if meta.is_dir() { dir_contents(&path) } else { DirContents::Media };
        if is_orphan(&name.to_string_lossy(), meta.is_dir(), age, referenced, contents) && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Recording needs at least this much free space where the file is written.
pub const MIN_FREE_TO_RECORD: u64 = 2 * 1024 * 1024 * 1024;

/// The refusal when `available` bytes are too few to record, or `None`.
/// An unknown amount does not refuse: a check that cannot run must not stop
/// a recording that would have fit.
#[must_use]
pub fn space_refusal(available: Option<u64>) -> Option<crate::error::AppError> {
    (available? < MIN_FREE_TO_RECORD)
        .then(|| crate::error::AppError::Validation("There isn't enough free disk space to record. Free up at least 2 GB and try again.".into()))
}

/// Free bytes on the volume holding `path` (or its nearest existing parent).
#[cfg(unix)]
pub fn available_space(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|p| p.exists())?;
    let stat = nix::sys::statvfs::statvfs(existing).ok()?;
    // f_bavail counts f_frsize units (see `sync::migrate::check_disk_space`).
    #[allow(clippy::useless_conversion)]
    Some(u64::from(stat.fragment_size()).saturating_mul(u64::from(stat.blocks_available())))
}

#[cfg(not(unix))]
pub fn available_space(_path: &Path) -> Option<u64> {
    None
}

/// Pixels per overlay point for an area on one display, read off the image
/// itself rather than trusted from the OS: the overlay spans exactly this
/// display, so image pixels over overlay points IS the conversion, whatever
/// the display mode reports. Per display, so a 150 % laptop beside a 100 %
/// monitor crops each at its own scale.
#[must_use]
pub fn area_scale(image_width: u32, logical_width: f64) -> f64 {
    if logical_width > 0.0 {
        f64::from(image_width) / logical_width
    } else {
        1.0
    }
}

#[cfg(any(target_os = "macos", windows))]
mod os {
    use super::Selection;
    use crate::capture::geometry::crop_rect;
    use crate::capture::targets::{DisplayTarget, list_displays};
    use crate::error::{AppError, Result};

    fn capture_err(e: &xcap::XCapError) -> AppError {
        AppError::Other(format!("Could not capture the screen: {e}"))
    }

    fn display_by_id(id: u32) -> Result<(xcap::Monitor, DisplayTarget)> {
        let target = list_displays()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| AppError::Validation("That display is no longer connected.".into()))?;
        let monitor = xcap::Monitor::all()
            .map_err(|e| capture_err(&e))?
            .into_iter()
            .find(|m| m.id().is_ok_and(|mid| mid == id))
            .ok_or_else(|| AppError::Validation("That display is no longer connected.".into()))?;
        Ok((monitor, target))
    }

    /// Take the screenshot `selection` describes, in memory. Blocking: call
    /// it from `spawn_blocking`.
    pub fn capture_image(selection: Selection) -> Result<image::RgbaImage> {
        let image = match selection {
            Selection::Screen { display_id } => display_by_id(display_id)?.0.capture_image().map_err(|e| capture_err(&e))?,
            Selection::Window { window_id } => xcap::Window::all()
                .map_err(|e| capture_err(&e))?
                .into_iter()
                .find(|w| w.id().is_ok_and(|id| id == window_id))
                .ok_or_else(|| AppError::Validation("That window has closed.".into()))?
                .capture_image()
                .map_err(|e| capture_err(&e))?,
            Selection::Area { display_id, rect } => {
                let (monitor, target) = display_by_id(display_id)?;
                let full = monitor.capture_image().map_err(|e| capture_err(&e))?;
                let scale = super::area_scale(full.width(), target.logical_width());
                let crop = crop_rect(rect, scale, full.width(), full.height())
                    .ok_or_else(|| AppError::Validation("Drag to select an area to capture.".into()))?;
                xcap::image::imageops::crop_imm(&full, crop.x, crop.y, crop.width, crop.height).to_image()
            }
        };
        Ok(image)
    }
}

#[cfg(any(target_os = "macos", windows))]
pub use os::capture_image;

/// Linux X11 reads the root window (`linux_x11`); a Wayland screenshot never
/// comes here, it is the desktop portal's file (`linux_portal`).
#[cfg(target_os = "linux")]
pub use super::linux_x11::capture_image;

/// Write a screenshot as a PNG. Fast compression: a Retina screenshot at the
/// default level took most of a second, which the user waited through before
/// the card appeared; the file is a little larger and loses nothing.
///
/// # Errors
///
/// [`AppError::Other`] when the file cannot be written.
pub fn save_png(image: &image::RgbaImage, dest: &Path) -> crate::error::Result<()> {
    use crate::error::AppError;
    use image::ImageEncoder;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};

    let file = std::fs::File::create(dest).map_err(|e| AppError::Other(format!("Could not save the screenshot: {e}")))?;
    PngEncoder::new_with_quality(std::io::BufWriter::new(file), CompressionType::Fast, FilterType::Adaptive)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| AppError::Other(format!("Could not save the screenshot: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The overlay posts these shapes; a rename on either side silently turns
    /// every selection into a deserialisation error.
    #[test]
    fn deserialises_each_selection_the_overlay_sends() {
        let area: Selection = serde_json::from_value(serde_json::json!({
            "target": "area", "displayId": 7, "rect": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 }
        }))
        .unwrap();
        assert_eq!(
            area,
            Selection::Area {
                display_id: 7,
                rect: LogicalRect {
                    x: 1.0,
                    y: 2.0,
                    width: 3.0,
                    height: 4.0
                }
            }
        );
        let window: Selection = serde_json::from_value(serde_json::json!({ "target": "window", "windowId": 42 })).unwrap();
        assert_eq!(window, Selection::Window { window_id: 42 });
        let screen: Selection = serde_json::from_value(serde_json::json!({ "target": "screen", "displayId": 7 })).unwrap();
        assert_eq!(screen, Selection::Screen { display_id: 7 });
    }

    /// The crop scale is the display's own: Retina 2x, a Windows 150 % laptop
    /// 1.5x, the 100 % monitor beside it 1x, a 125 % panel 1.25x.
    #[test]
    fn an_areas_scale_is_its_own_displays() {
        assert!((area_scale(3024, 1512.0) - 2.0).abs() < f64::EPSILON);
        assert!((area_scale(2880, 1920.0) - 1.5).abs() < f64::EPSILON);
        assert!((area_scale(1920, 1920.0) - 1.0).abs() < f64::EPSILON);
        assert!((area_scale(3000, 2400.0) - 1.25).abs() < f64::EPSILON);
        assert!(
            (area_scale(1920, 0.0) - 1.0).abs() < f64::EPSILON,
            "a display with no size is not divided by"
        );
        // With the scale, a drag of the whole 150 % display crops every pixel.
        let crop = crate::capture::geometry::crop_rect(
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1200.0,
            },
            area_scale(2880, 1920.0),
            2880,
            1800,
        )
        .unwrap();
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (0, 0, 2880, 1800));
    }

    #[test]
    fn only_old_unreferenced_capture_dirs_without_a_capture_are_orphans() {
        use DirContents::{Empty, Media, OnlyLeftovers};
        let day = ORPHAN_AGE;
        let hour = std::time::Duration::from_hours(1);
        assert!(is_orphan("capture-abc", true, Some(day + hour), false, Empty));
        assert!(is_orphan("capture-abc", true, Some(day), false, Empty));
        assert!(!is_orphan("capture-abc", true, day.checked_sub(hour), false, Empty), "younger than a day");
        assert!(!is_orphan("capture-abc", true, Some(day * 3), true, Empty), "a card still points at it");
        assert!(!is_orphan("capture-abc", true, None, false, Empty), "unknown age stays");
        assert!(!is_orphan("capture-abc", false, Some(day * 3), false, Empty), "not a directory");
        assert!(!is_orphan("notes", true, Some(day * 3), false, Empty), "not one of ours");
        // Leftovers wait a week; a capture is never removed.
        assert!(!is_orphan("capture-abc", true, Some(day * 3), false, OnlyLeftovers));
        assert!(is_orphan("capture-abc", true, Some(LEFTOVER_AGE), false, OnlyLeftovers));
        assert!(!is_orphan("capture-abc", true, Some(day * 365), false, Media));
    }

    #[test]
    fn a_saved_capture_counts_as_media_and_a_poster_does_not() {
        let root = tempfile::TempDir::new().unwrap();
        let dir = fresh_capture_dir(root.path()).unwrap();
        assert_eq!(dir_contents(&dir), DirContents::Empty);
        std::fs::write(dir.join("poster.png"), b"still").unwrap();
        std::fs::write(dir.join("Recording.mp4"), b"").unwrap();
        assert_eq!(dir_contents(&dir), DirContents::OnlyLeftovers, "a poster and an empty file are leftovers");
        std::fs::write(dir.join("Recording.mp4"), b"moov").unwrap();
        assert_eq!(dir_contents(&dir), DirContents::Media);
        let shot = fresh_capture_dir(root.path()).unwrap();
        std::fs::write(shot.join("Screenshot 2026-09-30 at 10.00.00.PNG"), b"png").unwrap();
        assert_eq!(dir_contents(&shot), DirContents::Media);
    }

    #[test]
    fn reclaim_removes_old_empty_dirs_and_never_a_capture() {
        let root = tempfile::TempDir::new().unwrap();
        let old = fresh_capture_dir(root.path()).unwrap();
        let kept = fresh_capture_dir(root.path()).unwrap();
        let recording = fresh_capture_dir(root.path()).unwrap();
        std::fs::write(recording.join("Recording.mp4"), b"moov").unwrap();
        let other = root.path().join("not-a-capture");
        std::fs::create_dir(&other).unwrap();
        // "Now" is two days on: all are old, one is still referenced.
        let later = std::time::SystemTime::now() + ORPHAN_AGE * 2;
        assert_eq!(reclaim_orphans(root.path(), later, std::slice::from_ref(&kept)), 1);
        assert!(!old.exists() && kept.exists() && other.exists());
        assert!(recording.exists(), "a recording left by a crash is never deleted");
        // Today, nothing is old enough.
        assert_eq!(reclaim_orphans(root.path(), std::time::SystemTime::now(), &[]), 0);
    }

    #[cfg(unix)]
    #[test]
    fn capture_dirs_are_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::TempDir::new().unwrap();
        let root = home.path().join("capture-tmp");
        let dir = fresh_capture_dir(&root).unwrap();
        for p in [&root, &dir] {
            assert_eq!(std::fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o700, "{}", p.display());
        }
    }

    #[test]
    fn recording_needs_two_gigabytes_free() {
        assert!(space_refusal(Some(MIN_FREE_TO_RECORD - 1)).is_some());
        assert!(space_refusal(Some(MIN_FREE_TO_RECORD)).is_none());
        assert!(space_refusal(None).is_none(), "an unknown amount never refuses");
        let Some(crate::error::AppError::Validation(message)) = space_refusal(Some(0)) else {
            panic!("a Validation refusal");
        };
        assert!(message.contains("2 GB"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn free_space_is_read_for_a_path_not_yet_created() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(available_space(&root.path().join("capture-tmp").join("x")).is_some_and(|b| b > 0));
    }

    #[test]
    fn each_capture_gets_its_own_directory() {
        let root = tempfile::TempDir::new().unwrap();
        let a = fresh_capture_dir(root.path()).unwrap();
        let b = fresh_capture_dir(root.path()).unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        assert!(a.starts_with(root.path()));
    }

    /// A fast-compressed PNG is still the exact picture.
    #[test]
    fn a_saved_screenshot_reads_back_pixel_for_pixel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Screenshot.png");
        let mut img = image::RgbaImage::from_pixel(64, 40, image::Rgba([49, 103, 221, 255]));
        img.put_pixel(3, 5, image::Rgba([255, 0, 0, 128]));
        save_png(&img, &path).unwrap();
        assert_eq!(image::open(&path).unwrap().to_rgba8(), img);
    }
}
