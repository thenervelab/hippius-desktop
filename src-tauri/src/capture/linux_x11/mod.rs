//! Screen capture on an X11 session: the displays (RandR), the windows
//! (EWMH), the pointer, and the pixels (`GetImage` on the root window).
//!
//! x11rb, not xcap: on Linux xcap links PipeWire, libgbm, libEGL and xcb and
//! needs clang for bindgen in every build, and its Wayland path is the
//! non-interactive portal, which is the wrong experience there. x11rb is pure
//! Rust and already in the dependency graph.
//!
//! [`model`] is the pure half (EWMH and XSETTINGS parsing, window filtering,
//! pixel conversion), tested on every OS. `os` talks to the server and is
//! built on Linux only. Wayland never comes here: it captures through the
//! desktop portal (`capture::linux_portal`), since an X11 client there sees
//! only XWayland windows.

pub mod model;

#[cfg(target_os = "linux")]
mod os;

#[cfg(target_os = "linux")]
pub use os::{WindowReader, capture_image, cursor_point, grab_root, list_displays, list_windows, window_frame, windows_on_display};

/// How long to wait after the overlays close before reading the screen on
/// X11. There is no content protection there, so the overlays, the bar and
/// the card must be gone from the screen first, and a compositing window
/// manager draws that a frame or two later (no portable "has repainted"
/// signal). Spike L1 in the plan measures it on GNOME Xorg, KDE X11 and XFCE;
/// until then this covers two frames at 30 Hz with room to spare.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const COMPOSITOR_SETTLE: std::time::Duration = std::time::Duration::from_millis(120);
