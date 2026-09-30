//! The capture IPCs and the session that ties them together.
//!
//! Flow: `capture_start` opens one transparent overlay per display, and the
//! overlay under the pointer draws the capture bar (`bar.rs`). The bar can
//! switch what is captured (`capture_set_mode`); an area drawn on any display
//! is held here (`capture_set_pending`) so the bar's Capture button can take
//! it (`capture_confirm`), and a window or screen click answers directly
//! (`capture_select`). A screenshot is taken at once, or a recording starts
//! with a floating control bar. Either way the preview card opens in the
//! corner (`preview.rs`) while delivery runs in the background →
//! `capture_delivered` / `capture_failed`. Every phase change is broadcast as
//! `capture_state_changed`, which is the only thing the surfaces read.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::bar::{self, CameraShape, CameraSize, CaptureOptions};
use super::camera::{self, CameraState};
use super::destination::{self, CaptureDestination, DestinationChoice};
use super::preview::{PreviewCard, PreviewStatus};
use super::recording::{self, Microphone, RecordOptions, Recorder};
use super::screenshot::Selection;
use super::session::{CaptureEvent, CaptureKind, CaptureMode, CapturePhase, TransitionError, transition};
use super::share;
use super::shortcut::{self, ShortcutSetting};
use super::targets::{DisplayTarget, WindowTarget};
use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};

pub const STATE_CHANGED_EVENT: &str = "capture_state_changed";
pub const DELIVERED_EVENT: &str = "capture_delivered";
pub const FAILED_EVENT: &str = "capture_failed";
/// An area was drawn (or cleared) on one display; the others drop theirs.
pub const PENDING_EVENT: &str = "capture_pending_changed";
/// The preview card's content changed (new capture, upload finished).
pub const PREVIEW_EVENT: &str = "capture_preview_changed";
/// "Show in folder": the main window opens the drive's Captures folder.
pub const SHOW_IN_FOLDER_EVENT: &str = "capture_show_in_folder";
/// The camera window's shape or device changed (`camera::CameraState`); the
/// camera page and the recording pill both read it.
pub const CAMERA_STATE_EVENT: &str = "capture_camera_state";
/// The camera window listed the cameras it can use.
pub const CAMERAS_EVENT: &str = "capture_cameras";
/// The saved options changed from outside the bar (the camera's own size
/// strip or its ×); the bar replaces its copy (`bar::CaptureOptions`).
pub const OPTIONS_EVENT: &str = "capture_options_changed";
/// More pictures for the share picker (`share::ShareArt`).
pub const SHARE_ART_EVENT: &str = "capture_share_art";
/// The pointer went onto or off the camera window (a bool), so its size
/// controls show only while the pointer is over it. Sent from Rust because a
/// window that is not the key window does not always get the webview's own
/// hover events on macOS.
pub const CAMERA_HOVER_EVENT: &str = "capture_camera_hover";

/// Overlay windows are labelled `capture-overlay-<display id>`, which is also
/// the glob the overlay's capability file grants.
pub const OVERLAY_LABEL_PREFIX: &str = "capture-overlay-";
pub const CONTROLS_LABEL: &str = "capture-controls";
pub const PREVIEW_LABEL: &str = "capture-preview";
pub const CAMERA_LABEL: &str = "capture-camera";

/// The card's window, in logical points; the card fills it.
const PREVIEW_WIDTH: f64 = 316.0;
/// Tall enough for the picture, two lines, the progress or timer bar and the
/// buttons; at 290 the top of the picture was clipped.
const PREVIEW_HEIGHT: f64 = 330.0;
/// Gap between the card and the display's bottom-right corner.
const PREVIEW_MARGIN: f64 = 16.0;
/// The recording pill's window, in logical points.
const CONTROLS_WIDTH: f64 = 340.0;
const CONTROLS_HEIGHT: f64 = 60.0;
/// Gap between the pill and the bottom of the usable area.
const CONTROLS_MARGIN: f64 = 24.0;

const MAIN_WINDOW_LABEL: &str = "main";

/// Whether this build can capture screenshots at all. Linux screenshots go
/// through the desktop portal in a follow-up, so the surfaces hide themselves
/// there.
pub const CAPTURE_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

#[derive(Default)]
pub struct CaptureState {
    phase: Mutex<Option<CapturePhase>>,
    /// Whether the main window was on screen when the capture started, so it
    /// comes back only if it was there to begin with.
    restore_main: AtomicBool,
    /// Live recording backend, if any.
    recorder: Mutex<Option<Box<dyn Recorder>>>,
    /// Cancels the elapsed-time tick task.
    tick_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// The display the capture bar is on; the preview card opens there too.
    bar_display: Mutex<Option<DisplayTarget>>,
    /// The area drawn so far, on whichever display, for the Capture button.
    pending: Mutex<Option<Selection>>,
    /// A still of a recording's first frame, for its preview card.
    poster: Mutex<Option<String>>,
    /// The card in the corner, if one is showing.
    preview: Mutex<Option<PreviewCard>>,
    preview_seq: AtomicU64,
    /// The camera window on screen, and in which shape.
    camera_shape: Mutex<Option<CameraShape>>,
    /// The camera this recording started with; the window stays until stop.
    recording_camera: Mutex<Option<CameraShape>>,
    /// The bubble was hidden from the pill for part of a recording.
    camera_hidden: AtomicBool,
    /// The cameras the camera window found (the webview's `deviceId`s). The
    /// bar's picker falls back to these where the system list is empty.
    cameras: Mutex<Vec<CameraDevice>>,
    /// The cameras the system lists (the helper on macOS), last read.
    native_cameras: Mutex<Vec<CameraDevice>>,
    /// Tags the share picker's picture taking; a new picker, or the picker
    /// closing, moves it on and the old thread stops.
    share_seq: AtomicU64,
    /// Where the bubble was before it went full size, so Small / Large brings
    /// it back there.
    bubble_frame: Mutex<Option<camera::Frame>>,
    /// The pointer is over the camera window (the last hover sent). macOS
    /// only: elsewhere the webview's own hover events are used.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    camera_hover: AtomicBool,
    /// Which hover watch is current (see `spawn_camera_hover_watch`).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    camera_watch: AtomicU64,
}

/// A camera the bar's picker offers: from the system list (a platform id) or
/// as the camera window's webview names it (its `deviceId`).
pub type CameraDevice = recording::MediaDevice;

impl CaptureState {
    fn current(&self) -> CapturePhase {
        self.phase.lock().map_or(CapturePhase::Idle, |p| p.unwrap_or(CapturePhase::Idle))
    }

    fn take_recorder(&self) -> Option<Box<dyn Recorder>> {
        self.recorder.lock().ok().and_then(|mut g| g.take())
    }

    fn stop_ticks(&self) {
        if let Ok(mut g) = self.tick_cancel.lock()
            && let Some(tx) = g.take()
        {
            let _ = tx.send(());
        }
    }
}

/// Apply `event` and broadcast the new phase. The lock is released before
/// the emit, so a listener that calls back in cannot deadlock.
fn advance(app: &AppHandle, state: &CaptureState, event: CaptureEvent) -> Result<CapturePhase> {
    let next = {
        let mut guard = state.phase.lock()?;
        let next = transition(guard.unwrap_or(CapturePhase::Idle), event).map_err(transition_error)?;
        *guard = Some(next);
        next
    };
    let _ = app.emit(STATE_CHANGED_EVENT, next);
    Ok(next)
}

fn transition_error(e: TransitionError) -> AppError {
    AppError::Validation(e.to_string())
}

/// Hide the app's own windows so they are not in the shot, remembering
/// whether the main window was visible.
fn hide_own_windows(app: &AppHandle, state: &CaptureState) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = main.is_visible().unwrap_or(false);
        state.restore_main.store(visible, Ordering::SeqCst);
        if visible {
            let _ = main.hide();
        }
    }
    let _ = crate::tray::panel::hide_tray_panel(app.clone());
}

fn restore_own_windows(app: &AppHandle, state: &CaptureState) {
    if state.restore_main.swap(false, Ordering::SeqCst)
        && let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL)
    {
        let _ = main.show();
    }
}

fn close_overlays(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            let _ = window.close();
        }
    }
}

fn close_controls(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = w.close();
    }
}

/// Start a capture: check it can happen, then put an overlay on every display
/// with the capture bar on the one under the pointer.
///
/// `kind` and `mode` preselect the bar (a Capture menu item, the tray); left
/// out, the bar opens on whatever was used last.
///
/// Refusals are structured so the UI can answer each one:
/// `NotReady(CaptureDestinationUnset)` → the drive picker,
/// `NotReady(ScreenRecordingPermission)` → the permission explainer.
/// A capture already in progress is brought forward, not refused.
#[tauri::command]
pub async fn capture_start(state: tauri::State<'_, AppState>, app: AppHandle, kind: Option<CaptureKind>, mode: Option<CaptureMode>) -> Result<()> {
    if !CAPTURE_SUPPORTED {
        return Err(AppError::Validation("Screen capture isn't available on this system yet.".into()));
    }
    let recording_ok = recording::recording_supported();
    if kind == Some(CaptureKind::Recording) && !recording_ok {
        return Err(AppError::Validation("Screen recording isn't available on this system yet.".into()));
    }
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    if destination::load(pool, &account_id).await?.is_none() {
        return Err(AppError::NotReady(NotReadyKind::CaptureDestinationUnset));
    }
    if !super::permissions::screen_capture_granted() {
        // Shows the system prompt the first time; after that it only reports.
        super::permissions::request_screen_capture();
        return Err(AppError::NotReady(NotReadyKind::ScreenRecordingPermission));
    }

    let mut options = bar::load_options(pool).await?;
    let kind = match kind {
        Some(k) => k,
        // Last time was a recording on a Mac that has since lost the helper.
        None if options.last_kind == CaptureKind::Recording && !recording_ok => CaptureKind::Screenshot,
        None => options.last_kind,
    };
    let mode = mode.unwrap_or(options.last_mode);

    match advance(&app, &state.capture, CaptureEvent::Start { kind, mode }) {
        Ok(_) => {}
        Err(_) if state.capture.current() != CapturePhase::Idle => {
            focus_active_ui(&app, &state.capture);
            return Ok(());
        }
        Err(e) => return Err(e),
    }
    if (options.last_kind, options.last_mode) != (kind, mode) {
        options.last_kind = kind;
        options.last_mode = mode;
        if let Err(e) = bar::save_options(pool, options.clone()).await {
            tracing::warn!(error = %e, "capture bar: last mode not remembered");
        }
    }

    close_preview(&app, &state.capture);
    hide_own_windows(&app, &state.capture);
    let opened = open_capture_ui(&app, &state.capture).await;
    state.capture.camera_hidden.store(false, Ordering::SeqCst);
    sync_camera(&app).await;
    // Load the card and the recording pill while the user is still choosing,
    // so each appears the moment it is needed instead of after its page loads.
    let display = state.capture.bar_display.lock().ok().and_then(|g| g.clone());
    if let Err(e) = open_preview_window(&app, display.as_ref()) {
        tracing::warn!(error = %e, "capture preview card not prepared");
    }
    if kind == CaptureKind::Recording
        && let Err(e) = open_controls(&app, false)
    {
        tracing::warn!(error = %e, "recording controls not prepared");
    }
    if let Err(e) = opened {
        close_overlays(&app);
        restore_own_windows(&app, &state.capture);
        let _ = advance(&app, &state.capture, CaptureEvent::Failed);
        return Err(e);
    }
    Ok(())
}

fn focus_active_ui(app: &AppHandle, state: &CaptureState) {
    match state.current() {
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } | CapturePhase::Finalizing => {
            if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
                let _ = w.set_focus();
            }
        }
        _ => focus_overlays(app),
    }
}

/// Put an overlay on every display and choose which one carries the bar.
async fn open_capture_ui(app: &AppHandle, state: &CaptureState) -> Result<()> {
    let displays = tauri::async_runtime::spawn_blocking(list_displays_blocking)
        .await
        .map_err(|e| AppError::Other(format!("display listing task failed: {e}")))??;
    if displays.is_empty() {
        return Err(AppError::Other("No display to capture.".into()));
    }
    let host = bar::bar_display(&displays, cursor_point(app, &displays));
    if let Ok(mut g) = state.bar_display.lock() {
        *g = displays.iter().find(|d| Some(d.id) == host).cloned();
    }
    if let Ok(mut g) = state.pending.lock() {
        *g = None;
    }
    for display in &displays {
        open_overlay(app, display)?;
    }
    Ok(())
}

/// The pointer, in the displays' own space: points with a top-left origin on
/// macOS (AppKit reports bottom-left, y up, from the primary display), and
/// physical pixels on Windows, as `targets::list_displays` reports them.
#[cfg(target_os = "macos")]
fn cursor_point(_app: &AppHandle, displays: &[DisplayTarget]) -> Option<(f64, f64)> {
    use cocoa::foundation::NSPoint;
    use objc::{class, msg_send, sel, sel_impl};

    let primary = displays.iter().find(|d| d.is_primary).or_else(|| displays.first())?;
    // SAFETY: `+[NSEvent mouseLocation]` is a class method that only reads
    // the current pointer position and returns it by value.
    let p: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    Some((p.x, f64::from(primary.height) - p.y))
}

#[cfg(windows)]
fn cursor_point(app: &AppHandle, _displays: &[DisplayTarget]) -> Option<(f64, f64)> {
    app.cursor_position().ok().map(|p| (p.x, p.y))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn cursor_point(_app: &AppHandle, _displays: &[DisplayTarget]) -> Option<(f64, f64)> {
    None
}

#[cfg(any(target_os = "macos", windows))]
fn list_displays_blocking() -> Result<Vec<DisplayTarget>> {
    super::targets::list_displays()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn list_displays_blocking() -> Result<Vec<DisplayTarget>> {
    Ok(Vec::new())
}

fn open_overlay(app: &AppHandle, display: &DisplayTarget) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let label = format!("{OVERLAY_LABEL_PREFIX}{}", display.id);
    // Same split as the tray panel: the dev server serves `/capture-overlay`,
    // the static export only `capture-overlay.html`.
    let route = if cfg!(dev) { "capture-overlay" } else { "capture-overlay.html" };
    let url = WebviewUrl::App(format!("{route}?display={}", display.id).into());
    let window = WebviewWindowBuilder::new(app, &label, url)
        .title("Hippius capture")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // Keeps the overlay out of its own capture (NSWindow.sharingType =
        // none; WDA_EXCLUDEFROMCAPTURE on Windows), so the screenshot is of
        // the screen, not of the dimmed selection UI over it.
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|e| AppError::Other(format!("Could not open the capture overlay: {e}")))?;

    // Placed after building, in the display's own space: points on macOS,
    // physical pixels on Windows, where a logical position would be resolved
    // against whichever monitor Tauri guessed and land on the wrong one in a
    // mixed-DPI setup.
    if super::targets::COORDS_ARE_LOGICAL {
        let _ = window.set_position(tauri::LogicalPosition::new(f64::from(display.x), f64::from(display.y)));
        let _ = window.set_size(tauri::LogicalSize::new(f64::from(display.width), f64::from(display.height)));
    } else {
        let _ = window.set_position(tauri::PhysicalPosition::new(display.x, display.y));
        let _ = window.set_size(tauri::PhysicalSize::new(display.width, display.height));
    }
    raise_above_menu_bar(&window);
    window
        .show()
        .map_err(|e| AppError::Other(format!("Could not show the capture overlay: {e}")))?;
    let _ = window.set_focus();
    Ok(())
}

/// The recording pill, bottom-centre of the bar's display, above the Dock.
/// Built hidden while choosing (`show` false) so it is ready to appear the
/// moment the countdown ends; shown with `show` true.
fn open_controls(app: &AppHandle, show: bool) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let window = if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
        w
    } else {
        let route = if cfg!(dev) { "capture-controls" } else { "capture-controls.html" };
        let mut builder = WebviewWindowBuilder::new(app, CONTROLS_LABEL, WebviewUrl::App(route.into()))
            .title("Hippius recording")
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .content_protected(true)
            .focused(false)
            // Pause and Stop answer the first click, like the card's buttons.
            .accept_first_mouse(true)
            .inner_size(CONTROLS_WIDTH, CONTROLS_HEIGHT)
            .visible(false);
        let display = app.state::<AppState>().capture.bar_display.lock().ok().and_then(|g| g.clone());
        if let Some(d) = display {
            let area = work_area(app, &d);
            builder = builder.position(
                area.x + (area.width - CONTROLS_WIDTH) / 2.0,
                area.y + area.height - CONTROLS_HEIGHT - CONTROLS_MARGIN,
            );
        }
        let window = builder
            .build()
            .map_err(|e| AppError::Other(format!("Could not open the recording controls: {e}")))?;
        raise_above_menu_bar(&window);
        window
    };
    if show {
        show_without_focus(&window);
    }
    Ok(())
}

/// A display's usable area in logical points: without the menu bar and the
/// Dock on macOS, without the taskbar on Windows. Windows placed against the
/// whole display sat under the Dock and looked cut off.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn display_area(d: &DisplayTarget) -> LogicalArea {
    let scale = if super::targets::COORDS_ARE_LOGICAL {
        1.0
    } else {
        d.scale_factor.max(1.0)
    };
    LogicalArea {
        x: f64::from(d.x) / scale,
        y: f64::from(d.y) / scale,
        width: f64::from(d.width) / scale,
        height: f64::from(d.height) / scale,
    }
}

#[cfg(target_os = "macos")]
fn work_area(app: &AppHandle, d: &DisplayTarget) -> LogicalArea {
    let full = display_area(d);
    let id = d.id;
    let (tx, rx) = std::sync::mpsc::channel();
    // AppKit is only asked on the main thread.
    let asked = app.run_on_main_thread(move || {
        let _ = tx.send(macos_visible_frame(id));
    });
    let visible = asked
        .ok()
        .and_then(|()| rx.recv_timeout(std::time::Duration::from_millis(500)).ok())
        .flatten();
    let Some((vx, vy, vw, vh, primary_height)) = visible else {
        return full;
    };
    // AppKit's origin is the primary display's bottom-left, y up.
    LogicalArea {
        x: vx,
        y: primary_height - (vy + vh),
        width: vw,
        height: vh,
    }
}

/// `(x, y, width, height)` of the screen with this `CGDirectDisplayID`'s
/// visible frame in AppKit coordinates, plus the primary screen's height.
#[cfg(target_os = "macos")]
fn macos_visible_frame(display_id: u32) -> Option<(f64, f64, f64, f64, f64)> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSRect, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    // SAFETY: read-only AppKit queries on the main thread; every object is
    // checked for nil before it is messaged.
    unsafe {
        let screens: id = msg_send![class!(NSScreen), screens];
        if screens == nil {
            return None;
        }
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return None;
        }
        let primary: id = msg_send![screens, objectAtIndex: 0usize];
        let primary_frame: NSRect = msg_send![primary, frame];
        let key = NSString::alloc(nil).init_str("NSScreenNumber");
        for i in 0..count {
            let screen: id = msg_send![screens, objectAtIndex: i];
            let desc: id = msg_send![screen, deviceDescription];
            let number: id = msg_send![desc, objectForKey: key];
            if number == nil {
                continue;
            }
            let n: u32 = msg_send![number, unsignedIntValue];
            if n == display_id {
                let vf: NSRect = msg_send![screen, visibleFrame];
                return Some((vf.origin.x, vf.origin.y, vf.size.width, vf.size.height, primary_frame.size.height));
            }
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn work_area(app: &AppHandle, d: &DisplayTarget) -> LogicalArea {
    let full = display_area(d);
    // Windows: the monitor at the display's own origin, in physical pixels.
    let Ok(monitors) = app.available_monitors() else { return full };
    let Some(m) = monitors.into_iter().find(|m| m.position().x == d.x && m.position().y == d.y) else {
        return full;
    };
    let area = m.work_area();
    let scale = m.scale_factor().max(1.0);
    LogicalArea {
        x: f64::from(area.position.x) / scale,
        y: f64::from(area.position.y) / scale,
        width: f64::from(area.size.width) / scale,
        height: f64::from(area.size.height) / scale,
    }
}

/// Bring a floating window forward without making it the key window, so the
/// app the user is in keeps the keyboard.
fn show_without_focus(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns_window) = target.ns_window() {
                let ns_window = ns_window.cast::<objc::runtime::Object>();
                // SAFETY: this window's live NSWindow, touched on the main thread.
                let () = unsafe { msg_send![ns_window, orderFrontRegardless] };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
    }
}

/// Tauri's always-on-top level sits BELOW the macOS menu bar, which would
/// leave the overlay stopping short of the top of the screen and the menu bar
/// impossible to select. Raise it to the screen-saver level.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &tauri::WebviewWindow) {
    // NSScreenSaverWindowLevel.
    set_window_level(window, 1000);
}

/// The camera sits one level above the overlays, so it can be placed while
/// choosing, and above the pill so a bubble dragged over it stays in view.
#[cfg(target_os = "macos")]
fn raise_camera(window: &tauri::WebviewWindow) {
    set_window_level(window, 1001);
}

#[cfg(not(target_os = "macos"))]
fn raise_camera(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
fn set_window_level(window: &tauri::WebviewWindow, level: i64) {
    use objc::{msg_send, sel, sel_impl};
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = target.ns_window() {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: `ns_window` is this window's live NSWindow, and AppKit
            // is only touched here, on the main thread.
            let () = unsafe { msg_send![ns_window, setLevel: level] };
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn raise_above_menu_bar(_window: &tauri::WebviewWindow) {}

fn focus_overlays(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            let _ = window.set_focus();
        }
    }
}

/// What an overlay needs to draw itself, and the capture bar with it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContext {
    pub mode: CaptureMode,
    pub display_id: u32,
    pub kind: CaptureKind,
    /// Pickable windows on this display, front first — only in window mode.
    pub windows: Vec<WindowTarget>,
    /// Whether this overlay draws the capture bar (one display does).
    pub hosts_bar: bool,
    pub options: CaptureOptions,
    /// Seconds to count down once Capture / Record is pressed.
    pub countdown_secs: u8,
    pub recording_available: bool,
    pub microphone_available: bool,
    pub show_clicks_available: bool,
    pub destination: Option<CaptureDestination>,
    /// The area already drawn, on this display or another.
    pub pending: Option<Selection>,
}

#[tauri::command]
pub async fn capture_overlay_context(state: tauri::State<'_, AppState>, display_id: u32) -> Result<OverlayContext> {
    let CapturePhase::Selecting { mode, kind } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    let windows = if mode == CaptureMode::Window {
        tauri::async_runtime::spawn_blocking(move || windows_on_display_blocking(display_id))
            .await
            .map_err(|e| AppError::Other(format!("window listing task failed: {e}")))??
    } else {
        Vec::new()
    };
    let pool = state.pool()?;
    let options = bar::load_options(pool).await?;
    let destination = match state.current_account_id() {
        Ok(account_id) => destination::load(pool, &account_id).await?,
        Err(_) => None,
    };
    let hosts_bar = state
        .capture
        .bar_display
        .lock()
        .is_ok_and(|g| g.as_ref().is_some_and(|d| d.id == display_id));
    let pending = state.capture.pending.lock().ok().and_then(|g| *g);
    Ok(OverlayContext {
        mode,
        display_id,
        kind,
        windows,
        hosts_bar,
        countdown_secs: options.countdown_secs(kind),
        options,
        recording_available: recording::recording_supported(),
        microphone_available: recording::microphone_supported(),
        show_clicks_available: recording::show_clicks_supported(),
        destination,
        pending,
    })
}

/// The capture bar switched what to capture. The overlays re-read their
/// context on the state event, and the choice is remembered for next time.
#[tauri::command]
pub async fn capture_set_mode(state: tauri::State<'_, AppState>, app: AppHandle, kind: CaptureKind, mode: CaptureMode) -> Result<()> {
    if kind == CaptureKind::Recording && !recording::recording_supported() {
        return Err(AppError::Validation("Screen recording isn't available on this system yet.".into()));
    }
    advance(&app, &state.capture, CaptureEvent::SetMode { kind, mode })?;
    let pool = state.pool()?;
    let options = CaptureOptions {
        last_kind: kind,
        last_mode: mode,
        ..bar::load_options(pool).await?
    };
    bar::save_options(pool, options).await?;
    sync_camera(&app).await;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPayload {
    /// The display holding the drawn area, or `None` when it was cleared.
    display_id: Option<u32>,
}

/// An overlay drew, moved or cleared its area. One area at a time: the other
/// displays drop theirs on [`PENDING_EVENT`].
#[tauri::command]
pub fn capture_set_pending(state: tauri::State<'_, AppState>, app: AppHandle, selection: Option<Selection>) -> Result<()> {
    if !matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    }
    let display_id = match selection {
        None => None,
        Some(Selection::Area { display_id, .. }) => Some(display_id),
        Some(_) => return Err(AppError::Validation("Only an area can be held for the Capture button.".into())),
    };
    {
        let mut g = state.capture.pending.lock()?;
        *g = selection;
    }
    let _ = app.emit(PENDING_EVENT, PendingPayload { display_id });
    Ok(())
}

/// The bar's Capture / Record button, pressed on `display_id`.
#[tauri::command]
pub async fn capture_confirm(app: AppHandle, display_id: u32) -> Result<()> {
    let state = app.state::<AppState>();
    let CapturePhase::Selecting { mode, kind } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    let options = bar::load_options(state.pool()?).await?;
    let selection = if options.camera_shape(kind) == Some(CameraShape::Stage) {
        // Camera only: what is recorded is the stage window itself.
        let window_id =
            camera_window_id(&app).ok_or_else(|| AppError::Validation("The camera isn't on screen yet. Try again in a moment.".into()))?;
        Selection::Window { window_id }
    } else {
        let pending = state.capture.pending.lock().ok().and_then(|g| *g);
        bar::resolve_confirm(mode, pending, display_id).map_err(|e| AppError::Validation(e.to_string()))?
    };
    select_inner(&app, selection).await
}

#[tauri::command]
pub async fn capture_get_options(state: tauri::State<'_, AppState>) -> Result<CaptureOptions> {
    bar::load_options(state.pool()?).await
}

/// Save the bar's Options menu. Returns what was stored (the timer snapped to
/// a choice the bar offers).
#[tauri::command]
pub async fn capture_set_options(state: tauri::State<'_, AppState>, app: AppHandle, options: CaptureOptions) -> Result<CaptureOptions> {
    let options = options.normalized();
    bar::save_options(state.pool()?, options.clone()).await?;
    // Turning the camera on shows it at once, so it can be placed first.
    sync_camera(&app).await;
    Ok(options)
}

/// The drives "Save to" offers: this account's own, synced here or not.
#[tauri::command]
pub async fn capture_destination_choices(state: tauri::State<'_, AppState>) -> Result<Vec<DestinationChoice>> {
    let account_id = state.current_account_id()?;
    destination::choices(state.pool()?, &account_id).await
}

#[cfg(any(target_os = "macos", windows))]
fn windows_on_display_blocking(display_id: u32) -> Result<Vec<WindowTarget>> {
    let display = super::targets::list_displays()?
        .into_iter()
        .find(|d| d.id == display_id)
        .ok_or_else(|| AppError::Validation("That display is no longer connected.".into()))?;
    super::targets::windows_on_display(&display)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn windows_on_display_blocking(_display_id: u32) -> Result<Vec<WindowTarget>> {
    Ok(Vec::new())
}

/// The overlay's answer: take the capture, then deliver it in the background.
#[tauri::command]
pub async fn capture_select(app: AppHandle, selection: Selection) -> Result<()> {
    select_inner(&app, selection).await
}

/// "Choose what to share": every window and display the picker offers, with
/// what pictures are ready within `share::INLINE_BUDGET`; the rest arrive as
/// [`SHARE_ART_EVENT`] batches tagged with the returned token, and keep
/// refreshing until [`capture_share_done`] or the choosing ends. `first` is the
/// tab the picker opens on, whose pictures are taken first.
#[tauri::command]
pub async fn capture_share_targets(app: AppHandle, first: share::ShareTab) -> Result<share::ShareTargets> {
    let state = app.state::<AppState>();
    if !matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    }
    let token = state.capture.share_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<share::ShareMessage>();
    spawn_share_thread(&app, token, first, tx);

    let deadline = tokio::time::Instant::now() + share::INLINE_BUDGET;
    let (windows, displays) = match rx.recv().await {
        Some(share::ShareMessage::List(listed)) => listed?,
        _ => return Err(AppError::Other("Could not list the windows to share.".into())),
    };
    let mut targets = share::ShareTargets {
        token,
        windows,
        displays,
        pending: true,
    };
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(share::ShareMessage::Art(item))) => share::apply_art(&mut targets, item),
            Ok(Some(share::ShareMessage::FirstPassDone)) => {
                targets.pending = false;
                break;
            }
            Ok(Some(share::ShareMessage::List(_)) | None) | Err(_) => break,
        }
    }
    // Everything after the budget, refreshes included, streams to the picker.
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut batch = Vec::new();
        loop {
            // Pictures that arrive close together go as one batch.
            let next = if batch.is_empty() {
                rx.recv().await
            } else if let Ok(next) = tokio::time::timeout(std::time::Duration::from_millis(80), rx.recv()).await {
                next
            } else {
                flush_share_art(&emitter, token, &mut batch);
                continue;
            };
            match next {
                Some(share::ShareMessage::Art(item)) => batch.push(item),
                Some(_) => {}
                None => break,
            }
        }
        flush_share_art(&emitter, token, &mut batch);
    });
    Ok(targets)
}

fn flush_share_art(app: &AppHandle, token: u64, batch: &mut Vec<share::ShareArtItem>) {
    if batch.is_empty() {
        return;
    }
    let _ = app.emit(
        SHARE_ART_EVENT,
        share::ShareArt {
            token,
            items: std::mem::take(batch),
        },
    );
}

/// The picker closed: stop taking its pictures.
#[tauri::command]
pub fn capture_share_done(state: tauri::State<'_, AppState>, token: u64) {
    // Only this picker's run; a newer picker opened since keeps going.
    let _ = state
        .capture
        .share_seq
        .compare_exchange(token, token + 1, Ordering::SeqCst, Ordering::SeqCst);
}

/// The picture taking runs on its own thread: it is all blocking system calls,
/// and it outlives the command that started it (the refreshes).
#[cfg(any(target_os = "macos", windows))]
fn spawn_share_thread(app: &AppHandle, token: u64, first: share::ShareTab, tx: tokio::sync::mpsc::UnboundedSender<share::ShareMessage>) {
    let keep = app.clone();
    let icons_app = app.clone();
    let spawned = std::thread::Builder::new().name("capture-share".into()).spawn(move || {
        let keep_going = move || {
            let state = keep.state::<AppState>();
            state.capture.share_seq.load(Ordering::SeqCst) == token && matches!(state.capture.current(), CapturePhase::Selecting { .. })
        };
        let icons: share::IconSource = Box::new(move |pids: &[u32]| app_icons(&icons_app, pids));
        share::run(first, std::process::id(), &icons, &keep_going, &|m| tx.send(m).is_ok());
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "share picker pictures not started");
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn spawn_share_thread(_app: &AppHandle, _token: u64, _first: share::ShareTab, tx: tokio::sync::mpsc::UnboundedSender<share::ShareMessage>) {
    let _ = tx.send(share::ShareMessage::List(Err(AppError::Validation(
        "Screen capture isn't available on this system yet.".into(),
    ))));
}

/// App icons for the picker's tiles, read on the main thread (AppKit).
#[cfg(target_os = "macos")]
fn app_icons(app: &AppHandle, pids: &[u32]) -> std::collections::HashMap<u32, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let pids = pids.to_vec();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(share::macos_app_icons(&pids));
        })
        .is_err()
    {
        return std::collections::HashMap::new();
    }
    rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or_default()
}

#[cfg(windows)]
fn app_icons(_app: &AppHandle, _pids: &[u32]) -> std::collections::HashMap<u32, String> {
    std::collections::HashMap::new()
}

async fn select_inner(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let CapturePhase::Selecting { kind, .. } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    // The camera the recording keeps, whatever the options say later. Set
    // before the phase moves on, so the window is never closed in between.
    let camera_shape = match kind {
        CaptureKind::Recording => bar::load_options(state.pool()?).await?.camera_shape(kind),
        CaptureKind::Screenshot => None,
    };
    if let Ok(mut g) = state.capture.recording_camera.lock() {
        *g = camera_shape;
    }
    advance(app, &state.capture, CaptureEvent::Selected)?;
    if let Ok(mut g) = state.capture.pending.lock() {
        *g = None;
    }
    close_overlays(app);

    match kind {
        CaptureKind::Screenshot => finish_screenshot(app, selection).await,
        CaptureKind::Recording => begin_recording(app, selection).await,
    }
}

/// The pixels are read, the card opens with its picture, and only then is the
/// PNG written: the card no longer waits for an encode and a second decode.
async fn finish_screenshot(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let taken = take_screenshot(selection).await;
    restore_own_windows(app, &state.capture);
    let (image, thumbnail, path) = match taken {
        Ok(taken) => taken,
        Err(e) => return screenshot_failed(app, e),
    };
    let card_id = open_preview(app, CaptureKind::Screenshot, &path, thumbnail).await;

    let written = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || super::screenshot::save_png(&image, &path))
            .await
            .map_err(|e| AppError::Other(format!("capture task failed: {e}")))
            .and_then(|r| r)
    };
    if let Err(e) = written {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
        close_preview(app, &state.capture);
        return screenshot_failed(app, e);
    }
    advance(app, &state.capture, CaptureEvent::Captured)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
        let state = app.state::<AppState>();
        let _ = advance(&app, &state.capture, CaptureEvent::Finished);
    });
    Ok(())
}

async fn begin_recording(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let saved = bar::load_options(state.pool()?).await.unwrap_or_default();
    let options = RecordOptions {
        microphone: saved.microphone && recording::microphone_supported(),
        microphone_device: saved.microphone_device.clone(),
        show_clicks: saved.show_clicks && recording::show_clicks_supported(),
    };
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let name = super::naming::capture_file_name(CaptureKind::Recording, chrono::Local::now().naive_local());
    let path = dir.join(name);

    // The pill says "Starting recording…" straight after the countdown; the
    // recorder can take a second or two to begin.
    if let Err(e) = open_controls(app, true) {
        tracing::warn!(error = %e, "recording controls could not open");
    }

    // A still of the first frame, for the preview card once it is saved. Best
    // effort: a recording without a picture on its card is still a recording.
    // Taken in memory and alongside the recorder's start, so it adds nothing
    // to the wait before recording begins.
    let poster_task = tauri::async_runtime::spawn_blocking(move || {
        capture_blocking(selection)
            .ok()
            .and_then(|image| super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(image)).ok())
    });

    let started = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        let options = options.clone();
        move || recording::start(selection, &path, options)
    })
    .await
    .map_err(|e| AppError::Other(format!("recording task failed: {e}")))?;

    let poster = poster_task.await.ok().flatten();
    if let Ok(mut g) = state.capture.poster.lock() {
        *g = poster;
    }

    let recorder = match started {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            close_controls(app);
            end_camera(app).await;
            drop_unused_preview(app, &state.capture);
            restore_own_windows(app, &state.capture);
            let _ = advance(app, &state.capture, CaptureEvent::Failed);
            let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
            return Err(e);
        }
    };

    {
        let mut guard = state.capture.recorder.lock()?;
        *guard = Some(recorder);
    }
    advance(
        app,
        &state.capture,
        CaptureEvent::RecordingStarted {
            microphone: options.microphone,
        },
    )?;
    restore_own_windows(app, &state.capture);
    if let Err(e) = open_controls(app, true) {
        tracing::warn!(error = %e, "recording controls could not open");
    }
    spawn_tick_loop(app.clone());
    Ok(())
}

fn spawn_tick_loop(app: AppHandle) {
    let state = app.state::<AppState>();
    state.capture.stop_ticks();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    if let Ok(mut g) = state.capture.tick_cancel.lock() {
        *g = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = &mut rx => break,
                _ = interval.tick() => {
                    let state = app.state::<AppState>();
                    let (elapsed, died) = {
                        let Ok(guard) = state.capture.recorder.lock() else { continue };
                        match guard.as_ref() {
                            Some(r) => (r.elapsed_secs(), r.take_death()),
                            None => break,
                        }
                    };
                    // The recording ended on its own (display gone, helper
                    // crashed): end the session as Stop would, delivering
                    // what was saved, instead of counting on.
                    if let Some(e) = died {
                        tracing::warn!(error = %e, "recording ended on its own; saving what was recorded");
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<AppState>();
                            if let Err(e) = capture_stop(state, app.clone()).await {
                                tracing::warn!(error = %e, "could not save the recording that ended on its own");
                            }
                        });
                        break;
                    }
                    let phase = state.capture.current();
                    if !matches!(phase, CapturePhase::Recording { .. } | CapturePhase::Paused { .. }) {
                        break;
                    }
                    let _ = advance(&app, &state.capture, CaptureEvent::Tick { elapsed_secs: elapsed });
                }
            }
        }
    });
}

fn screenshot_failed(app: &AppHandle, e: AppError) -> Result<()> {
    let state = app.state::<AppState>();
    drop_unused_preview(app, &state.capture);
    let _ = advance(app, &state.capture, CaptureEvent::Failed);
    let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
    Err(e)
}

/// The screenshot in memory, its card picture, and where it will be written.
async fn take_screenshot(selection: Selection) -> Result<(image::RgbaImage, Option<String>, std::path::PathBuf)> {
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let name = super::naming::capture_file_name(CaptureKind::Screenshot, chrono::Local::now().naive_local());
    let path = dir.join(name);
    let taken = tauri::async_runtime::spawn_blocking(move || {
        let image = capture_blocking(selection)?;
        let thumbnail = super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(image.clone())).ok();
        Ok::<_, AppError>((image, thumbnail))
    })
    .await
    .map_err(|e| AppError::Other(format!("capture task failed: {e}")))
    .and_then(|r| r);
    match taken {
        Ok((image, thumbnail)) => Ok((image, thumbnail, path)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn capture_blocking(selection: Selection) -> Result<image::RgbaImage> {
    super::screenshot::capture_image(selection)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn capture_blocking(_selection: Selection) -> Result<image::RgbaImage> {
    Err(AppError::Validation("Screen capture isn't available on this system yet.".into()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    message: String,
}

/// Upload the capture and mint its link, then say how it went: on the preview
/// card when one is showing (`card_id`), and as a system notification only
/// when the upload failed, since the card already shows a success.
async fn deliver_and_announce(app: &AppHandle, path: &std::path::Path, card_id: Option<u64>) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<AppState>();
    let outcome = async {
        let account_id = state.current_account_id()?;
        let destination = destination::load(state.pool()?, &account_id)
            .await?
            .ok_or(AppError::NotReady(NotReadyKind::CaptureDestinationUnset))?;
        super::deliver::deliver(&state, app.clone(), &account_id, &destination, path).await
    }
    .await;

    match &outcome {
        Ok(delivered) => {
            let mut copied = false;
            if let Some(url) = &delivered.share_url {
                if let Err(e) = app.clipboard().write_text(url.clone()) {
                    tracing::warn!(error = %e, "capture link minted but not copied");
                } else {
                    copied = true;
                }
            }
            // The upload landed, so the plaintext copy has served its purpose.
            if let Some(dir) = path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = app.emit(DELIVERED_EVENT, delivered);
            let status = if delivered.via_sync {
                PreviewStatus::Syncing {
                    link_copied: copied,
                    link_error: delivered.link_error.clone(),
                }
            } else {
                PreviewStatus::Uploaded {
                    link_copied: copied,
                    link_error: delivered.link_error.clone(),
                }
            };
            let shown = card_id.is_some_and(|id| {
                set_preview_outcome(
                    app,
                    &state.capture,
                    id,
                    status,
                    delivered.share_url.clone(),
                    Some(delivered.file_name.clone()),
                )
            });
            if !shown {
                let (title, body) = super::deliver::delivered_notice(delivered);
                notify(app, title, body);
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "capture could not be delivered; kept on disk");
            let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
            if let Some(id) = card_id {
                set_preview_outcome(app, &state.capture, id, PreviewStatus::Failed { message: e.to_string() }, None, None);
            }
            let (title, body) = super::deliver::failed_notice(e, path);
            notify(app, title, body);
        }
    }

    fn notify(app: &AppHandle, title: String, body: String) {
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            tracing::warn!(error = %e, "capture notification not shown");
        }
    }
}

#[tauri::command]
pub async fn capture_pause(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    {
        let mut guard = state.capture.recorder.lock()?;
        let recorder = guard
            .as_mut()
            .ok_or_else(|| AppError::Validation("No recording is in progress.".into()))?;
        recorder.pause()?;
    }
    advance(&app, &state.capture, CaptureEvent::Pause)?;
    Ok(())
}

#[tauri::command]
pub async fn capture_resume(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    {
        let mut guard = state.capture.recorder.lock()?;
        let recorder = guard
            .as_mut()
            .ok_or_else(|| AppError::Validation("No recording is in progress.".into()))?;
        recorder.resume()?;
    }
    advance(&app, &state.capture, CaptureEvent::Resume)?;
    Ok(())
}

#[tauri::command]
pub async fn capture_stop(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    state.capture.stop_ticks();
    advance(&app, &state.capture, CaptureEvent::Stop)?;
    close_controls(&app);
    end_camera(&app).await;

    let recorder = state
        .capture
        .take_recorder()
        .ok_or_else(|| AppError::Validation("No recording is in progress.".into()))?;

    let stopped = tauri::async_runtime::spawn_blocking(move || recorder.stop())
        .await
        .map_err(|e| AppError::Other(format!("stop task failed: {e}")))?;

    let path = match stopped {
        Ok(path) => path,
        Err(e) => {
            let _ = advance(&app, &state.capture, CaptureEvent::Failed);
            let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
            return Err(e);
        }
    };
    advance(&app, &state.capture, CaptureEvent::Captured)?;

    let poster = state.capture.poster.lock().ok().and_then(|mut g| g.take());
    let card_id = open_preview(&app, CaptureKind::Recording, &path, poster).await;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
        let state = app.state::<AppState>();
        let _ = advance(&app, &state.capture, CaptureEvent::Finished);
    });
    Ok(())
}

#[tauri::command]
pub async fn capture_cancel(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    state.capture.stop_ticks();
    close_overlays(&app);
    close_controls(&app);
    if let Some(recorder) = state.capture.take_recorder() {
        let _ = tauri::async_runtime::spawn_blocking(move || recorder.cancel()).await;
    }
    drop_unused_preview(&app, &state.capture);
    restore_own_windows(&app, &state.capture);
    let cancelled = advance(&app, &state.capture, CaptureEvent::Cancel);
    end_camera(&app).await;
    match cancelled {
        Ok(_) => Ok(()),
        // Escape can arrive from more than one overlay; the second finds the
        // session already idle, which is what it asked for.
        Err(_) if state.capture.current() == CapturePhase::Idle => Ok(()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn capture_state(state: tauri::State<'_, AppState>) -> CapturePhase {
    state.capture.current()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSupport {
    pub supported: bool,
    /// Whether Record actions should be offered (helper present + OS floor).
    pub recording: bool,
    pub screen_recording_permission: bool,
}

#[tauri::command]
pub fn capture_support() -> CaptureSupport {
    CaptureSupport {
        supported: CAPTURE_SUPPORTED,
        recording: recording::recording_supported(),
        screen_recording_permission: super::permissions::screen_capture_granted(),
    }
}

#[tauri::command]
pub fn capture_open_permission_settings(app: AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(super::permissions::SCREEN_RECORDING_SETTINGS_URL, None::<&str>)
        .map_err(|e| AppError::Other(format!("Could not open System Settings: {e}")))
}

#[tauri::command]
pub async fn capture_get_destination(state: tauri::State<'_, AppState>) -> Result<Option<CaptureDestination>> {
    let account_id = state.current_account_id()?;
    destination::load(state.pool()?, &account_id).await
}

#[tauri::command]
pub async fn capture_set_destination(state: tauri::State<'_, AppState>, destination: CaptureDestination) -> Result<()> {
    let account_id = state.current_account_id()?;
    destination::save(state.pool()?, &account_id, &destination).await
}

// ── The preview card ────────────────────────────────────────────────────────

/// Show the card for a capture that is about to upload. Returns its id, or
/// `None` when the card could not be opened (the notification covers it).
async fn open_preview(app: &AppHandle, kind: CaptureKind, path: &std::path::Path, thumbnail: Option<String>) -> Option<u64> {
    let state = app.state::<AppState>();
    let account_id = state.current_account_id().ok()?;
    let pool = state.pool().ok()?;
    let destination = destination::load(pool, &account_id).await.ok().flatten()?;
    let remote = !destination::is_local(pool, &account_id, &destination.label).await;
    let file_name = path.file_name()?.to_str()?.to_string();

    let id = state.capture.preview_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let card = PreviewCard {
        id,
        kind,
        file_name,
        drive_label: destination.label.clone(),
        drive_name: destination.display_name.clone(),
        remote,
        thumbnail,
        status: PreviewStatus::Uploading,
        share_url: None,
        file_path: path.to_path_buf(),
    };
    if let Ok(mut g) = state.capture.preview.lock() {
        *g = Some(card.clone());
    }
    let display = state.capture.bar_display.lock().ok().and_then(|g| g.clone());
    if let Err(e) = open_preview_window(app, display.as_ref()) {
        tracing::warn!(error = %e, "capture preview card could not open");
        return None;
    }
    let _ = app.emit(PREVIEW_EVENT, Some(&card));
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        show_without_focus(&w);
    }
    Some(id)
}

/// Record how card `id`'s upload went, if it is still the card on screen.
/// Returns whether it was.
fn set_preview_outcome(
    app: &AppHandle,
    state: &CaptureState,
    id: u64,
    status: PreviewStatus,
    share_url: Option<String>,
    file_name: Option<String>,
) -> bool {
    let updated = {
        let Ok(mut g) = state.preview.lock() else { return false };
        let Some(mut next) = g.as_ref().and_then(|c| c.with_outcome(id, status, share_url)) else {
            return false;
        };
        // A capture moved into a synced folder may have been renamed
        // ("Shot (2).png"); the card follows the name the sync engine sees.
        if let Some(name) = file_name {
            next.file_name = name;
        }
        *g = Some(next.clone());
        next
    };
    let _ = app.emit(PREVIEW_EVENT, Some(&updated));
    app.get_webview_window(PREVIEW_LABEL).is_some()
}

/// Close the card's window if it was only prepared (no capture was taken).
fn drop_unused_preview(app: &AppHandle, state: &CaptureState) {
    let showing = state.preview.lock().is_ok_and(|g| g.is_some());
    if !showing && let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
}

fn close_preview(app: &AppHandle, state: &CaptureState) {
    if let Ok(mut g) = state.preview.lock() {
        *g = None;
    }
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
}

/// The card's window in the bottom-right corner of `display` (the one the
/// capture bar was on), inside its usable area so the Dock never covers it.
/// Built hidden when a capture starts; `open_preview` shows it.
fn open_preview_window(app: &AppHandle, display: Option<&DisplayTarget>) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if app.get_webview_window(PREVIEW_LABEL).is_some() {
        return Ok(());
    }
    let route = if cfg!(dev) { "capture-preview" } else { "capture-preview.html" };
    let mut builder = WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App(route.into()))
        .title("Hippius capture")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // Out of any later screenshot or recording, like the bar itself.
        .content_protected(true)
        // A card is information, not a dialog: typing carries on in the app
        // the user was in.
        .focused(false)
        // Without this the card's first click only brings Hippius forward
        // (the card is never the key window), so Show in folder and Copy
        // link looked dead: every button needed a second click.
        .accept_first_mouse(true)
        .visible(false)
        .inner_size(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    if let Some(d) = display {
        let area = work_area(app, d);
        builder = builder.position(
            area.x + area.width - PREVIEW_WIDTH - PREVIEW_MARGIN,
            area.y + area.height - PREVIEW_HEIGHT - PREVIEW_MARGIN,
        );
    }
    builder
        .build()
        .map_err(|e| AppError::Other(format!("Could not open the capture preview: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn capture_preview_context(state: tauri::State<'_, AppState>) -> Option<PreviewCard> {
    state.capture.preview.lock().ok().and_then(|g| g.clone())
}

/// Copy link on the card: the link minted for this capture, again.
#[tauri::command]
pub fn capture_preview_copy_link(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let url = state
        .capture
        .preview
        .lock()?
        .as_ref()
        .and_then(|c| c.share_url.clone())
        .ok_or_else(|| AppError::Validation("This capture has no link yet.".into()))?;
    app.clipboard()
        .write_text(url)
        .map_err(|e| AppError::Other(format!("Could not copy the link: {e}")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShowInFolderPayload {
    label: String,
    remote: bool,
    subfolder: String,
    file_name: String,
}

/// Show in folder: bring Hippius forward on the drive's Captures folder.
#[tauri::command]
pub fn capture_preview_show_in_folder(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card = state
        .capture
        .preview
        .lock()?
        .clone()
        .ok_or_else(|| AppError::Validation("There is no capture to show.".into()))?;
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit(
        SHOW_IN_FOLDER_EVENT,
        ShowInFolderPayload {
            label: card.drive_label,
            remote: card.remote,
            subfolder: super::naming::CAPTURES_FOLDER.to_string(),
            file_name: card.file_name,
        },
    );
    close_preview(&app, &state.capture);
    Ok(())
}

/// The card closed itself (its timer, or ×). Only card `id`: a newer card that
/// opened in the meantime stays.
#[tauri::command]
pub fn capture_preview_dismiss(state: tauri::State<'_, AppState>, app: AppHandle, id: u64) {
    let current = state.capture.preview.lock().ok().and_then(|g| g.as_ref().map(|c| c.id));
    if current == Some(id) {
        close_preview(&app, &state.capture);
    }
}

/// Retry on a card whose upload failed: the same file, the same way.
#[tauri::command]
pub fn capture_preview_retry(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card = {
        let mut g = state.capture.preview.lock()?;
        let card = g
            .as_ref()
            .filter(|c| c.can_retry())
            .cloned()
            .ok_or_else(|| AppError::Validation("There is nothing to retry.".into()))?;
        let uploading = PreviewCard {
            status: PreviewStatus::Uploading,
            ..card
        };
        *g = Some(uploading.clone());
        uploading
    };
    let _ = app.emit(PREVIEW_EVENT, Some(&card));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &card.file_path, Some(card.id)).await;
    });
    Ok(())
}

// ── The system-wide shortcut ────────────────────────────────────────────────

/// Register the saved shortcut. Called when the signed-in app mounts; a
/// shortcut another app took since is logged, not raised, so start-up never
/// fails over it (Settings says so when the user looks).
#[tauri::command]
pub async fn capture_sync_shortcut(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let accelerator = shortcut::load(state.pool()?).await?;
    if let Err(e) = shortcut::apply(&app, accelerator.as_deref()) {
        tracing::warn!(error = %e, "capture shortcut not registered");
    }
    Ok(())
}

#[tauri::command]
pub async fn capture_get_shortcut(state: tauri::State<'_, AppState>) -> Result<ShortcutSetting> {
    Ok(ShortcutSetting {
        accelerator: shortcut::load(state.pool()?).await?,
        default_accelerator: shortcut::DEFAULT_SHORTCUT.to_string(),
    })
}

/// Change the shortcut (`None` turns it off). Registered before it is saved,
/// so a shortcut another app holds is refused and the old one stays.
#[tauri::command]
pub async fn capture_set_shortcut(state: tauri::State<'_, AppState>, app: AppHandle, accelerator: Option<String>) -> Result<()> {
    let pool = state.pool()?;
    let previous = shortcut::load(pool).await?;
    let next = accelerator.as_deref().map(str::trim).filter(|a| !a.is_empty());
    if let Err(e) = shortcut::apply(&app, next) {
        let _ = shortcut::apply(&app, previous.as_deref());
        return Err(e);
    }
    shortcut::save(pool, next).await
}

// ---------------------------------------------------------------------------
// The camera window (`camera.rs` decides; this opens, moves and closes it).
// ---------------------------------------------------------------------------

/// Put the camera window in the shape the session wants now, or take it away,
/// and tell the camera page and the pill. Called after everything that can
/// change it: start, mode, options, Record, the pill's toggle, stop, cancel.
async fn sync_camera(app: &AppHandle) {
    let state = app.state::<AppState>();
    let options = match state.pool() {
        Ok(pool) => bar::load_options(pool).await.unwrap_or_default(),
        Err(_) => CaptureOptions::default(),
    };
    let recording = state.capture.recording_camera.lock().ok().and_then(|g| *g);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    let wanted = camera::wanted_shape(state.capture.current(), &options, recording, hidden);
    let previous = state
        .capture
        .camera_shape
        .lock()
        .ok()
        .and_then(|mut g| std::mem::replace(&mut *g, wanted));

    match (wanted, app.get_webview_window(CAMERA_LABEL)) {
        (None, Some(window)) => {
            let _ = window.close();
        }
        (None, None) => {}
        (Some(shape), Some(window)) => {
            if previous != Some(shape) {
                place_camera(app, &window, shape, options.camera_size);
            }
            show_without_focus(&window);
        }
        (Some(shape), None) => {
            if let Err(e) = open_camera_window(app, shape, options.camera_size) {
                tracing::warn!(error = %e, "camera window could not open");
            }
        }
    }
    if wanted.is_none()
        && let Ok(mut g) = state.capture.bubble_frame.lock()
    {
        *g = None;
    }
    let camera_state = camera_state_for(app, wanted, hidden, &options).await;
    let _ = app.emit(CAMERA_STATE_EVENT, camera_state);
}

/// What the camera page and the pill are told: the shape, and the chosen
/// camera by id AND name (the webview finds a platform-listed camera by name).
async fn camera_state_for(app: &AppHandle, shape: Option<CameraShape>, hidden: bool, options: &CaptureOptions) -> CameraState {
    let device_name = match &options.camera_device {
        Some(id) => camera_name(app, id).await,
        None => None,
    };
    CameraState {
        shape,
        hidden,
        device_id: options.camera_device.clone(),
        device_name,
        size: options.camera_size,
    }
}

/// The name of camera `id`, from the lists already read, else from the
/// system (once: the list is kept).
async fn camera_name(app: &AppHandle, id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let known = |list: &Mutex<Vec<CameraDevice>>| list.lock().ok().and_then(|g| g.iter().find(|c| c.id == id).map(|c| c.name.clone()));
    if let Some(name) = known(&state.capture.native_cameras).or_else(|| known(&state.capture.cameras)) {
        return Some(name);
    }
    let listed = refresh_native_cameras(app).await;
    listed.into_iter().find(|c| c.id == id).map(|c| c.name)
}

/// Read the system's cameras again and keep the list.
async fn refresh_native_cameras(app: &AppHandle) -> Vec<CameraDevice> {
    let listed = tauri::async_runtime::spawn_blocking(recording::list_cameras).await.unwrap_or_default();
    if let Ok(mut g) = app.state::<AppState>().capture.native_cameras.lock() {
        g.clone_from(&listed);
    }
    listed
}

/// The recording is over (stopped, cancelled or failed): forget its camera.
async fn end_camera(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut g) = state.capture.recording_camera.lock() {
        *g = None;
    }
    state.capture.camera_hidden.store(false, Ordering::SeqCst);
    sync_camera(app).await;
}

fn bar_work_area(app: &AppHandle) -> Option<camera::Frame> {
    let display = app.state::<AppState>().capture.bar_display.lock().ok().and_then(|g| g.clone())?;
    let area = work_area(app, &display);
    Some(camera::Frame {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    })
}

fn camera_frame(app: &AppHandle, shape: CameraShape, size: CameraSize) -> Option<camera::Frame> {
    Some(camera::frame(shape, size, bar_work_area(app)?))
}

fn place_camera(app: &AppHandle, window: &tauri::WebviewWindow, shape: CameraShape, size: CameraSize) {
    if let Some(f) = camera_frame(app, shape, size) {
        set_camera_frame(window, f, false);
    }
}

/// Move and size the camera window in one step. On macOS `animate` lets AppKit
/// glide it there (`-[NSWindow setFrame:display:animate:]`), which is smoother
/// than any series of moves from here; elsewhere it jumps, and the page's own
/// fade covers it.
fn set_camera_frame(window: &tauri::WebviewWindow, f: camera::Frame, animate: bool) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::foundation::{NSPoint, NSRect, NSSize};
        use objc::{class, msg_send, sel, sel_impl};

        let target = window.clone();
        let hopped = window.run_on_main_thread(move || {
            let Ok(ns_window) = target.ns_window() else { return };
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: this window's live NSWindow and the screen list, both
            // touched on the main thread; `screens` is checked before use.
            unsafe {
                let screens: cocoa::base::id = msg_send![class!(NSScreen), screens];
                let count: usize = if screens.is_null() { 0 } else { msg_send![screens, count] };
                if count == 0 {
                    return;
                }
                let primary: cocoa::base::id = msg_send![screens, objectAtIndex: 0usize];
                let primary_frame: NSRect = msg_send![primary, frame];
                // AppKit's origin is the primary display's bottom-left, y up.
                let rect = NSRect::new(
                    NSPoint::new(f.x, primary_frame.size.height - (f.y + f.height)),
                    NSSize::new(f.width, f.height),
                );
                let animate = if animate { objc::runtime::YES } else { objc::runtime::NO };
                let () = msg_send![ns_window, setFrame: rect display: objc::runtime::YES animate: animate];
            }
        });
        if hopped.is_err() {
            let _ = window.set_size(tauri::LogicalSize::new(f.width, f.height));
            let _ = window.set_position(tauri::LogicalPosition::new(f.x, f.y));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = animate;
        let _ = window.set_size(tauri::LogicalSize::new(f.width, f.height));
        let _ = window.set_position(tauri::LogicalPosition::new(f.x, f.y));
    }
}

/// The camera window's frame now, in logical points (it may have been dragged).
fn current_camera_frame(window: &tauri::WebviewWindow) -> Option<camera::Frame> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    Some(camera::Frame {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

fn open_camera_window(app: &AppHandle, shape: CameraShape, size: CameraSize) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let route = if cfg!(dev) { "capture-camera" } else { "capture-camera.html" };
    let mut builder = WebviewWindowBuilder::new(app, CAMERA_LABEL, WebviewUrl::App(route.into()))
        .title("Hippius camera")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // Filmed on purpose: the camera is part of the recording. Every other
        // capture window is protected; this one must never be.
        .content_protected(false)
        .focused(false)
        // The first click drags the bubble instead of only focusing it.
        .accept_first_mouse(true)
        .visible(false);
    if let Some(f) = camera_frame(app, shape, size) {
        builder = builder.inner_size(f.width, f.height).position(f.x, f.y);
    }
    let window = builder.build().map_err(|e| AppError::Other(format!("Could not open the camera: {e}")))?;
    raise_camera(&window);
    show_without_focus(&window);
    spawn_camera_hover_watch(app.clone());
    Ok(())
}

/// Tell the camera page when the pointer is over it, so its size controls
/// show on hover and are gone otherwise (the window is filmed). AppKit does
/// not reliably deliver hover to a webview whose window is not the key window,
/// and the camera never is, so this asks where the pointer is instead. Runs
/// while the camera window exists.
#[cfg(target_os = "macos")]
fn spawn_camera_hover_watch(app: AppHandle) {
    use cocoa::foundation::NSPoint;
    use objc::{class, msg_send, sel, sel_impl};

    tauri::async_runtime::spawn(async move {
        let primary_height = tauri::async_runtime::spawn_blocking(list_displays_blocking)
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .and_then(|d| d.iter().find(|d| d.is_primary).or_else(|| d.first()).map(|d| f64::from(d.height)));
        let Some(primary_height) = primary_height else { return };
        let state = app.state::<AppState>();
        // One watch at a time: a camera window reopened while an older watch
        // is still between ticks retires that one.
        let generation = state.capture.camera_watch.fetch_add(1, Ordering::SeqCst) + 1;
        state.capture.camera_hover.store(false, Ordering::SeqCst);
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(120));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if state.capture.camera_watch.load(Ordering::SeqCst) != generation {
                break;
            }
            let Some(window) = app.get_webview_window(CAMERA_LABEL) else { break };
            let Some(frame) = current_camera_frame(&window) else { continue };
            // SAFETY: a class method that only reads the pointer position.
            let p: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
            let over = frame.contains(p.x, primary_height - p.y);
            if state.capture.camera_hover.swap(over, Ordering::SeqCst) != over {
                let _ = app.emit_to(CAMERA_LABEL, CAMERA_HOVER_EVENT, over);
            }
        }
    });
}

/// Elsewhere the webview's own hover events are enough.
#[cfg(not(target_os = "macos"))]
fn spawn_camera_hover_watch(_app: AppHandle) {}

/// The camera window's system window number, which is what a window
/// recording is started with. Camera-only recordings record the stage.
#[cfg(target_os = "macos")]
fn camera_window_id(app: &AppHandle) -> Option<u32> {
    use objc::{msg_send, sel, sel_impl};

    let window = app.get_webview_window(CAMERA_LABEL)?;
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let number = target.ns_window().ok().map(|ns_window| {
                let ns_window = ns_window.cast::<objc::runtime::Object>();
                // SAFETY: `ns_window` is this window's live NSWindow, read on
                // the main thread; `windowNumber` only returns an integer.
                let n: isize = unsafe { msg_send![ns_window, windowNumber] };
                n
            });
            let _ = tx.send(number);
        })
        .ok()?;
    let number = rx.recv_timeout(std::time::Duration::from_millis(500)).ok().flatten()?;
    u32::try_from(number).ok().filter(|n| *n > 0)
}

#[cfg(not(target_os = "macos"))]
fn camera_window_id(_app: &AppHandle) -> Option<u32> {
    None
}

/// The camera page's first read: the shape to draw and the device to open.
#[tauri::command]
pub async fn capture_camera_context(app: AppHandle) -> Result<CameraState> {
    let state = app.state::<AppState>();
    let options = bar::load_options(state.pool()?).await?;
    let shape = state.capture.camera_shape.lock().ok().and_then(|g| *g);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    Ok(camera_state_for(&app, shape, hidden, &options).await)
}

/// The camera page found these cameras (its own `deviceId`s). The bar lists
/// them only where the system list is empty (see [`camera_list`]).
#[tauri::command]
pub fn capture_set_cameras(state: tauri::State<'_, AppState>, app: AppHandle, cameras: Vec<CameraDevice>) {
    let cameras = recording::tidy_devices(cameras);
    let native = state.capture.native_cameras.lock().map(|g| g.clone()).unwrap_or_default();
    if let Ok(mut g) = state.capture.cameras.lock() {
        if *g == cameras {
            return;
        }
        g.clone_from(&cameras);
    }
    let _ = app.emit(CAMERAS_EVENT, camera_list(native, cameras));
}

/// The cameras the bar offers: the system's list when it has one (it exists
/// before any camera has been opened, and names every camera), else what the
/// camera window reported. Never a mix: the two use different ids for the
/// same camera, and the menu would list it twice.
#[must_use]
pub fn camera_list(native: Vec<CameraDevice>, webview: Vec<CameraDevice>) -> Vec<CameraDevice> {
    if native.is_empty() { webview } else { native }
}

/// The cameras the bar offers, read afresh (the bar asks each time its camera
/// menu opens, so a camera plugged in since shows up).
#[tauri::command]
pub async fn capture_cameras(app: AppHandle) -> Vec<CameraDevice> {
    let native = refresh_native_cameras(&app).await;
    let webview = app.state::<AppState>().capture.cameras.lock().map(|g| g.clone()).unwrap_or_default();
    camera_list(native, webview)
}

/// The bubble's size strip: small, large or full. Saved with the options (so
/// the next recording opens at the same size), and the window glides to its
/// new frame, anchored where the user put it.
#[tauri::command]
pub async fn capture_camera_set_size(app: AppHandle, size: CameraSize) -> Result<CameraSize> {
    let state = app.state::<AppState>();
    let pool = state.pool()?;
    let mut options = bar::load_options(pool).await?;
    let previous = options.camera_size;
    options.camera_size = size;
    bar::save_options(pool, options.clone()).await?;
    // The bar holds a copy of the options and saves it whole on its next
    // change; it must not write the old size back.
    let _ = app.emit(OPTIONS_EVENT, options.clone().normalized());

    let shape = state.capture.camera_shape.lock().ok().and_then(|g| *g);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    // The page restyles (round / 16:9) as the window starts to move.
    let camera_state = camera_state_for(&app, shape, hidden, &options).await;
    let _ = app.emit(CAMERA_STATE_EVENT, camera_state);

    // Only a bubble changes size; the camera-only stage is the recording.
    if shape != Some(CameraShape::Bubble) || previous == size {
        return Ok(size);
    }
    let (Some(window), Some(area)) = (app.get_webview_window(CAMERA_LABEL), bar_work_area(&app)) else {
        return Ok(size);
    };
    let current = current_camera_frame(&window);
    let target = match camera::bubble_side(size) {
        None => {
            // Going full: remember where the bubble was, to go back there.
            if previous != CameraSize::Full
                && let Ok(mut g) = state.capture.bubble_frame.lock()
            {
                *g = current;
            }
            camera::frame(CameraShape::Bubble, size, area)
        }
        Some(side) => {
            let from = if previous == CameraSize::Full {
                state.capture.bubble_frame.lock().ok().and_then(|g| *g)
            } else {
                current
            };
            match from {
                Some(from) => camera::resize_bubble(from, side, area),
                None => camera::frame(CameraShape::Bubble, size, area),
            }
        }
    };
    set_camera_frame(&window, target, true);
    Ok(size)
}

/// The × on the bubble's strip. While choosing it turns the camera off (the
/// choice the bar's camera menu would make); mid-recording it hides the
/// bubble, as the pill's camera button does, and the recording carries on.
#[tauri::command]
pub async fn capture_camera_dismiss(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    match state.capture.current() {
        CapturePhase::Selecting { .. } => {
            let pool = state.pool()?;
            let options = bar::load_options(pool).await?;
            if !options.screen {
                return Err(AppError::Validation("Camera only records the camera; turn the screen on first.".into()));
            }
            let options = CaptureOptions { camera: false, ..options };
            bar::save_options(pool, options.clone()).await?;
            let _ = app.emit(OPTIONS_EVENT, options.normalized());
        }
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } => {
            let recording = state.capture.recording_camera.lock().ok().and_then(|g| *g);
            if recording != Some(CameraShape::Bubble) {
                return Err(AppError::Validation("This recording has no camera bubble to hide.".into()));
            }
            state.capture.camera_hidden.store(true, Ordering::SeqCst);
        }
        _ => return Ok(()),
    }
    sync_camera(&app).await;
    Ok(())
}

/// The microphones the bar's picker offers. Lists through the recording
/// helper, so it is empty where recording with a microphone is not available.
#[tauri::command]
pub async fn capture_microphones() -> Vec<Microphone> {
    if !recording::microphone_supported() {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(recording::list_microphones)
        .await
        .unwrap_or_default()
}

/// The pill's camera button: hide or show the bubble mid-recording, returning
/// whether it is showing now. The
/// camera-only stage is the recording itself, so it cannot be hidden.
#[tauri::command]
pub async fn capture_camera_toggle(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool> {
    let recording = state.capture.recording_camera.lock().ok().and_then(|g| *g);
    if recording != Some(CameraShape::Bubble) {
        return Err(AppError::Validation("This recording has no camera bubble to hide.".into()));
    }
    let was_hidden = state.capture.camera_hidden.fetch_xor(true, Ordering::SeqCst);
    sync_camera(&app).await;
    // Whether the bubble is on screen now.
    Ok(was_hidden)
}
