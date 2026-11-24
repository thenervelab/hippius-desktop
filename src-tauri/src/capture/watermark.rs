//! The Free plan's watermark: a dark pill holding the Hippius mark and the
//! words "Recorded with Hippius", in the bottom-right corner of every
//! screenshot and recording, burned into the pixels so it stays on a file
//! that is shared or downloaded. On a recording it sits higher
//! ([`RECORDING_LIFT_SHARE`]), above the share page player's controls, which
//! cover the bottom of the video while it plays.
//!
//! Only the Free tier gets one. The tier is the one the recording limits use
//! (`allowance::session_tier`), read once per capture. There is no unknown
//! tier here: a capture whose plan could not be read is refused before
//! anything is captured (`allowance`), so it never reaches this decision.
//!
//! The look is the one the web console and the browser extension draw, with
//! the same numbers: a fully rounded pill filled [`PILL_FILL`] at
//! [`PILL_OPACITY`] with a white hairline at [`HAIRLINE_OPACITY`] just inside
//! its edge, no shadow, and the mark's white body and the words in solid
//! white on it, so it reads on light and dark pictures alike. Its height
//! follows the picture's shorter side ([`layout`]) and everything in it
//! follows its height ([`PillLayout`]). It is drawn once per size
//! ([`mark`]) and then blended into each frame over its own small rectangle,
//! never re-rendered per frame:
//!
//! - screenshots: [`stamp_image`] on the picture before its PNG is written;
//! - Windows and Linux recordings: an [`Nv12Stamp`] in the recorder child's
//!   pipeline, on every picture at the recording's size, after the camera
//!   bubble is drawn in;
//! - macOS recordings: the Swift helper encodes, so it is handed every size
//!   at once ([`atlas`]) and blends the one its frames need.
//!
//! The glyphs come from two masters, white on transparent, of which only
//! the alpha is read: `icons/watermark-logo.png` (the mark's body with its
//! eyes, nostril and mouth cut out, its whole 633 x 544 viewBox) and
//! `icons/watermark-text.png` (the words in Geist SemiBold at
//! [`TEXT_MASTER_FONT_PX`]). Both are rendered by Chromium's canvas, as the
//! console and the extension draw them, by `scripts/watermark/render-masters.mjs`.

use std::sync::OnceLock;

use image::{GrayImage, RgbaImage};

use super::allowance::RecordingTier;

/// The pill's height as a share of the picture's shorter side.
pub const HEIGHT_SHARE: f64 = 0.04;
pub const MIN_HEIGHT: u32 = 26;
pub const MAX_HEIGHT: u32 = 60;
/// The gap to the picture's right and bottom edges, as a share of its
/// shorter side.
pub const MARGIN_SHARE: f64 = 0.02;
pub const MIN_MARGIN: u32 = 12;
pub const MAX_MARGIN: u32 = 32;
/// On a recording, the mark's bottom edge sits this share of the frame's
/// height above its bottom edge (or the margin, when that is larger), so it
/// clears the share page player's controls.
pub const RECORDING_LIFT_SHARE: f64 = 0.12;
/// [`RECORDING_LIFT_SHARE`] in thousandths, as the macOS helper reads it.
const RECORDING_LIFT_PERMILLE: u32 = 120;
/// The pill's fill colour, sRGB.
pub const PILL_FILL: [u8; 3] = [14, 16, 20];
/// The pill's fill opacity.
pub const PILL_OPACITY: f64 = 0.62;
/// The white hairline's opacity, just inside the pill's edge.
pub const HAIRLINE_OPACITY: f64 = 0.14;
/// The words on the pill.
pub const TEXT: &str = "Recorded with Hippius";

/// The logo master's size: the mark's whole viewBox, at 1:1.
const LOGO_VIEWBOX: (f64, f64) = (633.0, 544.0);
/// The text master's font size, in its pixels.
pub const TEXT_MASTER_FONT_PX: f64 = 200.0;
/// Where the text master's pen starts, from its left edge.
const TEXT_MASTER_ORIGIN_X: f64 = 24.0;
/// [`TEXT`]'s advance width in the master (Chromium's `measureText` at
/// [`TEXT_MASTER_FONT_PX`]), printed by the script that renders it. The
/// canvas "middle" baseline is the master's middle row.
const TEXT_MASTER_ADVANCE: f64 = 2_150.405_761_718_75;

/// Beyond this shorter side neither the height nor the margin grows.
const LAYOUT_SETTLED_FROM: u32 = 2000;

/// The first bytes of an [`atlas`].
pub const ATLAS_MAGIC: &[u8; 4] = b"HWM2";

static LOGO_PNG: &[u8] = include_bytes!("../../icons/watermark-logo.png");
static TEXT_PNG: &[u8] = include_bytes!("../../icons/watermark-text.png");

/// Whether a capture on `tier` is watermarked: the Free plan only.
#[must_use]
pub fn applies(tier: RecordingTier) -> bool {
    tier == RecordingTier::Free
}

/// How big the watermark is on a picture, and how far from its corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// The pill's height.
    pub height: u32,
    /// From the picture's right and bottom edges to the pill.
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

/// What is inside a pill `height` px tall, left to right, every length a
/// share of the height as drawn at 44 px: 14 px in, the logo half the
/// height, 9 px, the words at 20 px, 18 px to the end.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PillLayout {
    pub height: u32,
    /// The whole pill, rounded up to a pixel.
    pub width: u32,
    pub hairline: u32,
    pub pad_left: u32,
    pub logo_height: u32,
    /// The logo keeps its viewBox's proportions, so this is fractional.
    pub logo_width: f64,
    pub gap: u32,
    pub font_size: u32,
    /// [`TEXT`]'s advance at `font_size`, rounded up.
    pub text_width: u32,
    pub pad_right: u32,
}

/// The pill's measurements at `height` (1080p: 43 tall).
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn pill_layout(height: u32) -> PillLayout {
    let h = height.max(1);
    let of = |n: f64| (f64::from(h) * n / 44.0).round() as u32;
    let logo_height = ((f64::from(h) * 0.5).round() as u32).max(1);
    let logo_width = f64::from(logo_height) * LOGO_VIEWBOX.0 / LOGO_VIEWBOX.1;
    let font_size = of(20.0);
    let text_width = (TEXT_MASTER_ADVANCE * f64::from(font_size) / TEXT_MASTER_FONT_PX).ceil() as u32;
    let (pad_left, gap, pad_right) = (of(14.0), of(9.0), of(18.0));
    let width = (f64::from(pad_left) + logo_width + f64::from(gap) + f64::from(text_width) + f64::from(pad_right)).ceil() as u32;
    PillLayout {
        height: h,
        width,
        hairline: of(1.0).max(1),
        pad_left,
        logo_height,
        logo_width,
        gap,
        font_size,
        text_width,
        pad_right,
    }
}

/// The watermark drawn at one height: premultiplied RGBA. `pad` is room
/// around the pill that the old shadowed mark needed; the pill has none, so
/// it is 0, and it stays in the atlas so the helper's reader is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub width: u32,
    pub height: u32,
    pub pad: u32,
    pub pixels: Vec<u8>,
}

/// A master's alpha, decoded once.
fn alpha_of(png: &[u8]) -> GrayImage {
    let rgba = image::load_from_memory(png).map(|i| i.to_rgba8()).unwrap_or_default();
    GrayImage::from_fn(rgba.width(), rgba.height(), |x, y| image::Luma([rgba.get_pixel(x, y)[3]]))
}

fn logo_master() -> &'static GrayImage {
    static MASTER: OnceLock<GrayImage> = OnceLock::new();
    MASTER.get_or_init(|| alpha_of(LOGO_PNG))
}

fn text_master() -> &'static GrayImage {
    static MASTER: OnceLock<GrayImage> = OnceLock::new();
    MASTER.get_or_init(|| alpha_of(TEXT_PNG))
}

/// How much of the pixel centred on (`px`, `py`) a pill `width` x `height`
/// with `inset` px taken off every side covers, 0 to 1: one pixel of
/// anti-aliasing across the edge, from the distance to the edge.
fn pill_coverage(px: f64, py: f64, width: f64, height: f64, inset: f64) -> f64 {
    let r = height / 2.0 - inset;
    if r <= 0.0 {
        return 0.0;
    }
    // A pill is every point within `r` of the segment between its two
    // round ends' centres.
    let (left, right) = (height / 2.0, (width - height / 2.0).max(height / 2.0));
    let dx = px - px.clamp(left, right);
    let dy = py - height / 2.0;
    let edge = dx.hypot(dy) - r;
    (0.5 - edge).clamp(0.0, 1.0)
}

/// The watermark with its pill `height` px tall.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::many_single_char_names
)]
pub fn mark(height: u32) -> Mark {
    let p = pill_layout(height);
    let (width, h) = (p.width, p.height);
    let (wf, hf) = (f64::from(width), f64::from(h));

    // Premultiplied RGBA, 0 to 1: the fill, the hairline over it, the
    // glyphs over both.
    let mut px = vec![[0.0f64; 4]; width as usize * h as usize];
    let fill = PILL_FILL.map(|c| f64::from(c) / 255.0);
    let t = f64::from(p.hairline);
    for y in 0..h {
        for x in 0..width {
            let (cx, cy) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
            let outer = pill_coverage(cx, cy, wf, hf, 0.0);
            if outer == 0.0 {
                continue;
            }
            let ring = (outer - pill_coverage(cx, cy, wf, hf, t)).max(0.0);
            let a_fill = PILL_OPACITY * outer;
            let a_line = HAIRLINE_OPACITY * ring;
            let v = &mut px[(y * width + x) as usize];
            for c in 0..3 {
                v[c] = a_line + fill[c] * a_fill * (1.0 - a_line);
            }
            v[3] = a_line + a_fill * (1.0 - a_line);
        }
    }

    // White glyphs over the pill, each resized from its master once and
    // put on whole pixels.
    let mut glyphs = |master: &GrayImage, scale: f64, left: f64, top: f64| {
        if master.width() == 0 || master.height() == 0 {
            return;
        }
        let gw = ((f64::from(master.width()) * scale).round() as u32).max(1);
        let gh = ((f64::from(master.height()) * scale).round() as u32).max(1);
        let small = image::imageops::resize(master, gw, gh, image::imageops::FilterType::Lanczos3);
        let (ox, oy) = (left.round() as i64, top.round() as i64);
        for (gx, gy, a) in small.enumerate_pixels() {
            let (x, y) = (ox + i64::from(gx), oy + i64::from(gy));
            if a[0] == 0 || x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(h) {
                continue;
            }
            let g = f64::from(a[0]) / 255.0;
            let v = &mut px[(y as u32 * width + x as u32) as usize];
            for c in v.iter_mut() {
                *c = g + *c * (1.0 - g);
            }
        }
    };
    let logo_scale = f64::from(p.logo_height) / LOGO_VIEWBOX.1;
    glyphs(logo_master(), logo_scale, f64::from(p.pad_left), (hf - f64::from(p.logo_height)) / 2.0);
    let text_scale = f64::from(p.font_size) / TEXT_MASTER_FONT_PX;
    let pen = f64::from(p.pad_left) + p.logo_width + f64::from(p.gap);
    let master_h = f64::from(text_master().height());
    glyphs(
        text_master(),
        text_scale,
        pen - TEXT_MASTER_ORIGIN_X * text_scale,
        hf / 2.0 - master_h / 2.0 * text_scale,
    );

    let pixels = px.iter().flat_map(|v| v.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)).collect();
    Mark {
        width,
        height: h,
        pad: 0,
        pixels,
    }
}

/// Where `mark`'s top-left goes on a `width` x `height` picture, for the pill
/// to sit `margin` px in from the bottom-right corner. Off
/// the picture (negative) when the picture is smaller than the mark: the
/// blend draws what lands on it.
#[must_use]
pub fn origin(width: u32, height: u32, mark: &Mark, margin: u32) -> (i64, i64) {
    place(width, height, mark, margin, margin)
}

/// The gap from a recording's bottom edge to the mark's:
/// [`RECORDING_LIFT_SHARE`] of its `height`, or `margin` when that is larger.
/// Whole thousandths, rounded half up, so the macOS helper works out the
/// same pixel from the atlas.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn recording_bottom_gap(height: u32, margin: u32) -> u32 {
    let lift = (u64::from(height) * u64::from(RECORDING_LIFT_PERMILLE) + 500) / 1000;
    (lift as u32).max(margin)
}

/// Where `mark`'s top-left goes on a `width` x `height` recording frame: the
/// mark `margin` px in from the right edge, as on a screenshot, and
/// [`recording_bottom_gap`] above the bottom edge.
#[must_use]
pub fn recording_origin(width: u32, height: u32, mark: &Mark, margin: u32) -> (i64, i64) {
    place(width, height, mark, margin, recording_bottom_gap(height, margin))
}

/// `mark`'s top-left for the pill (inside its `pad`) to sit `right` px in from
/// the right edge and `bottom` px up from the bottom edge.
fn place(width: u32, height: u32, mark: &Mark, right: u32, bottom: u32) -> (i64, i64) {
    let pad = i64::from(mark.pad);
    (
        i64::from(width) - (i64::from(right) - pad) - i64::from(mark.width),
        i64::from(height) - (i64::from(bottom) - pad) - i64::from(mark.height),
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
/// premultiplied) alpha in its last channel, RGBA as the mark is. Only the
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
        let (ax, ay) = recording_origin(width, height, &mark, margin);
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
/// mark, its bitmap this far in from the right and bottom edges. The bottom
/// inset is the floor: a frame tall enough lifts the mark higher (see
/// [`atlas`]).
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
/// "HWM2"
/// u32 lift_permille  (RECORDING_LIFT_SHARE in thousandths)
/// u32 marks;  per mark:  u32 width, u32 height, u32 pad, width*height*4 bytes
///             (premultiplied BGRA, the helper's frames' order)
/// u32 steps;  per step:  u32 short_from, u32 mark, i32 inset_right, i32 inset_bottom
/// ```
///
/// A frame uses the last step whose `short_from` is at most its shorter
/// side. Its bottom inset is the larger of `inset_bottom` and
/// `(height * lift_permille + 500) / 1000 - pad` ([`recording_origin`]);
/// the mark's top-left is then at (`width - inset_right - mark width`,
/// `height - bottom inset - mark height`).
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn atlas() -> Vec<u8> {
    let (steps, marks) = atlas_steps();
    let mut out = Vec::with_capacity(marks.iter().map(|m| m.pixels.len() + 12).sum::<usize>() + steps.len() * 16 + 16);
    out.extend_from_slice(ATLAS_MAGIC);
    out.extend_from_slice(&RECORDING_LIFT_PERMILLE.to_le_bytes());
    out.extend_from_slice(&(marks.len() as u32).to_le_bytes());
    for m in &marks {
        out.extend_from_slice(&m.width.to_le_bytes());
        out.extend_from_slice(&m.height.to_le_bytes());
        out.extend_from_slice(&m.pad.to_le_bytes());
        out.extend(bgra(&m.pixels));
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

/// Premultiplied RGBA as BGRA: the pill's fill is not grey, so the order
/// matters.
fn bgra(rgba: &[u8]) -> impl Iterator<Item = u8> + '_ {
    rgba.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]])
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
    fn only_the_free_plan_is_watermarked() {
        assert!(applies(RecordingTier::Free));
        assert!(!applies(RecordingTier::Paid));
    }

    #[test]
    fn the_size_follows_the_shorter_side_within_its_bounds() {
        // 1080p: 4 % of 1080 is a 43 px pill, 2 % is 22 px in.
        assert_eq!(layout(1920, 1080), Layout { height: 43, margin: 22 });
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
        assert_eq!((MIN_HEIGHT, MAX_HEIGHT), (26, 60));
        assert_eq!(layout(5120, 2880), layout(u32::MAX, u32::MAX));
        // Odd sizes round, never truncate to the floor.
        assert_eq!(layout(1279, 717), Layout { height: 29, margin: 14 });
    }

    #[test]
    fn the_pill_is_laid_out_in_shares_of_its_height() {
        // As drawn at 44 px: 14 in, a 22 px logo, 9, 20 px words, 18.
        let p = pill_layout(44);
        assert_eq!(
            (p.pad_left, p.logo_height, p.gap, p.font_size, p.pad_right, p.hairline),
            (14, 22, 9, 20, 18, 1)
        );
        // 1080p's 43 px pill rounds each one on its own.
        let p = pill_layout(43);
        assert_eq!(
            (p.pad_left, p.logo_height, p.gap, p.font_size, p.pad_right, p.hairline),
            (14, 22, 9, 20, 18, 1)
        );
        assert!((p.logo_width - 22.0 * 633.0 / 544.0).abs() < 1e-9);
        let sum = f64::from(p.pad_left) + p.logo_width + f64::from(p.gap) + f64::from(p.text_width) + f64::from(p.pad_right);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let rounded_up = sum.ceil() as u32;
        assert_eq!(p.width, rounded_up);
        // The ends of the range.
        let small = pill_layout(MIN_HEIGHT);
        assert_eq!(
            (small.pad_left, small.logo_height, small.gap, small.font_size, small.pad_right),
            (8, 13, 5, 12, 11)
        );
        let large = pill_layout(MAX_HEIGHT);
        assert_eq!(
            (large.pad_left, large.logo_height, large.gap, large.font_size, large.pad_right),
            (19, 30, 12, 27, 25)
        );
        // The hairline is one pixel across the whole range.
        assert!((MIN_HEIGHT..=MAX_HEIGHT).all(|h| pill_layout(h).hairline == 1));
        // The words are about ten and three quarter ems wide in Geist
        // SemiBold, so the pill is about six and a half times its height.
        for h in MIN_HEIGHT..=MAX_HEIGHT {
            let p = pill_layout(h);
            let ratio = f64::from(p.width) / f64::from(h);
            assert!((6.0..7.0).contains(&ratio), "{h}: {} wide", p.width);
        }
    }

    #[test]
    fn the_masters_are_the_ones_the_layout_was_measured_on() {
        let logo = logo_master();
        assert_eq!((f64::from(logo.width()), f64::from(logo.height())), LOGO_VIEWBOX);
        let text = text_master();
        // The pen's start and its advance, with the origin's margin on both sides.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let want = (TEXT_MASTER_ADVANCE.ceil() + 2.0 * TEXT_MASTER_ORIGIN_X) as u32;
        assert_eq!(text.width(), want);
        // Both carry ink, none of it on their edges (nothing was clipped).
        for m in [logo, text] {
            assert!(m.pixels().any(|p| p[0] == 255));
            let (w, h) = m.dimensions();
            assert!((0..w).all(|x| m.get_pixel(x, 0)[0] == 0 && m.get_pixel(x, h - 1)[0] == 0));
            assert!((0..h).all(|y| m.get_pixel(0, y)[0] == 0 && m.get_pixel(w - 1, y)[0] == 0));
        }
    }

    /// The mark's premultiplied pixel at (`x`, `y`).
    fn at(m: &Mark, x: u32, y: u32) -> [u8; 4] {
        let s = (y * m.width + x) as usize * 4;
        [m.pixels[s], m.pixels[s + 1], m.pixels[s + 2], m.pixels[s + 3]]
    }

    #[test]
    fn each_size_is_a_dark_pill_with_white_glyphs() {
        for height in [MIN_HEIGHT, 43, MAX_HEIGHT] {
            let m = mark(height);
            let p = pill_layout(height);
            assert_eq!((m.width, m.height, m.pad), (p.width, height, 0));
            assert_eq!(m.pixels.len(), m.width as usize * m.height as usize * 4);
            // Premultiplied: no channel above alpha.
            assert!(m.pixels.chunks_exact(4).all(|px| px[..3].iter().all(|&c| c <= px[3])));
            // The corners are outside the round ends.
            for (x, y) in [(0, 0), (m.width - 1, 0), (0, m.height - 1), (m.width - 1, m.height - 1)] {
                assert_eq!(at(&m, x, y)[3], 0, "{height}: corner ({x}, {y})");
            }
            // Between the logo and the words, mid-height, is the bare fill:
            // rgba(14, 16, 20, 0.62), premultiplied.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let gap_x = (f64::from(p.pad_left) + p.logo_width + f64::from(p.gap) / 2.0) as u32;
            let fill = PILL_FILL.map(|c| (f64::from(c) * PILL_OPACITY).round() as u8);
            assert_eq!(at(&m, gap_x, height / 2), [fill[0], fill[1], fill[2], 158], "{height}");
            // The hairline makes the top edge lighter than the fill.
            let top = at(&m, m.width / 2, 0);
            assert!(top[0] > fill[0] + 20 && top[3] > 158, "{height}: {top:?}");
            // The glyphs are solid white somewhere, in the logo and in the words.
            let solid = |x0: u32, x1: u32| (x0..x1).any(|x| (0..m.height).any(|y| at(&m, x, y) == [255; 4]));
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let logo_end = (f64::from(p.pad_left) + p.logo_width) as u32;
            assert!(solid(p.pad_left, logo_end), "{height}: the logo");
            assert!(solid(logo_end + p.gap, m.width - p.pad_right), "{height}: the words");
            // Nothing white spills into the paddings at the ends.
            let mid = height / 2;
            assert!(
                (0..p.pad_left.saturating_sub(1)).all(|x| at(&m, x, mid)[0] < 120),
                "{height}: left padding"
            );
            assert!(
                (m.width - p.pad_right + 1..m.width).all(|x| at(&m, x, mid)[0] < 120),
                "{height}: right padding"
            );
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
        // The pill's own edges, no shadow beyond them.
        assert_eq!((w - 1 - x1, h - 1 - y1), (margin, margin));
        assert_eq!((x0, y0), (w - margin - pill_layout(height).width, h - margin - height));
        // White glyphs and a darker pill over the grey.
        assert!(after.pixels().any(|p| p.0[..3] == [255, 255, 255]));
        assert!(after.pixels().any(|p| p[0] < GREY[0] - 40));
        // The picture stays opaque.
        assert!(after.pixels().all(|p| p[3] == 255));
    }

    #[test]
    fn the_words_read_on_white_and_on_black() {
        for base in [[255, 255, 255, 255], [0, 0, 0, 255], [0x1e, 0x1f, 0x22, 255]] {
            let mut img = picture(1920, 1080, base);
            stamp_image(&mut img);
            let Layout { height, margin } = layout(1920, 1080);
            let p = pill_layout(height);
            // Behind the words, mid-height between the logo and them, the
            // pill is dark on any picture: rgba(14,16,20,0.62) over it.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let gap_x = 1920 - margin - p.width + (f64::from(p.pad_left) + p.logo_width + f64::from(p.gap) / 2.0) as u32;
            let behind = img.get_pixel(gap_x, 1080 - margin - height / 2);
            assert!(behind[0] <= 106, "{base:?}: {behind:?}");
            // And the words are solid white on it.
            let words = (1920 - margin - p.width..1920 - margin)
                .flat_map(|x| (1080 - margin - height..1080 - margin).map(move |y| (x, y)))
                .filter(|&(x, y)| img.get_pixel(x, y).0[..3] == [255, 255, 255])
                .count();
            assert!(words > 200, "{base:?}: {words} white pixels");
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
        let before = picture(60, 50, GREY);
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
        // The glyphs are opaque white, the pill its own colour at 62 %, not
        // the premultiplied (darker) value.
        assert!(img.pixels().any(|p| p.0 == [255, 255, 255, 255]));
        // Within the rounding of a premultiplied byte.
        let bare = |p: &&image::Rgba<u8>| p[3] == 158 && (0..3).all(|c| p[c].abs_diff(PILL_FILL[c]) <= 1);
        assert!(img.pixels().any(|p| bare(&p)), "the bare fill");
    }

    /// Writes the bottom-right 700 x 250 of a 1920 x 1080 white and a dark
    /// (#1e1f22) frame, watermarked as a screenshot and as an NV12 recording
    /// frame converted back, to `$WATERMARK_PROOF_DIR`, to look at.
    #[test]
    #[ignore = "writes pictures to look at; set WATERMARK_PROOF_DIR"]
    fn proof_pictures() {
        let Ok(dir) = std::env::var("WATERMARK_PROOF_DIR") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (1920u32, 1080u32);
        for (name, base) in [("light", [255, 255, 255, 255]), ("dark", [0x1e, 0x1f, 0x22, 255])] {
            let mut shot = picture(w, h, base);
            stamp_image(&mut shot);
            image::imageops::crop_imm(&shot, w - 700, h - 250, 700, 250)
                .to_image()
                .save(dir.join(format!("desktop-{name}.png")))
                .unwrap();
            let mut frame = Vec::new();
            let plain = picture(w, h, base);
            crate::capture::recorder_child::frame::to_nv12(
                crate::capture::recorder_child::frame::Bgra {
                    data: plain.as_raw(),
                    width: w,
                    height: h,
                    stride: w as usize * 4,
                },
                w,
                h,
                &mut frame,
            );
            Nv12Stamp::new(w, h).unwrap().apply(&mut frame);
            // The recording's place is higher: crop 250 rows ending at the
            // lifted pill's bottom plus the screenshot margin.
            let back = nv12_to_rgba(&frame, w, h);
            let bottom = h - recording_bottom_gap(h, layout(w, h).margin) + layout(w, h).margin;
            image::imageops::crop_imm(&back, w - 700, bottom - 250, 700, 250)
                .to_image()
                .save(dir.join(format!("desktop-{name}-nv12.png")))
                .unwrap();
        }
    }

    /// BT.709 limited range NV12 back to RGBA, the inverse of `to_nv12`.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::many_single_char_names)]
    fn nv12_to_rgba(nv12: &[u8], w: u32, h: u32) -> RgbaImage {
        let (wu, hu) = (w as usize, h as usize);
        RgbaImage::from_fn(w, h, |x, y| {
            let (x, y) = (x as usize, y as usize);
            let luma = (f64::from(nv12[y * wu + x]) - 16.0) * 255.0 / 219.0;
            let c = wu * hu + (y / 2) * wu + (x / 2) * 2;
            let cb = (f64::from(nv12[c]) - 128.0) * 255.0 / 224.0;
            let cr = (f64::from(nv12[c + 1]) - 128.0) * 255.0 / 224.0;
            let r = luma + 1.5748 * cr;
            let g = luma - 0.1873 * cb - 0.4681 * cr;
            let b = luma + 1.8556 * cb;
            let [r, g, b] = [r, g, b].map(|v| v.round().clamp(0.0, 255.0) as u8);
            image::Rgba([r, g, b, 255])
        })
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
    fn the_recording_mark_is_lifted_above_the_player_controls() {
        // 12 % of the height, the right margin as on a screenshot.
        assert_eq!(recording_bottom_gap(1080, 22), 130);
        assert_eq!(recording_bottom_gap(720, 14), 86);
        assert_eq!(recording_bottom_gap(1920, 22), 230, "portrait reads the height");
        // A short frame keeps the margin when 12 % is smaller.
        assert_eq!(recording_bottom_gap(100, MIN_MARGIN), MIN_MARGIN);
        assert_eq!(recording_bottom_gap(0, MIN_MARGIN), MIN_MARGIN);
        // The thousandths the helper reads are the share, and round as it does.
        assert!((f64::from(RECORDING_LIFT_PERMILLE) / 1000.0 - RECORDING_LIFT_SHARE).abs() < 1e-9);
        for h in 1..=8640u32 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let want = (f64::from(h) * RECORDING_LIFT_SHARE).round() as u32;
            assert_eq!(recording_bottom_gap(h, 0), want, "{h}");
        }
        // Same size and right edge as a screenshot's mark, only higher.
        for (w, h) in [(1280, 720), (1920, 1080), (1080, 1920), (3840, 2160)] {
            let Layout { height, margin } = layout(w, h);
            let m = mark(height);
            let shot = origin(w, h, &m, margin);
            let rec = recording_origin(w, h, &m, margin);
            assert_eq!(rec.0, shot.0, "{w}x{h}");
            let mark_bottom = rec.1 + i64::from(m.height) - i64::from(m.pad);
            assert_eq!(i64::from(h) - mark_bottom, i64::from(recording_bottom_gap(h, margin)), "{w}x{h}");
            assert!(i64::from(h) - mark_bottom >= i64::from(h) * 12 / 100, "{w}x{h}");
        }
    }

    #[test]
    fn a_recording_frame_matches_the_same_mark_blended_into_a_picture() {
        let (w, h) = (1280, 720);
        let mut frame = nv12(w, h, 90);
        let stamp = Nv12Stamp::new(w, h).unwrap();
        stamp.apply(&mut frame);
        // The same mark blended at the recording's place, then converted.
        let mut shot = picture(w, h, GREY);
        let Layout { height, margin } = layout(w, h);
        let m = mark(height);
        let at = recording_origin(w, h, &m, margin);
        blend(shot.as_mut(), w, h, w as usize * 4, &m, at);
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
        // And only the pill's rectangle changed: near the bottom, with its
        // bottom edge 12 % of the height up.
        let plain = nv12(w, h, 90);
        let luma = (w * h) as usize;
        let rows: Vec<usize> = (0..luma).filter(|&i| frame[i] != plain[i]).map(|i| i / w as usize).collect();
        let (top, bottom) = (rows[0], *rows.last().unwrap());
        let gap = recording_bottom_gap(h, margin) as usize;
        assert!(top > h as usize - 200, "first change on row {top}");
        assert_eq!(bottom, h as usize - gap - 1, "last change on row {bottom}");
        assert_eq!(top, h as usize - gap - height as usize, "first change on row {top}");
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

    /// An atlas's mark as read back: width, height, pad, where its pixels start.
    type AtlasMark = (u32, u32, u32, usize);

    /// Reads an atlas back the way the Swift helper does.
    fn read_atlas(bytes: &[u8]) -> (Vec<AtlasMark>, Vec<AtlasStep>) {
        let mut at = 4;
        let u32_at = |at: &mut usize| {
            let v = u32::from_le_bytes(bytes[*at..*at + 4].try_into().unwrap());
            *at += 4;
            v
        };
        assert_eq!(&bytes[..4], ATLAS_MAGIC);
        assert_eq!(u32_at(&mut at), RECORDING_LIFT_PERMILLE);
        let mut marks = Vec::new();
        for _ in 0..u32_at(&mut at) {
            let (w, h, pad) = (u32_at(&mut at), u32_at(&mut at), u32_at(&mut at));
            marks.push((w, h, pad, at));
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
    fn the_macos_atlas_places_every_size_as_the_other_recorders_do() {
        let bytes = atlas();
        let (marks, steps) = read_atlas(&bytes);
        assert_eq!(marks.len() as u32, MAX_HEIGHT - MIN_HEIGHT + 1);
        assert_eq!(steps[0].short_from, 0, "every size has a step");
        assert!(steps.windows(2).all(|s| s[0].short_from < s[1].short_from));
        // A couple of megabytes at most: it is written for every recording.
        assert!(bytes.len() < 2_500_000, "{} bytes", bytes.len());
        for (w, h) in [
            (320, 240),
            (1280, 720),
            (1512, 982),
            (1920, 1080),
            (3024, 1964),
            (3840, 2160),
            (7680, 4320),
            (1080, 1920),
            (200, 120),
        ] {
            let short = w.min(h);
            let step = steps.iter().rev().find(|s| s.short_from <= short).unwrap();
            let (mw, mh, pad, start) = marks[step.mark as usize];
            let want = layout(w, h);
            let m = mark(want.height);
            assert_eq!((mw, mh, pad), (m.width, m.height, m.pad), "{w}x{h}");
            let bgra: Vec<u8> = super::bgra(&m.pixels).collect();
            assert_eq!(&bytes[start..start + m.pixels.len()], bgra.as_slice(), "{w}x{h}: BGRA");
            // As the helper works it out.
            let lift = (i64::from(h) * i64::from(RECORDING_LIFT_PERMILLE) + 500) / 1000 - i64::from(pad);
            let inset_bottom = i64::from(step.inset_bottom).max(lift);
            let at = (
                i64::from(w) - i64::from(step.inset_right) - i64::from(mw),
                i64::from(h) - inset_bottom - i64::from(mh),
            );
            assert_eq!(at, recording_origin(w, h, &m, want.margin), "{w}x{h}");
        }
    }

    /// The Swift helper's `Watermark.stamp`, line for line: the atlas's
    /// premultiplied BGRA over an opaque BGRA frame.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_possible_wrap)]
    fn swift_stamp(bytes: &[u8], frame: &mut [u8], width: usize, height: usize) {
        let (marks, steps) = read_atlas(bytes);
        let short = width.min(height) as u32;
        let step = steps.iter().rev().find(|s| s.short_from <= short).unwrap();
        let (mw, mh, pad, start) = marks[step.mark as usize];
        let (mw, mh) = (mw as usize, mh as usize);
        let lift = (height as i64 * i64::from(RECORDING_LIFT_PERMILLE) + 500) / 1000 - i64::from(pad);
        let inset_bottom = i64::from(step.inset_bottom).max(lift);
        let left = width as i64 - i64::from(step.inset_right) - mw as i64;
        let top = height as i64 - inset_bottom - mh as i64;
        for y in top.max(0)..(top + mh as i64).min(height as i64) {
            for x in left.max(0)..(left + mw as i64).min(width as i64) {
                let s = start + (((y - top) as usize) * mw + (x - left) as usize) * 4;
                let alpha = u32::from(bytes[s + 3]);
                if alpha == 0 {
                    continue;
                }
                let d = (y as usize * width + x as usize) * 4;
                for c in 0..3 {
                    let v = u32::from(bytes[s + c]) + (u32::from(frame[d + c]) * (255 - alpha) + 127) / 255;
                    frame[d + c] = v.min(255) as u8;
                }
            }
        }
    }

    #[test]
    fn the_macos_helper_draws_what_the_screenshot_blend_draws() {
        let bytes = atlas();
        let (w, h) = (1920u32, 1080u32);
        for base in [[255, 255, 255, 255], [0x1e, 0x1f, 0x22, 255], [200, 40, 90, 255]] {
            // The helper's frame, BGRA.
            let mut frame: Vec<u8> = picture(w, h, base).pixels().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
            swift_stamp(&bytes, &mut frame, w as usize, h as usize);
            // The same mark at the recording's place, through the RGBA blend.
            let mut shot = picture(w, h, base);
            let Layout { height, margin } = layout(w, h);
            let m = mark(height);
            blend(shot.as_mut(), w, h, w as usize * 4, &m, recording_origin(w, h, &m, margin));
            let want: Vec<u8> = shot.pixels().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
            let worst = frame.iter().zip(&want).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
            assert!(worst <= 1, "{base:?}: worst {worst}");
            assert_ne!(
                frame,
                picture(w, h, base).pixels().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect::<Vec<u8>>()
            );
        }
    }

    /// The helper reads the atlas this module writes: pinned on its source.
    #[test]
    fn the_swift_helper_reads_this_atlas() {
        let swift = include_str!("../../../macos/HippiusCapture/Sources/HippiusCapture.swift");
        for literal in [
            r#"obj["watermarkAtlas"] as? String"#,
            r#"Array("HWM2".utf8)"#,
            "liftPermille",
            "stamp(pixelBuffer)",
        ] {
            assert!(swift.contains(literal), "HippiusCapture.swift no longer says `{literal}`");
        }
    }
}
