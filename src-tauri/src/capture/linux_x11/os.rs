//! The X11 connection half of [`super`]: asks the server, hands the answers
//! to [`super::model`]. Every function opens its own short-lived connection:
//! they run on blocking threads, rarely, and a connection kept across a
//! capture would outlive a display server restart.

use std::collections::HashMap;

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, ImageFormat, ImageOrder, Screen, Window};
use x11rb::rust_connection::RustConnection;

use super::model::{self, ListedWindow, PixelLayout, RawMonitor, RawWindow};
use crate::capture::geometry::{PixelRect, crop_rect};
use crate::capture::rollout::{Platform, current_platform};
use crate::capture::screenshot::{Selection, area_scale};
use crate::capture::targets::{DisplayTarget, NativeFrame, WindowTarget, is_pickable, window_rect_on_display};
use crate::error::{AppError, Result};

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        UTF8_STRING,
        _NET_CLIENT_LIST_STACKING,
        _NET_CURRENT_DESKTOP,
        _NET_WM_NAME,
        _NET_WM_PID,
        _NET_FRAME_EXTENTS,
        _NET_WM_STATE,
        _NET_WM_STATE_HIDDEN,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_DESKTOP,
        _XSETTINGS_SETTINGS,
    }
}

/// Longest property read, in 32-bit units (a window title or a client list).
const PROPERTY_LONGS: u32 = 1 << 16;

struct X {
    conn: RustConnection,
    screen: usize,
    atoms: Atoms,
}

impl X {
    fn screen(&self) -> &Screen {
        &self.conn.setup().roots[self.screen]
    }

    fn root(&self) -> Window {
        self.screen().root
    }
}

fn x_err(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("{context}: {e}"))
}

/// A connection to the X server of this session. Refused on Wayland, where
/// `DISPLAY` reaches XWayland and would see only XWayland windows.
fn connect() -> Result<X> {
    if current_platform() == Platform::LinuxWayland {
        return Err(AppError::Validation(
            "This desktop uses Wayland; Hippius captures through your desktop's screenshot tool there.".into(),
        ));
    }
    let (conn, screen) = x11rb::connect(None).map_err(|e| x_err("Could not reach the X server", e))?;
    let atoms = Atoms::new(&conn)
        .map_err(|e| x_err("X server", e))?
        .reply()
        .map_err(|e| x_err("X server", e))?;
    Ok(X { conn, screen, atoms })
}

/// A property's reply, or `None` when it is missing or the window is gone.
fn property(x: &X, window: Window, prop: u32, kind: impl Into<u32>) -> Option<x11rb::protocol::xproto::GetPropertyReply> {
    let reply = x
        .conn
        .get_property(false, window, prop, kind.into(), 0, PROPERTY_LONGS)
        .ok()?
        .reply()
        .ok()?;
    (reply.type_ != u32::from(AtomEnum::NONE)).then_some(reply)
}

fn u32s(x: &X, window: Window, prop: u32, kind: impl Into<u32>) -> Vec<u32> {
    property(x, window, prop, kind)
        .and_then(|r| r.value32().map(Iterator::collect))
        .unwrap_or_default()
}

/// The screen's scale as GDK has it: `GDK_SCALE`, else the desktop's
/// `Gdk/WindowScalingFactor` from the XSETTINGS manager of this screen.
fn screen_scale(x: &X) -> f64 {
    let env = std::env::var("GDK_SCALE").ok();
    let xsettings = (|| {
        let selection = x
            .conn
            .intern_atom(true, format!("_XSETTINGS_S{}", x.screen).as_bytes())
            .ok()?
            .reply()
            .ok()?
            .atom;
        if selection == 0 {
            return None;
        }
        let owner = x.conn.get_selection_owner(selection).ok()?.reply().ok()?.owner;
        if owner == 0 {
            return None;
        }
        let reply = property(x, owner, x.atoms._XSETTINGS_SETTINGS, x.atoms._XSETTINGS_SETTINGS)?;
        model::xsettings_int(&reply.value, "Gdk/WindowScalingFactor")
    })();
    model::screen_scale(env.as_deref(), xsettings)
}

fn displays(x: &X) -> Vec<DisplayTarget> {
    let screen = x.screen();
    let monitors: Vec<RawMonitor> = x
        .conn
        .randr_get_monitors(screen.root, true)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|reply| {
            reply
                .monitors
                .iter()
                .map(|m| RawMonitor {
                    name_atom: m.name,
                    name: x
                        .conn
                        .get_atom_name(m.name)
                        .ok()
                        .and_then(|c| c.reply().ok())
                        .map(|r| String::from_utf8_lossy(&r.name).into_owned())
                        .unwrap_or_default(),
                    primary: m.primary,
                    x: m.x,
                    y: m.y,
                    width: m.width,
                    height: m.height,
                })
                .collect()
        })
        .unwrap_or_default();
    model::displays_from(&monitors, screen.width_in_pixels, screen.height_in_pixels, screen_scale(x))
}

/// Every monitor of this screen, in physical root pixels.
pub fn list_displays() -> Result<Vec<DisplayTarget>> {
    let x = connect()?;
    Ok(displays(&x))
}

/// The names of `atoms`, looked up once per listing.
fn atom_names(x: &X, atoms: &[u32], cache: &mut HashMap<u32, String>) -> Vec<String> {
    atoms
        .iter()
        .map(|&a| {
            cache
                .entry(a)
                .or_insert_with(|| {
                    x.conn
                        .get_atom_name(a)
                        .ok()
                        .and_then(|c| c.reply().ok())
                        .map(|r| String::from_utf8_lossy(&r.name).into_owned())
                        .unwrap_or_default()
                })
                .clone()
        })
        .collect()
}

fn raw_window(x: &X, id: Window, root: Window, names: &mut HashMap<u32, String>) -> Option<RawWindow> {
    let geometry = x.conn.get_geometry(id).ok()?.reply().ok()?;
    let at = x.conn.translate_coordinates(id, root, 0, 0).ok()?.reply().ok()?;
    let a = &x.atoms;
    let state = u32s(x, id, a._NET_WM_STATE, AtomEnum::ATOM);
    let types = u32s(x, id, a._NET_WM_WINDOW_TYPE, AtomEnum::ATOM);
    let extents = u32s(x, id, a._NET_FRAME_EXTENTS, AtomEnum::CARDINAL);
    Some(RawWindow {
        id,
        net_wm_name: property(x, id, a._NET_WM_NAME, a.UTF8_STRING).map(|r| String::from_utf8_lossy(&r.value).into_owned()),
        wm_name: property(x, id, AtomEnum::WM_NAME.into(), AtomEnum::ANY).map(|r| model::latin1(&r.value)),
        wm_class: property(x, id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING).map(|r| r.value),
        pid: u32s(x, id, a._NET_WM_PID, AtomEnum::CARDINAL).first().copied(),
        client: NativeFrame {
            x: i32::from(at.dst_x),
            y: i32::from(at.dst_y),
            width: u32::from(geometry.width),
            height: u32::from(geometry.height),
        },
        frame_extents: <[u32; 4]>::try_from(extents.as_slice()).ok(),
        hidden: state.contains(&a._NET_WM_STATE_HIDDEN),
        window_type: model::window_type(&atom_names(x, &types, names)),
        desktop: u32s(x, id, a._NET_WM_DESKTOP, AtomEnum::CARDINAL).first().copied(),
    })
}

fn windows(x: &X) -> Vec<ListedWindow> {
    let root = x.root();
    let stacking = u32s(x, root, x.atoms._NET_CLIENT_LIST_STACKING, AtomEnum::WINDOW);
    let current = u32s(x, root, x.atoms._NET_CURRENT_DESKTOP, AtomEnum::CARDINAL).first().copied();
    let mut names = HashMap::new();
    let raw = stacking.into_iter().filter_map(|id| raw_window(x, id, root, &mut names)).collect();
    model::windows_front_first(raw, current)
}

/// Every window the window manager manages that a person could pick, front
/// first, with its outer frame in root pixels.
pub fn list_windows() -> Result<Vec<ListedWindow>> {
    let x = connect()?;
    Ok(windows(&x))
}

/// The pickable windows on `display`, front first, in its logical points.
pub fn windows_on_display(display: &DisplayTarget) -> Result<Vec<WindowTarget>> {
    let own = std::process::id();
    Ok(list_windows()?
        .into_iter()
        .filter_map(|w| {
            let rect = window_rect_on_display(w.frame, display)?;
            is_pickable(&w.app_name, &w.title, w.pid == Some(own), false, &rect).then_some(WindowTarget {
                id: w.id,
                app_name: w.app_name,
                title: w.title,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            })
        })
        .collect())
}

/// Window `id`'s outer frame in root pixels, or `None` once it has closed.
pub fn window_frame(id: u32) -> Option<NativeFrame> {
    list_windows().ok()?.into_iter().find(|w| w.id == id).map(|w| w.frame)
}

/// The pointer, in root pixels (the displays' own space).
pub fn cursor_point() -> Option<(f64, f64)> {
    let x = connect().ok()?;
    let reply = x.conn.query_pointer(x.root()).ok()?.reply().ok()?;
    Some(model::pointer_point(reply.root_x, reply.root_y))
}

/// One X connection a recording keeps for the camera bubble it draws into
/// a window recording: where the two windows are, and the bubble's own
/// pixels. Opened once in the recorder child, read up to 30 times a second;
/// a connection per read would add a round trip and an atom lookup each.
pub struct WindowReader {
    x: X,
}

impl WindowReader {
    /// # Errors
    /// No X server (or a Wayland session).
    pub fn open() -> Result<Self> {
        Ok(Self { x: connect()? })
    }

    /// Window `id`'s own area (without the window manager's frame) on the
    /// root, in pixels; `None` when it is not on screen (unmapped, hidden
    /// from the pill) or gone.
    #[must_use]
    pub fn placement(&self, id: u32) -> Option<NativeFrame> {
        use x11rb::protocol::xproto::MapState;
        let attrs = self.x.conn.get_window_attributes(id).ok()?.reply().ok()?;
        if attrs.map_state != MapState::VIEWABLE {
            return None;
        }
        let geometry = self.x.conn.get_geometry(id).ok()?.reply().ok()?;
        let at = self.x.conn.translate_coordinates(id, self.x.root(), 0, 0).ok()?.reply().ok()?;
        Some(NativeFrame {
            x: i32::from(at.dst_x),
            y: i32::from(at.dst_y),
            width: u32::from(geometry.width),
            height: u32::from(geometry.height),
        })
    }

    /// Window `id`'s own pixels (what it draws, even where something covers
    /// it), `width` x `height` from its top-left, as opaque RGBA; `None`
    /// when it is not on screen.
    #[must_use]
    pub fn pixels(&self, id: u32, width: u32, height: u32) -> Option<image::RgbaImage> {
        grab_drawable(&self.x, id, PixelRect { x: 0, y: 0, width, height }).ok()
    }
}

/// The pixels of `rect` of the root window, as RGBA.
fn grab(x: &X, rect: PixelRect) -> Result<image::RgbaImage> {
    grab_drawable(x, x.root(), rect)
}

/// The pixels of `rect` of `drawable` (the root, or one window), as RGBA.
fn grab_drawable(x: &X, drawable: Window, rect: PixelRect) -> Result<image::RgbaImage> {
    let too_big = || AppError::Validation("That part of the screen is too large to capture.".into());
    let reply = x
        .conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            i16::try_from(rect.x).map_err(|_| too_big())?,
            i16::try_from(rect.y).map_err(|_| too_big())?,
            u16::try_from(rect.width).map_err(|_| too_big())?,
            u16::try_from(rect.height).map_err(|_| too_big())?,
            u32::MAX,
        )
        .map_err(|e| x_err("Could not capture the screen", e))?
        .reply()
        .map_err(|e| x_err("Could not capture the screen", e))?;
    let setup = x.conn.setup();
    let format = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == reply.depth)
        .ok_or_else(|| AppError::Other(format!("Could not capture the screen: no pixel format for depth {}", reply.depth)))?;
    let visual_id = if reply.visual == 0 { x.screen().root_visual } else { reply.visual };
    let visual = x
        .screen()
        .allowed_depths
        .iter()
        .flat_map(|d| d.visuals.iter())
        .find(|v| v.visual_id == visual_id)
        .ok_or_else(|| AppError::Other("Could not capture the screen: unknown visual".into()))?;
    let layout = PixelLayout {
        bits_per_pixel: format.bits_per_pixel,
        scanline_pad: format.scanline_pad,
        msb_first: setup.image_byte_order == ImageOrder::MSB_FIRST,
        red_mask: visual.red_mask,
        green_mask: visual.green_mask,
        blue_mask: visual.blue_mask,
    };
    model::zpixmap_to_rgba(&reply.data, rect.width, rect.height, &layout).ok_or_else(|| {
        AppError::Other(format!(
            "Could not capture the screen: {}-bit pixels are not supported",
            format.bits_per_pixel
        ))
    })
}

fn display_rect(d: &DisplayTarget) -> PixelRect {
    PixelRect {
        x: u32::try_from(d.x).unwrap_or(0),
        y: u32::try_from(d.y).unwrap_or(0),
        width: d.width,
        height: d.height,
    }
}

/// The whole root window at once, with the displays and windows it shows:
/// the share picker crops every picture from one grab instead of one
/// request per window.
pub fn grab_root() -> Result<(image::RgbaImage, Vec<DisplayTarget>, Vec<ListedWindow>)> {
    let x = connect()?;
    let screen = x.screen();
    let image = grab(
        &x,
        PixelRect {
            x: 0,
            y: 0,
            width: u32::from(screen.width_in_pixels),
            height: u32::from(screen.height_in_pixels),
        },
    )?;
    Ok((image, displays(&x), windows(&x)))
}

/// Take the screenshot `selection` describes. Blocking: call it from
/// `spawn_blocking`, after the overlays have gone (X11 cannot keep them out
/// of the picture).
///
/// A window shot reads the screen where the window is, so a window covered
/// by another comes out as what is on top, like an area. Reading a covered
/// window's own pixels needs XComposite, a later nicety.
pub fn capture_image(selection: Selection) -> Result<image::RgbaImage> {
    let x = connect()?;
    let gone = || AppError::Validation("That display is no longer connected.".into());
    match selection {
        Selection::Screen { display_id } => {
            let d = displays(&x).into_iter().find(|d| d.id == display_id).ok_or_else(gone)?;
            grab(&x, display_rect(&d))
        }
        Selection::Area { display_id, rect } => {
            let d = displays(&x).into_iter().find(|d| d.id == display_id).ok_or_else(gone)?;
            let full = grab(&x, display_rect(&d))?;
            let scale = area_scale(full.width(), d.logical_width());
            let crop = crop_rect(rect, scale, full.width(), full.height())
                .ok_or_else(|| AppError::Validation("Drag to select an area to capture.".into()))?;
            Ok(image::imageops::crop_imm(&full, crop.x, crop.y, crop.width, crop.height).to_image())
        }
        Selection::Window { window_id } => {
            let frame = windows(&x)
                .into_iter()
                .find(|w| w.id == window_id)
                .map(|w| w.frame)
                .ok_or_else(|| AppError::Validation("That window has closed.".into()))?;
            let screen = x.screen();
            let rect = model::clip_to_root(frame, u32::from(screen.width_in_pixels), u32::from(screen.height_in_pixels))
                .ok_or_else(|| AppError::Validation("That window is not on screen.".into()))?;
            grab(&x, rect)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against a real X server (CI runs it under `xvfb-run`; skipped where
    /// there is none): the screen lists at least one display, and a screen
    /// grab is that display's size in pixels.
    #[test]
    #[ignore = "needs an X server: xvfb-run cargo test --lib capture::linux_x11 -- --ignored"]
    fn an_x_server_lists_a_display_and_grabs_it_at_full_size() {
        if std::env::var_os("DISPLAY").is_none() {
            return;
        }
        let displays = list_displays().expect("displays");
        assert!(!displays.is_empty());
        let d = &displays[0];
        let image = capture_image(Selection::Screen { display_id: d.id }).expect("grab");
        assert_eq!((image.width(), image.height()), (d.width, d.height));
        let (root, _, _) = grab_root().expect("root");
        assert!(root.width() >= d.width && root.height() >= d.height);
        assert!(cursor_point().is_some());
    }
}
