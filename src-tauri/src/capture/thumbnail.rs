//! The small picture on the capture card.
//!
//! Sent to the card as a `data:` URL: the capture's plaintext sits under
//! `~/.hippius/capture-tmp`, which the asset protocol deliberately does not
//! serve, and a few kilobytes of JPEG are cheaper than widening that scope.

use std::io::Cursor;
use std::path::Path;

use base64::Engine;

use crate::error::{AppError, Result};

/// Big enough for a crisp card on a Retina display, small enough to send over IPC.
pub const MAX_WIDTH: u32 = 560;
pub const MAX_HEIGHT: u32 = 360;
const JPEG_QUALITY: u8 = 80;

/// A JPEG `data:` URL of the image at `path`, scaled to fit the card.
///
/// # Errors
///
/// [`AppError::Other`] when the file cannot be read or encoded.
pub fn data_url(path: &Path) -> Result<String> {
    let image = image::open(path).map_err(|e| AppError::Other(format!("Could not read the capture for its preview: {e}")))?;
    let thumb = image.thumbnail(MAX_WIDTH, MAX_HEIGHT).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), JPEG_QUALITY)
        .encode_image(&thumb)
        .map_err(|e| AppError::Other(format!("Could not encode the capture preview: {e}")))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn a_large_capture_becomes_a_small_jpeg_that_keeps_its_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Screenshot.png");
        image::RgbaImage::from_pixel(2880, 1800, image::Rgba([49, 103, 221, 255]))
            .save(&path)
            .unwrap();

        let url = data_url(&path).unwrap();
        let b64 = url.strip_prefix("data:image/jpeg;base64,").expect("a JPEG data URL");
        let decoded = image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(b64).unwrap()).unwrap();
        assert!(decoded.width() <= MAX_WIDTH && decoded.height() <= MAX_HEIGHT);
        let (w, h) = (f64::from(decoded.width()), f64::from(decoded.height()));
        assert!((w / h - 1.6).abs() < 0.02, "{w}x{h}");
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        assert!(data_url(Path::new("/nonexistent/capture.png")).is_err());
    }
}
