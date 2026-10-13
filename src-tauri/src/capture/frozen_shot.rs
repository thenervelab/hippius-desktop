//! Wayland screenshots chosen on Hippius's own overlay, over a still of the
//! desktop.
//!
//! A Wayland app can neither read the screen nor draw over it live, but the
//! Screenshot portal hands it one picture of the whole desktop when asked
//! with `interactive = false` (GNOME 42's portal takes it at once, with no
//! dialog; newer GNOME asks once and remembers). So a screenshot there is:
//!
//! 1. One non-interactive portal picture of every monitor at once.
//! 2. That picture cut into one slice per monitor ([`monitor_slices`], by
//!    GDK's layout), each shown full screen behind the usual overlay on its
//!    own monitor, with the same capture bar, keys and instant shortcut as
//!    every other platform. Area and Entire screen only: Wayland lists no
//!    windows.
//! 3. The chosen area, in the overlay's CSS pixels, cut out of the still
//!    ([`pixels_for`]). The ratio is the slice's pixels over the monitor's
//!    logical width, so HiDPI and fractional scaling need nothing more.
//!
//! With the screenshot timer the overlay counts down over the live screen
//! (the still is hidden while it counts) and a fresh picture is taken once
//! the overlays are gone ([`retakes`]): the timer exists so the screen can
//! change first.
//!
//! When the picture cannot be had or cannot be laid onto the monitors (the
//! portal refuses, or GDK's layout does not match the picture's shape), the
//! desktop's own interactive screenshot tool takes over, so the user is
//! never stuck.
//!
//! Pure, so it is tested on every OS; `commands` carries it out.

use std::io::Cursor;

use base64::Engine;

use super::area_pick::MonitorBox;
use super::geometry::{PixelRect, crop_rect};
use super::screenshot::Selection;
use super::targets::DisplayTarget;

/// How far apart the picture's horizontal and vertical scale may be and
/// still describe GDK's layout: logical sizes are whole numbers while a
/// fractionally scaled picture is not, so a little rounding is expected.
pub const SCALE_TOLERANCE: f64 = 0.02;

/// JPEG quality of the still each overlay shows: it is what the user looks
/// at while choosing, so close to the screen, while staying a quick encode.
pub const BACKDROP_QUALITY: u8 = 90;

/// Where each of `monitors` (GDK's layout, logical pixels) lies in the
/// portal's `image`-sized picture of the whole desktop. The picture is one
/// raster of the layout's bounding box at one scale, which is how GNOME
/// draws it whatever each monitor's own scale. `None` when the picture's
/// shape does not match the layout (the two scales disagree), or anything
/// is empty: the caller falls back to the desktop's own tool rather than
/// show the wrong part of the screen.
#[must_use]
pub fn monitor_slices(image: (u32, u32), monitors: &[MonitorBox]) -> Option<Vec<PixelRect>> {
    if monitors.is_empty() || image.0 == 0 || image.1 == 0 {
        return None;
    }
    let sane = |m: &MonitorBox| [m.x, m.y, m.width, m.height].iter().all(|v| v.is_finite()) && m.width > 0.0 && m.height > 0.0;
    if !monitors.iter().all(sane) {
        return None;
    }
    let min_x = monitors.iter().map(|m| m.x).fold(f64::INFINITY, f64::min);
    let min_y = monitors.iter().map(|m| m.y).fold(f64::INFINITY, f64::min);
    let max_x = monitors.iter().map(|m| m.x + m.width).fold(f64::NEG_INFINITY, f64::max);
    let max_y = monitors.iter().map(|m| m.y + m.height).fold(f64::NEG_INFINITY, f64::max);
    let sx = f64::from(image.0) / (max_x - min_x);
    let sy = f64::from(image.1) / (max_y - min_y);
    if (sx - sy).abs() > SCALE_TOLERANCE * sx.max(sy) {
        return None;
    }
    let edge = |v: f64, scale: f64, limit: u32| {
        // Clamped to the picture first, so the cast cannot wrap.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let px = (v * scale).round().clamp(0.0, f64::from(limit)) as u32;
        px
    };
    monitors
        .iter()
        .map(|m| {
            let x0 = edge(m.x - min_x, sx, image.0);
            let y0 = edge(m.y - min_y, sy, image.1);
            let x1 = edge(m.x + m.width - min_x, sx, image.0);
            let y1 = edge(m.y + m.height - min_y, sy, image.1);
            (x1 > x0 && y1 > y0).then_some(PixelRect {
                x: x0,
                y: y0,
                width: x1 - x0,
                height: y1 - y0,
            })
        })
        .collect()
}

/// The pixels of the picture a selection on the frozen overlay means.
/// The display id is the monitor's index; an area is in that overlay's CSS
/// pixels, whose viewport is the monitor's logical size (the overlay is
/// full screen on it). `None` for a window (Wayland lists none), a monitor
/// that is not there, or an area with nothing in it.
#[must_use]
pub fn pixels_for(selection: Selection, monitors: &[MonitorBox], slices: &[PixelRect]) -> Option<PixelRect> {
    let (display_id, rect) = match selection {
        Selection::Area { display_id, rect } => (display_id, Some(rect)),
        Selection::Screen { display_id } => (display_id, None),
        Selection::Window { .. } => return None,
    };
    let index = usize::try_from(display_id).ok()?;
    let (monitor, slice) = (monitors.get(index)?, slices.get(index)?);
    let Some(rect) = rect else {
        return Some(*slice);
    };
    let scale = f64::from(slice.width) / monitor.width;
    let px = crop_rect(rect, scale, slice.width, slice.height)?;
    Some(PixelRect {
        x: slice.x + px.x,
        y: slice.y + px.y,
        ..px
    })
}

/// Whether the shot is taken again once the overlays are gone: with a
/// countdown the user meant the screen as it is when the count ends, not
/// as it was frozen.
#[must_use]
pub const fn retakes(countdown_secs: u8) -> bool {
    countdown_secs > 0
}

/// Which monitor carries the capture bar: the primary one GDK names, else
/// the first. Wayland tells an app nothing about the pointer outside its
/// own windows, so "the display under the pointer" is not known here.
#[must_use]
pub fn bar_monitor(count: usize, primary: Option<usize>) -> usize {
    primary.filter(|i| *i < count).unwrap_or(0)
}

/// The session's displays, one per monitor, its index as the id. Sizes are
/// in the monitor's pixels (logical times GDK's scale), the units Linux
/// display targets carry, so `logical_width` is the overlay's CSS width.
#[must_use]
pub fn display_targets(monitors: &[MonitorBox], scales: &[f64], bar: usize) -> Vec<DisplayTarget> {
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let scale = scales.get(i).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(1.0);
            // Finite, positive and on-screen sized: the casts cannot wrap.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let target = DisplayTarget {
                id: u32::try_from(i).unwrap_or(u32::MAX),
                name: String::new(),
                x: (m.x * scale).round() as i32,
                y: (m.y * scale).round() as i32,
                width: (m.width * scale).round().max(1.0) as u32,
                height: (m.height * scale).round().max(1.0) as u32,
                scale_factor: scale,
                is_primary: i == bar,
            };
            target
        })
        .collect()
}

/// The desktop as it was when the capture started, and where each monitor
/// is in it.
pub struct FrozenDesktop {
    pub image: image::RgbaImage,
    pub monitors: Vec<MonitorBox>,
    pub slices: Vec<PixelRect>,
    /// Each overlay's still (a JPEG data URL), made once.
    pub backdrops: Vec<String>,
}

impl FrozenDesktop {
    /// The picture laid onto `monitors`, with each overlay's still encoded.
    /// `None` when it does not fit them ([`monitor_slices`]).
    #[must_use]
    pub fn new(image: image::RgbaImage, monitors: Vec<MonitorBox>) -> Option<Self> {
        let slices = monitor_slices(image.dimensions(), &monitors)?;
        let backdrops = slices.iter().map(|s| backdrop(&image, *s)).collect::<Option<Vec<_>>>()?;
        Some(Self {
            image,
            monitors,
            slices,
            backdrops,
        })
    }

    /// The pixels `selection` means, cut out of `image` (the frozen picture,
    /// or a fresh one of the same desktop). `None` when it means nothing
    /// there, or the fresh picture no longer fits the layout.
    #[must_use]
    pub fn cut(&self, selection: Selection, image: &image::RgbaImage) -> Option<image::RgbaImage> {
        let slices = if image.dimensions() == self.image.dimensions() {
            self.slices.clone()
        } else {
            monitor_slices(image.dimensions(), &self.monitors)?
        };
        let px = pixels_for(selection, &self.monitors, &slices)?;
        Some(image::imageops::crop_imm(image, px.x, px.y, px.width, px.height).to_image())
    }

    /// The selection cut from `fresh` (the timer's new picture) when there
    /// is one that fits the layout, else from the frozen picture: a still
    /// that could not be taken again is better than no screenshot.
    #[must_use]
    pub fn cut_latest(&self, selection: Selection, fresh: Option<&image::RgbaImage>) -> Option<image::RgbaImage> {
        fresh.and_then(|f| self.cut(selection, f)).or_else(|| self.cut(selection, &self.image))
    }
}

/// One monitor's part of the picture as a JPEG data URL, for its overlay.
fn backdrop(image: &image::RgbaImage, slice: PixelRect) -> Option<String> {
    let part = image::imageops::crop_imm(image, slice.x, slice.y, slice.width, slice.height).to_image();
    let rgb = image::DynamicImage::ImageRgba8(part).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), BACKDROP_QUALITY)
        .encode_image(&rgb)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;

    fn monitor(x: f64, y: f64, width: f64, height: f64) -> MonitorBox {
        MonitorBox { x, y, width, height }
    }

    fn px(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
        PixelRect { x, y, width, height }
    }

    fn area(display_id: u32, x: f64, y: f64, width: f64, height: f64) -> Selection {
        Selection::Area {
            display_id,
            rect: LogicalRect { x, y, width, height },
        }
    }

    /// One 1x monitor: the picture is the monitor.
    #[test]
    fn one_monitor_is_the_whole_picture() {
        let slices = monitor_slices((1920, 1080), &[monitor(0.0, 0.0, 1920.0, 1080.0)]).unwrap();
        assert_eq!(slices, [px(0, 0, 1920, 1080)]);
    }

    /// A 2x monitor beside a 1x one: GNOME draws the whole layout at one
    /// scale, so each monitor is its logical box times that scale.
    #[test]
    fn two_monitors_are_cut_at_the_pictures_one_scale() {
        let monitors = [monitor(0.0, 0.0, 1920.0, 1080.0), monitor(1920.0, 0.0, 1280.0, 1024.0)];
        let slices = monitor_slices((6400, 2160), &monitors).unwrap();
        assert_eq!(slices, [px(0, 0, 3840, 2160), px(3840, 0, 2560, 2048)]);
        // A layout that starts off the origin (a monitor left of the primary).
        let shifted = [monitor(-1280.0, 0.0, 1280.0, 1024.0), monitor(0.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(
            monitor_slices((3200, 1080), &shifted).unwrap(),
            [px(0, 0, 1280, 1024), px(1280, 0, 1920, 1080)]
        );
    }

    /// Fractional scaling: 150% of a 2560x1440 panel is 1707x960 logical;
    /// the picture is in the panel's pixels and still maps one to one.
    #[test]
    fn a_fractionally_scaled_monitor_maps_onto_its_pixels() {
        let slices = monitor_slices((2560, 1440), &[monitor(0.0, 0.0, 1707.0, 960.0)]).unwrap();
        assert_eq!(slices, [px(0, 0, 2560, 1440)]);
    }

    /// A picture whose shape the layout cannot explain is refused, never
    /// guessed at: the desktop's own tool takes over.
    #[test]
    fn a_picture_that_does_not_match_the_layout_is_refused() {
        let monitors = [monitor(0.0, 0.0, 1920.0, 1080.0), monitor(3840.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(monitor_slices((5760, 2160), &monitors), None);
        assert_eq!(monitor_slices((1920, 1080), &[]), None);
        assert_eq!(monitor_slices((0, 0), &[monitor(0.0, 0.0, 10.0, 10.0)]), None);
        assert_eq!(monitor_slices((100, 100), &[monitor(0.0, 0.0, f64::NAN, 10.0)]), None);
    }

    /// An area on a 2x monitor is its CSS pixels doubled; the second
    /// monitor's area is offset by that monitor's slice.
    #[test]
    fn an_area_is_cut_from_its_monitors_slice() {
        let monitors = [monitor(0.0, 0.0, 1920.0, 1080.0), monitor(1920.0, 0.0, 1280.0, 1024.0)];
        let slices = monitor_slices((6400, 2160), &monitors).unwrap();
        assert_eq!(
            pixels_for(area(0, 100.0, 50.0, 200.0, 100.0), &monitors, &slices),
            Some(px(200, 100, 400, 200))
        );
        assert_eq!(
            pixels_for(area(1, 10.0, 20.0, 30.0, 40.0), &monitors, &slices),
            Some(px(3840 + 20, 40, 60, 80))
        );
        assert_eq!(pixels_for(Selection::Screen { display_id: 1 }, &monitors, &slices), Some(slices[1]));
    }

    /// Fractional scaling rounds outward and never leaves the monitor.
    #[test]
    fn a_fractional_area_rounds_outward_inside_its_monitor() {
        let monitors = [monitor(0.0, 0.0, 1707.0, 960.0)];
        let slices = monitor_slices((2560, 1440), &monitors).unwrap();
        let cut = pixels_for(area(0, 100.5, 10.0, 333.0, 201.0), &monitors, &slices).unwrap();
        assert!(cut.x <= 150 && cut.x + cut.width >= 650, "{cut:?}");
        let edge = pixels_for(area(0, 1600.0, 900.0, 500.0, 500.0), &monitors, &slices).unwrap();
        assert_eq!((edge.x + edge.width, edge.y + edge.height), (2560, 1440), "clamped to the monitor");
    }

    /// No window on Wayland, no monitor that is not there, no click.
    #[test]
    fn a_window_a_missing_monitor_or_a_click_is_nothing() {
        let monitors = [monitor(0.0, 0.0, 1920.0, 1080.0)];
        let slices = monitor_slices((1920, 1080), &monitors).unwrap();
        assert_eq!(pixels_for(Selection::Window { window_id: 1 }, &monitors, &slices), None);
        assert_eq!(pixels_for(Selection::Screen { display_id: 3 }, &monitors, &slices), None);
        assert_eq!(pixels_for(area(0, 10.0, 10.0, 0.0, 0.0), &monitors, &slices), None);
    }

    #[test]
    fn only_a_countdown_takes_the_picture_again() {
        assert!(!retakes(0));
        assert!(retakes(5));
        assert!(retakes(10));
    }

    #[test]
    fn the_bar_goes_on_the_primary_monitor_else_the_first() {
        assert_eq!(bar_monitor(2, Some(1)), 1);
        assert_eq!(bar_monitor(2, None), 0);
        assert_eq!(bar_monitor(2, Some(5)), 0, "a primary that is not listed");
    }

    /// The overlay's CSS size is the monitor's logical size, kept in pixels.
    #[test]
    fn each_monitor_becomes_a_display_by_its_index() {
        let monitors = [monitor(0.0, 0.0, 1707.0, 960.0), monitor(1707.0, 0.0, 1920.0, 1080.0)];
        let displays = display_targets(&monitors, &[2.0, 1.0], 1);
        assert_eq!(displays.iter().map(|d| d.id).collect::<Vec<_>>(), [0, 1]);
        // Linux display targets are in pixels: logical times the scale.
        assert_eq!((displays[0].width, displays[0].height, displays[0].x), (3414, 1920, 0));
        assert_eq!((displays[1].x, displays[1].width), (1707, 1920));
        assert!(displays[1].is_primary && !displays[0].is_primary);
        assert!((display_targets(&monitors, &[], 0)[0].scale_factor - 1.0).abs() < f64::EPSILON);
    }

    fn picture(width: u32, height: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(width, height, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, 7, 255]))
    }

    /// Each overlay gets its own monitor's part of the picture, and the cut
    /// keeps the picture's own pixels.
    #[test]
    fn the_frozen_desktop_shows_and_cuts_each_monitor() {
        let monitors = vec![monitor(0.0, 0.0, 100.0, 50.0), monitor(100.0, 0.0, 60.0, 50.0)];
        let frozen = FrozenDesktop::new(picture(320, 100), monitors).unwrap();
        assert_eq!(frozen.backdrops.len(), 2);
        let encoded = frozen.backdrops[1].strip_prefix("data:image/jpeg;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 120, "the second monitor's slice");
        let cut = frozen.cut(area(1, 5.0, 5.0, 10.0, 10.0), &frozen.image).unwrap();
        assert_eq!(cut.dimensions(), (20, 20));
        assert_eq!(cut.get_pixel(0, 0), frozen.image.get_pixel(210, 10));
    }

    /// A fresh picture for the timer is laid onto the same monitors; one
    /// that no longer fits them is not used.
    #[test]
    fn a_fresh_picture_is_cut_by_the_same_layout() {
        let frozen = FrozenDesktop::new(picture(200, 100), vec![monitor(0.0, 0.0, 200.0, 100.0)]).unwrap();
        let fresh = picture(400, 200);
        assert_eq!(frozen.cut(area(0, 10.0, 10.0, 20.0, 20.0), &fresh).unwrap().dimensions(), (40, 40));
        assert!(frozen.cut(area(0, 10.0, 10.0, 20.0, 20.0), &picture(400, 100)).is_none());
        assert!(FrozenDesktop::new(picture(200, 100), vec![monitor(0.0, 0.0, 100.0, 100.0)]).is_none());
    }

    /// The timer's fresh picture wins; without one, or with one that does
    /// not fit, the frozen picture is cut instead.
    #[test]
    fn the_latest_picture_that_fits_is_cut() {
        let frozen = FrozenDesktop::new(picture(200, 100), vec![monitor(0.0, 0.0, 200.0, 100.0)]).unwrap();
        let selection = area(0, 0.0, 0.0, 10.0, 10.0);
        let fresh = image::RgbaImage::from_pixel(200, 100, image::Rgba([1, 2, 3, 255]));
        assert_eq!(
            frozen.cut_latest(selection, Some(&fresh)).unwrap().get_pixel(0, 0),
            &image::Rgba([1, 2, 3, 255])
        );
        let odd = image::RgbaImage::from_pixel(50, 100, image::Rgba([1, 2, 3, 255]));
        assert_eq!(
            frozen.cut_latest(selection, Some(&odd)).unwrap().get_pixel(5, 5),
            frozen.image.get_pixel(5, 5)
        );
        assert_eq!(frozen.cut_latest(selection, None).unwrap().dimensions(), (10, 10));
    }
}
