//! The borderless tray-panel popover window.
//!
//! A single reusable webview window (label [`PANEL_LABEL`]) that opens anchored
//! to the system-tray icon and closes when it loses focus. It replaces the old
//! native tray menu. Window placement is delegated to the pure
//! [`super::geometry`] math; this module owns only the window lifecycle and the
//! two IPC commands the frontend drives it with.
//!
//! ## Why a window instead of a menu
//! The redesigned tray UI (search, rich upload rows, credits, account footer)
//! cannot be expressed with native `Menu`/`MenuItem`s, so the tray icon's click
//! now toggles this window rather than popping a menu.

use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tracing::warn;

use crate::app_state::AppState;
use crate::error::{AppError, Result};

use super::geometry::{self, Rect};

/// Window label of the tray panel. The popover is a single reused window,
/// looked up by this label rather than tracked in a module `static`.
pub const PANEL_LABEL: &str = "tray-panel";

/// Logical (DPI-independent) panel dimensions, converted to physical pixels
/// against the target monitor's scale factor before positioning.
const PANEL_WIDTH: f64 = 460.0;
const PANEL_HEIGHT: f64 = 672.0;
/// Corner radius of the panel card, matched by the native vibrancy material's
/// `radius` and the card's CSS `rounded-[16px]` so the frosted material and the
/// card edge line up exactly.
const PANEL_RADIUS: f64 = 16.0;
/// Logical breathing room between the tray icon and the panel's near edge.
const GAP: f64 = 8.0;
/// Logical inset kept between the panel and the work-area edges.
const MARGIN: f64 = 8.0;

/// Window within which a tray click following a blur-hide is treated as a
/// dismiss rather than a re-open. Sized to cover the OS delivering the blur
/// and the tray click as a single user gesture. See [`toggle_tray_panel`].
const REOPEN_COOLDOWN_MS: u64 = 350;

/// Tray-icon bounding rectangle forwarded from the frontend tray click.
///
/// JavaScript numbers are `f64`; the tray event reports physical pixels. The
/// values are rounded to integers for the geometry math.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct TrayIconRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Largest absolute physical-pixel coordinate accepted from a tray rect. Real
/// monitors are orders of magnitude smaller; clamping to this bound keeps the
/// downstream `i32` geometry arithmetic (`x + width`, `x + width / 2`) well
/// clear of overflow even on garbage/adversarial input.
const MAX_COORD: f64 = 1_000_000.0;

impl TrayIconRect {
    /// Round + sanitize the floating-point screen rect into the integer [`Rect`]
    /// the geometry math operates on.
    ///
    /// JS `f64` values reach here unvalidated, so a malformed tray event could
    /// carry `NaN`/`±Inf` or an absurd magnitude. A non-finite value maps to `0`
    /// and every component is clamped to [`MAX_COORD`] so `tray::geometry`'s
    /// unchecked `i32` arithmetic cannot overflow (which would debug-panic).
    fn to_rect(self) -> Rect {
        let coord = |v: f64| -> i32 {
            if v.is_finite() {
                v.round().clamp(-MAX_COORD, MAX_COORD) as i32
            } else {
                0
            }
        };
        let dim = |v: f64| -> i32 {
            if v.is_finite() {
                v.round().clamp(0.0, MAX_COORD) as i32
            } else {
                0
            }
        };
        Rect {
            x: coord(self.x),
            y: coord(self.y),
            width: dim(self.width),
            height: dim(self.height),
        }
    }
}

/// Current Unix time in milliseconds, or `0` if the clock is before the epoch
/// (which cannot happen in practice but must not panic).
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Toggle the tray panel: show it anchored to the tray icon, or hide it if it
/// is already visible.
///
/// `rect` is the tray icon's screen rectangle on macOS/Windows, where the
/// left-click `action` event carries it. On **Linux** the `tray-icon` crate
/// fires no left-click event, so the popover is opened from the native menu's
/// "Open Hippius" item instead, which has no icon bounds to forward — there
/// `rect` is `None` and the panel uses a deterministic top-right anchor (see
/// [`fallback_anchor`]).
///
/// Runs as a **synchronous** command so the window operations execute on the
/// main thread, which macOS requires for `show`/`set_position`/`set_focus`.
///
/// # Errors
/// Returns [`AppError::Other`] if the window cannot be built, no monitor can be
/// resolved, or a window operation (position/show/focus/hide)
/// fails.
#[tauri::command]
pub fn toggle_tray_panel(app: AppHandle, state: tauri::State<'_, AppState>, rect: Option<TrayIconRect>) -> Result<()> {
    // NOTE: the signed-in/out decision is made by the frontend before calling
    // this command (it gates on the auth context's `isAuthenticated`, the same
    // value that decides whether the app shows its login screen). Rust's
    // `AuthInfo.substrate_address` is NOT used here because it stays populated
    // for a session restored from disk even while the UI is on the login
    // screen — gating on it would wrongly open the popover for a logged-out UI.
    let win = match app.get_webview_window(PANEL_LABEL) {
        Some(w) => w,
        None => build_panel(&app)?,
    };

    if win.is_visible().unwrap_or(false) {
        hide_window(&win)?;
        return Ok(());
    }

    // Clicking the icon of an open panel first blurs+hides it (recording the
    // timestamp in `on_panel_blur`) and then fires this toggle. Within the
    // cooldown, treat that click as the dismiss and stay hidden rather than
    // immediately re-opening.
    let hidden_at = state.tray_panel_hidden_at.load(Ordering::Relaxed);
    if hidden_at != 0 && now_ms().saturating_sub(hidden_at) < REOPEN_COOLDOWN_MS {
        return Ok(());
    }

    // macOS/Windows forward the tray icon's screen rect; Linux forwards `None`
    // (no left-click tray event there) and we fall back to a deterministic
    // top-right anchor. Either way the result is a physical-pixel rect fed to
    // the same geometry.
    let icon = match rect {
        Some(r) => r.to_rect(),
        None => fallback_anchor(&app)?,
    };
    let (work_area, scale) = target_work_area(&app, icon)?;

    // Convert the logical panel/gap/margin to physical pixels for the target
    // monitor so the placement matches `work_area`, which is physical.
    let panel_w = (PANEL_WIDTH * scale).round() as i32;
    let panel_h = (PANEL_HEIGHT * scale).round() as i32;
    let gap = (GAP * scale).round() as i32;
    let margin = (MARGIN * scale).round() as i32;

    let (x, y) = geometry::compute_panel_position(icon, panel_w, panel_h, work_area, gap, margin);

    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| AppError::Other(format!("failed to position tray panel: {e}")))?;
    win.show().map_err(|e| AppError::Other(format!("failed to show tray panel: {e}")))?;
    win.set_focus().map_err(|e| AppError::Other(format!("failed to focus tray panel: {e}")))?;
    // Clear the dismiss timestamp now that the panel is open again, so a stale
    // value can never interfere with a later toggle (the cooldown only guards the
    // blur→click gesture immediately after a hide).
    state.tray_panel_hidden_at.store(0, Ordering::Relaxed);
    Ok(())
}

/// Hide the tray panel if it exists. Invoked by the frontend after an in-panel
/// action that opens the main window (e.g. "Open Hippius").
///
/// # Errors
/// Returns [`AppError::Other`] if hiding the window fails.
#[tauri::command]
pub fn hide_tray_panel(app: AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        hide_window(&win)?;
    }
    Ok(())
}

/// Hide the panel in response to it losing focus (click-outside dismissal),
/// recording the hide time so an immediately following tray click is treated as
/// a dismiss instead of a re-open. Called from the global window-event handler
/// in `main.rs`; errors are logged rather than propagated because there is no
/// caller to surface them to.
pub fn on_panel_blur(app: &AppHandle) {
    let Some(win) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        if let Err(e) = win.hide() {
            warn!("failed to hide tray panel on blur: {e}");
            return;
        }
        app.state::<AppState>().tray_panel_hidden_at.store(now_ms(), Ordering::Relaxed);
    }
}

/// Eagerly create the (hidden) panel window at startup so the first tray click
/// only has to position and show it — the webview + Next route load cost is
/// paid in the background at boot instead of on the user's first click.
///
/// Best-effort: a failure here is logged but not fatal, because
/// [`toggle_tray_panel`] will lazily build the window if it is still absent.
pub fn prewarm(app: &AppHandle) {
    if app.get_webview_window(PANEL_LABEL).is_some() {
        return;
    }
    if let Err(e) = build_panel(app) {
        warn!("failed to prewarm tray panel: {e}");
    }
}

/// Build the borderless, transparent, always-on-top panel window (initially
/// hidden and unfocused — `toggle_tray_panel` positions then reveals it).
fn build_panel(app: &AppHandle) -> Result<WebviewWindow> {
    // The Next dev server serves the route at `/tray-panel`, but the static
    // export (no `trailingSlash`) emits `tray-panel.html` at the dist root —
    // and Tauri's directory fallback looks for `tray-panel/index.html`, which
    // does not exist. Pick the path that resolves for the current build.
    let route = if cfg!(dev) { "tray-panel" } else { "tray-panel.html" };
    WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App(route.into()))
        .title("Hippius")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false)
        // Transparent on every platform so the card's rounded corners cut out
        // cleanly. The FROSTED look is macOS-only: there the native "Popover"
        // vibrancy material below fills the window behind a translucent card.
        // Linux/Windows have no such material, so the frontend paints an OPAQUE
        // card off macOS — without that, the 0.7-alpha card over the transparent
        // window showed the desktop straight through (the "very transparent"
        // popover reported on Linux).
        .transparent(true)
        // The "Popover" vibrancy gives the real desktop blur the Figma frost
        // calls for, which CSS `backdrop-filter` cannot do on a transparent
        // WebKit window. `radius` rounds the material to the 16px card. This is a
        // macOS-only material; Tauri ignores it on Linux/Windows, so applying it
        // unconditionally is a harmless no-op there (and keeps the build path
        // identical across platforms).
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(PANEL_RADIUS)
                .build(),
        )
        // Native window shadow only on macOS, where it wraps the rounded vibrancy
        // material correctly. On a transparent Linux/Windows window with NO
        // material it would shadow the rectangular bounds (a dark frame around
        // the rounded corners), so it is left off there; the opaque card's
        // hairline border supplies edge definition instead.
        .shadow(cfg!(target_os = "macos"))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| AppError::Other(format!("failed to build tray panel window: {e}")))
}

/// Deterministic anchor [`Rect`] for the popover when the tray click carries no
/// icon bounds — the Linux path, where the `tray-icon` crate emits no left-click
/// event and the panel is opened from the native menu instead.
///
/// Linux gives us neither tray-icon bounds nor reliable self-positioning: under
/// Wayland `set_position` is a no-op, and an earlier cursor-based anchor dropped
/// the window at the compositor default (top-left) in practice. So we pin a
/// predictable spot — the TOP-RIGHT corner of the primary monitor's work area,
/// where the GNOME/most-Linux system tray lives. Returned as a zero-size rect at
/// that corner; [`geometry::compute_panel_position`] then drops the panel just
/// below the top inset, right-aligned, and clamps it fully on-screen.
///
/// # Errors
/// Returns [`AppError::Other`] if no primary monitor can be resolved.
fn fallback_anchor(app: &AppHandle) -> Result<Rect> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| AppError::Other(format!("primary_monitor failed: {e}")))?
        .ok_or_else(|| AppError::Other("no primary monitor for tray panel".into()))?;
    let wa = monitor.work_area();
    Ok(Rect {
        // Right/top corner of the work area as a zero-size point; the geometry
        // clamps it to the right margin and just under the top inset.
        x: wa.position.x + wa.size.width as i32,
        y: wa.position.y,
        width: 0,
        height: 0,
    })
}

/// Resolve the work area (and scale factor) of the monitor containing the tray
/// icon, falling back to the primary monitor when the icon point maps to none.
fn target_work_area(app: &AppHandle, icon: Rect) -> Result<(Rect, f64)> {
    let center_x = f64::from(icon.x + icon.width / 2);
    let center_y = f64::from(icon.y + icon.height / 2);

    let monitor = app
        .monitor_from_point(center_x, center_y)
        .map_err(|e| AppError::Other(format!("monitor_from_point failed: {e}")))?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| AppError::Other("no monitor available for tray panel".into()))?;

    let wa = monitor.work_area();
    let rect = Rect {
        x: wa.position.x,
        y: wa.position.y,
        width: wa.size.width as i32,
        height: wa.size.height as i32,
    };
    Ok((rect, monitor.scale_factor()))
}

/// Hide a panel window, mapping any failure to [`AppError::Other`].
fn hide_window(win: &WebviewWindow) -> Result<()> {
    win.hide().map_err(|e| AppError::Other(format!("failed to hide tray panel: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        TrayIconRect { x, y, width: w, height: h }.to_rect()
    }

    #[test]
    fn to_rect_maps_non_finite_to_zero() {
        assert_eq!(
            rect(f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::NAN),
            Rect { x: 0, y: 0, width: 0, height: 0 }
        );
    }

    #[test]
    fn to_rect_clamps_absurd_magnitudes() {
        let max = MAX_COORD as i32;
        let huge = rect(1e300, -1e300, 1e300, -5.0);
        assert_eq!(huge.x, max);
        assert_eq!(huge.y, -max);
        assert_eq!(huge.width, max, "width clamped to the safe bound");
        assert_eq!(huge.height, 0, "negative dimension clamps to 0");
    }

    #[test]
    fn to_rect_rounds_normal_values() {
        assert_eq!(rect(10.4, 20.6, 30.0, 40.0), Rect { x: 10, y: 21, width: 30, height: 40 });
    }
}
