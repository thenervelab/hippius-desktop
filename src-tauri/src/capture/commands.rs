//! The capture IPCs and the session that ties them together.
//!
//! Flow: `capture_start` opens one transparent overlay per display →
//! the overlay calls `capture_select` (or `capture_cancel`) → the screenshot
//! is taken, the main window comes back, and delivery runs in the background
//! → `capture_delivered` / `capture_failed`. Every phase change is broadcast
//! as `capture_state_changed`, which is the only thing the surfaces read.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::destination::{self, CaptureDestination};
use super::screenshot::Selection;
use super::session::{CaptureEvent, CaptureKind, CaptureMode, CapturePhase, TransitionError, transition};
use super::targets::{DisplayTarget, WindowTarget};
use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};

pub const STATE_CHANGED_EVENT: &str = "capture_state_changed";
pub const DELIVERED_EVENT: &str = "capture_delivered";
pub const FAILED_EVENT: &str = "capture_failed";

/// Overlay windows are labelled `capture-overlay-<display id>`, which is also
/// the glob the overlay's capability file grants.
pub const OVERLAY_LABEL_PREFIX: &str = "capture-overlay-";

const MAIN_WINDOW_LABEL: &str = "main";

/// Whether this build can capture at all. Linux screenshots go through the
/// desktop portal in a follow-up, so the surfaces hide themselves there.
pub const CAPTURE_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

#[derive(Default)]
pub struct CaptureState {
    phase: Mutex<Option<CapturePhase>>,
    /// Whether the main window was on screen when the capture started, so it
    /// comes back only if it was there to begin with.
    restore_main: AtomicBool,
}

impl CaptureState {
    fn current(&self) -> CapturePhase {
        self.phase.lock().map_or(CapturePhase::Idle, |p| p.unwrap_or(CapturePhase::Idle))
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

/// Start a capture: check it can happen, then put an overlay on every display.
///
/// Refusals are structured so the UI can answer each one:
/// `NotReady(CaptureDestinationUnset)` → the drive picker,
/// `NotReady(ScreenRecordingPermission)` → the permission explainer.
/// A capture already in progress is brought forward, not refused.
#[tauri::command]
pub async fn capture_start(state: tauri::State<'_, AppState>, app: AppHandle, kind: CaptureKind, mode: CaptureMode) -> Result<()> {
    if !CAPTURE_SUPPORTED {
        return Err(AppError::Validation("Screen capture isn't available on this system yet.".into()));
    }
    if kind == CaptureKind::Recording {
        return Err(AppError::Validation("Screen recording is coming in a later update.".into()));
    }
    let account_id = state.current_account_id()?;
    if destination::load(state.pool()?, &account_id).await?.is_none() {
        return Err(AppError::NotReady(NotReadyKind::CaptureDestinationUnset));
    }
    if !super::permissions::screen_capture_granted() {
        // Shows the system prompt the first time; after that it only reports.
        super::permissions::request_screen_capture();
        return Err(AppError::NotReady(NotReadyKind::ScreenRecordingPermission));
    }

    match advance(&app, &state.capture, CaptureEvent::Start { kind, mode }) {
        Ok(_) => {}
        Err(_) if state.capture.current() != CapturePhase::Idle => {
            focus_overlays(&app);
            return Ok(());
        }
        Err(e) => return Err(e),
    }

    hide_own_windows(&app, &state.capture);
    let opened = open_capture_ui(&app, mode).await;
    if let Err(e) = opened {
        close_overlays(&app);
        restore_own_windows(&app, &state.capture);
        let _ = advance(&app, &state.capture, CaptureEvent::Failed);
        return Err(e);
    }
    Ok(())
}

/// Put up the overlays — or, for a whole screen on a single display, skip
/// the choice nobody needs to make and capture straight away.
async fn open_capture_ui(app: &AppHandle, mode: CaptureMode) -> Result<()> {
    let displays = tauri::async_runtime::spawn_blocking(list_displays_blocking)
        .await
        .map_err(|e| AppError::Other(format!("display listing task failed: {e}")))??;
    if displays.is_empty() {
        return Err(AppError::Other("No display to capture.".into()));
    }
    if mode == CaptureMode::Screen && displays.len() == 1 {
        return select_inner(app, Selection::Screen { display_id: displays[0].id }).await;
    }
    for display in &displays {
        open_overlay(app, display)?;
    }
    Ok(())
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

/// Tauri's always-on-top level sits BELOW the macOS menu bar, which would
/// leave the overlay stopping short of the top of the screen and the menu bar
/// impossible to select. Raise it to the screen-saver level.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};
    // NSScreenSaverWindowLevel.
    const LEVEL: i64 = 1000;
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = target.ns_window() {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: `ns_window` is this window's live NSWindow, and AppKit
            // is only touched here, on the main thread.
            let () = unsafe { msg_send![ns_window, setLevel: LEVEL] };
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

/// What an overlay needs to draw itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContext {
    pub mode: CaptureMode,
    pub display_id: u32,
    /// Pickable windows on this display, front first — only in window mode.
    pub windows: Vec<WindowTarget>,
}

#[tauri::command]
pub async fn capture_overlay_context(state: tauri::State<'_, AppState>, display_id: u32) -> Result<OverlayContext> {
    let CapturePhase::Selecting { mode, .. } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    let windows = if mode == CaptureMode::Window {
        tauri::async_runtime::spawn_blocking(move || windows_on_display_blocking(display_id))
            .await
            .map_err(|e| AppError::Other(format!("window listing task failed: {e}")))??
    } else {
        Vec::new()
    };
    Ok(OverlayContext { mode, display_id, windows })
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

async fn select_inner(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    advance(app, &state.capture, CaptureEvent::Selected)?;
    close_overlays(app);

    let taken = take_screenshot(selection).await;
    restore_own_windows(app, &state.capture);
    let path = match taken {
        Ok(path) => path,
        Err(e) => {
            let _ = advance(app, &state.capture, CaptureEvent::Failed);
            let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
            return Err(e);
        }
    };
    advance(app, &state.capture, CaptureEvent::Captured)?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path).await;
        let state = app.state::<AppState>();
        let _ = advance(&app, &state.capture, CaptureEvent::Finished);
    });
    Ok(())
}

async fn take_screenshot(selection: Selection) -> Result<std::path::PathBuf> {
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let name = super::naming::capture_file_name(CaptureKind::Screenshot, chrono::Local::now().naive_local());
    let path = dir.join(name);
    let dest = path.clone();
    let written = tauri::async_runtime::spawn_blocking(move || capture_blocking(selection, &dest))
        .await
        .map_err(|e| AppError::Other(format!("capture task failed: {e}")))?;
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(path)
}

#[cfg(any(target_os = "macos", windows))]
fn capture_blocking(selection: Selection, dest: &std::path::Path) -> Result<()> {
    super::screenshot::capture_to_png(selection, dest)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn capture_blocking(_selection: Selection, _dest: &std::path::Path) -> Result<()> {
    Err(AppError::Validation("Screen capture isn't available on this system yet.".into()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    message: String,
}

async fn deliver_and_announce(app: &AppHandle, path: &std::path::Path) {
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

    let (title, body) = match &outcome {
        Ok(delivered) => {
            if let Some(url) = &delivered.share_url
                && let Err(e) = app.clipboard().write_text(url.clone())
            {
                tracing::warn!(error = %e, "capture link minted but not copied");
            }
            // The upload landed, so the plaintext copy has served its purpose.
            if let Some(dir) = path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = app.emit(DELIVERED_EVENT, delivered);
            super::deliver::delivered_notice(delivered)
        }
        Err(e) => {
            tracing::warn!(error = %e, "capture could not be delivered; kept on disk");
            let _ = app.emit(FAILED_EVENT, FailedPayload { message: e.to_string() });
            super::deliver::failed_notice(e, path)
        }
    };
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "capture notification not shown");
    }
}

#[tauri::command]
pub async fn capture_cancel(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    close_overlays(&app);
    restore_own_windows(&app, &state.capture);
    match advance(&app, &state.capture, CaptureEvent::Cancel) {
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
    pub screen_recording_permission: bool,
}

#[tauri::command]
pub fn capture_support() -> CaptureSupport {
    CaptureSupport {
        supported: CAPTURE_SUPPORTED,
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
