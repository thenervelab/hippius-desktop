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
//! Pure CPU code, so it is tested on every OS. A 4K picture is converted in
//! horizontal bands on up to four threads ([`bands_for`]), byte for byte what
//! one thread writes. A GPU video processor would do the same work for free
//! on most machines (the plan's `gpu.rs`); spike W3 weighs the two.

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

/// Output pictures of at least this many pixels (4K) are converted in
/// horizontal bands on up to [`MAX_BANDS`] threads. Measured (spike W3, the
/// plan's "Parity gaps closed after Phase 6"): 4K on one core takes 27 ms a
/// frame at the same size and 75 ms scaled on an M3 Max, beyond the 33 ms a
/// frame 30 fps allows once a laptop core is slower; 1440p and below fit on
/// one core, where a thread hand-off would cost more than it saves.
const PARALLEL_FROM_PIXELS: u64 = 3840 * 2160;
/// Four bands: about 4x on the scaled 4K path, and the capture thread does
/// not take every core of a 4-core laptop from the encoder.
const MAX_BANDS: usize = 4;

/// How many bands an `out_w` x `out_h` picture is converted in, given the
/// machine's parallelism.
#[must_use]
pub fn bands_for(out_w: u32, out_h: u32, parallelism: usize) -> usize {
    if u64::from(out_w) * u64::from(out_h) >= PARALLEL_FROM_PIXELS {
        parallelism.clamp(1, MAX_BANDS)
    } else {
        1
    }
}

/// Draw `src` into an NV12 picture of `out_w` x `out_h` (even), fitted and
/// centred, black around it. `out` is resized to [`nv12_len`]. A 4K picture
/// is converted on several threads ([`bands_for`]); the bytes are the same
/// as on one.
///
/// # Panics
///
/// Never for a well-formed picture; a `src` whose `data` is shorter than
/// `stride * height` is drawn as black instead of read out of bounds.
pub fn to_nv12(src: Bgra<'_>, out_w: u32, out_h: u32, out: &mut Vec<u8>) {
    let parallelism = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    to_nv12_in_bands(src, out_w, out_h, out, bands_for(out_w, out_h, parallelism));
}

/// [`to_nv12`] in `bands` horizontal bands, each on its own thread (the
/// first on the caller's). A band owns whole 2-row blocks, so its luma rows
/// and its chroma row are its own and no two threads write one byte.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn to_nv12_in_bands(src: Bgra<'_>, out_w: u32, out_h: u32, out: &mut Vec<u8>, bands: usize) {
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
    // The placed rectangle's 2-row blocks: `place.y` is even, so block `k`
    // is luma rows `place.y + 2k` and `+ 1` and chroma row `place.y / 2 + k`.
    let first = place.y as usize;
    let pairs = place.height as usize / 2;
    if pairs == 0 {
        return;
    }
    let luma_rows = &mut luma_plane[first * cols..(first + pairs * 2) * cols];
    let chroma_rows = &mut chroma_plane[first / 2 * cols..(first / 2 + pairs) * cols];
    let per_band = pairs.div_ceil(bands.max(1));
    let mut work = luma_rows
        .chunks_mut(per_band * 2 * cols)
        .zip(chroma_rows.chunks_mut(per_band * cols))
        .enumerate();
    let Some((_, (own_luma, own_chroma))) = work.next() else {
        return;
    };
    let sampler = &sampler;
    std::thread::scope(|scope| {
        for (band, (y_rows, c_rows)) in work {
            scope.spawn(move || draw_band(sampler, place, cols, band * per_band * 2, y_rows, c_rows));
        }
        draw_band(sampler, place, cols, 0, own_luma, own_chroma);
    });
}

/// Draw the 2-row blocks of the placed rectangle from output row
/// `first_row` (relative to `place.y`): `y_rows` holds two luma rows a
/// block, `c_rows` one chroma row.
#[allow(clippy::cast_possible_truncation)]
fn draw_band(sampler: &Sampler<'_>, place: Placement, cols: usize, first_row: usize, y_rows: &mut [u8], c_rows: &mut [u8]) {
    // Two rows at a time: each 2x2 block yields four luma samples and one
    // chroma pair, averaged from the block's four colours.
    for block in 0..c_rows.len() / cols {
        let oy = (first_row + block * 2) as u32;
        let row0 = block * 2 * cols;
        let row1 = row0 + cols;
        let crow = block * cols;
        let mut ox = 0;
        while ox + 1 < place.width {
            let p00 = sampler.rgb(ox, oy);
            let p01 = sampler.rgb(ox + 1, oy);
            let p10 = sampler.rgb(ox, oy + 1);
            let p11 = sampler.rgb(ox + 1, oy + 1);
            let col = (place.x + ox) as usize;
            y_rows[row0 + col] = luma(p00.0, p00.1, p00.2);
            y_rows[row0 + col + 1] = luma(p01.0, p01.1, p01.2);
            y_rows[row1 + col] = luma(p10.0, p10.1, p10.2);
            y_rows[row1 + col + 1] = luma(p11.0, p11.1, p11.2);
            let red = (p00.0 + p01.0 + p10.0 + p11.0 + 2) / 4;
            let green = (p00.1 + p01.1 + p10.1 + p11.1 + 2) / 4;
            let blue = (p00.2 + p01.2 + p10.2 + p11.2 + 2) / 4;
            let (cb, cr) = chroma(red, green, blue);
            c_rows[crow + col] = cb;
            c_rows[crow + col + 1] = cr;
            ox += 2;
        }
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

    /// A picture whose bytes are all different, so a band drawn from the
    /// wrong rows (or not drawn) shows.
    fn noise(height: u32, stride: usize) -> Vec<u8> {
        let mut state = 0x9E37_79B9_u32;
        (0..stride * height as usize)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state.to_le_bytes()[0]
            })
            .collect()
    }

    /// Spike W3: the banded conversion writes exactly the bytes the single
    /// thread does, whether the picture is copied, scaled down or up,
    /// letterboxed or pillarboxed, padded, and whether the blocks divide
    /// evenly into bands or there are more bands than blocks.
    #[test]
    fn bands_give_the_same_bytes_as_one_thread() {
        // (source width, height, row padding in bytes, output width, height)
        let cases = [
            (64, 36, 0, 64, 36),  // same size
            (100, 70, 0, 64, 36), // scaled down, letterboxed
            (30, 60, 8, 64, 36),  // pillarboxed, padded rows
            (33, 19, 4, 66, 38),  // scaled up; 19 blocks, not a multiple of 4
            (8, 2, 0, 8, 2),      // one block, more bands than blocks
            (50, 50, 0, 40, 30),  // a square in a wide frame
        ];
        for (w, h, pad, out_w, out_h) in cases {
            let stride = w as usize * 4 + pad;
            let data = noise(h, stride);
            let src = Bgra {
                data: &data,
                width: w,
                height: h,
                stride,
            };
            let mut one = Vec::new();
            to_nv12_in_bands(src, out_w, out_h, &mut one, 1);
            for bands in 2..=5 {
                let mut many = Vec::new();
                to_nv12_in_bands(src, out_w, out_h, &mut many, bands);
                assert!(one == many, "{w}x{h} into {out_w}x{out_h} in {bands} bands differs from one thread");
            }
            let mut public = Vec::new();
            to_nv12(src, out_w, out_h, &mut public);
            assert!(one == public, "to_nv12 for {w}x{h} into {out_w}x{out_h}");
        }
    }

    /// Only 4K and above is split, into at most four bands; a machine with
    /// one core never spawns.
    #[test]
    fn only_4k_pictures_are_split_and_into_four_bands_at_most() {
        assert_eq!(bands_for(2560, 1440, 16), 1);
        assert_eq!(bands_for(3840, 2158, 16), 1);
        assert_eq!(bands_for(3840, 2160, 16), 4);
        assert_eq!(bands_for(3840, 2160, 2), 2);
        assert_eq!(bands_for(3840, 2160, 1), 1);
        assert_eq!(bands_for(3840, 2160, 0), 1);
        assert_eq!(bands_for(5120, 2880, 8), 4);
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
