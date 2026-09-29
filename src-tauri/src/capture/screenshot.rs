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

/// A fresh directory for ONE capture, so its file can carry its real name
/// (the upload takes the name from the file) without colliding with another.
pub fn fresh_capture_dir(root: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let dir = tempfile::Builder::new().prefix("capture-").tempdir_in(root)?;
    // Kept, not dropped: delivery removes it once the upload has landed, and
    // a failed upload leaves it for the user to find.
    Ok(dir.keep())
}

#[cfg(any(target_os = "macos", windows))]
mod os {
    use super::{Path, Selection};
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

    /// Take the screenshot `selection` describes and write it as a PNG at
    /// `dest`. Blocking: call it from `spawn_blocking`.
    pub fn capture_to_png(selection: Selection, dest: &Path) -> Result<()> {
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
                // The scale is read off the image itself rather than trusted
                // from the OS: the overlay spans exactly this display, so
                // image pixels over overlay points IS the conversion, whatever
                // the display mode reports.
                let scale = f64::from(full.width()) / target.logical_width();
                let crop = crop_rect(rect, scale, full.width(), full.height())
                    .ok_or_else(|| AppError::Validation("Drag to select an area to capture.".into()))?;
                xcap::image::imageops::crop_imm(&full, crop.x, crop.y, crop.width, crop.height).to_image()
            }
        };
        image
            .save_with_format(dest, xcap::image::ImageFormat::Png)
            .map_err(|e| AppError::Other(format!("Could not save the screenshot: {e}")))
    }
}

#[cfg(any(target_os = "macos", windows))]
pub use os::capture_to_png;

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

    #[test]
    fn each_capture_gets_its_own_directory() {
        let root = tempfile::TempDir::new().unwrap();
        let a = fresh_capture_dir(root.path()).unwrap();
        let b = fresh_capture_dir(root.path()).unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        assert!(a.starts_with(root.path()));
    }
}
