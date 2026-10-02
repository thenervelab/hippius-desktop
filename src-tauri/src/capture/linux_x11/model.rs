//! What an X11 server answers, turned into the shapes capture uses. Pure, so
//! it is tested on every OS from recorded property values; the connection
//! that asks the server is `super::os` (Linux only).
//!
//! **Coordinates.** X11 has one root window per screen and every monitor is a
//! rectangle inside it, in physical pixels from the root's top-left, so no
//! value here is ever negative. GDK (and so the webview) has ONE scale for
//! the whole screen on X11 (`GDK_SCALE`, or the desktop's
//! `Gdk/WindowScalingFactor` XSETTING): a CSS pixel is that many physical
//! pixels on every monitor, unlike Windows' per-monitor scale.

// Only the Linux connection calls these outside the tests.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::capture::geometry::PixelRect;
use crate::capture::targets::{DisplayTarget, NativeFrame};

// ── Monitors and the screen's scale ────────────────────────────────────────

/// A monitor as RandR's `GetMonitors` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawMonitor {
    /// The monitor's name atom: stable while the monitor stays connected,
    /// so it is the display id the overlay and the selection carry.
    pub name_atom: u32,
    pub name: String,
    pub primary: bool,
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

/// Display id for the whole screen when RandR lists no monitor (an X server
/// without RandR 1.5, or Xvfb started without one).
pub const WHOLE_SCREEN_ID: u32 = 1;

/// The displays to capture, from RandR's monitors, every one at the screen's
/// single `scale`. With no monitor listed, the whole root is one display.
/// The primary is marked; with none marked, the first is.
#[must_use]
pub fn displays_from(monitors: &[RawMonitor], root_width: u16, root_height: u16, scale: f64) -> Vec<DisplayTarget> {
    let mut out: Vec<DisplayTarget> = monitors
        .iter()
        .filter(|m| m.width > 0 && m.height > 0)
        .map(|m| DisplayTarget {
            id: m.name_atom,
            name: m.name.clone(),
            // RandR monitors are inside the root; a negative origin would be
            // a server bug, and is clamped rather than wrapped.
            x: i32::from(m.x.max(0)),
            y: i32::from(m.y.max(0)),
            width: u32::from(m.width),
            height: u32::from(m.height),
            scale_factor: scale,
            is_primary: m.primary,
        })
        .collect();
    if out.is_empty() && root_width > 0 && root_height > 0 {
        out.push(DisplayTarget {
            id: WHOLE_SCREEN_ID,
            name: String::new(),
            x: 0,
            y: 0,
            width: u32::from(root_width),
            height: u32::from(root_height),
            scale_factor: scale,
            is_primary: true,
        });
    }
    if !out.iter().any(|d| d.is_primary)
        && let Some(first) = out.first_mut()
    {
        first.is_primary = true;
    }
    out
}

/// The screen's scale as GDK sees it: `GDK_SCALE` when set to a whole number
/// of 1 or more (GDK honours it over everything), else the desktop's
/// `Gdk/WindowScalingFactor` XSETTING, else 1. GDK 3 scales by whole numbers
/// only on X11; fractional desktop scaling there changes font DPI, not the
/// webview's pixel size, so a fraction is never returned.
#[must_use]
pub fn screen_scale(gdk_scale_env: Option<&str>, xsettings_window_scale: Option<i32>) -> f64 {
    if let Some(n) = gdk_scale_env.and_then(|v| v.trim().parse::<u32>().ok()).filter(|n| *n >= 1) {
        return f64::from(n);
    }
    match xsettings_window_scale {
        Some(n) if n >= 1 => f64::from(n),
        _ => 1.0,
    }
}

/// The integer setting `name` from an `_XSETTINGS_SETTINGS` property (the
/// XSETTINGS wire format: a byte-order byte, a serial, a count, then each
/// setting as type, name, serial and value, every part padded to 4 bytes).
/// `None` when it is missing, not an integer, or the data is cut short.
#[must_use]
pub fn xsettings_int(data: &[u8], name: &str) -> Option<i32> {
    let mut r = Reader::new(data)?;
    r.skip(3)?;
    let _serial = r.u32()?;
    let count = r.u32()?;
    for _ in 0..count {
        let kind = r.u8()?;
        r.skip(1)?;
        let name_len = usize::from(r.u16()?);
        let this = r.bytes(name_len)?;
        r.skip(pad4(name_len))?;
        let _last_change = r.u32()?;
        match kind {
            0 => {
                let value = r.u32()?;
                if this == name.as_bytes() {
                    return Some(i32::from_ne_bytes(value.to_ne_bytes()));
                }
            }
            1 => {
                let len = usize::try_from(r.u32()?).ok()?;
                r.skip(len)?;
                r.skip(pad4(len))?;
            }
            2 => r.skip(8)?,
            _ => return None,
        }
    }
    None
}

fn pad4(len: usize) -> usize {
    (4 - len % 4) % 4
}

/// Reads XSETTINGS fields in the byte order its first byte names.
struct Reader<'a> {
    data: &'a [u8],
    at: usize,
    big_endian: bool,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Option<Self> {
        let order = *data.first()?;
        Some(Self {
            data,
            at: 1,
            big_endian: order == 1,
        })
    }

    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let out = self.data.get(self.at..end)?;
        self.at = end;
        Some(out)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.bytes(n).map(|_| ())
    }

    fn u8(&mut self) -> Option<u8> {
        self.bytes(1).map(|b| b[0])
    }

    fn u16(&mut self) -> Option<u16> {
        let b: [u8; 2] = self.bytes(2)?.try_into().ok()?;
        Some(if self.big_endian { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) })
    }

    fn u32(&mut self) -> Option<u32> {
        let b: [u8; 4] = self.bytes(4)?.try_into().ok()?;
        Some(if self.big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    }
}

/// Which display the pointer is on, as `(x, y)` in root pixels: the same
/// space `DisplayTarget` uses on Linux, so `bar::bar_display` takes it as is.
#[must_use]
pub fn pointer_point(root_x: i16, root_y: i16) -> (f64, f64) {
    (f64::from(root_x), f64::from(root_y))
}

// ── Windows (EWMH) ──────────────────────────────────────────────────────────

/// What `_NET_WM_WINDOW_TYPE` says a window is, as far as picking goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowType {
    /// A normal application window, a dialog, a utility palette: pickable.
    Normal,
    /// Panels, docks, the desktop icons window, notifications, menus,
    /// tooltips, splash screens: desktop furniture, never offered.
    Furniture,
}

/// The `_NET_WM_WINDOW_TYPE_*` atom names that are desktop furniture.
pub const FURNITURE_TYPES: [&str; 9] = [
    "_NET_WM_WINDOW_TYPE_DESKTOP",
    "_NET_WM_WINDOW_TYPE_DOCK",
    "_NET_WM_WINDOW_TYPE_NOTIFICATION",
    "_NET_WM_WINDOW_TYPE_TOOLTIP",
    "_NET_WM_WINDOW_TYPE_MENU",
    "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
    "_NET_WM_WINDOW_TYPE_POPUP_MENU",
    "_NET_WM_WINDOW_TYPE_SPLASH",
    "_NET_WM_WINDOW_TYPE_DND",
];

/// A window type from its atom names, most specific first (EWMH lists them
/// in order of preference): the first known one decides. No type at all is
/// a normal window, as EWMH says for a managed top-level window.
#[must_use]
pub fn window_type(type_names: &[String]) -> WindowType {
    for name in type_names {
        if FURNITURE_TYPES.contains(&name.as_str()) {
            return WindowType::Furniture;
        }
        if name.starts_with("_NET_WM_WINDOW_TYPE_") {
            return WindowType::Normal;
        }
    }
    WindowType::Normal
}

/// One client window as the window manager reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct RawWindow {
    pub id: u32,
    /// `_NET_WM_NAME` (UTF-8).
    pub net_wm_name: Option<String>,
    /// `WM_NAME` (Latin-1), for the windows that set no `_NET_WM_NAME`.
    pub wm_name: Option<String>,
    /// `WM_CLASS`: `instance\0class\0`.
    pub wm_class: Option<Vec<u8>>,
    pub pid: Option<u32>,
    /// The client area in root coordinates, without the frame.
    pub client: NativeFrame,
    /// `_NET_FRAME_EXTENTS`: left, right, top, bottom.
    pub frame_extents: Option<[u32; 4]>,
    /// `_NET_WM_STATE` holds `_NET_WM_STATE_HIDDEN` (minimised, or shaded).
    pub hidden: bool,
    pub window_type: WindowType,
    /// `_NET_WM_DESKTOP`: the workspace it is on (`0xFFFF_FFFF` = all).
    pub desktop: Option<u32>,
}

/// A window the overlay may offer, front first.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedWindow {
    pub id: u32,
    pub pid: Option<u32>,
    pub app_name: String,
    pub title: String,
    /// The window WITH its frame (title bar, borders), the way it looks on
    /// screen and the way macOS and Windows window shots include it.
    pub frame: NativeFrame,
}

/// EWMH's "on every workspace".
pub const ALL_DESKTOPS: u32 = 0xFFFF_FFFF;

/// The title a person would recognise: `_NET_WM_NAME`, else `WM_NAME`.
#[must_use]
pub fn title_of(w: &RawWindow) -> String {
    w.net_wm_name
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .or(w.wm_name.as_deref())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The app's name from `WM_CLASS`: the class part ("Firefox"), or the
/// instance part when there is no class.
#[must_use]
pub fn app_name_of(wm_class: Option<&[u8]>) -> String {
    let Some(raw) = wm_class else { return String::new() };
    let mut parts = raw.split(|b| *b == 0).filter(|p| !p.is_empty());
    let instance = parts.next();
    let class = parts.next();
    class
        .or(instance)
        .map(|p| String::from_utf8_lossy(p).trim().to_string())
        .unwrap_or_default()
}

/// The window's outer frame: the client area grown by the frame extents the
/// window manager drew around it. Saturates rather than wrapping.
#[must_use]
pub fn outer_frame(client: NativeFrame, extents: Option<[u32; 4]>) -> NativeFrame {
    let [left, right, top, bottom] = extents.unwrap_or([0; 4]);
    let left_i = i32::try_from(left).unwrap_or(i32::MAX);
    let top_i = i32::try_from(top).unwrap_or(i32::MAX);
    NativeFrame {
        x: client.x.saturating_sub(left_i),
        y: client.y.saturating_sub(top_i),
        width: client.width.saturating_add(left).saturating_add(right),
        height: client.height.saturating_add(top).saturating_add(bottom),
    }
}

/// The windows the overlay may offer, FRONT FIRST, from
/// `_NET_CLIENT_LIST_STACKING` (which EWMH orders bottom to top).
///
/// Out: minimised (hidden) windows, desktop furniture, windows on another
/// workspace, and untitled windows. Hippius's own windows and slivers are
/// dropped later by `targets::is_pickable`, the same rule as every platform.
#[must_use]
pub fn windows_front_first(stacking_bottom_to_top: Vec<RawWindow>, current_desktop: Option<u32>) -> Vec<ListedWindow> {
    stacking_bottom_to_top
        .into_iter()
        .rev()
        .filter(|w| !w.hidden && w.window_type == WindowType::Normal)
        .filter(|w| match (w.desktop, current_desktop) {
            (Some(d), Some(current)) => d == current || d == ALL_DESKTOPS,
            _ => true,
        })
        .filter_map(|w| {
            let title = title_of(&w);
            if title.is_empty() {
                return None;
            }
            Some(ListedWindow {
                id: w.id,
                pid: w.pid,
                app_name: app_name_of(w.wm_class.as_deref()),
                title,
                frame: outer_frame(w.client, w.frame_extents),
            })
        })
        .collect()
}

/// A Latin-1 `WM_NAME` as text.
#[must_use]
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

// ── Pixels ──────────────────────────────────────────────────────────────────

/// The part of the root `frame` covers, clipped to the root: what a window
/// shot reads. `None` when nothing of it is on screen.
#[must_use]
pub fn clip_to_root(frame: NativeFrame, root_width: u32, root_height: u32) -> Option<PixelRect> {
    let left = i64::from(frame.x).max(0);
    let top = i64::from(frame.y).max(0);
    let right = (i64::from(frame.x) + i64::from(frame.width)).min(i64::from(root_width));
    let bottom = (i64::from(frame.y) + i64::from(frame.height)).min(i64::from(root_height));
    if right <= left || bottom <= top {
        return None;
    }
    Some(PixelRect {
        x: u32::try_from(left).ok()?,
        y: u32::try_from(top).ok()?,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

/// How a `ZPixmap` `GetImage` reply lays out its pixels: from the screen's
/// pixmap format for the root's depth and the root visual's colour masks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelLayout {
    pub bits_per_pixel: u8,
    /// Each row is padded to a multiple of this many bits.
    pub scanline_pad: u8,
    /// The server's image byte order is most significant byte first.
    pub msb_first: bool,
    pub red_mask: u32,
    pub green_mask: u32,
    pub blue_mask: u32,
}

/// The bytes one row takes, padding included.
#[must_use]
pub fn row_stride(width: u32, layout: &PixelLayout) -> Option<usize> {
    let bits = u64::from(width) * u64::from(layout.bits_per_pixel);
    let pad = u64::from(layout.scanline_pad.max(8));
    let padded = bits.div_ceil(pad) * pad;
    usize::try_from(padded / 8).ok()
}

/// A `ZPixmap` image as opaque RGBA. Handles 32, 24 and 16 bits per pixel
/// in either byte order with any channel masks (BGRX on almost every
/// desktop, RGB565 on old setups). `None` for a layout it cannot read or
/// data shorter than the size says.
#[must_use]
pub fn zpixmap_to_rgba(data: &[u8], width: u32, height: u32, layout: &PixelLayout) -> Option<image::RgbaImage> {
    let bytes_per_pixel = match layout.bits_per_pixel {
        32 => 4,
        24 => 3,
        16 => 2,
        _ => return None,
    };
    let stride = row_stride(width, layout)?;
    let needed = stride.checked_mul(usize::try_from(height).ok()?)?;
    if data.len() < needed || width == 0 || height == 0 {
        return None;
    }
    let channels = [layout.red_mask, layout.green_mask, layout.blue_mask].map(Channel::from_mask);
    let mut out = image::RgbaImage::new(width, height);
    for (y, row) in data.chunks_exact(stride).take(usize::try_from(height).ok()?).enumerate() {
        for (x, px) in row.chunks_exact(bytes_per_pixel).take(usize::try_from(width).ok()?).enumerate() {
            let value = px.iter().enumerate().fold(0u32, |acc, (i, &b)| {
                let shift = if layout.msb_first { (bytes_per_pixel - 1 - i) * 8 } else { i * 8 };
                acc | (u32::from(b) << shift)
            });
            let [r, g, b] = channels.map(|c| c.read(value));
            // Both indices come from enumerating within width and height.
            #[allow(clippy::cast_possible_truncation)]
            out.put_pixel(x as u32, y as u32, image::Rgba([r, g, b, 255]));
        }
    }
    Some(out)
}

/// One colour channel of a visual: where it sits and how wide it is.
#[derive(Debug, Clone, Copy)]
struct Channel {
    shift: u32,
    bits: u32,
}

impl Channel {
    fn from_mask(mask: u32) -> Self {
        if mask == 0 {
            return Self { shift: 0, bits: 0 };
        }
        let shift = mask.trailing_zeros();
        Self {
            shift,
            bits: (mask >> shift).trailing_ones(),
        }
    }

    /// The channel scaled to 8 bits (5 or 6 bit channels spread to 0..=255).
    fn read(self, value: u32) -> u8 {
        if self.bits == 0 {
            return 0;
        }
        let max = (1u32 << self.bits.min(31)) - 1;
        let v = (value >> self.shift) & max;
        // v <= max, so the result is at most 255.
        #[allow(clippy::cast_possible_truncation)]
        let byte = ((v * 255 + max / 2) / max) as u8;
        byte
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(atom: u32, name: &str, primary: bool, x: i16, y: i16, w: u16, h: u16) -> RawMonitor {
        RawMonitor {
            name_atom: atom,
            name: name.into(),
            primary,
            x,
            y,
            width: w,
            height: h,
        }
    }

    /// Two monitors side by side, the right one primary, at the screen's
    /// one scale: physical pixels in, the overlay's CSS size out.
    #[test]
    fn randr_monitors_become_displays_at_the_screens_one_scale() {
        let d = displays_from(
            &[
                monitor(300, "eDP-1", false, 0, 0, 3840, 2160),
                monitor(301, "HDMI-1", true, 3840, 0, 1920, 1080),
            ],
            5760,
            2160,
            2.0,
        );
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].id, d[0].x, d[0].width, d[0].is_primary), (300, 0, 3840, false));
        assert_eq!((d[1].id, d[1].x, d[1].is_primary), (301, 3840, true));
        // X11 has one scale: the 1080p monitor beside the 4K panel is ALSO at
        // 200 %, which is what the webview draws it at. (`targets` divides
        // physical pixels by it on Linux; that maths is pinned there.)
        assert!(d.iter().all(|d| (d.scale_factor - 2.0).abs() < f64::EPSILON));
    }

    #[test]
    fn no_randr_monitor_means_the_whole_root_is_one_display() {
        let d = displays_from(&[], 1280, 800, 1.0);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].id, d[0].width, d[0].height, d[0].is_primary), (WHOLE_SCREEN_ID, 1280, 800, true));
        assert!(displays_from(&[], 0, 0, 1.0).is_empty());
    }

    #[test]
    fn with_no_primary_the_first_monitor_is_primary_and_empty_ones_are_dropped() {
        let d = displays_from(
            &[monitor(5, "DP-1", false, 0, 0, 0, 1080), monitor(6, "DP-2", false, 0, 0, 1920, 1080)],
            1920,
            1080,
            1.0,
        );
        assert_eq!(d.len(), 1);
        assert!(d[0].is_primary);
        assert_eq!(d[0].id, 6);
    }

    #[test]
    fn the_screen_scale_follows_gdk() {
        assert!((screen_scale(Some("2"), Some(1)) - 2.0).abs() < f64::EPSILON, "GDK_SCALE wins");
        assert!((screen_scale(None, Some(2)) - 2.0).abs() < f64::EPSILON);
        assert!(
            (screen_scale(Some(" "), Some(3)) - 3.0).abs() < f64::EPSILON,
            "an empty GDK_SCALE is ignored"
        );
        assert!(
            (screen_scale(Some("1.5"), None) - 1.0).abs() < f64::EPSILON,
            "GDK 3 takes whole numbers only"
        );
        assert!((screen_scale(Some("0"), Some(0)) - 1.0).abs() < f64::EPSILON);
        assert!((screen_scale(None, None) - 1.0).abs() < f64::EPSILON);
    }

    /// An XSETTINGS blob in `order` holding a string, a colour and the
    /// window scale, in that order.
    fn xsettings_blob(big_endian: bool, scale: i32) -> Vec<u8> {
        let u16b = |v: u16| {
            if big_endian {
                v.to_be_bytes().to_vec()
            } else {
                v.to_le_bytes().to_vec()
            }
        };
        let u32b = |v: u32| {
            if big_endian {
                v.to_be_bytes().to_vec()
            } else {
                v.to_le_bytes().to_vec()
            }
        };
        let mut out = vec![u8::from(big_endian), 0, 0, 0];
        out.extend(u32b(7));
        out.extend(u32b(3));
        let name = |out: &mut Vec<u8>, kind: u8, n: &str| {
            out.push(kind);
            out.push(0);
            out.extend(u16b(u16::try_from(n.len()).unwrap()));
            out.extend(n.as_bytes());
            out.extend(std::iter::repeat_n(0, pad4(n.len())));
            out.extend(u32b(0));
        };
        name(&mut out, 1, "Net/ThemeName");
        out.extend(u32b(5));
        out.extend(b"Yaru\0");
        out.extend(std::iter::repeat_n(0, pad4(5)));
        name(&mut out, 2, "Net/Colour");
        out.extend([0u8; 8]);
        name(&mut out, 0, "Gdk/WindowScalingFactor");
        out.extend(u32b(u32::from_ne_bytes(scale.to_ne_bytes())));
        out
    }

    #[test]
    fn the_window_scale_is_read_from_xsettings_in_either_byte_order() {
        assert_eq!(xsettings_int(&xsettings_blob(false, 2), "Gdk/WindowScalingFactor"), Some(2));
        assert_eq!(xsettings_int(&xsettings_blob(true, 2), "Gdk/WindowScalingFactor"), Some(2));
        assert_eq!(xsettings_int(&xsettings_blob(false, 1), "Gdk/UnscaledDPI"), None);
        let blob = xsettings_blob(false, 2);
        assert_eq!(xsettings_int(&blob[..blob.len() - 2], "Gdk/WindowScalingFactor"), None, "cut short");
        assert_eq!(xsettings_int(&[], "Gdk/WindowScalingFactor"), None);
    }

    fn raw(id: u32, title: &str, client: (i32, i32, u32, u32)) -> RawWindow {
        RawWindow {
            id,
            net_wm_name: Some(title.into()),
            wm_name: None,
            wm_class: Some(b"navigator\0Firefox\0".to_vec()),
            pid: Some(4242),
            client: NativeFrame {
                x: client.0,
                y: client.1,
                width: client.2,
                height: client.3,
            },
            frame_extents: None,
            hidden: false,
            window_type: WindowType::Normal,
            desktop: Some(0),
        }
    }

    /// EWMH stacks bottom to top; the overlay wants the topmost first, so
    /// hovering a window over another highlights the one in front.
    #[test]
    fn the_stacking_list_comes_out_front_first() {
        let listed = windows_front_first(vec![raw(1, "Bottom", (0, 0, 800, 600)), raw(2, "Top", (0, 0, 800, 600))], Some(0));
        assert_eq!(listed.iter().map(|w| w.id).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(listed[0].app_name, "Firefox");
    }

    #[test]
    fn minimised_furniture_other_workspace_and_untitled_windows_are_left_out() {
        let mut hidden = raw(1, "Minimised", (0, 0, 800, 600));
        hidden.hidden = true;
        let mut dock = raw(2, "Top Bar", (0, 0, 1920, 32));
        dock.window_type = WindowType::Furniture;
        let mut elsewhere = raw(3, "Other workspace", (0, 0, 800, 600));
        elsewhere.desktop = Some(1);
        let mut sticky = raw(4, "On every workspace", (0, 0, 800, 600));
        sticky.desktop = Some(ALL_DESKTOPS);
        let untitled = raw(5, "  ", (0, 0, 800, 600));
        let mut legacy = raw(6, "", (0, 0, 800, 600));
        legacy.net_wm_name = None;
        legacy.wm_name = Some(latin1(b"xterm \xe9"));
        let listed = windows_front_first(vec![hidden, dock, elsewhere, sticky, untitled, legacy], Some(0));
        assert_eq!(listed.iter().map(|w| w.id).collect::<Vec<_>>(), [6, 4]);
        assert_eq!(listed[0].title, "xterm \u{e9}", "WM_NAME is Latin-1");
    }

    #[test]
    fn without_workspace_information_every_window_counts() {
        let mut w = raw(1, "A", (0, 0, 800, 600));
        w.desktop = None;
        assert_eq!(windows_front_first(vec![w.clone()], Some(0)).len(), 1);
        w.desktop = Some(3);
        assert_eq!(windows_front_first(vec![w], None).len(), 1);
    }

    #[test]
    fn the_window_type_is_decided_by_the_first_known_type() {
        let t = |names: &[&str]| window_type(&names.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert_eq!(t(&[]), WindowType::Normal);
        assert_eq!(t(&["_NET_WM_WINDOW_TYPE_DOCK"]), WindowType::Furniture);
        assert_eq!(t(&["_NET_WM_WINDOW_TYPE_DESKTOP"]), WindowType::Furniture);
        assert_eq!(t(&["_KDE_NET_WM_WINDOW_TYPE_OVERRIDE", "_NET_WM_WINDOW_TYPE_NORMAL"]), WindowType::Normal);
        assert_eq!(t(&["_NET_WM_WINDOW_TYPE_DIALOG", "_NET_WM_WINDOW_TYPE_NORMAL"]), WindowType::Normal);
        assert_eq!(t(&["_NET_WM_WINDOW_TYPE_NOTIFICATION"]), WindowType::Furniture);
    }

    #[test]
    fn app_names_come_from_the_class_part_of_wm_class() {
        assert_eq!(app_name_of(Some(b"gnome-terminal-server\0Gnome-terminal\0")), "Gnome-terminal");
        assert_eq!(app_name_of(Some(b"only-instance\0")), "only-instance");
        assert_eq!(app_name_of(Some(b"")), "");
        assert_eq!(app_name_of(None), "");
    }

    /// A window shot includes the title bar the window manager drew, like
    /// a window shot on macOS and Windows.
    #[test]
    fn the_frame_is_the_client_area_plus_the_decorations() {
        let client = NativeFrame {
            x: 100,
            y: 137,
            width: 800,
            height: 600,
        };
        assert_eq!(
            outer_frame(client, Some([1, 1, 37, 1])),
            NativeFrame {
                x: 99,
                y: 100,
                width: 802,
                height: 638
            }
        );
        assert_eq!(outer_frame(client, None), client);
        // A frame reaching off the left edge keeps its negative origin; the
        // grab clips it.
        let edge = outer_frame(NativeFrame { x: 0, ..client }, Some([4, 4, 4, 4]));
        assert_eq!(edge.x, -4);
    }

    #[test]
    fn a_window_shot_is_clipped_to_the_screen() {
        let r = clip_to_root(
            NativeFrame {
                x: -10,
                y: 1000,
                width: 300,
                height: 200,
            },
            1920,
            1080,
        )
        .unwrap();
        assert_eq!((r.x, r.y, r.width, r.height), (0, 1000, 290, 80));
        assert_eq!(
            clip_to_root(
                NativeFrame {
                    x: 2000,
                    y: 0,
                    width: 10,
                    height: 10
                },
                1920,
                1080
            ),
            None
        );
    }

    const BGRX: PixelLayout = PixelLayout {
        bits_per_pixel: 32,
        scanline_pad: 32,
        msb_first: false,
        red_mask: 0x00ff_0000,
        green_mask: 0x0000_ff00,
        blue_mask: 0x0000_00ff,
    };

    /// Almost every X server today: 24-bit depth in 32-bit pixels, BGRX in
    /// memory (little-endian 0x00RRGGBB).
    #[test]
    fn a_bgrx_image_reads_back_as_opaque_rgba() {
        // Two pixels: pure red, then (10, 20, 30); the pad byte is junk.
        let data = [0, 0, 255, 0x7f, 30, 20, 10, 0x55];
        let img = zpixmap_to_rgba(&data, 2, 1, &BGRX).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(1, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn a_big_endian_server_is_read_in_its_own_order() {
        let layout = PixelLayout { msb_first: true, ..BGRX };
        let data = [0, 10, 20, 30];
        assert_eq!(zpixmap_to_rgba(&data, 1, 1, &layout).unwrap().get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    /// Rows are padded to the scanline pad: a 3-pixel 24-bit row is 9 bytes
    /// of pixels and 3 of padding at a 32-bit pad.
    #[test]
    fn padded_24_bit_rows_are_walked_by_their_stride() {
        let layout = PixelLayout { bits_per_pixel: 24, ..BGRX };
        assert_eq!(row_stride(3, &layout), Some(12));
        let mut data = Vec::new();
        for row in 0..2u8 {
            for col in 0..3u8 {
                data.extend([col, row, 200]);
            }
            data.extend([9, 9, 9]);
        }
        let img = zpixmap_to_rgba(&data, 3, 2, &layout).unwrap();
        assert_eq!(img.get_pixel(2, 1).0, [200, 1, 2, 255]);
    }

    /// 16-bit RGB565: 5 and 6 bit channels are spread to the full 8 bits.
    #[test]
    fn rgb565_is_spread_to_eight_bits() {
        let layout = PixelLayout {
            bits_per_pixel: 16,
            scanline_pad: 32,
            msb_first: false,
            red_mask: 0xf800,
            green_mask: 0x07e0,
            blue_mask: 0x001f,
        };
        // White, then pure green, then padding to 32 bits.
        let data = [0xff, 0xff, 0xe0, 0x07];
        let img = zpixmap_to_rgba(&data, 2, 1, &layout).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(img.get_pixel(1, 0).0, [0, 255, 0, 255]);
    }

    #[test]
    fn short_or_unreadable_images_are_refused() {
        assert!(zpixmap_to_rgba(&[0; 7], 2, 1, &BGRX).is_none());
        assert!(zpixmap_to_rgba(&[0; 8], 2, 1, &PixelLayout { bits_per_pixel: 8, ..BGRX }).is_none());
        assert!(zpixmap_to_rgba(&[], 0, 0, &BGRX).is_none());
    }
}
