//! A captured BGRA picture to the encoder's NV12, at the recording's fixed
//! size.
//!
//! The output size is decided once, at Start (an MP4's picture size cannot
//! change mid-file). What arrives later may differ: a recorded window that
//! is resized, or a display above [`super::sizing::MAX_LONG_EDGE`]. Every
//! picture is therefore fitted into the output whole, centred, with black
//! bars where the shapes differ (letterboxing), and scaled with bilinear
//! filtering when its size is not the output's.
//!
//! Colour is BT.709 limited range, the matrix the Swift helper tags its
//! files with, so a Windows recording plays with the same colours as a Mac
//! one. NV12 is what every H.264 encoder takes (hardware ones take nothing
//! else), so the encoder never has to insert a converter of its own.
//!
//! Pure CPU code, so it is tested on every OS. A GPU video processor would
//! do the same work for free on most machines (the plan's `gpu.rs`); spike
//! W3 measures whether 4K at 30 fps needs it.

/// Where a picture goes inside the output: the fitted rectangle, in output
/// pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The largest rectangle with the source's shape that fits `out`, centred,
/// on even pixels (NV12 shares one colour sample between 2x2 pixels).
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn fit(src_w: u32, src_h: u32, out_w: u32, out_h: u32) -> Placement {
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        return Placement {
            x: 0,
            y: 0,
            width: out_w,
            height: out_h,
        };
    }
    if src_w == out_w && src_h == out_h {
        return Placement {
            x: 0,
            y: 0,
            width: out_w,
            height: out_h,
        };
    }
    let k = (f64::from(out_w) / f64::from(src_w)).min(f64::from(out_h) / f64::from(src_h));
    let even = |v: f64, max: u32| ((v.round() as u32) & !1).clamp(2.min(max), max);
    let width = even(f64::from(src_w) * k, out_w);
    let height = even(f64::from(src_h) * k, out_h);
    Placement {
        x: ((out_w - width) / 2) & !1,
        y: ((out_h - height) / 2) & !1,
        width,
        height,
    }
}

/// A BGRA picture in memory, rows `stride` bytes apart.
#[derive(Debug, Clone, Copy)]
pub struct Bgra<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

/// The bytes an NV12 picture of `width` x `height` (both even) takes: a full
/// luma plane, then one interleaved Cb/Cr pair per 2x2 block.
#[must_use]
pub const fn nv12_len(width: u32, height: u32) -> usize {
    (width as usize) * (height as usize) * 3 / 2
}

/// BT.709 limited range, 8-bit fixed point (x256).
#[inline]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    clamp_u8(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16)
}

#[inline]
fn chroma(r: i32, g: i32, b: i32) -> (u8, u8) {
    let cb = ((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128;
    let cr = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
    (clamp_u8(cb), clamp_u8(cr))
}

#[inline]
fn clamp_u8(v: i32) -> u8 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let v = v.clamp(0, 255) as u8;
    v
}

/// Black in BT.709 limited range.
const BLACK_Y: u8 = 16;
const BLACK_C: u8 = 128;

/// One output pixel's colour, read from the source with bilinear filtering
/// (or straight, when the sizes match).
struct Sampler<'a> {
    src: Bgra<'a>,
    /// Source pixels per output pixel, each way.
    sx: f64,
    sy: f64,
    identity: bool,
}

impl Sampler<'_> {
    #[inline]
    fn px(&self, x: u32, y: u32) -> (i32, i32, i32) {
        let x = x.min(self.src.width - 1) as usize;
        let y = y.min(self.src.height - 1) as usize;
        let at = y * self.src.stride + x * 4;
        let p = &self.src.data[at..at + 4];
        (i32::from(p[2]), i32::from(p[1]), i32::from(p[0]))
    }

    /// The colour at output pixel (`ox`, `oy`) of the placed rectangle.
    #[inline]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn rgb(&self, ox: u32, oy: u32) -> (i32, i32, i32) {
        if self.identity {
            return self.px(ox, oy);
        }
        // Pixel centres map to pixel centres.
        let fx = ((f64::from(ox) + 0.5) * self.sx - 0.5).max(0.0);
        let fy = ((f64::from(oy) + 0.5) * self.sy - 0.5).max(0.0);
        let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
        let tx = (((fx - fx.floor()) * 256.0) as i32).min(256);
        let ty = (((fy - fy.floor()) * 256.0) as i32).min(256);
        let a = self.px(x0, y0);
        let b = self.px(x0 + 1, y0);
        let c = self.px(x0, y0 + 1);
        let d = self.px(x0 + 1, y0 + 1);
        let mix = |p: i32, q: i32, t: i32| p + (((q - p) * t) >> 8);
        (
            mix(mix(a.0, b.0, tx), mix(c.0, d.0, tx), ty),
            mix(mix(a.1, b.1, tx), mix(c.1, d.1, tx), ty),
            mix(mix(a.2, b.2, tx), mix(c.2, d.2, tx), ty),
        )
    }
}

/// Draw `src` into an NV12 picture of `out_w` x `out_h` (even), fitted and
/// centred, black around it. `out` is resized to [`nv12_len`].
///
/// # Panics
///
/// Never for a well-formed picture; a `src` whose `data` is shorter than
/// `stride * height` is drawn as black instead of read out of bounds.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn to_nv12(src: Bgra<'_>, out_w: u32, out_h: u32, out: &mut Vec<u8>) {
    let (cols, rows) = (out_w as usize, out_h as usize);
    out.clear();
    out.resize(nv12_len(out_w, out_h), 0);
    let (luma_plane, chroma_plane) = out.split_at_mut(cols * rows);
    luma_plane.fill(BLACK_Y);
    chroma_plane.fill(BLACK_C);

    let readable = src.width > 0
        && src.height > 0
        && src.stride >= src.width as usize * 4
        && src.data.len() >= src.stride * (src.height as usize - 1) + src.width as usize * 4;
    if !readable || cols == 0 || rows == 0 {
        return;
    }
    let place = fit(src.width, src.height, out_w, out_h);
    let sampler = Sampler {
        src,
        sx: f64::from(src.width) / f64::from(place.width),
        sy: f64::from(src.height) / f64::from(place.height),
        identity: place.width == src.width && place.height == src.height,
    };
    // Two rows at a time: each 2x2 block yields four luma samples and one
    // chroma pair, averaged from the block's four colours.
    let mut oy = 0;
    while oy + 1 < place.height {
        let row0 = (place.y + oy) as usize * cols;
        let row1 = row0 + cols;
        let crow = (place.y + oy) as usize / 2 * cols;
        let mut ox = 0;
        while ox + 1 < place.width {
            let p00 = sampler.rgb(ox, oy);
            let p01 = sampler.rgb(ox + 1, oy);
            let p10 = sampler.rgb(ox, oy + 1);
            let p11 = sampler.rgb(ox + 1, oy + 1);
            let col = (place.x + ox) as usize;
            luma_plane[row0 + col] = luma(p00.0, p00.1, p00.2);
            luma_plane[row0 + col + 1] = luma(p01.0, p01.1, p01.2);
            luma_plane[row1 + col] = luma(p10.0, p10.1, p10.2);
            luma_plane[row1 + col + 1] = luma(p11.0, p11.1, p11.2);
            let red = (p00.0 + p01.0 + p10.0 + p11.0 + 2) / 4;
            let green = (p00.1 + p01.1 + p10.1 + p11.1 + 2) / 4;
            let blue = (p00.2 + p01.2 + p10.2 + p11.2 + 2) / 4;
            let (cb, cr) = chroma(red, green, blue);
            chroma_plane[crow + col] = cb;
            chroma_plane[crow + col + 1] = cr;
            ox += 2;
        }
        oy += 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, bgra: [u8; 4]) -> Vec<u8> {
        bgra.iter().copied().cycle().take(width as usize * height as usize * 4).collect()
    }

    fn nv12(width: u32, height: u32, bgra: [u8; 4], out_w: u32, out_h: u32) -> Vec<u8> {
        let data = solid(width, height, bgra);
        let mut out = Vec::new();
        to_nv12(
            Bgra {
                data: &data,
                width,
                height,
                stride: width as usize * 4,
            },
            out_w,
            out_h,
            &mut out,
        );
        out
    }

    #[test]
    fn white_black_and_red_are_bt709_limited_range() {
        let white = nv12(4, 4, [255, 255, 255, 255], 4, 4);
        assert_eq!((white[0], white[16], white[17]), (235, 128, 128));
        let black = nv12(4, 4, [0, 0, 0, 255], 4, 4);
        assert_eq!((black[0], black[16], black[17]), (16, 128, 128));
        // Pure red in BT.709 limited range: Y 63, Cb 102, Cr 240.
        let red = nv12(4, 4, [0, 0, 255, 255], 4, 4);
        assert_eq!(red[0], 63);
        assert!((101..=103).contains(&red[16]), "Cb {}", red[16]);
        assert!((239..=240).contains(&red[17]), "Cr {}", red[17]);
    }

    #[test]
    fn nv12_has_a_full_luma_plane_and_a_quarter_size_chroma_plane() {
        assert_eq!(nv12_len(1920, 1080), 1920 * 1080 * 3 / 2);
        assert_eq!(nv12(8, 6, [9, 9, 9, 255], 8, 6).len(), 72);
    }

    /// A window made narrower after Start is drawn whole in the middle of
    /// the frame, black either side, never stretched.
    #[test]
    fn a_narrower_picture_is_pillarboxed_in_the_middle() {
        assert_eq!(
            fit(800, 1000, 1000, 1000),
            Placement {
                x: 100,
                y: 0,
                width: 800,
                height: 1000
            }
        );
        let out = nv12(4, 8, [255, 255, 255, 255], 8, 8);
        let row: Vec<u8> = out[..8].to_vec();
        assert_eq!(row, vec![16, 16, 235, 235, 235, 235, 16, 16]);
    }

    #[test]
    fn a_wider_picture_is_letterboxed_and_a_bigger_one_scaled_down() {
        assert_eq!(
            fit(1920, 1080, 1280, 1280),
            Placement {
                x: 0,
                y: 280,
                width: 1280,
                height: 720
            }
        );
        // A 5K display into the 3840 cap keeps its shape.
        assert_eq!(
            fit(5120, 2880, 3840, 2160),
            Placement {
                x: 0,
                y: 0,
                width: 3840,
                height: 2160
            }
        );
        let out = nv12(16, 16, [255, 255, 255, 255], 8, 8);
        assert!(out[..64].iter().all(|y| *y == 235), "scaled, not cropped");
    }

    #[test]
    fn same_size_is_copied_pixel_for_pixel() {
        // A left half black, right half white picture keeps its edge exactly.
        let mut data = solid(4, 2, [0, 0, 0, 255]);
        for row in 0..2 {
            for x in 2..4 {
                let at = row * 16 + x * 4;
                data[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        let mut out = Vec::new();
        to_nv12(
            Bgra {
                data: &data,
                width: 4,
                height: 2,
                stride: 16,
            },
            4,
            2,
            &mut out,
        );
        assert_eq!(&out[..4], &[16, 16, 235, 235]);
    }

    /// GPU staging textures pad each row; the padding is never drawn.
    #[test]
    fn row_padding_is_skipped() {
        let mut data = vec![0u8; 2 * 32];
        for row in 0..2 {
            for x in 0..2 {
                let at = row * 32 + x * 4;
                data[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
            // Bright garbage in the padding.
            data[row * 32 + 8..row * 32 + 32].fill(0x7f);
        }
        let mut out = Vec::new();
        to_nv12(
            Bgra {
                data: &data,
                width: 2,
                height: 2,
                stride: 32,
            },
            2,
            2,
            &mut out,
        );
        assert_eq!(&out[..4], &[235, 235, 235, 235]);
    }

    #[test]
    fn a_short_buffer_draws_black_instead_of_reading_past_its_end() {
        let data = vec![255u8; 10];
        let mut out = Vec::new();
        to_nv12(
            Bgra {
                data: &data,
                width: 4,
                height: 4,
                stride: 16,
            },
            4,
            4,
            &mut out,
        );
        assert!(out[..16].iter().all(|y| *y == 16));
    }
}
