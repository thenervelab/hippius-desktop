//! The camera bubble drawn into a window recording.
//!
//! A window recording films one window, so on Windows the bubble (another
//! window, Hippius's own) is not in it: Windows.Graphics.Capture takes one
//! item. The recorder therefore captures the bubble's window too and draws
//! its latest picture into each picture of the recorded window, where the
//! bubble sits on screen relative to that window, the way macOS's
//! ScreenCaptureKit filter of the two windows does.
//!
//! The bubble's window is transparent around the bubble (the camera page's
//! `p-1.5` margin, then a 2 px ring and a round or 18 px rounded frame), and
//! a capture may hand those transparent pixels over as black. So only the
//! bubble's own shape is drawn ([`bubble_shape`]), edge-smoothed, with the
//! picture's alpha on top. Pure, so it is tested on every OS.

/// The camera page's margin around the bubble, in CSS px (`p-1.5`).
pub const MARGIN_CSS: f64 = 6.0;
/// The ring drawn just outside the bubble (`ring-2`).
pub const RING_CSS: f64 = 2.0;
/// The full-size bubble's corner (`rounded-[18px]`).
pub const CORNER_CSS: f64 = 18.0;

/// A rectangle on screen or in a picture, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The part of the bubble's window that is the bubble: inset from the
/// window's edge, with this corner radius (a circle when the radius is half
/// the side).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub inset: f64,
    pub radius: f64,
}

/// The bubble inside a `width` x `height` camera window at `scale` pixels
/// per CSS px: round when the window is square (small and large), rounded
/// corners otherwise (full size). The ring is kept, the margin is not.
#[must_use]
pub fn bubble_shape(width: u32, height: u32, scale: f64) -> Shape {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let inset = (MARGIN_CSS - RING_CSS) * scale;
    let inner_w = (f64::from(width) - 2.0 * inset).max(0.0);
    let inner_h = (f64::from(height) - 2.0 * inset).max(0.0);
    let round = width.abs_diff(height) <= 1;
    let radius = if round {
        inner_w.min(inner_h) / 2.0
    } else {
        ((CORNER_CSS + RING_CSS) * scale).min(inner_w.min(inner_h) / 2.0)
    };
    Shape { inset, radius }
}

/// How much of pixel (`x`, `y`) of a `width` x `height` window lies inside
/// `shape`, 0 to 1, with a one-pixel soft edge.
#[must_use]
pub fn coverage(shape: Shape, width: u32, height: u32, x: u32, y: u32) -> f64 {
    let (px, py) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
    let (left, top) = (shape.inset, shape.inset);
    let (right, bottom) = (f64::from(width) - shape.inset, f64::from(height) - shape.inset);
    if right <= left || bottom <= top {
        return 0.0;
    }
    let (half_w, half_h) = ((right - left) / 2.0, (bottom - top) / 2.0);
    let r = shape.radius.clamp(0.0, half_w.min(half_h));
    // Signed distance from the rounded rectangle's edge (negative inside).
    let qx = (px - (left + half_w)).abs() - (half_w - r);
    let qy = (py - (top + half_h)).abs() - (half_h - r);
    let distance = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
    (0.5 - distance).clamp(0.0, 1.0)
}

/// Where the camera's picture goes in the recorded window's picture: the
/// camera window's offset from the recorded window on screen, scaled when the
/// picture is not the window's size on screen.
#[must_use]
pub fn placement(window: Rect, camera: Rect, picture: (u32, u32)) -> (i32, i32) {
    let sx = if window.width > 0 {
        f64::from(picture.0) / f64::from(window.width)
    } else {
        1.0
    };
    let sy = if window.height > 0 {
        f64::from(picture.1) / f64::from(window.height)
    } else {
        1.0
    };
    #[allow(clippy::cast_possible_truncation)]
    (
        (f64::from(camera.x - window.x) * sx).round() as i32,
        (f64::from(camera.y - window.y) * sy).round() as i32,
    )
}

/// BGRA pixels with premultiplied alpha (what Windows.Graphics.Capture
/// hands out), `stride` bytes per row.
#[derive(Debug, Clone, Copy)]
pub struct Pixels<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

impl Pixels<'_> {
    fn readable(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.stride >= self.width as usize * 4
            && self.data.len() >= self.stride * (self.height as usize - 1) + self.width as usize * 4
    }
}

/// Draw `camera` (its window's whole picture) into `dst` (a `dst_w` x
/// `dst_h` BGRA picture, `dst_stride` bytes per row) with its top-left at
/// `at`, keeping only `shape`. Anything off the picture is left out; a
/// malformed buffer draws nothing.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_possible_wrap)]
pub fn composite(dst: &mut [u8], dst_w: u32, dst_h: u32, dst_stride: usize, camera: Pixels<'_>, at: (i32, i32), shape: Shape) {
    if !camera.readable() || dst_stride < dst_w as usize * 4 || dst_h == 0 || dst.len() < dst_stride * (dst_h as usize - 1) + dst_w as usize * 4 {
        return;
    }
    for sy in 0..camera.height {
        let dy = at.1 + sy as i32;
        if dy < 0 || dy >= dst_h as i32 {
            continue;
        }
        for sx in 0..camera.width {
            let dx = at.0 + sx as i32;
            if dx < 0 || dx >= dst_w as i32 {
                continue;
            }
            let cover = coverage(shape, camera.width, camera.height, sx, sy);
            if cover <= 0.0 {
                continue;
            }
            let s = sy as usize * camera.stride + sx as usize * 4;
            let d = dy as usize * dst_stride + dx as usize * 4;
            let alpha = f64::from(camera.data[s + 3]) / 255.0 * cover;
            for c in 0..3 {
                let src = f64::from(camera.data[s + c]) * cover;
                let under = f64::from(dst[d + c]) * (1.0 - alpha);
                dst[d + c] = (src + under).round().clamp(0.0, 255.0) as u8;
            }
            let under_a = f64::from(dst[d + 3]) * (1.0 - alpha);
            dst[d + 3] = (alpha * 255.0 + under_a).round().clamp(0.0, 255.0) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [0, 0, 255, 255];
    const BLUE: [u8; 4] = [255, 0, 0, 255];

    fn picture(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        px.iter().copied().cycle().take((w * h * 4) as usize).collect()
    }

    fn at(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn a_square_window_is_a_round_bubble_and_a_wide_one_has_rounded_corners() {
        // The small bubble at 150 %: 300 px window, 6 px inset (4 CSS px).
        let round = bubble_shape(300, 300, 1.5);
        assert!((round.inset - 6.0).abs() < 1e-9);
        assert!((round.radius - 144.0).abs() < 1e-9);
        let full = bubble_shape(1280, 720, 1.0);
        assert!((full.inset - 4.0).abs() < 1e-9);
        assert!((full.radius - 20.0).abs() < 1e-9);
        // A nonsense scale reads as 1.
        assert_eq!(bubble_shape(100, 100, f64::NAN), bubble_shape(100, 100, 1.0));
    }

    #[test]
    fn the_margin_and_the_corners_are_not_drawn() {
        let shape = bubble_shape(100, 100, 1.0);
        assert!(coverage(shape, 100, 100, 0, 0) <= 0.0, "the transparent margin");
        assert!(coverage(shape, 100, 100, 8, 8) <= 0.0, "outside the circle, inside the margin box");
        assert!((coverage(shape, 100, 100, 50, 50) - 1.0).abs() < 1e-9, "the middle");
        assert!((coverage(shape, 100, 100, 50, 5) - 1.0).abs() < 1e-9, "the ring at the top");
        assert!(coverage(shape, 100, 100, 50, 3) <= 0.0, "just above the ring");
        // A soft edge, not a staircase.
        let edge = (0..100)
            .map(|x| coverage(shape, 100, 100, x, 20))
            .filter(|c| *c > 0.0 && *c < 1.0)
            .count();
        assert!(edge >= 1, "some pixel on the edge is partly covered");
    }

    #[test]
    fn the_bubble_lands_where_it_is_on_screen() {
        let window = Rect {
            x: 100,
            y: 50,
            width: 800,
            height: 600,
        };
        let camera = Rect {
            x: 140,
            y: 400,
            width: 300,
            height: 300,
        };
        assert_eq!(placement(window, camera, (800, 600)), (40, 350));
        // A picture at half the window's size (scaled capture) halves it.
        assert_eq!(placement(window, camera, (400, 300)), (20, 175));
        // Above and left of the window: negative, drawn cut.
        let up_left = Rect { x: 50, y: 0, ..camera };
        assert_eq!(placement(window, up_left, (800, 600)), (-50, -50));
    }

    #[test]
    fn an_opaque_bubble_covers_the_window_inside_its_shape_only() {
        let (w, h) = (40u32, 40u32);
        let mut dst = picture(w, h, BLUE);
        let cam = picture(20, 20, RED);
        let shape = bubble_shape(20, 20, 1.0);
        composite(
            &mut dst,
            w,
            h,
            w as usize * 4,
            Pixels {
                data: &cam,
                width: 20,
                height: 20,
                stride: 80,
            },
            (10, 10),
            shape,
        );
        assert_eq!(at(&dst, w, 20, 20), RED, "the middle of the bubble");
        assert_eq!(at(&dst, w, 10, 10), BLUE, "the camera window's corner is not drawn");
        assert_eq!(at(&dst, w, 5, 5), BLUE, "outside the camera window");
    }

    #[test]
    fn transparent_camera_pixels_leave_the_window_showing() {
        let (w, h) = (20u32, 20u32);
        let mut dst = picture(w, h, BLUE);
        let cam = picture(20, 20, [0, 0, 0, 0]);
        composite(
            &mut dst,
            w,
            h,
            80,
            Pixels {
                data: &cam,
                width: 20,
                height: 20,
                stride: 80,
            },
            (0, 0),
            bubble_shape(20, 20, 1.0),
        );
        assert_eq!(at(&dst, w, 10, 10), BLUE);
    }

    #[test]
    fn a_bubble_half_off_the_picture_is_cut_and_bad_buffers_draw_nothing() {
        let (w, h) = (20u32, 20u32);
        let mut dst = picture(w, h, BLUE);
        let cam = picture(20, 20, RED);
        let pixels = Pixels {
            data: &cam,
            width: 20,
            height: 20,
            stride: 80,
        };
        composite(&mut dst, w, h, 80, pixels, (10, -10), bubble_shape(20, 20, 1.0));
        assert_eq!(at(&dst, w, 19, 0), RED, "the lower half lands at the top right");
        assert_eq!(at(&dst, w, 5, 15), BLUE);
        let before = dst.clone();
        let short = Pixels { data: &cam[..10], ..pixels };
        composite(&mut dst, w, h, 80, short, (0, 0), bubble_shape(20, 20, 1.0));
        assert_eq!(dst, before, "a short camera buffer is not read");
        composite(&mut dst, w, h, 40, pixels, (0, 0), bubble_shape(20, 20, 1.0));
        assert_eq!(dst, before, "a stride shorter than a row is refused");
    }
}
