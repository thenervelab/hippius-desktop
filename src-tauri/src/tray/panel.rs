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
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tracing::{info, warn};

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

/// Window after a show within which a blur is the activation settling, not a
/// click outside: [`on_panel_blur`] gives the panel the keyboard back instead
/// of hiding it. Activating the app can hand the keyboard to the window that
/// last had it (a capture card the user clicked, the recording pill) a beat
/// after the panel took it, which used to hide the popover the moment it
/// appeared. Shorter than any deliberate click elsewhere.
pub const SHOW_SETTLE_MS: u64 = 400;

/// The popover's window level on macOS: `NSPopUpMenuWindowLevel`, the level
/// of a menu dropped from the menu bar. Tauri's `always_on_top` is
/// `NSFloatingWindowLevel` (3), the SAME level as the capture preview card
/// (`capture::commands::float_over_full_screen`), which is ordered front with
/// `orderFrontRegardless` whenever it shows; on a laptop display the 330pt
/// card in the bottom-right corner overlaps the 672pt popover hanging from a
/// right-hand menu bar icon, so a card shown or brought back after the
/// popover covered its lower half. Above the card and the Dock, still below
/// the capture overlays (1000) and the camera bubble (1001), which the user
/// is placing over the whole screen.
pub const PANEL_WINDOW_LEVEL: i64 = 101;

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
    /// The rect a tray event carries, in physical pixels (which is what
    /// `tray-icon` reports on macOS and Windows).
    fn from_tray(rect: tauri::Rect) -> Self {
        let position = rect.position.to_physical::<f64>(1.0);
        let size = rect.size.to_physical::<f64>(1.0);
        Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }
    }

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
        let dim = |v: f64| -> i32 { if v.is_finite() { v.round().clamp(0.0, MAX_COORD) as i32 } else { 0 } };
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

/// A tray icon event, from Rust's own tray listener (`main.rs` registers it
/// with `Builder::on_tray_icon_event`). A left click on the Hippius icon is
/// routed here, whatever state the webviews are in.
///
/// The click used to reach Rust through a callback the main window's
/// webview attached when it made the icon (`TrayIcon.new({ action })`). That
/// callback lives in the webview's page: once the page reloaded (a dev
/// reload, the error screen's navigation), the icon kept sending clicks to a
/// callback that no longer existed and the popover never opened again,
/// because the reloaded page found the icon already there and did not make
/// it again. Rust's listener belongs to the app, so it cannot go stale.
///
/// Linux gets no left-click event from `tray-icon` (the menu opens instead),
/// and never shows the popover.
pub fn on_tray_icon_event(app: &AppHandle, event: &TrayIconEvent) {
    if cfg!(target_os = "linux") || event.id().as_ref() != crate::capture::tray_status::TRAY_ID {
        return;
    }
    // macOS: keep the context menu off the status item, or the status item
    // opens it on every click and the left click never arrives (see
    // `tray::status_menu`). Also opens it on a right click.
    super::status_menu::on_tray_event(app, event);
    let TrayIconEvent::Click {
        rect,
        button,
        button_state: MouseButtonState::Up,
        ..
    } = event
    else {
        return;
    };
    info!("tray: {button:?} click");
    if *button != MouseButton::Left {
        return;
    }
    if let Err(e) = on_left_click(app, Some(TrayIconRect::from_tray(*rect))) {
        warn!("tray click: {e}");
    }
}

/// Record whether the app on screen is signed in, which decides what a tray
/// click opens (the popover, or the main window's sign-in screen). Sent by
/// the main window's `useTrayInit` from the auth context's
/// `isAuthenticated`, the value that decides whether the login screen shows,
/// and sent again after any reload. NOT Rust's `AuthInfo.substrate_address`:
/// that stays set for a session restored from disk while the UI shows the
/// login screen.
#[tauri::command]
pub fn tray_set_signed_in(state: tauri::State<'_, AppState>, signed_in: bool) {
    info!("tray: signed in = {signed_in}");
    state.tray_signed_in.store(signed_in, Ordering::Relaxed);
}

/// A left click on the tray icon: the recording's pill, the main window, or
/// the popover ([`crate::capture::tray_status::tray_click_route`]).
fn on_left_click(app: &AppHandle, rect: Option<TrayIconRect>) -> Result<()> {
    use crate::capture::tray_status::TrayClickRoute;
    let signed_in = app.state::<AppState>().tray_signed_in.load(Ordering::Relaxed);
    let route = crate::capture::commands::on_tray_click(app, signed_in);
    info!("tray click: signed in = {signed_in}, route = {route:?}, rect = {rect:?}");
    match route {
        TrayClickRoute::ShowRecordingControls => Ok(()),
        TrayClickRoute::OpenMainWindow => {
            show_main_window(app);
            Ok(())
        }
        TrayClickRoute::TogglePanel { recording } => toggle_panel(app, rect, recording),
    }
}

/// The main window, forward: a signed-out tray click.
fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Toggle the tray panel (IPC form of a tray click). The click itself now
/// reaches Rust directly ([`on_tray_icon_event`]); this stays for callers
/// that hold an icon rect and routes the same way.
///
/// # Errors
/// See [`toggle_panel`].
#[tauri::command]
pub fn toggle_tray_panel(app: AppHandle, rect: Option<TrayIconRect>) -> Result<()> {
    on_left_click(&app, rect)
}

/// Toggle the tray panel: show it anchored to the tray icon, or hide it if it
/// is already visible.
///
/// `rect` is the tray icon's screen rectangle on macOS/Windows, where the
/// left-click event carries it. With `None` the panel uses a deterministic
/// top-right anchor (see [`fallback_anchor`]).
///
/// `recording`: a screen recording is running or paused. The popover still
/// opens (the menu bar icon must never go dead mid-recording), kept out of
/// the video: by the macOS helper, which leaves Hippius out, or elsewhere
/// by content protection, lifted again on the next open after the
/// recording.
///
/// Runs on the main thread (the tray listener runs on the event loop), which
/// macOS requires for `show`/`set_position`/`set_focus`.
///
/// # Errors
/// Returns [`AppError::Other`] if the window cannot be built, no monitor can be
/// resolved, or a window operation (position/show/focus/hide)
/// fails.
fn toggle_panel(app: &AppHandle, rect: Option<TrayIconRect>, recording: bool) -> Result<()> {
    let win = match app.get_webview_window(PANEL_LABEL) {
        Some(w) => w,
        None => build_panel(app)?,
    };

    if win.is_visible().unwrap_or(false) {
        info!("tray panel: visible, click hides it");
        hide_window(&win)?;
        return Ok(());
    }

    // Clicking the icon of an open panel first blurs+hides it (recording the
    // timestamp in `on_panel_blur`) and then fires this toggle. Within the
    // cooldown, treat that click as the dismiss and stay hidden rather than
    // immediately re-opening.
    let hidden_at = app.state::<AppState>().tray_panel_hidden_at.load(Ordering::Relaxed);
    if hidden_at != 0 && now_ms().saturating_sub(hidden_at) < REOPEN_COOLDOWN_MS {
        info!("tray panel: hidden by this click's blur, stays hidden");
        return Ok(());
    }

    // macOS/Windows forward the tray icon's screen rect; Linux forwards `None`
    // (no left-click tray event there) and we fall back to a deterministic
    // top-right anchor. Either way the result is a physical-pixel rect fed to
    // the same geometry.
    let icon = match rect {
        Some(r) => r.to_rect(),
        None => fallback_anchor(app)?,
    };
    let (work_area, scale) = target_work_area(app, icon)?;

    // Convert the logical panel/gap/margin to physical pixels for the target
    // monitor so the placement matches `work_area`, which is physical.
    let panel_w = (PANEL_WIDTH * scale).round() as i32;
    let panel_h = (PANEL_HEIGHT * scale).round() as i32;
    let gap = (GAP * scale).round() as i32;
    let margin = (MARGIN * scale).round() as i32;

    let (x, y) = geometry::compute_panel_position(icon, panel_w, panel_h, work_area, gap, margin);

    info!("tray panel: show at ({x}, {y}) on work area {work_area:?} x{scale}, recording = {recording}");
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| AppError::Other(format!("failed to position tray panel: {e}")))?;
    // Mid-recording the popover must stay out of the video. On macOS the
    // helper leaves Hippius out itself, so the popover is never protected
    // there and shows in other apps' screen sharing (`own_windows`).
    let protect = crate::capture::own_windows::content_protected(
        crate::capture::rollout::current_platform(),
        crate::capture::own_windows::OwnWindow::TrayPopover { recording },
    );
    if let Err(e) = win.set_content_protected(protect) {
        warn!("tray panel content protection: {e}");
    }
    raise_above_capture_surfaces(&win);
    app.state::<AppState>().tray_panel_shown_at.store(now_ms(), Ordering::Relaxed);
    win.show().map_err(|e| AppError::Other(format!("failed to show tray panel: {e}")))?;
    win.set_focus().map_err(|e| AppError::Other(format!("failed to focus tray panel: {e}")))?;
    // Clear the dismiss timestamp now that the panel is open again, so a stale
    // value can never interfere with a later toggle (the cooldown only guards the
    // blur→click gesture immediately after a hide).
    app.state::<AppState>().tray_panel_hidden_at.store(0, Ordering::Relaxed);

    // Tell the (reused, prewarmed) popover webview it is now visible so it
    // re-fetches its account / credits / uploads. The webview's own
    // `onFocusChanged` is unreliable across re-shows of a reused window — when
    // it fails to fire, the popover keeps the stale boot-gap menu it fetched
    // before `restore_session` hydrated the in-memory session, showing credits
    // "—" and an endless loading skeleton (the F-3 recurrence). An explicit
    // event on every show guarantees a fresh fetch; a duplicate refresh when
    // the focus event also fires is harmless (the fetch is idempotent).
    let _ = win.emit("hippius:tray-panel-shown", ());
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

/// Tear down the tray panel and exit the process.
///
/// Shared by Linux/Windows window-close and the tray Quit IPC so X and Quit
/// cannot diverge. The panel is prewarmed hidden even on Linux (where the
/// popover is unused). Destroy it *before* `exit(0)` so a leftover webview
/// cannot keep the event loop alive after the main window is gone.
pub fn quit_desktop(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL_LABEL)
        && let Err(e) = panel.destroy()
    {
        warn!("failed to destroy tray panel on quit: {e}");
    }
    app.exit(0);
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
        let shown_at = app.state::<AppState>().tray_panel_shown_at.load(Ordering::Relaxed);
        if !blur_dismisses(now_ms(), shown_at) {
            // The activation settling, not a click outside: keep the keyboard.
            info!("tray panel: blur right after the show, keeps focus");
            let _ = win.set_focus();
            return;
        }
        info!("tray panel: blur, hidden");
        if let Err(e) = win.hide() {
            warn!("failed to hide tray panel on blur: {e}");
            return;
        }
        app.state::<AppState>().tray_panel_hidden_at.store(now_ms(), Ordering::Relaxed);
    }
}

/// Whether a blur at `now` hides the panel shown at `shown_at` (Unix ms;
/// `0` = never shown): only once [`SHOW_SETTLE_MS`] have passed since the
/// show. A clock that went backwards dismisses, so it can never hold the
/// panel open.
fn blur_dismisses(now: u64, shown_at: u64) -> bool {
    shown_at == 0 || now < shown_at || now - shown_at >= SHOW_SETTLE_MS
}

/// Put the panel at [`PANEL_WINDOW_LEVEL`], above every capture surface it
/// can meet, and let it open over a full-screen app's Space like a real menu
/// bar popover. macOS only; elsewhere `always_on_top` and show order decide.
#[cfg(target_os = "macos")]
fn raise_above_capture_surfaces(win: &WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};
    /// NSWindowCollectionBehaviorFullScreenAuxiliary.
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    let target = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(ns_window) = target.ns_window() {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: the panel's live NSWindow, touched only here, on the
            // main thread.
            unsafe {
                let () = msg_send![ns_window, setLevel: PANEL_WINDOW_LEVEL];
                let behavior: usize = msg_send![ns_window, collectionBehavior];
                let () = msg_send![ns_window, setCollectionBehavior: behavior | FULL_SCREEN_AUXILIARY];
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn raise_above_capture_surfaces(_win: &WebviewWindow) {}

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
    match build_panel(app) {
        Ok(win) => raise_above_capture_surfaces(&win),
        Err(e) => warn!("failed to prewarm tray panel: {e}"),
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
            Rect {
                x: 0,
                y: 0,
                width: 0,
                height: 0
            }
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

    /// A capture window taking the keyboard back as the app activates used to
    /// hide the popover the moment it appeared; a real click outside, later,
    /// still dismisses it.
    #[test]
    fn a_blur_right_after_the_show_does_not_dismiss() {
        let shown = 1_000_000;
        assert!(!blur_dismisses(shown, shown));
        assert!(!blur_dismisses(shown + SHOW_SETTLE_MS - 1, shown));
        assert!(blur_dismisses(shown + SHOW_SETTLE_MS, shown));
        assert!(blur_dismisses(shown + 5_000, shown));
        assert!(blur_dismisses(shown, 0), "never shown: nothing to protect");
        // A clock that went backwards must not pin the panel open.
        assert!(blur_dismisses(shown - 10, shown));
    }

    /// The settle window must stay shorter than a deliberate click elsewhere,
    /// and at least as long as the reopen cooldown it sits beside.
    #[test]
    fn the_settle_window_is_short() {
        const { assert!(SHOW_SETTLE_MS >= REOPEN_COOLDOWN_MS && SHOW_SETTLE_MS <= 500) };
    }

    /// The popover sits above the capture card (`NSFloatingWindowLevel`, 3,
    /// which is also `always_on_top`) and the Dock (20), and below the
    /// capture overlays (1000) and the camera bubble (1001).
    #[test]
    fn the_popover_level_is_above_the_card_and_below_the_overlays() {
        const FLOATING: i64 = 3;
        const DOCK: i64 = 20;
        const OVERLAY: i64 = 1000;
        const { assert!(PANEL_WINDOW_LEVEL > FLOATING && PANEL_WINDOW_LEVEL > DOCK && PANEL_WINDOW_LEVEL < OVERLAY) };
    }

    #[test]
    fn to_rect_rounds_normal_values() {
        assert_eq!(
            rect(10.4, 20.6, 30.0, 40.0),
            Rect {
                x: 10,
                y: 21,
                width: 30,
                height: 40
            }
        );
    }
}
