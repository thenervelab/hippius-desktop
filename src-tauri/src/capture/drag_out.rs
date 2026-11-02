//! Drag a capture out of the card into another app as a real file.
//!
//! The card's picture is an `<img>` with a `data:` URL, and the webview's own
//! drag of it hands other apps that URL: dropped into a chat app it pasted a
//! huge string of text instead of the picture. So the page cancels the
//! webview's drag and asks Rust to start the system's own file drag with the
//! capture's file on this computer (`drag` crate: an `NSDraggingSession` on
//! macOS, OLE `DoDragDrop` on Windows, a GTK drag on Linux), the same drag a
//! file manager starts. The drop target receives the PNG or MP4 itself, a
//! copy of it; the capture, its drive and its link are untouched.
//!
//! The page never names a path: the card's own file is looked up here.

use std::io::Cursor;
use std::path::PathBuf;

use base64::Engine;

use crate::error::{AppError, Result};

/// The drag picture's longest side, in pixels: a thumbnail under the
/// pointer, not the capture at full size.
pub const ICON_SIDE: u32 = 160;

/// Shown under the pointer when the card has no picture (a recording whose
/// first frame could not be read).
const FALLBACK_ICON: &[u8] = include_bytes!("../../icons/128x128.png");

/// The file a drag of the card hands out: the capture in its drive folder
/// when it is placed there, else the copy kept while it uploads. `None`
/// when neither is on this computer any more.
#[must_use]
pub fn file_to_drag(placed: Option<&PathBuf>, kept: &std::path::Path) -> Option<PathBuf> {
    placed
        .filter(|p| p.is_file())
        .cloned()
        .or_else(|| kept.is_file().then(|| kept.to_path_buf()))
}

/// The picture under the pointer while dragging, as PNG bytes: the card's
/// thumbnail (a JPEG `data:` URL) scaled to [`ICON_SIDE`], or the app icon.
#[must_use]
pub fn drag_icon(thumbnail: Option<&str>) -> Vec<u8> {
    thumbnail.and_then(icon_from_data_url).unwrap_or_else(|| FALLBACK_ICON.to_vec())
}

fn icon_from_data_url(url: &str) -> Option<Vec<u8>> {
    let (_, b64) = url.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let picture = image::load_from_memory(&bytes).ok()?;
    let small = picture.thumbnail(ICON_SIDE, ICON_SIDE);
    let mut png = Vec::new();
    small.to_rgba8().write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}

/// Start the system's file drag of `file` from `window`, on the main thread
/// (AppKit, OLE and GTK all drag from there). Called while the mouse button
/// that began the drag is still down. `ended` runs once the drop or the
/// cancel is over, and also when the drag could not start.
pub fn start(window: &tauri::WebviewWindow, file: PathBuf, icon: Vec<u8>, ended: impl Fn() + Send + Sync + 'static) -> Result<()> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let ended = std::sync::Arc::new(ended);
            let on_drop = {
                let ended = ended.clone();
                move |result: drag::DragResult, _: drag::CursorPosition| {
                    tracing::debug!(?result, "capture: card drag ended");
                    ended();
                }
            };
            let item = drag::DragItem::Files(vec![file]);
            let image = drag::Image::Raw(icon);
            #[cfg(target_os = "linux")]
            let started = target
                .gtk_window()
                .map_err(|e| e.to_string())
                .and_then(|w| drag::start_drag(&w, item, image, on_drop, drag::Options::default()).map_err(|e| e.to_string()));
            #[cfg(not(target_os = "linux"))]
            let started = drag::start_drag(&target, item, image, on_drop, drag::Options::default()).map_err(|e| e.to_string());
            if let Err(e) = started {
                tracing::warn!(error = %e, "capture: the card's file drag did not start");
                ended();
            }
        })
        .map_err(|e| AppError::Other(format!("Could not start the drag: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_drag_hands_out_the_placed_file_else_the_kept_copy() {
        let dir = tempfile::TempDir::new().unwrap();
        let placed = dir.path().join("in-drive.png");
        let kept = dir.path().join("kept.png");
        std::fs::write(&kept, b"kept").unwrap();
        assert_eq!(file_to_drag(Some(&placed), &kept), Some(kept.clone()), "a placed path not there yet");
        std::fs::write(&placed, b"placed").unwrap();
        assert_eq!(file_to_drag(Some(&placed), &kept), Some(placed.clone()));
        assert_eq!(file_to_drag(None, &kept), Some(kept.clone()));
        std::fs::remove_file(&kept).unwrap();
        assert_eq!(file_to_drag(None, &kept), None, "nothing on this computer to drag");
    }

    #[test]
    fn the_drag_picture_is_a_small_png_of_the_thumbnail() {
        let big = image::RgbImage::from_pixel(560, 315, image::Rgb([10, 20, 30]));
        let url = super::super::thumbnail::from_image(&image::DynamicImage::ImageRgb8(big)).unwrap();
        let icon = image::load_from_memory(&drag_icon(Some(&url))).unwrap();
        assert_eq!((icon.width(), icon.height()), (ICON_SIDE, 90), "fits the side, keeps the shape");
        assert_eq!(&drag_icon(Some(&url))[..4], b"\x89PNG");
    }

    #[test]
    fn a_card_without_a_readable_picture_drags_the_app_icon() {
        assert_eq!(drag_icon(None), FALLBACK_ICON);
        assert_eq!(drag_icon(Some("data:image/jpeg;base64,not base64")), FALLBACK_ICON);
        assert!(image::load_from_memory(FALLBACK_ICON).is_ok());
    }
}
