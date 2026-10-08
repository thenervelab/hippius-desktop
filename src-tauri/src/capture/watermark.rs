//! The Free plan's watermark: the Hippius mark and the word "Hippius" in the
//! bottom-right corner of every screenshot and recording, burned into the
//! pixels so it stays on a file that is shared or downloaded.
//!
//! Only the Free tier gets one. The tier is the one the recording limits use
//! (`allowance::recording_tier`), read once per capture, and an unknown tier
//! (offline with nothing remembered, or a plan read that could not tell)
//! gets none: the same fail-open rule as the length limit.
//!
//! The look is white at [`OPACITY`] over a soft dark shadow, so it reads on
//! light and dark pictures alike. Its height follows the picture's shorter
//! side ([`layout`]), so it is the same share of the picture at any size.
//! It is drawn once per size from one master ([`mark`]) and then blended
//! into each frame over its own small rectangle, never re-rendered per
//! frame:
//!
//! - screenshots: [`stamp_image`] on the picture before its PNG is written;
//! - Windows and Linux recordings: an [`Nv12Stamp`] in the recorder child's
//!   pipeline, on every picture at the recording's size, after the camera
//!   bubble is drawn in;
//! - macOS recordings: the Swift helper encodes, so it is handed every size
//!   at once ([`atlas`]) and blends the one its frames need.
//!
//! The master (`icons/watermark.png`) is the tray icon's hippo with its eyes,
//! nostrils and mouth cut out, beside "Hippius" in Geist SemiBold, white on
//! transparent, the mark 176 px tall. Only its alpha is read.

use std::sync::OnceLock;

use image::{GrayImage, RgbaImage};

use super::allowance::RecordingTier;

/// The mark's height as a share of the picture's shorter side.
pub const HEIGHT_SHARE: f64 = 0.03;
pub const MIN_HEIGHT: u32 = 18;
pub const MAX_HEIGHT: u32 = 44;
/// The gap to the picture's right and bottom edges, as a share of its
/// shorter side.
pub const MARGIN_SHARE: f64 = 0.02;
pub const MIN_MARGIN: u32 = 12;
pub const MAX_MARGIN: u32 = 32;
/// The white's opacity.
pub const OPACITY: f32 = 0.7;
/// The shadow's opacity where it is fullest.
const SHADOW_OPACITY: f32 = 0.45;

/// Beyond this shorter side neither the height nor the margin grows.
const LAYOUT_SETTLED_FROM: u32 = 2000;

/// The first bytes of an [`atlas`].
pub const ATLAS_MAGIC: &[u8; 4] = b"HWM1";

static MASTER_PNG: &[u8] = include_bytes!("../../icons/watermark.png");

/// Whether a capture on `tier` is watermarked: the Free plan only. An
/// unknown tier is not (fail open, as with the length limit).
#[must_use]
pub fn applies(tier: Option<RecordingTier>) -> bool {
    tier == Some(RecordingTier::Free)
}

/// How big the watermark is on a picture, and how far from its corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// The mark's height (the shadow comes on top).
    pub height: u32,
    /// From the picture's right and bottom edges to the mark.
    pub margin: u32,
}

/// The watermark's size on a `width` x `height` picture.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn layout(width: u32, height: u32) -> Layout {
    let short = f64::from(width.min(height));
    let scaled = |share: f64, min: u32, max: u32| ((short * share).round() as u32).clamp(min, max);
    Layout {
        height: scaled(HEIGHT_SHARE, MIN_HEIGHT, MAX_HEIGHT),
        margin: scaled(MARGIN_SHARE, MIN_MARGIN, MAX_MARGIN),
    }
}

/// The watermark drawn at one height: premultiplied RGBA, `pad` px of shadow
/// room on every side of the mark. White and a black shadow only, so every
/// colour channel holds the same value and the bytes read the same as BGRA.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub width: u32,
    pub height: u32,
    pub pad: u32,
    pub pixels: Vec<u8>,
}

/// The master's alpha, decoded once.
fn master() -> &'static GrayImage {
    static MASTER: OnceLock<GrayImage> = OnceLock::new();
    MASTER.get_or_init(|| {
        let rgba = image::load_from_memory(MASTER_PNG).map(|i| i.to_rgba8()).unwrap_or_default();
        GrayImage::from_fn(rgba.width(), rgba.height(), |x, y| image::Luma([rgba.get_pixel(x, y)[3]]))
    })
}

/// The watermark with its mark `height` px tall.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
pub fn mark(height: u32) -> Mark {
    let master = master();
    let height = height.max(1);
    if master.width() == 0 || master.height() == 0 {
        return Mark {
            width: 0,
            height: 0,
            pad: 0,
            pixels: Vec::new(),
        };
    }
    let glyph_w = ((f64::from(master.width()) * f64::from(height) / f64::from(master.height())).round() as u32).max(1);
    let glyphs = image::imageops::resize(master, glyph_w, height, image::imageops::FilterType::Lanczos3);

    // A shadow a little below the mark, blurred in proportion to it.
    let sigma = (height as f32 * 0.06).max(0.8);
    let drop = (height / 25).max(1);
    let pad = (sigma * 3.0).ceil() as u32 + drop;
    let (width, full_h) = (glyph_w + 2 * pad, height + 2 * pad);
    let mut shadow = GrayImage::new(width, full_h);
    image::imageops::replace(&mut shadow, &glyphs, i64::from(pad), i64::from(pad + drop));
    let shadow = image::imageops::blur(&shadow, sigma);

    let mut pixels = vec![0u8; width as usize * full_h as usize * 4];
    for y in 0..full_h {
        for x in 0..width {
            let glyph = if x >= pad && y >= pad && x - pad < glyph_w && y - pad < height {
                f32::from(glyphs.get_pixel(x - pad, y - pad)[0]) / 255.0
            } else {
                0.0
            };
            let white = glyph * OPACITY;
            let dark = f32::from(shadow.get_pixel(x, y)[0]) / 255.0 * SHADOW_OPACITY;
            let alpha = white + dark * (1.0 - white);
            let at = (y as usize * width as usize + x as usize) * 4;
            let colour = (white * 255.0).round() as u8;
            pixels[at..at + 3].fill(colour);
            pixels[at + 3] = (alpha * 255.0).round() as u8;
        }
    }
    Mark {
        width,
        height: full_h,
        pad,
        pixels,
    }
}

/// Where `mark`'s top-left goes on a `width` x `height` picture, for the mark
/// (not its shadow) to sit `margin` px in from the bottom-right corner. Off
/// the picture (negative) when the picture is smaller than the mark: the
/// blend draws what lands on it.
#[must_use]
pub fn origin(width: u32, height: u32, mark: &Mark, margin: u32) -> (i64, i64) {
    let inset = i64::from(margin) - i64::from(mark.pad);
    (
        i64::from(width) - inset - i64::from(mark.width),
        i64::from(height) - inset - i64::from(mark.height),
    )
}

/// The part of `mark` at `at` that lands on a `width` x `height` picture:
/// picture columns `x0..x1` and rows `y0..y1`, empty when none does.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn visible(width: u32, height: u32, mark: &Mark, at: (i64, i64)) -> Option<(usize, usize, usize, usize)> {
    let x0 = at.0.max(0);
    let y0 = at.1.max(0);
    let x1 = (at.0 + i64::from(mark.width)).min(i64::from(width));
    let y1 = (at.1 + i64::from(mark.height)).min(i64::from(height));
    (x0 < x1 && y0 < y1).then_some((x0 as usize, y0 as usize, x1 as usize, y1 as usize))
}

/// Blend `mark` at `at` into a 4-channel picture with straight (not
/// premultiplied) alpha in its last channel: RGBA or BGRA alike. Only the
/// mark's own rectangle is touched; a short buffer is left alone.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn blend(dst: &mut [u8], width: u32, height: u32, stride: usize, mark: &Mark, at: (i64, i64)) {
    if stride < width as usize * 4 || height == 0 || dst.len() < stride * (height as usize - 1) + width as usize * 4 {
        return;
    }
    let Some((x0, y0, x1, y1)) = visible(width, height, mark, at) else {
        return;
    };
    let mark_w = mark.width as usize;
    for y in y0..y1 {
        let my = (y as i64 - at.1) as usize;
        for x in x0..x1 {
            let mx = (x as i64 - at.0) as usize;
            let s = (my * mark_w + mx) * 4;
            let alpha = u32::from(mark.pixels[s + 3]);
            if alpha == 0 {
                continue;
            }
            let d = y * stride + x * 4;
            let under = u32::from(dst[d + 3]);
            // Over, in straight alpha: out = mark + picture * (1 - mark's alpha).
            let kept = under * (255 - alpha);
            let out_a = alpha * 255 + kept;
            for c in 0..3 {
                let value = u32::from(mark.pixels[s + c]) * 255 * 255 + u32::from(dst[d + c]) * kept;
                dst[d + c] = ((value + out_a / 2) / out_a).min(255) as u8;
            }
            dst[d + 3] = ((out_a + 127) / 255).min(255) as u8;
        }
    }
}

/// Watermark a screenshot in place, sized to it.
pub fn stamp_image(image: &mut RgbaImage) {
    let (width, height) = image.dimensions();
    let Layout { height: size, margin } = layout(width, height);
    let mark = mark(size);
    let at = origin(width, height, &mark, margin);
    blend(image.as_mut(), width, height, width as usize * 4, &mark, at);
}

/// The watermark for every picture of one NV12 recording, worked out once:
/// what each pixel of its rectangle keeps of the picture and what it adds,
/// in BT.709 limited range (the encoder's colours, `recorder_child::frame`).
/// [`Nv12Stamp::apply`] then costs a multiply-add per byte of the rectangle
/// and allocates nothing.
#[derive(Debug, Clone)]
pub struct Nv12Stamp {
    frame: (usize, usize),
    /// The rectangle, on even pixels (NV12 shares a colour sample between
    /// 2x2 pixels).
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    /// Per pixel: (255 - alpha, the mark's luma premultiplied, x255).
    luma: Vec<(u16, u32)>,
    /// Per 2x2 block: (255 - alpha, Cb and Cr premultiplied, x255).
    chroma: Vec<(u16, u32, u32)>,
}

impl Nv12Stamp {
    /// The stamp for `width` x `height` NV12 pictures (both even, as the
    /// recorder makes them), or `None` when nothing of it lands on one.
    #[must_use]
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_possible_wrap)]
    pub fn new(width: u32, height: u32) -> Option<Self> {
        if width < 2 || height < 2 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return None;
        }
        let Layout { height: size, margin } = layout(width, height);
        let mark = mark(size);
        let (ax, ay) = origin(width, height, &mark, margin);
        let (x0, y0, x1, y1) = visible(width, height, &mark, (ax, ay))?;
        // Out to whole 2x2 blocks; the picture's sides are even, so this
        // stays on it.
        let (x0, y0) = (x0 & !1, y0 & !1);
        let (x1, y1) = (x1 + (x1 & 1), y1 + (y1 & 1));
        let (rect_w, rect_h) = (x1 - x0, y1 - y0);
        // The mark's premultiplied (r, g, b, a) at a picture pixel, 0 to 1.
        let at = |x: usize, y: usize| -> [f64; 4] {
            let (mx, my) = (x as i64 - ax, y as i64 - ay);
            if mx < 0 || my < 0 || mx >= i64::from(mark.width) || my >= i64::from(mark.height) {
                return [0.0; 4];
            }
            let s = (my as usize * mark.width as usize + mx as usize) * 4;
            [0, 1, 2, 3].map(|c| f64::from(mark.pixels[s + c]) / 255.0)
        };
        let mut luma = Vec::with_capacity(rect_w * rect_h);
        for y in y0..y1 {
            for x in x0..x1 {
                let [r, g, b, a] = at(x, y);
                // Limited range: 16 + (47R + 157G + 16B) / 256, premultiplied.
                let y_add = a * 16.0 + (47.0 * r + 157.0 * g + 16.0 * b) * 255.0 / 256.0;
                luma.push(((255.0 - a * 255.0).round() as u16, (y_add * 255.0).round() as u32));
            }
        }
        let mut chroma = Vec::with_capacity(rect_w * rect_h / 4);
        for y in (y0..y1).step_by(2) {
            for x in (x0..x1).step_by(2) {
                let px = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)];
                let mean = |c: usize| px.iter().map(|p| p[c]).sum::<f64>() / 4.0;
                let (red, green, blue, alpha) = (mean(0) * 255.0, mean(1) * 255.0, mean(2) * 255.0, mean(3));
                let cb = alpha * 128.0 + (-26.0 * red - 86.0 * green + 112.0 * blue) / 256.0;
                let cr = alpha * 128.0 + (112.0 * red - 102.0 * green - 10.0 * blue) / 256.0;
                chroma.push((
                    (255.0 - alpha * 255.0).round() as u16,
                    (cb.max(0.0) * 255.0).round() as u32,
                    (cr.max(0.0) * 255.0).round() as u32,
                ));
            }
        }
        Some(Self {
            frame: (width as usize, height as usize),
            x: x0,
            y: y0,
            width: rect_w,
            height: rect_h,
            luma,
            chroma,
        })
    }

    /// Blend the watermark into one NV12 picture of the size this stamp was
    /// made for. A picture of another size is left alone.
    pub fn apply(&self, nv12: &mut [u8]) {
        let (fw, fh) = self.frame;
        if nv12.len() != fw * fh * 3 / 2 {
            return;
        }
        let mix = |under: u8, keep: u16, add: u32| -> u8 {
            let v = (add + u32::from(under) * u32::from(keep) + 127) / 255;
            u8::try_from(v.min(255)).unwrap_or(u8::MAX)
        };
        let (luma_plane, chroma_plane) = nv12.split_at_mut(fw * fh);
        for row in 0..self.height {
            let line = &mut luma_plane[(self.y + row) * fw + self.x..][..self.width];
            for (px, &(keep, add)) in line.iter_mut().zip(&self.luma[row * self.width..][..self.width]) {
                *px = mix(*px, keep, add);
            }
        }
        let blocks = self.width / 2;
        for row in 0..self.height / 2 {
            let line = &mut chroma_plane[(self.y / 2 + row) * fw + self.x..][..self.width];
            for (pair, &(keep, cb, cr)) in line.chunks_exact_mut(2).zip(&self.chroma[row * blocks..][..blocks]) {
                pair[0] = mix(pair[0], keep, cb);
                pair[1] = mix(pair[1], keep, cr);
            }
        }
    }
}

/// One row of an [`atlas`]'s table: from this shorter side up, use this
/// mark, its bitmap this far in from the right and bottom edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtlasStep {
    pub short_from: u32,
    pub mark: u32,
    pub inset_right: i32,
    pub inset_bottom: i32,
}

/// The table of [`AtlasStep`]s and the marks they use, by height.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn atlas_steps() -> (Vec<AtlasStep>, Vec<Mark>) {
    let marks: Vec<Mark> = (MIN_HEIGHT..=MAX_HEIGHT).map(mark).collect();
    let mut steps: Vec<AtlasStep> = Vec::new();
    let mut last: Option<Layout> = None;
    for short in 1..=LAYOUT_SETTLED_FROM {
        let now = layout(short, short);
        if last == Some(now) {
            continue;
        }
        last = Some(now);
        let index = now.height - MIN_HEIGHT;
        let inset = i64::from(now.margin) - i64::from(marks[index as usize].pad);
        let inset = i32::try_from(inset).unwrap_or(0);
        steps.push(AtlasStep {
            short_from: if steps.is_empty() { 0 } else { short },
            mark: index,
            inset_right: inset,
            inset_bottom: inset,
        });
    }
    (steps, marks)
}

/// Every watermark size and where it goes, for the macOS helper, which
/// learns its frames' size only once its stream runs. Little-endian:
///
/// ```text
/// "HWM1"
/// u32 marks;  per mark:  u32 width, u32 height, width*height*4 bytes
///             (premultiplied, the same read as BGRA or RGBA)
/// u32 steps;  per step:  u32 short_from, u32 mark, i32 inset_right, i32 inset_bottom
/// ```
///
/// A frame uses the last step whose `short_from` is at most its shorter
/// side; the mark's top-left is then at (`width - inset_right - mark
/// width`, `height - inset_bottom - mark height`).
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn atlas() -> Vec<u8> {
    let (steps, marks) = atlas_steps();
    let mut out = Vec::with_capacity(marks.iter().map(|m| m.pixels.len() + 8).sum::<usize>() + steps.len() * 16 + 12);
    out.extend_from_slice(ATLAS_MAGIC);
    out.extend_from_slice(&(marks.len() as u32).to_le_bytes());
    for m in &marks {
        out.extend_from_slice(&m.width.to_le_bytes());
        out.extend_from_slice(&m.height.to_le_bytes());
        out.extend_from_slice(&m.pixels);
    }
    out.extend_from_slice(&(steps.len() as u32).to_le_bytes());
    for s in &steps {
        out.extend_from_slice(&s.short_from.to_le_bytes());
        out.extend_from_slice(&s.mark.to_le_bytes());
        out.extend_from_slice(&s.inset_right.to_le_bytes());
        out.extend_from_slice(&s.inset_bottom.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREY: [u8; 4] = [90, 90, 90, 255];

    fn picture(width: u32, height: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba(px))
    }

    /// The pixels `stamp_image` changed: their bounding box, or `None`.
    fn changed(before: &RgbaImage, after: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
        let mut bounds: Option<(u32, u32, u32, u32)> = None;
        for (x, y, px) in after.enumerate_pixels() {
            if px != before.get_pixel(x, y) {
                let b = bounds.get_or_insert((x, y, x, y));
                *b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
            }
        }
        bounds
    }

    #[test]
    fn only_the_free_plan_is_watermarked_and_an_unknown_one_is_not() {
        assert!(applies(Some(RecordingTier::Free)));
        assert!(!applies(Some(RecordingTier::Paid)));
        assert!(!applies(None), "no verdict falls open, as the length limit does");
    }

    #[test]
    fn the_size_follows_the_shorter_side_within_its_bounds() {
        // 1080p: 3 % of 1080 is 32 px tall, 2 % is 22 px in.
        assert_eq!(layout(1920, 1080), Layout { height: 32, margin: 22 });
        // Portrait reads the width, the shorter side.
        assert_eq!(layout(1080, 1920), layout(1920, 1080));
        // Small pictures stop at the floor, large ones at the ceiling.
        assert_eq!(
            layout(320, 200),
            Layout {
                height: MIN_HEIGHT,
                margin: MIN_MARGIN
            }
        );
        assert_eq!(
            layout(1, 1),
            Layout {
                height: MIN_HEIGHT,
                margin: MIN_MARGIN
            }
        );
        assert_eq!(
            layout(7680, 4320),
            Layout {
                height: MAX_HEIGHT,
                margin: MAX_MARGIN
            }
        );
        assert_eq!(layout(5120, 2880), layout(u32::MAX, u32::MAX));
        // Odd sizes round, never truncate to the floor.
        assert_eq!(layout(1279, 717), Layout { height: 22, margin: 14 });
    }

    #[test]
    fn each_size_is_drawn_at_its_height_with_room_for_the_shadow() {
        for height in [MIN_HEIGHT, 31, MAX_HEIGHT] {
            let m = mark(height);
            assert_eq!(m.height, height + 2 * m.pad);
            assert_eq!(m.pixels.len(), m.width as usize * m.height as usize * 4);
            // The mark and the word: far wider than tall.
            assert!(m.width > 3 * height, "{height}: {} wide", m.width);
            // Premultiplied and neutral: no channel above alpha, all equal.
            for px in m.pixels.chunks_exact(4) {
                assert!(px[0] <= px[3]);
                assert!(px[0] == px[1] && px[1] == px[2]);
            }
            // Some of it is the white at full strength, none of it opaque.
            let strongest = m.pixels.chunks_exact(4).map(|p| p[0]).max().unwrap();
            assert!((175..=180).contains(&strongest), "{height}: {strongest}");
            assert!(m.pixels.chunks_exact(4).all(|p| p[3] < 255));
        }
    }

    #[test]
    fn the_mark_sits_its_margin_in_from_the_bottom_right_corner() {
        let (w, h) = (1920, 1080);
        let before = picture(w, h, GREY);
        let mut after = before.clone();
        stamp_image(&mut after);
        let (x0, y0, x1, y1) = changed(&before, &after).expect("something was drawn");
        let Layout { height, margin } = layout(w, h);
        // The mark's own edge is `margin` in; its shadow reaches a little
        // further (never past its pad), and nothing of it reaches the left
        // or the top.
        let pad = mark(height).pad;
        let (right, bottom) = (w - 1 - x1, h - 1 - y1);
        assert!(right + pad >= margin && right <= margin + 2, "right gap {right}");
        assert!(bottom + pad >= margin && bottom <= margin + 1, "bottom gap {bottom}");
        assert!(x0 > w / 2 && y0 > h - 3 * height, "({x0}, {y0})");
        // White over grey somewhere, darker (the shadow) somewhere else.
        let lighter = after.pixels().any(|p| p[0] > GREY[0] + 60);
        let darker = after.pixels().any(|p| p[0] < GREY[0]);
        assert!(lighter && darker);
        // The picture stays opaque.
        assert!(after.pixels().all(|p| p[3] == 255));
    }

    #[test]
    fn white_reads_on_white_and_on_black() {
        for base in [[255, 255, 255, 255], [0, 0, 0, 255]] {
            let before = picture(800, 600, base);
            let mut after = before.clone();
            stamp_image(&mut after);
            assert!(changed(&before, &after).is_some(), "the mark shows on {base:?}");
        }
    }

    #[test]
    fn small_and_odd_pictures_are_drawn_on_without_going_out_of_bounds() {
        for (w, h) in [(1, 1), (3, 5), (17, 9), (63, 41), (101, 33), (333, 47), (641, 479)] {
            let mut img = picture(w, h, GREY);
            stamp_image(&mut img);
            assert_eq!(img.dimensions(), (w, h));
        }
        // Too small for the whole mark: what lands on it is drawn.
        let before = picture(60, 30, GREY);
        let mut after = before.clone();
        stamp_image(&mut after);
        assert!(changed(&before, &after).is_some());
        // A short buffer or a bad stride is not read.
        let m = mark(MIN_HEIGHT);
        let mut short = vec![7u8; 10];
        blend(&mut short, 100, 100, 400, &m, (0, 0));
        assert_eq!(short, vec![7u8; 10]);
        let mut row = vec![7u8; 400];
        blend(&mut row, 100, 1, 40, &m, (0, 0));
        assert_eq!(row, vec![7u8; 400]);
    }

    #[test]
    fn a_transparent_corner_takes_the_mark_with_its_own_alpha() {
        let mut img = picture(400, 300, [0, 0, 0, 0]);
        stamp_image(&mut img);
        let strongest = img.pixels().map(|p| p[3]).max().unwrap();
        assert!(strongest > 150 && strongest < 255);
        // Where it is strongest it is the white over its shadow, a light
        // grey, not the premultiplied value (a darker grey).
        let white = img.pixels().find(|p| p[3] == strongest).unwrap();
        assert!(white[0] > 200, "{white:?}");
    }

    /// NV12 of a solid grey picture, as `recorder_child::frame` writes it.
    fn nv12(width: u32, height: u32, grey: u8) -> Vec<u8> {
        let mut out = Vec::new();
        let rgba = picture(width, height, [grey, grey, grey, 255]);
        crate::capture::recorder_child::frame::to_nv12(
            crate::capture::recorder_child::frame::Bgra {
                data: rgba.as_raw(),
                width,
                height,
                stride: width as usize * 4,
            },
            width,
            height,
            &mut out,
        );
        out
    }

    #[test]
    fn a_recording_frame_matches_the_screenshot_of_the_same_picture() {
        let (w, h) = (1280, 720);
        let mut frame = nv12(w, h, 90);
        let stamp = Nv12Stamp::new(w, h).unwrap();
        stamp.apply(&mut frame);
        // The same picture stamped as a screenshot, then converted.
        let mut shot = picture(w, h, GREY);
        stamp_image(&mut shot);
        let mut expected = Vec::new();
        crate::capture::recorder_child::frame::to_nv12(
            crate::capture::recorder_child::frame::Bgra {
                data: shot.as_raw(),
                width: w,
                height: h,
                stride: w as usize * 4,
            },
            w,
            h,
            &mut expected,
        );
        let worst = frame.iter().zip(&expected).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(worst <= 3, "luma and chroma within rounding, worst {worst}");
        // And only the corner changed.
        let plain = nv12(w, h, 90);
        let first = frame.iter().zip(&plain).position(|(a, b)| a != b).unwrap();
        assert!(first / w as usize > h as usize - 80, "first change on row {}", first / w as usize);
    }

    #[test]
    fn the_stamp_leaves_other_sizes_and_odd_frames_alone() {
        let stamp = Nv12Stamp::new(640, 480).unwrap();
        let mut other = nv12(320, 240, 90);
        let before = other.clone();
        stamp.apply(&mut other);
        assert_eq!(other, before);
        assert!(Nv12Stamp::new(641, 480).is_none(), "NV12 sides are even");
        assert!(Nv12Stamp::new(0, 0).is_none());
        // A tiny frame still gets what fits, inside its buffer.
        let tiny = Nv12Stamp::new(40, 24).unwrap();
        let mut frame = nv12(40, 24, 90);
        let before = frame.clone();
        tiny.apply(&mut frame);
        assert_ne!(frame, before);
    }

    /// Reads an atlas back the way the Swift helper does.
    fn read_atlas(bytes: &[u8]) -> (Vec<(u32, u32, usize)>, Vec<AtlasStep>) {
        let mut at = 4;
        let u32_at = |at: &mut usize| {
            let v = u32::from_le_bytes(bytes[*at..*at + 4].try_into().unwrap());
            *at += 4;
            v
        };
        assert_eq!(&bytes[..4], ATLAS_MAGIC);
        let mut marks = Vec::new();
        for _ in 0..u32_at(&mut at) {
            let (w, h) = (u32_at(&mut at), u32_at(&mut at));
            marks.push((w, h, at));
            at += w as usize * h as usize * 4;
        }
        let mut steps = Vec::new();
        for _ in 0..u32_at(&mut at) {
            let short_from = u32_at(&mut at);
            let mark = u32_at(&mut at);
            let inset_right = u32_at(&mut at).cast_signed();
            let inset_bottom = u32_at(&mut at).cast_signed();
            steps.push(AtlasStep {
                short_from,
                mark,
                inset_right,
                inset_bottom,
            });
        }
        assert_eq!(at, bytes.len(), "nothing after the table");
        (marks, steps)
    }

    #[test]
    fn the_macos_atlas_places_every_size_as_the_screenshot_does() {
        let bytes = atlas();
        let (marks, steps) = read_atlas(&bytes);
        assert_eq!(marks.len() as u32, MAX_HEIGHT - MIN_HEIGHT + 1);
        assert_eq!(steps[0].short_from, 0, "every size has a step");
        assert!(steps.windows(2).all(|s| s[0].short_from < s[1].short_from));
        // Well under a megabyte: it is written for every recording.
        assert!(bytes.len() < 1_000_000, "{} bytes", bytes.len());
        for (w, h) in [
            (320, 240),
            (1280, 720),
            (1512, 982),
            (1920, 1080),
            (3024, 1964),
            (3840, 2160),
            (7680, 4320),
        ] {
            let short = w.min(h);
            let step = steps.iter().rev().find(|s| s.short_from <= short).unwrap();
            let (mw, mh, start) = marks[step.mark as usize];
            let want = layout(w, h);
            let m = mark(want.height);
            assert_eq!((mw, mh), (m.width, m.height), "{w}x{h}");
            assert_eq!(&bytes[start..start + m.pixels.len()], m.pixels.as_slice());
            let at = (
                i64::from(w) - i64::from(step.inset_right) - i64::from(mw),
                i64::from(h) - i64::from(step.inset_bottom) - i64::from(mh),
            );
            assert_eq!(at, origin(w, h, &m, want.margin), "{w}x{h}");
        }
    }

    /// The helper reads the atlas this module writes: pinned on its source.
    #[test]
    fn the_swift_helper_reads_this_atlas() {
        let swift = include_str!("../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        for literal in [r#"obj["watermarkAtlas"] as? String"#, r#"Array("HWM1".utf8)"#, "stamp(pixelBuffer)"] {
            assert!(swift.contains(literal), "HippiusCapture.swift no longer says `{literal}`");
        }
    }
}
