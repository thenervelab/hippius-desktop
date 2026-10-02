//! The picture a Wayland area is drawn on: the first picture of the
//! monitor the user chose in the desktop's dialog, as the JPEG `area_still`
//! carries to the app (`capture::area_pick`).
//!
//! It is only something to draw on: the area comes back in the stream's own
//! pixels however large the picture was shown, so it may be smaller than
//! the stream. A 4K picture is brought down to [`MAX_LONG_EDGE`], which
//! stays sharp on a full-screen window and keeps the line short.
//!
//! Pure, so it is tested on every OS.

use super::poster;

/// The still's longest side, in pixels.
pub const MAX_LONG_EDGE: u32 = 2560;

/// The size the still is sent at: the picture's own, or brought down so
/// its longest side is [`MAX_LONG_EDGE`], keeping its shape.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn sent_size(width: u32, height: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= MAX_LONG_EDGE || long == 0 {
        return (width, height);
    }
    let k = f64::from(MAX_LONG_EDGE) / f64::from(long);
    let w = (f64::from(width) * k).round().max(1.0) as u32;
    let h = (f64::from(height) * k).round().max(1.0) as u32;
    (w, h)
}

/// A BGRx picture (rows `stride` bytes apart) as RGB, or `None` when the
/// bytes do not hold the picture.
#[must_use]
pub fn bgrx_to_rgb(data: &[u8], stride: usize, width: u32, height: u32) -> Option<image::RgbImage> {
    let row = width as usize * 4;
    if width == 0 || height == 0 || stride < row || data.len() < stride * (height as usize - 1) + row {
        return None;
    }
    let mut out = image::RgbImage::new(width, height);
    for (y, line) in out.rows_mut().enumerate() {
        let src = &data[y * stride..y * stride + row];
        for (px, bgrx) in line.zip(src.chunks_exact(4)) {
            *px = image::Rgb([bgrx[2], bgrx[1], bgrx[0]]);
        }
    }
    Some(out)
}

/// The base64 JPEG of a BGRx picture, at [`sent_size`].
#[must_use]
pub fn jpeg_from_bgrx(data: &[u8], stride: usize, width: u32, height: u32) -> Option<String> {
    let rgb = bgrx_to_rgb(data, stride, width, height)?;
    let (w, h) = sent_size(width, height);
    let rgb = if (w, h) == (width, height) {
        rgb
    } else {
        image::imageops::resize(&rgb, w, h, image::imageops::FilterType::Triangle)
    };
    poster::jpeg_base64(&rgb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    /// A 4K or 5K monitor is sent at 2560 on its long side, its shape kept;
    /// anything up to that goes as it is.
    #[test]
    fn a_large_picture_is_brought_down_and_keeps_its_shape() {
        assert_eq!(sent_size(3840, 2160), (2560, 1440));
        assert_eq!(sent_size(5120, 2880), (2560, 1440));
        assert_eq!(sent_size(2880, 1800), (2560, 1600));
        assert_eq!(sent_size(1920, 1080), (1920, 1080));
        assert_eq!(sent_size(1080, 3840), (720, 2560), "a portrait monitor");
        assert_eq!(sent_size(0, 0), (0, 0));
    }

    /// BGRx comes out as RGB, padding past each row ignored; a short buffer
    /// is no picture.
    #[test]
    fn bgrx_becomes_rgb_and_a_short_buffer_is_refused() {
        // 2x2, rows padded to 12 bytes: blue, green / red, white.
        let data = [
            255, 0, 0, 0, 0, 255, 0, 0, 9, 9, 9, 9, //
            0, 0, 255, 0, 255, 255, 255, 0, 9, 9, 9, 9,
        ];
        let rgb = bgrx_to_rgb(&data, 12, 2, 2).unwrap();
        assert_eq!(rgb.get_pixel(0, 0).0, [0, 0, 255]);
        assert_eq!(rgb.get_pixel(1, 0).0, [0, 255, 0]);
        assert_eq!(rgb.get_pixel(0, 1).0, [255, 0, 0]);
        assert_eq!(rgb.get_pixel(1, 1).0, [255, 255, 255]);
        assert!(bgrx_to_rgb(&data[..15], 12, 2, 2).is_none());
        assert!(bgrx_to_rgb(&data, 4, 2, 2).is_none(), "a stride shorter than a row");
    }

    /// The still decodes as a JPEG of the size it was sent at.
    #[test]
    fn the_still_is_a_jpeg_at_its_sent_size() {
        let (w, h) = (3000u32, 1000u32);
        let data = vec![128u8; w as usize * h as usize * 4];
        let b64 = jpeg_from_bgrx(&data, w as usize * 4, w, h).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), sent_size(w, h));
    }
}
