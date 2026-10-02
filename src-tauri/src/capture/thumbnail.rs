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
    from_image(&image)
}

/// The same, from a capture still in memory: no second decode of the PNG,
/// which is what lets the card open before the file is even written.
///
/// # Errors
///
/// [`AppError::Other`] when the JPEG cannot be encoded.
pub fn from_image(image: &image::DynamicImage) -> Result<String> {
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

/// A JPEG `data:` URL of `image` scaled to fit `max_width` × `max_height`,
/// keeping its shape. For pictures taken in memory (the share picker's live
/// window and screen thumbnails), which never touch the disk.
///
/// # Errors
///
/// [`AppError::Other`] when the image is empty or cannot be encoded.
pub fn fit_data_url(image: &image::RgbaImage, max_width: u32, max_height: u32) -> Result<String> {
    if image.width() == 0 || image.height() == 0 {
        return Err(AppError::Other("There is no picture to preview.".into()));
    }
    // Fit inside the box, keep the shape, never enlarge.
    let (w, h) = (f64::from(image.width()), f64::from(image.height()));
    let scale = (f64::from(max_width) / w).min(f64::from(max_height) / h).min(1.0);
    // Both results lie in 1..=the source size, so the casts cannot truncate.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (tw, th) = (((w * scale).round() as u32).max(1), ((h * scale).round() as u32).max(1));
    let thumb = image::DynamicImage::ImageRgba8(image::imageops::thumbnail(image, tw, th)).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), JPEG_QUALITY)
        .encode_image(&thumb)
        .map_err(|e| AppError::Other(format!("Could not encode the preview: {e}")))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// A PNG `data:` URL of an encoded image (an app icon), at most `side` pixels
/// square. PNG, not JPEG: icons have transparent corners.
///
/// # Errors
///
/// [`AppError::Other`] when `encoded` is not an image this build can read.
pub fn icon_data_url(encoded: &[u8], side: u32) -> Result<String> {
    let icon = image::load_from_memory(encoded).map_err(|e| AppError::Other(format!("Could not read the icon: {e}")))?;
    let icon = if icon.width() > side || icon.height() > side {
        icon.resize(side, side, image::imageops::FilterType::Triangle)
    } else {
        icon
    };
    let mut bytes = Vec::new();
    icon.to_rgba8()
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| AppError::Other(format!("Could not encode the icon: {e}")))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn decode(url: &str, prefix: &str) -> image::DynamicImage {
        let b64 = url.strip_prefix(prefix).expect("the expected data URL type");
        image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(b64).unwrap()).unwrap()
    }

    #[test]
    fn a_window_picture_fits_the_picker_tile_and_keeps_its_shape() {
        let window = image::RgbaImage::from_pixel(3024, 1964, image::Rgba([30, 30, 30, 255]));
        let thumb = decode(&fit_data_url(&window, 480, 300).unwrap(), "data:image/jpeg;base64,");
        assert!(thumb.width() <= 480 && thumb.height() <= 300);
        let ratio = f64::from(thumb.width()) / f64::from(thumb.height());
        assert!((ratio - 3024.0 / 1964.0).abs() < 0.02, "{}x{}", thumb.width(), thumb.height());
    }

    /// A small window is not blown up into a blurry tile.
    #[test]
    fn a_small_picture_is_not_enlarged() {
        let small = image::RgbaImage::from_pixel(120, 80, image::Rgba([1, 2, 3, 255]));
        let thumb = decode(&fit_data_url(&small, 480, 300).unwrap(), "data:image/jpeg;base64,");
        assert_eq!((thumb.width(), thumb.height()), (120, 80));
        assert!(fit_data_url(&image::RgbaImage::new(0, 0), 480, 300).is_err());
    }

    #[test]
    fn an_app_icon_is_shrunk_and_keeps_its_transparency() {
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(1024, 1024, image::Rgba([200, 10, 10, 0]))
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let icon = decode(&icon_data_url(&png, 64).unwrap(), "data:image/png;base64,");
        assert_eq!((icon.width(), icon.height()), (64, 64));
        assert_eq!(icon.to_rgba8().get_pixel(0, 0)[3], 0, "transparent corners stay transparent");
        assert!(icon_data_url(b"not an image", 64).is_err());
    }

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
