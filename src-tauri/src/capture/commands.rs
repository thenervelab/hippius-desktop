//! The capture IPCs and the session that ties them together.
//!
//! Flow: `capture_start` opens one transparent overlay per display, and the
//! overlay under the pointer draws the capture bar (`bar.rs`). The bar can
//! switch what is captured (`capture_set_mode`); an area drawn on any display
//! is held here (`capture_set_pending`) so the bar's Capture button can take
//! it (`capture_confirm`), and a window or screen click answers directly
//! (`capture_select`). A screenshot is taken at once, or a recording starts
//! with a floating control bar. Either way the session ends when the file
//! exists; the preview card opens in the corner (`preview.rs`) and owns the
//! upload from there → `capture_delivered` / `capture_failed`. Every phase
//! change is broadcast as `capture_state_changed`, which is the only thing
//! the surfaces read.
//!
//! Every way a session can go wrong after the choice is made ends in ONE
//! place, [`fail_capture`], so no error can leave the session stuck with no
//! UI (the phase in `Capturing`, every later start refused).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::bar::{self, CameraShape, CameraSize, CaptureOptions};
use super::camera::{self, CameraState};
use super::destination::{self, CaptureDestination, DestinationChoice};
use super::preview::{LinkState, PreviewCard, PreviewStatus};
use super::recording::{self, Microphone, RecordOptions, Recorder};
use super::screenshot::Selection;
use super::session::{CaptureEvent, CaptureKind, CaptureMode, CapturePhase, TransitionError, transition};
use super::share;
use super::shortcut::{self, ShortcutAction, ShortcutSetting};
use super::targets::{DisplayTarget, WindowTarget};
use super::tray_status::{self, TrayClickRoute, TrayText};
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
/// The card's Upgrade: the main window opens the storage plans.
pub const OPEN_PLANS_EVENT: &str = "capture_open_plans";
/// The camera window's shape or device changed (`camera::CameraState`); the
/// camera page and the recording pill both read it.
pub const CAMERA_STATE_EVENT: &str = "capture_camera_state";
/// The camera window listed the cameras it can use.
pub const CAMERAS_EVENT: &str = "capture_cameras";
/// The saved options changed from outside the bar (the camera's own size
/// strip or its ×); the bar replaces its copy (`bar::CaptureOptions`).
pub const OPTIONS_EVENT: &str = "capture_options_changed";
/// More pictures for the share picker (`share::ShareArt`). Sent to the
/// overlay that hosts the picker only: they are pictures of every window.
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
/// How often the displays are checked while a capture is open.
const DISPLAY_WATCH_EVERY: std::time::Duration = std::time::Duration::from_millis(1500);
/// A card follows the sync engine's row for at most this long.
const SYNC_FOLLOW_LIMIT: std::time::Duration = std::time::Duration::from_hours(2);

const MAIN_WINDOW_LABEL: &str = "main";

/// Whether this build can capture screenshots at all. Linux screenshots go
/// through the desktop portal in a follow-up, so the surfaces hide themselves
/// there.
pub const CAPTURE_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// Whether screenshots are offered here: built for this platform, and the
/// platform is on this build's lane (`rollout`). Every surface asks this, so
/// a platform still on staging is simply unsupported on beta and production.
#[must_use]
pub fn capture_supported() -> bool {
    CAPTURE_SUPPORTED && super::rollout::allows(super::rollout::Feature::Screenshots)
}

/// Whether camera only (the stage) can be recorded here: it records the
/// camera window by its system window number, which only the macOS recorder
/// takes. Elsewhere the bar must not offer it.
#[must_use]
pub fn camera_only_supported() -> bool {
    cfg!(target_os = "macos") && recording::recording_supported()
}

/// A lock that survives a panic elsewhere: a poisoned recorder lock must not
/// make the recorder unreachable (it would keep recording until quit).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `capture_state_changed`: the phase, plus a number that only goes up, so a
/// listener that seeded itself from `capture_state` can drop an older event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PhaseEvent {
    #[serde(flatten)]
    pub phase: CapturePhase,
    pub seq: u64,
}

#[derive(Default)]
pub struct CaptureState {
    phase: Mutex<Option<CapturePhase>>,
    /// Numbers every phase broadcast ([`PhaseEvent::seq`]).
    phase_seq: AtomicU64,
    /// The newest `seq` written to the tray, so a tray write that ran late
    /// never puts an older time back (see [`show_phase_in_tray`]).
    tray_seq: AtomicU64,
    /// What the tray was last given, so it is written only when that changes.
    tray_last: Mutex<Option<TrayText>>,
    /// Why the saved shortcut could not be registered at start-up, for
    /// Settings (`ShortcutSetting::problem`); cleared once one registers.
    shortcut_problem: Mutex<Option<String>>,
    /// Whether the main window was on screen when the capture started, so it
    /// comes back only if it was there to begin with.
    restore_main: AtomicBool,
    /// Whether it was also the key window: only then does it come back to
    /// the front. A window merely open behind other apps goes back behind.
    main_was_focused: AtomicBool,
    /// The app that was frontmost when the capture started (its process id),
    /// handed the keyboard back when the overlays close.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    previous_app: Mutex<Option<i32>>,
    /// Live recording backend, if any.
    recorder: Mutex<Option<Box<dyn Recorder>>>,
    /// The folder the live recording writes into, removed if it is thrown away.
    recording_dir: Mutex<Option<PathBuf>>,
    /// What the live recording records, so Restart can start it again.
    selection: Mutex<Option<Selection>>,
    /// Cancels the elapsed-time tick task.
    tick_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// The display the capture bar is on; the preview card opens there too.
    bar_display: Mutex<Option<DisplayTarget>>,
    /// The displays of this capture, as last listed.
    displays: Mutex<Vec<DisplayTarget>>,
    /// Each display's usable area, read once per capture (and again when the
    /// displays change) instead of asking AppKit each time a window is placed.
    work_areas: Mutex<HashMap<u32, LogicalArea>>,
    /// Which display watch is current (see `spawn_display_watch`).
    display_watch: AtomicU64,
    /// The area drawn so far, on whichever display, for the Capture button.
    pending: Mutex<Option<Selection>>,
    /// A still of a recording's first frame, for its preview card.
    poster: Mutex<Option<String>>,
    /// The card in the corner, if one is showing.
    preview: Mutex<Option<PreviewCard>>,
    /// A failed capture whose card was closed: it comes back on the next
    /// capture, so a capture that did not upload is never silently lost.
    parked: Mutex<Option<PreviewCard>>,
    preview_seq: AtomicU64,
    /// Serialises `sync_camera`: two overlapping calls could otherwise open
    /// the window after the other found none to close.
    camera_lock: tokio::sync::Mutex<()>,
    /// The camera window on screen, and in which shape.
    camera_shape: Mutex<Option<CameraShape>>,
    /// The camera this recording started with; the window stays until stop.
    recording_camera: Mutex<Option<CameraShape>>,
    /// The bubble was hidden from the pill for part of a recording.
    camera_hidden: AtomicBool,
    /// The capture UI may show up in this session's screenshot: Windows did
    /// not keep an overlay out of captures (a build below 2004, or a driver
    /// that refused `WDA_EXCLUDEFROMCAPTURE`). The overlays are then gone,
    /// the card hidden and the compositor settled before the grab.
    ui_in_grabs: AtomicBool,
    /// The camera window's system window number, read once when it opens
    /// (0 = not known yet). Camera only records that window.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    camera_window_number: AtomicU64,
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
        lock(&self.phase).unwrap_or(CapturePhase::Idle)
    }

    fn take_recorder(&self) -> Option<Box<dyn Recorder>> {
        lock(&self.recorder).take()
    }

    fn stop_ticks(&self) {
        if let Some(tx) = lock(&self.tick_cancel).take() {
            let _ = tx.send(());
        }
    }

    /// Apply `event` and hand the new phase to `emit`, which runs while the
    /// phase is still locked: two changes racing (a tick and a cancel) are
    /// broadcast in the order they happened, never an older one last.
    fn apply(&self, event: CaptureEvent, emit: impl FnOnce(PhaseEvent)) -> Result<CapturePhase> {
        let mut guard = lock(&self.phase);
        let next = transition(guard.unwrap_or(CapturePhase::Idle), event).map_err(transition_error)?;
        *guard = Some(next);
        emit(PhaseEvent {
            phase: next,
            seq: self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1,
        });
        Ok(next)
    }

    /// The phase again, under a new number, so every surface re-reads it
    /// (the displays changed under an open capture bar).
    fn rebroadcast(&self, emit: impl FnOnce(PhaseEvent)) {
        let guard = lock(&self.phase);
        emit(PhaseEvent {
            phase: guard.unwrap_or(CapturePhase::Idle),
            seq: self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1,
        });
    }

    fn snapshot(&self) -> PhaseEvent {
        let guard = lock(&self.phase);
        PhaseEvent {
            phase: guard.unwrap_or(CapturePhase::Idle),
            seq: self.phase_seq.load(Ordering::SeqCst),
        }
    }

    /// Take a recorder that has just started, but only if the session is
    /// still waiting for it. The check, the store and the phase change are one
    /// step under the phase lock: a Cancel during "Starting recording…" lands
    /// either before (the recorder is handed back, to be cancelled) or after
    /// (Cancel finds it and cancels it), never in between with the recorder
    /// running and nothing left to stop it.
    ///
    /// # Errors
    ///
    /// The recorder itself, when the session moved on without it.
    fn adopt_recorder(&self, recorder: Box<dyn Recorder>, emit: impl FnOnce(PhaseEvent)) -> std::result::Result<CapturePhase, Box<dyn Recorder>> {
        let mut guard = lock(&self.phase);
        let starting = CapturePhase::Capturing {
            kind: CaptureKind::Recording,
        };
        if *guard != Some(starting) {
            return Err(recorder);
        }
        let Ok(next) = transition(
            starting,
            CaptureEvent::RecordingStarted {
                microphone: recorder.microphone(),
            },
        ) else {
            return Err(recorder);
        };
        *lock(&self.recorder) = Some(recorder);
        *guard = Some(next);
        emit(PhaseEvent {
            phase: next,
            seq: self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1,
        });
        Ok(next)
    }

    /// What an ended recording leaves that must go: the recorder (to cancel)
    /// and its folder (to remove). Ticks stop.
    fn take_leftovers(&self) -> (Option<Box<dyn Recorder>>, Option<PathBuf>) {
        self.stop_ticks();
        (self.take_recorder(), lock(&self.recording_dir).take())
    }
}

/// Apply `event` and broadcast the new phase.
fn advance(app: &AppHandle, state: &CaptureState, event: CaptureEvent) -> Result<CapturePhase> {
    state.apply(event, |e| emit_phase(app, e))
}

/// Every phase broadcast goes through here (pinned by
/// `tests/capture_wiring.rs`), so the tray follows every change: the webview
/// hears the event, and the menu bar's title is written by Rust.
fn emit_phase(app: &AppHandle, event: PhaseEvent) {
    let _ = app.emit(STATE_CHANGED_EVENT, event);
    show_phase_in_tray(app, event);
}

/// Write the phase's time (or no time) beside the tray icon.
///
/// Posted to the main thread and NOT waited for: this runs under the phase
/// lock, and `TrayIcon::set_title` blocks until the main thread runs it,
/// while a synchronous command on the main thread may itself be waiting for
/// the phase lock (`capture_state`, `toggle_tray_panel`). Waiting here would
/// deadlock the two. Posted writes run in order; one posted from a worker
/// can still land after a newer one run inline on the main thread, so each
/// write checks it is the newest ([`newest_for_tray`]).
fn show_phase_in_tray(app: &AppHandle, event: PhaseEvent) {
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        if newest_for_tray(&state.capture.tray_seq, event.seq) {
            let text = tray_status::tray_text_for(event.phase);
            let mut last = lock(&state.capture.tray_last);
            if tray_status::tray_needs_write(last.as_ref(), &text) {
                write_tray_text(&handle, &text);
                *last = Some(text);
            }
        }
    });
    if let Err(e) = posted {
        tracing::debug!(error = %e, "could not update the tray for the capture phase");
    }
}

/// Whether `seq` is newer than any phase the tray has shown, recording it
/// if so. A rebroadcast carries a new `seq`, so it is written again.
fn newest_for_tray(shown: &AtomicU64, seq: u64) -> bool {
    shown.fetch_max(seq, Ordering::SeqCst) < seq
}

/// The icon is created by the main window (`useTraySync.ts`) under
/// [`tray_status::TRAY_ID`]; before it exists there is nothing to write.
/// Written only when the text changes ([`tray_status::tray_needs_write`]),
/// so a screenshot never touches the status item. The frontend may recreate
/// the icon (a sync icon that failed to apply) with no title; mid-recording
/// the next second's tick writes the time back.
fn write_tray_text(app: &AppHandle, text: &TrayText) {
    let Some(tray) = app.tray_by_id(tray_status::TRAY_ID) else {
        return;
    };
    // Empty, not `None`: `tray-icon` ignores a `None` title on macOS, which
    // is what left a saved recording's time stuck in the menu bar. Windows
    // has no title; the tooltip carries the time there.
    if let Err(e) = tray.set_title(Some(text.title.as_str())) {
        tracing::debug!(error = %e, "could not set the tray title");
    }
    if let Err(e) = tray.set_tooltip(Some(text.tooltip.as_str())) {
        tracing::debug!(error = %e, "could not set the tray tooltip");
    }
}

/// A left click on the tray icon, received by `tray::panel` before it opens
/// anything. During a recording the click brings the recording's pill back,
/// without taking the keyboard from the app being recorded, and does NOT
/// stop it (the pill has Stop); the popover does not open. Otherwise the
/// route is the popover, or the main window when nobody is signed in
/// ([`tray_status::tray_click_route`]).
pub fn on_tray_click(app: &AppHandle, signed_in: bool) -> TrayClickRoute {
    let state = app.state::<AppState>();
    let route = tray_status::tray_click_route(signed_in, state.capture.current());
    if route == TrayClickRoute::ShowRecordingControls {
        if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
            show_without_focus(&w);
        } else {
            tracing::warn!("tray click during a recording found no recording controls");
        }
    }
    route
}

fn transition_error(e: TransitionError) -> AppError {
    AppError::Validation(e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    message: String,
    /// The preview card already shows this failure: the main window skips
    /// its own toast, so it is said once.
    card_showing: bool,
}

/// The one ending for a capture that went wrong after the choice was made:
/// the session goes back to Idle and every window it put up comes down.
/// Only a session this call actually ended is reported: one cancelled in the
/// meantime is the user's doing, not a failure.
async fn fail_capture(app: &AppHandle, e: &AppError) {
    let state = app.state::<AppState>();
    let failed = advance(app, &state.capture, CaptureEvent::Failed).is_ok();
    let (recorder, dir) = state.capture.take_leftovers();
    discard_recording(recorder, dir).await;
    lock(&state.capture.selection).take();
    close_overlays(app);
    close_controls(app);
    drop_unused_preview(app, &state.capture);
    restore_main_window(app, &state.capture);
    hand_focus_back(app, &state.capture);
    end_camera(app).await;
    if failed {
        tracing::warn!(error = %e, "capture failed");
        let _ = app.emit(
            FAILED_EVENT,
            FailedPayload {
                message: e.to_string(),
                card_showing: false,
            },
        );
    }
}

/// Cancel a recorder and remove its folder. Both are best effort: the
/// session is over whatever they answer.
async fn discard_recording(recorder: Option<Box<dyn Recorder>>, dir: Option<PathBuf>) {
    if let Some(recorder) = recorder {
        let _ = tauri::async_runtime::spawn_blocking(move || recorder.cancel()).await;
    }
    if let Some(dir) = dir {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

// ── The app's own windows and the keyboard ──────────────────────────────────

/// How the main window comes back after a capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainRestore {
    /// It was not on screen: it stays hidden.
    Leave,
    /// It was open behind another app: back behind, without taking the
    /// keyboard from the app the user was in.
    Behind,
    /// It was the window the user was in: back in front, with the keyboard.
    Front,
}

fn restore_plan(was_visible: bool, was_focused: bool) -> MainRestore {
    match (was_visible, was_focused) {
        (false, _) => MainRestore::Leave,
        (true, false) => MainRestore::Behind,
        (true, true) => MainRestore::Front,
    }
}

/// Hide the app's own windows so they are not in the shot, remembering
/// whether the main window was visible and in front, and which app the user
/// was in.
async fn hide_own_windows(app: &AppHandle, state: &CaptureState) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = main.is_visible().unwrap_or(false);
        state.restore_main.store(visible, Ordering::SeqCst);
        state
            .main_was_focused
            .store(visible && main.is_focused().unwrap_or(false), Ordering::SeqCst);
        if visible {
            let _ = main.hide();
        }
    }
    *lock(&state.previous_app) = frontmost_other_app(app).await;
    let _ = crate::tray::panel::hide_tray_panel(app.clone());
}

/// Bring the main window back as it was (see [`restore_plan`]). Called when
/// a capture has fully ended: after a screenshot, or when a recording stops,
/// never while one runs (it would be in the video).
fn restore_main_window(app: &AppHandle, state: &CaptureState) {
    let visible = state.restore_main.swap(false, Ordering::SeqCst);
    let focused = state.main_was_focused.swap(false, Ordering::SeqCst);
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    match restore_plan(visible, focused) {
        MainRestore::Leave => {}
        MainRestore::Behind => show_behind(&main),
        MainRestore::Front => {
            let _ = main.show();
            let _ = main.set_focus();
            lock(&state.previous_app).take();
        }
    }
}

/// Give the keyboard back to the app the user was in when the overlays took
/// it. The overlays activated Hippius; without this, typing after a capture
/// went nowhere until the user clicked.
fn hand_focus_back(app: &AppHandle, state: &CaptureState) {
    if let Some(pid) = lock(&state.previous_app).take() {
        reactivate_app(app, pid);
    }
}

/// Order a window back on screen behind the others, without activating it.
fn show_behind(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns_window) = target.ns_window() {
                let ns_window = ns_window.cast::<objc::runtime::Object>();
                // SAFETY: this window's live NSWindow, touched on the main
                // thread. `orderBack:` shows it without making it key.
                let () = unsafe { msg_send![ns_window, orderBack: ns_window] };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        show_without_focus(window);
    }
}

/// The frontmost app when it is not Hippius (its process id).
#[cfg(target_os = "macos")]
async fn frontmost_other_app(app: &AppHandle) -> Option<i32> {
    use objc::{class, msg_send, sel, sel_impl};

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        // SAFETY: read-only AppKit queries on the main thread; nil checked.
        let pid = unsafe {
            let workspace: cocoa::base::id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: cocoa::base::id = msg_send![workspace, frontmostApplication];
            if front.is_null() {
                None
            } else {
                let pid: i32 = msg_send![front, processIdentifier];
                Some(pid)
            }
        };
        let _ = tx.send(pid);
    })
    .ok()?;
    let pid = tokio::time::timeout(std::time::Duration::from_millis(300), rx).await.ok()?.ok()??;
    let own = i32::try_from(std::process::id()).ok()?;
    (pid != own && pid > 0).then_some(pid)
}

// Async to match the macOS version, which waits on the main thread.
#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)]
async fn frontmost_other_app(_app: &AppHandle) -> Option<i32> {
    None
}

#[cfg(target_os = "macos")]
fn reactivate_app(app: &AppHandle, pid: i32) {
    use objc::{class, msg_send, sel, sel_impl};
    let _ = app.run_on_main_thread(move || {
        // SAFETY: AppKit on the main thread; the app is looked up by pid and
        // checked for nil (it may have quit meanwhile).
        unsafe {
            let running: cocoa::base::id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if !running.is_null() {
                // NSApplicationActivateIgnoringOtherApps.
                let _: bool = msg_send![running, activateWithOptions: 2usize];
            }
        }
    });
}

/// Elsewhere closing the overlays hands activation back by itself.
#[cfg(not(target_os = "macos"))]
fn reactivate_app(_app: &AppHandle, _pid: i32) {}

fn close_overlays(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            // Destroyed, not closed: `close` finishes later, and a capture
            // started straight after would find the label still taken.
            let _ = window.destroy();
        }
    }
}

fn close_controls(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = w.close();
    }
}

// ── Starting ────────────────────────────────────────────────────────────────

/// Start a capture: check it can happen, then put an overlay on every display
/// with the capture bar on the one under the pointer.
///
/// `kind` and `mode` preselect the bar (a Capture menu item, the tray); left
/// out, the bar opens on whatever was used last.
///
/// Refusals are structured so the UI can answer each one:
/// `NotReady(CaptureDestinationUnset)` → the drive picker,
/// `NotReady(ScreenRecordingPermission)` → the permission explainer (which
/// asks macOS through `capture_request_permission`; asking here as well put
/// two dialogs on screen at once).
/// A capture already in progress is brought forward, not refused.
#[tauri::command]
pub async fn capture_start(state: tauri::State<'_, AppState>, app: AppHandle, kind: Option<CaptureKind>, mode: Option<CaptureMode>) -> Result<()> {
    if !capture_supported() {
        return Err(AppError::Validation("Screen capture isn't available on this system yet.".into()));
    }
    let recording_ok = recording::recording_supported();
    if kind == Some(CaptureKind::Recording)
        && let Some(why) = recording::recording_unavailable()
    {
        return Err(AppError::Validation(why.message().into()));
    }
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    if destination::load(pool, &account_id).await?.is_none() {
        return Err(AppError::NotReady(NotReadyKind::CaptureDestinationUnset));
    }
    if !super::permissions::screen_capture_granted() {
        return Err(AppError::NotReady(NotReadyKind::ScreenRecordingPermission));
    }

    let mut options = bar::load_options(pool).await?.for_system(camera_only_supported());
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
    let areas = bar::load_areas(pool).await.unwrap_or_default();

    bring_back_failed_card(&app, &state.capture);
    hide_own_windows(&app, &state.capture).await;
    // Below Windows 10 2004 nothing can be kept out of a capture; each
    // overlay also checks for itself as it opens (`open_overlay`).
    state.capture.ui_in_grabs.store(
        !super::permissions::windows_excludes_from_capture(super::permissions::windows_build()),
        Ordering::SeqCst,
    );
    if let Err(e) = open_capture_ui(&app, &state.capture, &areas).await {
        // Everything this start put up comes down again, the camera included.
        close_overlays(&app);
        close_controls(&app);
        drop_unused_preview(&app, &state.capture);
        restore_main_window(&app, &state.capture);
        hand_focus_back(&app, &state.capture);
        let _ = advance(&app, &state.capture, CaptureEvent::Failed);
        end_camera(&app).await;
        return Err(e);
    }
    state.capture.camera_hidden.store(false, Ordering::SeqCst);
    sync_camera(&app).await;
    // Load the card and the recording pill while the user is still choosing,
    // so each appears the moment it is needed instead of after its page loads.
    let display = lock(&state.capture.bar_display).clone();
    if let Err(e) = open_preview_window(&app, display.as_ref()) {
        tracing::warn!(error = %e, "capture preview card not prepared");
    }
    show_card_if_any(&app, &state.capture);
    if kind == CaptureKind::Recording
        && let Err(e) = open_controls(&app, false)
    {
        tracing::warn!(error = %e, "recording controls not prepared");
    }
    spawn_display_watch(app.clone());
    Ok(())
}

fn focus_active_ui(app: &AppHandle, state: &CaptureState) {
    match state.current() {
        // Recording: the pill comes forward without taking the keyboard from
        // the app being recorded.
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } | CapturePhase::Finalizing => {
            if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
                show_without_focus(&w);
            }
        }
        _ => focus_overlays(app),
    }
}

/// Put an overlay on every display and choose which one carries the bar.
/// The last area drawn on the bar's display comes back drawn.
async fn open_capture_ui(app: &AppHandle, state: &CaptureState, areas: &bar::RememberedAreas) -> Result<()> {
    let displays = tauri::async_runtime::spawn_blocking(list_displays_blocking)
        .await
        .map_err(|e| AppError::Other(format!("display listing task failed: {e}")))??;
    if displays.is_empty() {
        return Err(AppError::Other("No display to capture.".into()));
    }
    let host = bar::bar_display(&displays, cursor_point(app, &displays));
    let host_display = displays.iter().find(|d| Some(d.id) == host).cloned();
    *lock(&state.pending) = host_display.as_ref().and_then(|d| remembered_area(areas, d));
    *lock(&state.bar_display) = host_display;
    lock(&state.displays).clone_from(&displays);
    refresh_work_areas(app, state, &displays).await;
    for display in &displays {
        open_overlay(app, display, Some(display.id) == host).await?;
    }
    Ok(())
}

/// The area last drawn on `display`, fitted to it as it is now.
fn remembered_area(areas: &bar::RememberedAreas, display: &DisplayTarget) -> Option<Selection> {
    let rect = bar::fit_area(*areas.get(&display.id)?, display.logical_width(), display.logical_height())?;
    Some(Selection::Area {
        display_id: display.id,
        rect,
    })
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

/// The overlay for `display`. Only the one hosting the bar takes the
/// keyboard: focusing every overlay left the last one focused, which was not
/// necessarily the bar's, and on Windows each focus could inject an Alt press.
async fn open_overlay(app: &AppHandle, display: &DisplayTarget, hosts_bar: bool) -> Result<()> {
    let label = format!("{OVERLAY_LABEL_PREFIX}{}", display.id);
    // A previous session's overlay may still be on its way out.
    if let Some(stale) = app.get_webview_window(&label) {
        let _ = stale.destroy();
    }
    let window = if let Ok(w) = build_overlay(app, &label, display) {
        w
    } else {
        // The label frees once the event loop has destroyed the old one.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        build_overlay(app, &label, display)?
    };
    // Content protection is asked for, not promised: on Windows it is
    // `SetWindowDisplayAffinity`, whose failure tao discards. Read it back;
    // if it did not hold, this session's screenshot closes the overlays
    // first rather than photographing the dimmed selection UI.
    if !kept_out_of_captures(&window) {
        tracing::warn!(
            build = ?super::permissions::windows_build(),
            "the capture overlay is not excluded from screen captures here; overlays will close before the grab"
        );
        app.state::<AppState>().capture.ui_in_grabs.store(true, Ordering::SeqCst);
    }

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
    if hosts_bar {
        let _ = window.set_focus();
    }
    Ok(())
}

fn build_overlay(app: &AppHandle, label: &str, display: &DisplayTarget) -> Result<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // Same split as the tray panel: the dev server serves `/capture-overlay`,
    // the static export only `capture-overlay.html`.
    let route = if cfg!(dev) { "capture-overlay" } else { "capture-overlay.html" };
    let url = WebviewUrl::App(format!("{route}?display={}", display.id).into());
    WebviewWindowBuilder::new(app, label, url)
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
        .map_err(|e| AppError::Other(format!("Could not open the capture overlay: {e}")))
}

/// The recording pill, bottom-centre of the bar's display, above the Dock.
/// Built hidden while choosing (`show` false) so it is ready to appear the
/// moment the countdown ends; shown with `show` true. It is placed on the
/// bar's display each time it comes on screen, never where an earlier
/// session left a hidden one.
fn open_controls(app: &AppHandle, show: bool) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let window = if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
        w
    } else {
        let route = if cfg!(dev) { "capture-controls" } else { "capture-controls.html" };
        let window = WebviewWindowBuilder::new(app, CONTROLS_LABEL, WebviewUrl::App(route.into()))
            .title("Hippius recording")
            .decorations(false)
            .transparent(true)
            // A DWM shadow on a transparent undecorated window draws a
            // rectangle around the pill on Windows; the page draws its own.
            .shadow(cfg!(target_os = "macos"))
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .content_protected(true)
            .focused(false)
            // Pause and Stop answer the first click, like the card's buttons.
            .accept_first_mouse(true)
            .inner_size(CONTROLS_WIDTH, CONTROLS_HEIGHT)
            .visible(false)
            .build()
            .map_err(|e| AppError::Other(format!("Could not open the recording controls: {e}")))?;
        raise_above_menu_bar(&window);
        window
    };
    if !window.is_visible().unwrap_or(false) {
        let state = app.state::<AppState>();
        if let Some(d) = lock(&state.capture.bar_display).clone() {
            let area = work_area(&state.capture, &d);
            place(
                &window,
                camera::Frame {
                    x: area.x + (area.width - CONTROLS_WIDTH) / 2.0,
                    y: area.y + area.height - CONTROLS_HEIGHT - CONTROLS_MARGIN,
                    width: CONTROLS_WIDTH,
                    height: CONTROLS_HEIGHT,
                },
                area.scale,
            );
        }
    }
    if show {
        show_without_focus(&window);
    }
    Ok(())
}

/// Take the pill off screen at once (Stop), before the file is closed.
fn hide_controls(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = w.hide();
    }
}

// ── Where windows go ────────────────────────────────────────────────────────

/// A display's usable area in logical points: without the menu bar and the
/// Dock on macOS, without the taskbar on Windows. Windows placed against the
/// whole display sat under the Dock and looked cut off.
///
/// `scale` turns it back into the display's own pixels: Windows has no
/// global logical space, so a window is placed in physical pixels there.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

impl LogicalArea {
    fn frame(self) -> camera::Frame {
        camera::Frame {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
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
        scale,
    }
}

/// `d`'s usable area from the cache, or the whole display when it was never
/// read. Never waits on the main thread.
fn work_area(state: &CaptureState, d: &DisplayTarget) -> LogicalArea {
    lock(&state.work_areas).get(&d.id).copied().unwrap_or_else(|| display_area(d))
}

/// Read every display's usable area once and keep it for this capture.
async fn refresh_work_areas(app: &AppHandle, state: &CaptureState, displays: &[DisplayTarget]) {
    let areas = read_work_areas(app, displays).await;
    *lock(&state.work_areas) = areas;
}

#[cfg(target_os = "macos")]
async fn read_work_areas(app: &AppHandle, displays: &[DisplayTarget]) -> HashMap<u32, LogicalArea> {
    let ids: Vec<u32> = displays.iter().map(|d| d.id).collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // AppKit is only asked on the main thread, once for every display.
    let asked = app.run_on_main_thread(move || {
        let frames: HashMap<u32, (f64, f64, f64, f64, f64)> = ids.iter().filter_map(|&id| macos_visible_frame(id).map(|f| (id, f))).collect();
        let _ = tx.send(frames);
    });
    let frames = match asked {
        Ok(()) => tokio::time::timeout(std::time::Duration::from_millis(500), rx)
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
    };
    frames
        .into_iter()
        // AppKit's origin is the primary display's bottom-left, y up.
        .map(|(id, (vx, vy, vw, vh, primary_height))| {
            (
                id,
                LogicalArea {
                    x: vx,
                    y: primary_height - (vy + vh),
                    width: vw,
                    height: vh,
                    scale: 1.0,
                },
            )
        })
        .collect()
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

// Async to match the macOS version, which waits on the main thread.
#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)]
async fn read_work_areas(app: &AppHandle, displays: &[DisplayTarget]) -> HashMap<u32, LogicalArea> {
    // Windows: the monitor at each display's own origin, in physical pixels.
    let Ok(monitors) = app.available_monitors() else {
        return HashMap::new();
    };
    displays
        .iter()
        .filter_map(|d| {
            let m = monitors.iter().find(|m| m.position().x == d.x && m.position().y == d.y)?;
            let area = m.work_area();
            let scale = m.scale_factor().max(1.0);
            Some((
                d.id,
                LogicalArea {
                    x: f64::from(area.position.x) / scale,
                    y: f64::from(area.position.y) / scale,
                    width: f64::from(area.size.width) / scale,
                    height: f64::from(area.size.height) / scale,
                    scale,
                },
            ))
        })
        .collect()
}

/// Move and size a floating window. macOS places in points (one global
/// space); Windows in the target monitor's own pixels, since a logical
/// position there is resolved against whichever monitor Tauri guesses.
fn place(window: &tauri::WebviewWindow, f: camera::Frame, scale: f64) {
    if super::targets::COORDS_ARE_LOGICAL {
        let _ = window.set_position(tauri::LogicalPosition::new(f.x, f.y));
        let _ = window.set_size(tauri::LogicalSize::new(f.width, f.height));
    } else {
        // Position first: a move onto a monitor of another scale resizes the
        // window, and the size set after it is the one that stays.
        let p = physical_frame(f, scale);
        let _ = window.set_position(tauri::PhysicalPosition::new(p.x, p.y));
        let _ = window.set_size(tauri::PhysicalSize::new(p.width, p.height));
    }
}

/// The card's frame: the bottom-right corner of the display's WORK area
/// (clear of the Dock, or of the taskbar wherever it is docked), in that
/// area's logical units.
fn card_frame(area: LogicalArea) -> camera::Frame {
    camera::Frame {
        x: area.x + area.width - PREVIEW_WIDTH - PREVIEW_MARGIN,
        y: area.y + area.height - PREVIEW_HEIGHT - PREVIEW_MARGIN,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
    }
}

/// A frame in a monitor's logical units (its work area over its own scale)
/// back in that monitor's physical pixels, rounded to whole pixels and never
/// empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PhysicalFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn physical_frame(f: camera::Frame, scale: f64) -> PhysicalFrame {
    #[allow(clippy::cast_possible_truncation)]
    let px = |v: f64| (v * scale).round() as i32;
    PhysicalFrame {
        x: px(f.x),
        y: px(f.y),
        width: px(f.width).max(1).unsigned_abs(),
        height: px(f.height).max(1).unsigned_abs(),
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
        // Windows honours "do not activate" only on a window's FIRST show; a
        // later plain `show` activates it. So an already visible window is
        // left alone, and a hidden one is shown while it cannot take focus.
        if window.is_visible().unwrap_or(false) {
            return;
        }
        let _ = window.set_focusable(false);
        let _ = window.show();
        let _ = window.set_focusable(true);
    }
}

/// Tauri's always-on-top level sits BELOW the macOS menu bar, which would
/// leave the overlay stopping short of the top of the screen and the menu bar
/// impossible to select. Raise it to the screen-saver level.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &tauri::WebviewWindow) {
    // NSScreenSaverWindowLevel.
    set_window_level(window, Some(1000));
}

/// The camera sits one level above the overlays, so it can be placed while
/// choosing, and above the pill so a bubble dragged over it stays in view.
#[cfg(target_os = "macos")]
fn raise_camera(window: &tauri::WebviewWindow) {
    set_window_level(window, Some(1001));
}

#[cfg(not(target_os = "macos"))]
fn raise_camera(_window: &tauri::WebviewWindow) {}

/// The card floats over a full-screen app too, at its own level.
#[cfg(target_os = "macos")]
fn float_over_full_screen(window: &tauri::WebviewWindow) {
    set_window_level(window, None);
}

#[cfg(not(target_os = "macos"))]
fn float_over_full_screen(_window: &tauri::WebviewWindow) {}

/// Set a capture window's level (when given) and let it appear over a
/// full-screen app's Space: without `FullScreenAuxiliary`, bringing it
/// forward could switch the user out of the full-screen app being captured.
#[cfg(target_os = "macos")]
fn set_window_level(window: &tauri::WebviewWindow, level: Option<i64>) {
    use objc::{msg_send, sel, sel_impl};
    /// NSWindowCollectionBehaviorFullScreenAuxiliary.
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = target.ns_window() {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: `ns_window` is this window's live NSWindow, and AppKit
            // is only touched here, on the main thread.
            unsafe {
                if let Some(level) = level {
                    let () = msg_send![ns_window, setLevel: level];
                }
                let behavior: usize = msg_send![ns_window, collectionBehavior];
                let () = msg_send![ns_window, setCollectionBehavior: behavior | FULL_SCREEN_AUXILIARY];
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn raise_above_menu_bar(_window: &tauri::WebviewWindow) {}

fn focus_overlays(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = lock(&state.capture.bar_display).as_ref().map(|d| d.id);
    let label = host.map(|id| format!("{OVERLAY_LABEL_PREFIX}{id}"));
    if let Some(window) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = window.set_focus();
    }
}

// ── The displays changing under an open capture ────────────────────────────

/// Watch the displays while a capture is open. An unplugged display's overlay
/// closes and an area held on it is dropped; a new display gets an overlay
/// while choosing; the bar moves if its display went; the usable areas are
/// read again. One watch at a time; it ends with the session.
fn spawn_display_watch(app: AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.capture.display_watch.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DISPLAY_WATCH_EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            let state = app.state::<AppState>();
            if state.capture.display_watch.load(Ordering::SeqCst) != generation || state.capture.current() == CapturePhase::Idle {
                break;
            }
            let Ok(Ok(now)) = tauri::async_runtime::spawn_blocking(list_displays_blocking).await else {
                continue;
            };
            if now.is_empty() {
                continue;
            }
            let before = lock(&state.capture.displays).clone();
            if let Some(change) = bar::display_change(&before, &now) {
                apply_display_change(&app, &now, &change).await;
            }
        }
    });
}

async fn apply_display_change(app: &AppHandle, now: &[DisplayTarget], change: &bar::DisplayChange) {
    let state = app.state::<AppState>();
    *lock(&state.capture.displays) = now.to_vec();
    refresh_work_areas(app, &state.capture, now).await;

    for id in &change.gone {
        if let Some(w) = app.get_webview_window(&format!("{OVERLAY_LABEL_PREFIX}{id}")) {
            let _ = w.destroy();
        }
    }
    let dropped = {
        let mut pending = lock(&state.capture.pending);
        let kept = bar::pending_after(*pending, now);
        let dropped = kept != *pending;
        *pending = kept;
        dropped
    };
    if dropped {
        let _ = app.emit(PENDING_EVENT, PendingPayload::of(None));
    }

    let bar_gone = lock(&state.capture.bar_display).as_ref().is_some_and(|d| change.gone.contains(&d.id));
    let selecting = matches!(state.capture.current(), CapturePhase::Selecting { .. });
    if bar_gone {
        let host = bar::bar_display(now, cursor_point(app, now));
        *lock(&state.capture.bar_display) = now.iter().find(|d| Some(d.id) == host).cloned();
    }
    if selecting {
        let host = lock(&state.capture.bar_display).as_ref().map(|d| d.id);
        for display in now.iter().filter(|d| change.added.contains(&d.id)) {
            if let Err(e) = open_overlay(app, display, false).await {
                tracing::warn!(error = %e, "no overlay for a display plugged in mid-capture");
            }
        }
        if bar_gone {
            // The overlays re-read their context: one of them now hosts the bar.
            state.capture.rebroadcast(|e| emit_phase(app, e));
            if let Some(label) = host.map(|id| format!("{OVERLAY_LABEL_PREFIX}{id}"))
                && let Some(w) = app.get_webview_window(&label)
            {
                let _ = w.set_focus();
            }
        }
    }
}

// ── Choosing ────────────────────────────────────────────────────────────────

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
    /// Camera only (screen off) can be recorded here.
    pub camera_only_available: bool,
    /// Why not, when recording is unavailable: the bar shows the Record modes
    /// disabled with this line on a Mac that lacks the helper or macOS 13.
    #[serde(flatten)]
    pub recording_availability: recording::RecordingAvailability,
    /// Whether the camera, if on, is in the video. False for a bubble over a
    /// window recording, which films that one window only.
    pub camera_filmed: bool,
    /// What this platform's bar may offer (modes, timer, the microphone's
    /// line), the same as `capture_support` says.
    #[serde(flatten)]
    pub surfaces: super::support::Surfaces,
    pub destination: Option<CaptureDestination>,
    /// The area already drawn, on this display or another. At the start of a
    /// capture it is the area last drawn on the bar's display, fitted to it.
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
    let options = bar::load_options(pool).await?.for_system(camera_only_supported());
    let destination = match state.current_account_id() {
        Ok(account_id) => destination::load(pool, &account_id).await?,
        Err(_) => None,
    };
    let hosts_bar = lock(&state.capture.bar_display).as_ref().is_some_and(|d| d.id == display_id);
    let pending = *lock(&state.capture.pending);
    Ok(OverlayContext {
        mode,
        display_id,
        kind,
        windows,
        hosts_bar,
        countdown_secs: options.countdown_secs(kind),
        camera_filmed: options.camera_filmed(kind, mode),
        options,
        recording_available: recording::recording_supported(),
        microphone_available: recording::microphone_supported(),
        show_clicks_available: recording::show_clicks_supported(),
        camera_only_available: camera_only_supported(),
        recording_availability: recording::RecordingAvailability::now(),
        surfaces: super::support::surfaces(),
        destination,
        pending,
    })
}

/// The pickable windows on `display_id` again, for window mode's hover: a
/// window opened or moved since the overlay loaded becomes pickable without
/// switching modes.
#[tauri::command]
pub async fn capture_refresh_windows(state: tauri::State<'_, AppState>, display_id: u32) -> Result<Vec<WindowTarget>> {
    let CapturePhase::Selecting {
        mode: CaptureMode::Window, ..
    } = state.capture.current()
    else {
        return Err(AppError::Validation("No capture is choosing a window.".into()));
    };
    tauri::async_runtime::spawn_blocking(move || windows_on_display_blocking(display_id))
        .await
        .map_err(|e| AppError::Other(format!("window listing task failed: {e}")))?
}

/// The capture bar switched what to capture. The overlays re-read their
/// context on the state event, and the choice is remembered for next time.
#[tauri::command]
pub async fn capture_set_mode(state: tauri::State<'_, AppState>, app: AppHandle, kind: CaptureKind, mode: CaptureMode) -> Result<()> {
    if kind == CaptureKind::Recording
        && let Some(why) = recording::recording_unavailable()
    {
        return Err(AppError::Validation(why.message().into()));
    }
    advance(&app, &state.capture, CaptureEvent::SetMode { kind, mode })?;
    let pool = state.pool()?;
    let options = CaptureOptions {
        last_kind: kind,
        last_mode: mode,
        ..bar::load_options(pool).await?
    };
    bar::save_options(pool, options).await?;
    // The pill is only for recordings; a hidden one left from a switch to a
    // screenshot would come back on the wrong display later.
    match kind {
        CaptureKind::Screenshot => close_controls(&app),
        CaptureKind::Recording => {
            if let Err(e) = open_controls(&app, false) {
                tracing::warn!(error = %e, "recording controls not prepared");
            }
        }
    }
    sync_camera(&app).await;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPayload {
    /// The display holding the drawn area, or `None` when it was cleared.
    display_id: Option<u32>,
    /// The area itself, so every overlay mirrors what Rust holds (the one
    /// that drew it included); `None` when it was cleared.
    rect: Option<super::geometry::LogicalRect>,
}

impl PendingPayload {
    fn of(selection: Option<Selection>) -> Self {
        match selection {
            Some(Selection::Area { display_id, rect }) => Self {
                display_id: Some(display_id),
                rect: Some(rect),
            },
            _ => Self {
                display_id: None,
                rect: None,
            },
        }
    }
}

/// An overlay drew, moved or cleared its area. One area at a time: the other
/// displays drop theirs on [`PENDING_EVENT`]. The area is remembered for that
/// display, and in area mode the camera bubble moves inside it so it is in
/// the recording.
#[tauri::command]
pub async fn capture_set_pending(state: tauri::State<'_, AppState>, app: AppHandle, selection: Option<Selection>) -> Result<()> {
    if !matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    }
    if matches!(selection, Some(Selection::Window { .. } | Selection::Screen { .. })) {
        return Err(AppError::Validation("Only an area can be held for the Capture button.".into()));
    }
    *lock(&state.capture.pending) = selection;
    let _ = app.emit(PENDING_EVENT, PendingPayload::of(selection));
    if let Some(Selection::Area { display_id, rect }) = selection
        && let Err(e) = bar::remember_area(state.pool()?, display_id, rect).await
    {
        tracing::warn!(error = %e, "capture area not remembered");
    }
    sync_camera(&app).await;
    Ok(())
}

/// The bar's Capture / Record button, pressed on `display_id`.
#[tauri::command]
pub async fn capture_confirm(app: AppHandle, display_id: u32) -> Result<()> {
    let state = app.state::<AppState>();
    let CapturePhase::Selecting { mode, kind } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    let options = bar::load_options(state.pool()?).await?.for_system(camera_only_supported());
    let selection = if options.camera_shape(kind) == Some(CameraShape::Stage) {
        // A platform that cannot record says so in the recording's own words,
        // before any window is looked for: "the camera isn't on screen yet"
        // would be untrue and could never be fixed by waiting.
        if let Some(why) = recording::recording_unavailable() {
            return Err(AppError::Validation(why.message().into()));
        }
        if !camera_only_supported() {
            return Err(AppError::Validation(
                "Recording the camera on its own isn't available on this system yet.".into(),
            ));
        }
        // Camera only: what is recorded is the stage window itself.
        let window_id = camera_window_id(&app)
            .await
            .ok_or_else(|| AppError::Validation("The camera isn't on screen yet. Try again in a moment.".into()))?;
        Selection::Window { window_id }
    } else {
        let pending = *lock(&state.capture.pending);
        // Entire screen: the display under the pointer, as a click takes it.
        let displays = lock(&state.capture.displays).clone();
        let under_pointer = bar::display_under(&displays, cursor_point(&app, &displays));
        // The window-mode refusal ("Click a window to choose it.") is Rust's
        // too: the bar shows this error as it is.
        bar::resolve_confirm(mode, pending, display_id, under_pointer).map_err(|e| AppError::Validation(e.to_string()))?
    };
    select_inner(&app, selection).await
}

#[tauri::command]
pub async fn capture_get_options(state: tauri::State<'_, AppState>) -> Result<CaptureOptions> {
    Ok(bar::load_options(state.pool()?).await?.for_system(camera_only_supported()))
}

/// What the bar needs after saving its options, decided here so it does not
/// re-derive any of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedOptions {
    /// What was stored: timers snapped to the choices offered, camera only
    /// turned back into screen where it cannot be recorded.
    pub options: CaptureOptions,
    /// Seconds to count down for the capture being chosen now.
    pub countdown_secs: u8,
    /// Whether the camera, if on, is in the video for the mode chosen now.
    pub camera_filmed: bool,
}

/// Save the bar's Options menu and sources panel.
///
/// `last_kind` / `last_mode` are the session's (set by `capture_start` and
/// `capture_set_mode`); the bar's copy may predate a mode switch, so its
/// values are ignored rather than written back.
#[tauri::command]
pub async fn capture_set_options(state: tauri::State<'_, AppState>, app: AppHandle, options: CaptureOptions) -> Result<SavedOptions> {
    let pool = state.pool()?;
    let stored = bar::load_options(pool).await?;
    let options = CaptureOptions {
        last_kind: stored.last_kind,
        last_mode: stored.last_mode,
        ..options
    }
    .for_system(camera_only_supported());
    bar::save_options(pool, options.clone()).await?;
    // Turning the camera on shows it at once, so it can be placed first.
    sync_camera(&app).await;
    let (kind, mode) = match state.capture.current() {
        CapturePhase::Selecting { kind, mode } => (kind, mode),
        _ => (options.last_kind, options.last_mode),
    };
    Ok(SavedOptions {
        countdown_secs: options.countdown_secs(kind),
        camera_filmed: options.camera_filmed(kind, mode),
        options,
    })
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
    // Everything after the budget, refreshes included, streams to the picker:
    // the overlay that hosts the bar, and no other window.
    let target = lock(&state.capture.bar_display)
        .as_ref()
        .map(|d| format!("{OVERLAY_LABEL_PREFIX}{}", d.id));
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(target) = target else { return };
        let mut batch = Vec::new();
        loop {
            // Pictures that arrive close together go as one batch.
            let next = if batch.is_empty() {
                rx.recv().await
            } else if let Ok(next) = tokio::time::timeout(std::time::Duration::from_millis(80), rx.recv()).await {
                next
            } else {
                flush_share_art(&emitter, &target, token, &mut batch);
                continue;
            };
            match next {
                Some(share::ShareMessage::Art(item)) => batch.push(item),
                Some(_) => {}
                None => break,
            }
        }
        flush_share_art(&emitter, &target, token, &mut batch);
    });
    Ok(targets)
}

/// Send a batch of pictures to the picker's overlay only. They are pictures
/// of every window on screen (mail, password managers); the main window, the
/// tray and the camera have no business receiving them.
fn flush_share_art(app: &AppHandle, target: &str, token: u64, batch: &mut Vec<share::ShareArtItem>) {
    if batch.is_empty() {
        return;
    }
    let _ = app.emit_to(
        target,
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

/// App icons for the picker's tiles, read on the main thread (AppKit). This
/// runs on the picker's own thread, never on the main one, so the wait
/// cannot deadlock.
#[cfg(target_os = "macos")]
fn app_icons(app: &AppHandle, pids: &[u32]) -> HashMap<u32, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let pids = pids.to_vec();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(share::macos_app_icons(&pids));
        })
        .is_err()
    {
        return HashMap::new();
    }
    rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or_default()
}

#[cfg(windows)]
fn app_icons(_app: &AppHandle, _pids: &[u32]) -> HashMap<u32, String> {
    HashMap::new()
}

// ── Taking it ───────────────────────────────────────────────────────────────

/// Take what was chosen. Checks that can refuse without ending the session
/// run first (the bar stays up with the reason); once the phase moves on,
/// every failure goes through [`fail_capture`].
async fn select_inner(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let CapturePhase::Selecting { kind, .. } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    if kind == CaptureKind::Recording
        && let Some(refusal) = super::screenshot::space_refusal(super::screenshot::available_space(&super::screenshot::capture_tmp_root()?))
    {
        return Err(refusal);
    }
    // The camera the recording keeps, whatever the options say later. Set
    // before the phase moves on, so the window is never closed in between.
    let camera_shape = match kind {
        CaptureKind::Recording => bar::load_options(state.pool()?)
            .await?
            .for_system(camera_only_supported())
            .camera_shape(kind),
        CaptureKind::Screenshot => None,
    };
    *lock(&state.capture.recording_camera) = camera_shape;
    advance(app, &state.capture, CaptureEvent::Selected)?;
    *lock(&state.capture.pending) = None;
    close_overlays(app);
    // The overlays took the keyboard; the app being captured gets it back.
    hand_focus_back(app, &state.capture);

    let taken = match kind {
        CaptureKind::Screenshot => finish_screenshot(app, selection).await,
        CaptureKind::Recording => {
            *lock(&state.capture.selection) = Some(selection);
            // The camera page learns the recording is under way.
            sync_camera(app).await;
            begin_recording(app, selection).await
        }
    };
    if let Err(e) = &taken {
        fail_capture(app, e).await;
    }
    taken
}

/// The pixels are read, the card opens with its picture, and only then is the
/// PNG written: the card no longer waits for an encode and a second decode.
/// Failures return to [`select_inner`], which ends the session.
async fn finish_screenshot(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    // A pill prepared while this session was a recording is not needed.
    close_controls(app);
    let clear = state.capture.ui_in_grabs.load(Ordering::SeqCst);
    if clear {
        clear_screen_for_grab(app).await;
    }
    let taken = take_screenshot(selection, clear).await;
    restore_main_window(app, &state.capture);
    let (image, thumbnail, path) = taken?;
    let card_id = open_preview(app, CaptureKind::Screenshot, &path, thumbnail).await;

    let written = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || super::screenshot::save_png(&image, &path))
            .await
            .map_err(|e| AppError::Other(format!("capture task failed: {e}")))
            .and_then(|r| r)
    };
    // The session ends here: the file exists, and the card owns the upload.
    let captured = written.and_then(|()| advance(app, &state.capture, CaptureEvent::Captured).map(|_| ()));
    if let Err(e) = captured {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
        close_preview(app, &state.capture);
        return Err(e);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
    });
    Ok(())
}

/// Start the recorder on `selection`. Failures return to the caller, which
/// ends the session through [`fail_capture`]; a session cancelled while the
/// recorder was starting ends quietly, with the recorder cancelled.
async fn begin_recording(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let saved = bar::load_options(state.pool()?).await.unwrap_or_default();
    let options = RecordOptions {
        microphone: saved.microphone && recording::microphone_supported(),
        microphone_device: saved.microphone_device.clone(),
        show_clicks: saved.show_clicks && recording::show_clicks_supported(),
        system_audio: saved.system_audio && super::support::surfaces().system_audio,
        camera_window: filmed_camera_window(&state.capture),
    };
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    *lock(&state.capture.recording_dir) = Some(dir.clone());
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

    let started = tauri::async_runtime::spawn_blocking(move || recording::start(selection, &path, options))
        .await
        .map_err(|e| AppError::Other(format!("recording task failed: {e}")))
        .and_then(|r| r);

    let poster = poster_task.await.ok().flatten();
    *lock(&state.capture.poster) = poster;
    let recorder = started?;

    if let Err(orphan) = state.capture.adopt_recorder(recorder, |e| emit_phase(app, e)) {
        // Cancelled (or ended) while the recorder was starting. It must not
        // keep recording the screen with no pill and nothing to stop it.
        let dir = lock(&state.capture.recording_dir).take();
        discard_recording(Some(orphan), dir).await;
        close_controls(app);
        end_camera(app).await;
        return Ok(());
    }
    // The main window stays hidden until the recording ends: it would be in
    // the video, and it would take the keyboard from the app being recorded.
    if let Err(e) = open_controls(app, true) {
        tracing::warn!(error = %e, "recording controls could not open");
    }
    spawn_tick_loop(app.clone());
    Ok(())
}

/// The bubble's window number, for a window recording to film it too: set
/// when this recording has a bubble (hidden from the pill or not, since it
/// can be shown again) and the window's number is known.
fn filmed_camera_window(state: &CaptureState) -> Option<u32> {
    if *lock(&state.recording_camera) != Some(CameraShape::Bubble) {
        return None;
    }
    u32::try_from(state.camera_window_number.load(Ordering::SeqCst)).ok().filter(|n| *n > 0)
}

/// The elapsed-time ticks while a recording runs. Each tick reads the
/// recorder's clock and moves the phase; the loop ends when the recording
/// does. Per-tick checks go in [`tick_once`].
fn spawn_tick_loop(app: AppHandle) {
    let state = app.state::<AppState>();
    state.capture.stop_ticks();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    *lock(&state.capture.tick_cancel) = Some(tx);
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = &mut rx => break,
                _ = interval.tick() => {
                    if tick_once(&app) == Tick::Done {
                        break;
                    }
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tick {
    Continue,
    Done,
}

fn tick_once(app: &AppHandle) -> Tick {
    let state = app.state::<AppState>();
    // `try_lock`: a pause or resume holds the recorder while the helper
    // answers (up to seconds). The tick skips a beat rather than blocking an
    // async worker for that long.
    let (elapsed, died) = match state.capture.recorder.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(r) => (r.elapsed_secs(), r.take_death()),
            None => return Tick::Done,
        },
        Err(std::sync::TryLockError::Poisoned(p)) => match p.into_inner().as_ref() {
            Some(r) => (r.elapsed_secs(), r.take_death()),
            None => return Tick::Done,
        },
        Err(std::sync::TryLockError::WouldBlock) => return Tick::Continue,
    };
    // The recording ended on its own (display gone, helper crashed): end the
    // session as Stop would, delivering what was saved, instead of counting
    // on. Spawned, because `stop_inner` stops this very loop.
    if let Some(e) = died {
        tracing::warn!(error = %e, "recording ended on its own; saving what was recorded");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = stop_inner(&app).await {
                tracing::warn!(error = %e, "could not save the recording that ended on its own");
            }
        });
        return Tick::Done;
    }
    if !matches!(state.capture.current(), CapturePhase::Recording { .. } | CapturePhase::Paused { .. }) {
        return Tick::Done;
    }
    let _ = advance(app, &state.capture, CaptureEvent::Tick { elapsed_secs: elapsed });
    Tick::Continue
}

/// Where Windows could not keep the capture UI out of the picture: wait for
/// the overlays to be gone (they were destroyed, which the event loop does
/// a moment later) and hide the card, so nothing of Hippius is on screen
/// when it is read. The compositor is settled in the grab itself.
async fn clear_screen_for_grab(app: &AppHandle) {
    if let Some(card) = app.get_webview_window(PREVIEW_LABEL)
        && card.is_visible().unwrap_or(false)
    {
        let _ = card.hide();
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while app.webview_windows().keys().any(|label| label.starts_with(OVERLAY_LABEL_PREFIX)) && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// Whether the system will keep `window` out of screen captures, read back
/// from the window itself: `GetWindowDisplayAffinity` must say
/// `WDA_EXCLUDEFROMCAPTURE` on Windows. macOS's `sharingType = none` holds
/// wherever the app runs.
#[cfg(windows)]
fn kept_out_of_captures(window: &tauri::WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let mut affinity = 0u32;
    // SAFETY: a live top-level window of this process; the call only writes
    // the affinity into `affinity`. Tauri's HWND comes from another version
    // of the `windows` crate, so it crosses as the raw handle it wraps.
    let read = unsafe { GetWindowDisplayAffinity(HWND(hwnd.0), &raw mut affinity) };
    read.is_ok() && affinity == WDA_EXCLUDEFROMCAPTURE.0
}

#[cfg(not(windows))]
fn kept_out_of_captures(_window: &tauri::WebviewWindow) -> bool {
    true
}

/// Give the compositor two frames to take closed windows off the screen
/// before it is read (`DwmFlush` waits for the next composition pass).
#[cfg(windows)]
fn settle_compositor() {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    for _ in 0..2 {
        // SAFETY: no arguments; blocks this (blocking-pool) thread until DWM
        // has composed a frame.
        if unsafe { DwmFlush() }.is_err() {
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    }
}

#[cfg(not(windows))]
fn settle_compositor() {}

/// The screenshot in memory, its card picture, and where it will be written.
/// `clear`: the capture UI could show in the picture, so the compositor is
/// settled first (see [`clear_screen_for_grab`]).
async fn take_screenshot(selection: Selection, clear: bool) -> Result<(image::RgbaImage, Option<String>, PathBuf)> {
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let name = super::naming::capture_file_name(CaptureKind::Screenshot, chrono::Local::now().naive_local());
    let path = dir.join(name);
    let taken = tauri::async_runtime::spawn_blocking(move || {
        if clear {
            settle_compositor();
        }
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

// ── Delivering ──────────────────────────────────────────────────────────────

/// Upload the capture and mint its link, then say how it went: on the preview
/// card when one is showing (`card_id`), and as a system notification only
/// when the upload failed, since the card already shows a success.
///
/// Two steps, each told to the card as it happens: the file is put in the
/// drive (a synced capture is then followed in the sync queue at once), and
/// only then is its link made. The card used to hear nothing until both were
/// done, so it said "Preparing upload" through the whole upload and the mint.
///
/// A card goes to the drive it names (Retry included), even if the capture
/// drive was changed since.
async fn deliver_and_announce(app: &AppHandle, path: &Path, card_id: Option<u64>) {
    let state = app.state::<AppState>();
    let started_ms = chrono::Utc::now().timestamp_millis();
    let card_destination = card_id.and_then(|id| {
        lock(&state.capture.preview)
            .as_ref()
            .filter(|c| c.id == id)
            .map(|c| c.destination.clone())
    });
    let outcome = async {
        let account_id = state.current_account_id()?;
        let pool = state.pool()?;
        let destination = match card_destination {
            Some(d) => d,
            None => destination::load(pool, &account_id)
                .await?
                .ok_or(AppError::NotReady(NotReadyKind::CaptureDestinationUnset))?,
        };
        let mint_link = bar::load_options(pool).await.map_or(true, |o| o.copy_link);
        let placed = super::deliver::place(&state, app.clone(), &account_id, &destination, path).await?;
        Ok::<_, AppError>((account_id, destination, mint_link, placed))
    }
    .await;

    match outcome {
        Ok((account_id, destination, mint_link, placed)) => {
            announce_placed(app, card_id, &destination, &placed, mint_link, started_ms);
            let minted = if mint_link {
                super::deliver::link_for(&state, &account_id, &destination, &placed).await
            } else {
                super::deliver::Minted::default()
            };
            let delivered = super::deliver::Delivered::from_parts(&placed, &minted, &destination.display_name);
            let copied = copy_link_to_clipboard(app, delivered.share_url.as_deref());
            // The upload landed (or, synced, the file is in the drive's own
            // folder), so the temp copy has served its purpose, unless a
            // direct upload still needs it to make a link later.
            let keep = super::deliver::keep_temp_after_upload(delivered.via_sync, delivered.share_url.is_some());
            if !keep && let Some(dir) = path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = app.emit(DELIVERED_EVENT, &delivered);
            let shown = card_id.is_some_and(|id| announce_link(app, &state.capture, id, &delivered, copied, keep));
            if !shown {
                let (title, body) = super::deliver::delivered_notice(&delivered);
                notify(app, title, body);
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "capture could not be delivered; kept on disk");
            let message = super::deliver::failure_copy(&e);
            let shown = card_id.is_some_and(|id| {
                update_card(app, &state.capture, id, |card| {
                    card.status = PreviewStatus::Failed {
                        message: message.clone(),
                        reason: super::deliver::failure_reason(&e),
                        retryable: path.exists(),
                    };
                })
            });
            let _ = app.emit(
                FAILED_EVENT,
                FailedPayload {
                    message,
                    card_showing: shown,
                },
            );
            let (title, body) = super::deliver::failed_notice(&e, shown);
            notify(app, title, body);
        }
    }
}

fn notify(app: &AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "capture notification not shown");
    }
}

/// Put `url` on the clipboard; whether it got there.
fn copy_link_to_clipboard(app: &AppHandle, url: Option<&str>) -> bool {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let Some(url) = url else { return false };
    match app.clipboard().write_text(url.to_string()) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(error = %e, "capture link minted but not copied");
            false
        }
    }
}

/// The file is in the drive: the card says so at once. A synced capture is
/// `syncing` and its card follows the engine from now on (the upload may
/// well finish before the link does); a direct upload is already on the
/// server. The link, when one is wanted, shows as being made.
fn announce_placed(
    app: &AppHandle,
    card_id: Option<u64>,
    destination: &CaptureDestination,
    placed: &super::deliver::Placed,
    mint_link: bool,
    started_ms: i64,
) {
    let Some(id) = card_id else { return };
    let state = app.state::<AppState>();
    let rel_path = super::preview::rel_path_for(&placed.file_name);
    update_card(app, &state.capture, id, |card| {
        card.status = if placed.via_sync {
            PreviewStatus::Syncing {
                link_copied: false,
                link_error: None,
            }
        } else {
            PreviewStatus::Uploaded {
                link_copied: false,
                link_error: None,
            }
        };
        card.link = if mint_link { LinkState::Creating } else { LinkState::None };
        card.placed_path = Some(placed.placed.clone());
        // A capture moved into a synced folder may have been renamed
        // ("Shot (2).png"); the card follows that name.
        card.file_name.clone_from(&placed.file_name);
        card.rel_path.clone_from(&rel_path);
    });
    if placed.via_sync {
        spawn_sync_follow(app.clone(), id, destination.label.clone(), rel_path, started_ms);
    }
}

/// The link is made (or not): the card says which, keeping whatever the
/// upload reached meanwhile. Returns whether a card window is there to show it.
fn announce_link(app: &AppHandle, state: &CaptureState, id: u64, delivered: &super::deliver::Delivered, copied: bool, keep: bool) -> bool {
    let link = match (&delivered.share_url, &delivered.link_error) {
        (Some(_), _) => LinkState::Public { copied },
        (None, Some(message)) => LinkState::Failed { message: message.clone() },
        (None, None) => LinkState::None,
    };
    let placed = (delivered.via_sync || keep).then(|| delivered.placed.clone());
    update_card(app, state, id, |card| {
        card.status = with_link_fields(&card.status, copied, delivered.link_error.clone());
        card.share_url.clone_from(&delivered.share_url);
        card.share_token.clone_from(&delivered.share_token);
        card.link = link;
        card.placed_path = placed;
    })
}

/// Follow the sync engine for a capture delivered into a synced folder, and
/// move its card to Uploaded (or Failed) from Rust. The file is matched by
/// the drive and its path in it, never by its name alone, and the engine is
/// asked everywhere it answers (`sync_facts`): the live row, the finished
/// list (a small file finishes in seconds and leaves the session) and the
/// set of files it knows are on the server. A card with a public link whose
/// file the engine lost track of is finished by the bounded fallback in
/// [`super::preview::link_fallback_applies`].
fn spawn_sync_follow(app: AppHandle, id: u64, label: String, rel_path: String, since_ms: i64) {
    tauri::async_runtime::spawn(async move {
        let started = tokio::time::Instant::now();
        let deadline = started + SYNC_FOLLOW_LIMIT;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if tokio::time::Instant::now() > deadline {
                break;
            }
            let state = app.state::<AppState>();
            let Some(card) = lock(&state.capture.preview).clone().filter(|c| c.id == id) else {
                break;
            };
            if !matches!(
                card.status,
                PreviewStatus::Syncing { .. } | PreviewStatus::Failed { retryable: false, .. }
            ) {
                break;
            }
            let mut row = sync_facts(&state.sync, &label, &rel_path, since_ms).row();
            if super::preview::link_fallback_applies(&card, &row, started.elapsed(), state.sync.is_any_sync_in_progress()) {
                tracing::info!(card = id, "capture card finished by its link: the sync engine has no row for it");
                row = super::preview::SyncRow::Completed;
            }
            if let Some(next) = super::preview::status_after_sync_row(&card, &row) {
                let done = matches!(next, PreviewStatus::Uploaded { .. });
                update_card(&app, &state.capture, id, |c| c.status = next);
                if done {
                    break;
                }
            }
        }
    });
}

/// What the engine says about `rel_path` on `label`: its row in the live
/// session, a finished upload of it since `since_ms`, and whether its set of
/// files on the server holds it.
fn sync_facts(sync: &hcfs_client::engine::runner::SyncRunner, label: &str, rel_path: &str, since_ms: i64) -> super::preview::SyncFacts {
    use super::preview::{SyncFacts, SyncRow, same_drive_path};
    use hcfs_client::engine::progress::state::{FileAction, FileStatus};
    use unicode_normalization::UnicodeNormalization;

    // An upload's row reads `Encrypt` while it is being encrypted.
    let upload = |a: &FileAction| matches!(a, FileAction::Upload | FileAction::Encrypt);
    let (live, finished) = {
        let progress = sync.progress.lock_state();
        let live = progress
            .current_session
            .as_ref()
            .and_then(|s| {
                s.files
                    .values()
                    .find(|f| &*f.label == label && upload(&f.action) && same_drive_path(&f.path, rel_path))
            })
            .map(|file| match file.status {
                FileStatus::Completed => SyncRow::Completed,
                FileStatus::Error => SyncRow::Failed(file.error.as_deref().map(str::to_string)),
                _ => SyncRow::Working,
            });
        let finished = progress
            .recent_files
            .iter()
            .any(|r| &*r.label == label && upload(&r.action) && r.completed_at >= since_ms && same_drive_path(&r.path, rel_path));
        (live, finished)
    };
    // The set is keyed by the engine's own spelling: ours (NFC) or macOS's
    // decomposed one. Looked up, never scanned (it can hold every file).
    let decomposed: String = rel_path.nfd().collect();
    let on_server =
        crate::finder_bridge::badges::is_synced(sync, label, rel_path) || crate::finder_bridge::badges::is_synced(sync, label, &decomposed);
    SyncFacts { live, finished, on_server }
}

// ── Recording controls ──────────────────────────────────────────────────────

/// Run `f` on the live recorder off the async workers: the helper can take
/// seconds to answer, and the recorder stays locked meanwhile.
async fn with_recorder(app: &AppHandle, f: impl FnOnce(&mut dyn Recorder) -> Result<()> + Send + 'static) -> Result<()> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut guard = lock(&state.capture.recorder);
        let recorder = guard
            .as_mut()
            .ok_or_else(|| AppError::Validation("No recording is in progress.".into()))?;
        f(recorder.as_mut())
    })
    .await
    .map_err(|e| AppError::Other(format!("recording task failed: {e}")))?
}

#[tauri::command]
pub async fn capture_pause(app: AppHandle) -> Result<()> {
    with_recorder(&app, |r| r.pause()).await?;
    let state = app.state::<AppState>();
    advance(&app, &state.capture, CaptureEvent::Pause)?;
    Ok(())
}

#[tauri::command]
pub async fn capture_resume(app: AppHandle) -> Result<()> {
    with_recorder(&app, |r| r.resume()).await?;
    let state = app.state::<AppState>();
    advance(&app, &state.capture, CaptureEvent::Resume)?;
    Ok(())
}

#[tauri::command]
pub async fn capture_stop(app: AppHandle) -> Result<()> {
    stop_inner(&app).await
}

/// Stop and save the recording (the pill, the tray, the shortcut).
///
/// The recorder is stopped BEFORE the camera window goes: a camera-only
/// recording is a recording of that very window, and closing it first ended
/// the stream with the file still open.
pub(crate) async fn stop_inner(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    advance(app, &state.capture, CaptureEvent::Stop)?;
    state.capture.stop_ticks();
    // The pill goes at once (it is never filmed); the camera stays until the
    // file is closed.
    hide_controls(app);
    let Some(recorder) = state.capture.take_recorder() else {
        let e = AppError::Validation("No recording is in progress.".into());
        fail_capture(app, &e).await;
        return Err(e);
    };
    let stopped = tauri::async_runtime::spawn_blocking(move || recorder.stop())
        .await
        .map_err(|e| AppError::Other(format!("stop task failed: {e}")))
        .and_then(|r| r);
    close_controls(app);
    end_camera(app).await;
    let path = match stopped {
        Ok(path) => path,
        Err(e) => {
            fail_capture(app, &e).await;
            return Err(e);
        }
    };
    // The session ends here: the file exists, and the card owns the upload.
    if let Err(e) = advance(app, &state.capture, CaptureEvent::Captured) {
        fail_capture(app, &e).await;
        return Err(e);
    }
    lock(&state.capture.recording_dir).take();
    lock(&state.capture.selection).take();
    restore_main_window(app, &state.capture);

    let poster = lock(&state.capture.poster).take();
    let card_id = open_preview(app, CaptureKind::Recording, &path, poster).await;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn capture_cancel(app: AppHandle) -> Result<()> {
    cancel_inner(&app).await
}

/// Close the bar, or throw a recording away. Refused while a recording is
/// being saved: the stop task owns the file by then.
pub(crate) async fn cancel_inner(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    match advance(app, &state.capture, CaptureEvent::Cancel) {
        Ok(_) => {}
        // Escape can arrive from more than one overlay; the second finds the
        // session already idle, which is what it asked for.
        Err(_) if state.capture.current() == CapturePhase::Idle => {
            close_overlays(app);
            return Ok(());
        }
        Err(e) => return Err(e),
    }
    let (recorder, dir) = state.capture.take_leftovers();
    close_overlays(app);
    close_controls(app);
    discard_recording(recorder, dir).await;
    *lock(&state.capture.pending) = None;
    lock(&state.capture.selection).take();
    drop_unused_preview(app, &state.capture);
    restore_main_window(app, &state.capture);
    hand_focus_back(app, &state.capture);
    end_camera(app).await;
    Ok(())
}

/// Throw the recording away and start again on the same selection, with the
/// same camera. The pill says "Starting recording…" meanwhile.
#[tauri::command]
pub async fn capture_restart(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let selection = (*lock(&state.capture.selection)).ok_or_else(|| AppError::Validation("No recording is in progress.".into()))?;
    advance(&app, &state.capture, CaptureEvent::Restart)?;
    let (recorder, dir) = state.capture.take_leftovers();
    discard_recording(recorder, dir).await;
    let started = begin_recording(&app, selection).await;
    if let Err(e) = &started {
        fail_capture(&app, e).await;
    }
    started
}

/// The phase now, numbered like `capture_state_changed`, so a surface that
/// seeds itself from this can drop an older event that arrives after it.
#[tauri::command]
pub fn capture_state(state: tauri::State<'_, AppState>) -> PhaseEvent {
    state.capture.snapshot()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSupport {
    pub supported: bool,
    /// Whether Record actions should be offered (helper present + OS floor).
    pub recording: bool,
    /// Whether camera only (screen off) may be offered.
    pub camera_only: bool,
    pub screen_recording_permission: bool,
    /// What System Settings calls the Screen Recording pane on this Mac
    /// ("Screen & System Audio Recording" from macOS 14); `None` off macOS.
    pub permission_pane: Option<String>,
    /// `recordingUnavailable` (why `recording` is false) and Rust's line for it.
    #[serde(flatten)]
    pub recording_availability: recording::RecordingAvailability,
    /// What this platform's surfaces may offer: selection, modes, timer,
    /// system audio, the microphone's line and the shortcut.
    #[serde(flatten)]
    pub surfaces: super::support::Surfaces,
}

#[tauri::command]
pub fn capture_support() -> CaptureSupport {
    CaptureSupport {
        supported: capture_supported(),
        recording: recording::recording_supported(),
        camera_only: camera_only_supported(),
        screen_recording_permission: super::permissions::screen_capture_granted(),
        permission_pane: super::permissions::permission_pane_name(cfg!(target_os = "macos"), super::permissions::macos_major()).map(str::to_string),
        recording_availability: recording::RecordingAvailability::now(),
        surfaces: super::support::surfaces(),
    }
}

#[tauri::command]
pub fn capture_open_permission_settings(app: AppHandle) -> Result<()> {
    open_permission_settings(&app)
}

#[cfg(target_os = "macos")]
fn open_permission_settings(app: &AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(super::permissions::SCREEN_RECORDING_SETTINGS_URL, None::<&str>)
        .map_err(|e| AppError::Other(format!("Could not open System Settings: {e}")))
}

#[cfg(not(target_os = "macos"))]
fn open_permission_settings(_app: &AppHandle) -> Result<()> {
    Err(AppError::Validation("Screen recording permission is only managed on macOS.".into()))
}

/// Read a permission preference; an empty value is a cleared one.
async fn permission_pref(pool: &sqlx::SqlitePool, key: &str) -> Result<Option<String>> {
    Ok(super::permission_flow::stored(
        crate::utils::preferences::get_user_preference_internal(pool, key).await?,
    ))
}

/// Ask macOS, off the async runtime. Shows the prompt only when macOS has no
/// answer on record for this build (never asked, or its entry was removed);
/// otherwise returns at once without UI. Either way it leaves Hippius in the
/// Screen Recording list, which is what spares the user the "+" button.
async fn ask_macos() {
    let _ = tauri::async_runtime::spawn_blocking(super::permissions::request_screen_capture).await;
}

/// Where the permission stands for the dialog: granted, not yet asked for
/// this build, asked, or stale (see [`super::permission_flow`]). Seeing the
/// grant clears the relaunch marker, so a later revoke is not read as stale.
#[tauri::command]
pub async fn capture_permission_status(state: tauri::State<'_, AppState>) -> Result<super::permission_flow::PermissionStatus> {
    use super::permission_flow::{PermissionState, PermissionStatus, RELAUNCHED_KEY, current_signature, permission_state};
    let pool = state.pool()?;
    let signature = current_signature();
    let build = signature.key();
    let granted = super::permissions::screen_capture_granted();
    let relaunched = permission_pref(pool, RELAUNCHED_KEY).await?;
    let asked = permission_pref(pool, super::permission_flow::ASKED_KEY).await?;
    let status = permission_state(granted, asked.as_deref(), relaunched.as_deref(), &build);
    if status == PermissionState::Granted && relaunched.is_some() {
        crate::utils::preferences::save_user_preference_internal(pool, RELAUNCHED_KEY, "").await?;
    }
    Ok(PermissionStatus {
        state: status,
        ad_hoc_signed: cfg!(target_os = "macos") && signature.is_ad_hoc(),
    })
}

/// The permission dialog's main button. The first press for this build asks
/// macOS, which shows its own prompt and adds Hippius to the list; later
/// presses open the pane in System Settings, since asking again shows
/// nothing. "This build" is the signature TCC keys the grant by, so a
/// rebuild of an ad hoc app, whose grant TCC has forgotten, is asked again.
///
/// The Settings path asks macOS first as well. It shows nothing while macOS
/// has an answer on record, and puts Hippius back into the list when the
/// entry was removed since (a `tccutil reset`, the minus button), which a
/// stored flag cannot see.
#[tauri::command]
pub async fn capture_request_permission(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<super::permissions::PermissionRequest> {
    use super::permission_flow::{ASKED_KEY, current_signature};
    use super::permissions::{PermissionRequest, next_request_step};
    let pool = state.pool()?;
    let build = current_signature().key();
    let asked = permission_pref(pool, ASKED_KEY).await?.as_deref() == Some(build.as_str());
    let step = next_request_step(super::permissions::screen_capture_granted(), asked);
    match step {
        PermissionRequest::Granted => {}
        PermissionRequest::Prompted => {
            crate::utils::preferences::save_user_preference_internal(pool, ASKED_KEY, &build).await?;
            ask_macos().await;
        }
        PermissionRequest::OpenedSettings => {
            ask_macos().await;
            open_permission_settings(&app)?;
        }
    }
    Ok(step)
}

/// The stale-entry fix: clear Hippius's own Screen Recording entry with
/// `tccutil reset ScreenCapture <bundle id>` (the user's own app needs no
/// privileges, and no other app or service is touched), then ask macOS
/// afresh so its prompt adds this build back. When the reset fails (a dev
/// binary outside a bundle, a macOS that refuses it) System Settings is
/// opened as well and the dialog tells the user to use the minus button.
#[tauri::command]
pub async fn capture_reset_permission(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<super::permissions::PermissionRequest> {
    reset_permission(&state, &app).await
}

#[cfg(target_os = "macos")]
async fn reset_permission(state: &AppState, app: &AppHandle) -> Result<super::permissions::PermissionRequest> {
    use super::permission_flow::{ASKED_KEY, RELAUNCHED_KEY, current_signature, tccutil_reset_args};
    use super::permissions::PermissionRequest;
    let pool = state.pool()?;
    let bundle_id = app.config().identifier.clone();
    let reset = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/tccutil")
            .args(tccutil_reset_args(&bundle_id))
            .output()
    })
    .await;
    let ok = match reset {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            tracing::warn!("capture: tccutil reset failed: {}", String::from_utf8_lossy(&out.stderr).trim());
            false
        }
        Ok(Err(e)) => {
            tracing::warn!("capture: could not run tccutil: {e}");
            false
        }
        Err(e) => {
            tracing::warn!("capture: tccutil task failed: {e}");
            false
        }
    };
    // Either way the stale state has been dealt with: a later press is an
    // ordinary "asked" press, which asks macOS before opening the pane and so
    // re-adds an entry the user removed by hand.
    crate::utils::preferences::save_user_preference_internal(pool, RELAUNCHED_KEY, "").await?;
    crate::utils::preferences::save_user_preference_internal(pool, ASKED_KEY, &current_signature().key()).await?;
    ask_macos().await;
    if !ok {
        open_permission_settings(app)?;
        return Ok(PermissionRequest::OpenedSettings);
    }
    Ok(PermissionRequest::Prompted)
}

#[cfg(not(target_os = "macos"))]
async fn reset_permission(_state: &AppState, _app: &AppHandle) -> Result<super::permissions::PermissionRequest> {
    Err(AppError::Validation("Screen recording permission is only managed on macOS.".into()))
}

/// "Relaunch Hippius": macOS applies a new Screen Recording grant only to a
/// fresh process. Remembers that this build was relaunched for the grant
/// (so still denied afterwards reads as the stale entry, not as "asked"),
/// then restarts through Tauri, which hands the single-instance socket over
/// before the new process starts.
#[tauri::command]
pub async fn capture_relaunch_for_permission(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    if !super::permissions::screen_capture_granted() {
        let build = super::permission_flow::current_signature().key();
        crate::utils::preferences::save_user_preference_internal(state.pool()?, super::permission_flow::RELAUNCHED_KEY, &build).await?;
    }
    app.request_restart();
    Ok(())
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
/// A failed capture the card was showing is kept for the next capture.
async fn open_preview(app: &AppHandle, kind: CaptureKind, path: &Path, thumbnail: Option<String>) -> Option<u64> {
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
        rel_path: super::preview::rel_path_for(&file_name),
        file_name,
        drive_label: destination.label.clone(),
        drive_name: destination.display_name.clone(),
        remote,
        thumbnail,
        status: PreviewStatus::Uploading,
        link: LinkState::None,
        link_text: None,
        actions: super::preview::CardActions::default(),
        settled: false,
        share_url: None,
        share_token: None,
        file_path: path.to_path_buf(),
        placed_path: None,
        destination,
    }
    .refreshed();
    let replaced = lock(&state.capture.preview).replace(card.clone());
    if let Some(old) = replaced {
        settle_closed_card(&state.capture, old);
    }
    let display = lock(&state.capture.bar_display).clone();
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

/// Change card `id`, if it is still the card on screen, and tell the card.
/// Returns whether a card window is there to show it.
fn update_card(app: &AppHandle, state: &CaptureState, id: u64, change: impl FnOnce(&mut PreviewCard)) -> bool {
    let updated = {
        let mut guard = lock(&state.preview);
        let Some(card) = guard.as_mut().filter(|c| c.id == id) else {
            return false;
        };
        change(card);
        let refreshed = card.clone().refreshed();
        *card = refreshed.clone();
        refreshed
    };
    let _ = app.emit(PREVIEW_EVENT, Some(&updated));
    app.get_webview_window(PREVIEW_LABEL).is_some()
}

/// A card leaving the screen: a failed capture is kept to come back; one
/// that reached the drive gives up its temp copy.
fn settle_closed_card(state: &CaptureState, card: PreviewCard) {
    if card.is_parkable() {
        *lock(&state.parked) = Some(card);
    } else if card.temp_copy_done_with() {
        remove_temp_dir(&card.file_path);
    }
}

/// Remove the capture's own temp folder, and nothing else: only a
/// `capture-…` folder directly under the capture temp root.
fn remove_temp_dir(file: &Path) {
    let Some(dir) = file.parent() else { return };
    let ours = super::screenshot::capture_tmp_root().is_ok_and(|root| dir.parent() == Some(root.as_path()))
        && dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with("capture-"));
    if ours {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// At the start of a capture: a failed capture's card stays up (or comes
/// back), so a capture that did not upload is never silently dropped; any
/// other card makes way for the new one.
fn bring_back_failed_card(app: &AppHandle, state: &CaptureState) {
    let showing_failed = lock(&state.preview).as_ref().is_some_and(PreviewCard::is_parkable);
    if showing_failed {
        return;
    }
    close_preview(app, state);
    if let Some(card) = lock(&state.parked).take() {
        *lock(&state.preview) = Some(card);
    }
}

/// Put the current card (a failed one brought back) on screen.
fn show_card_if_any(app: &AppHandle, state: &CaptureState) {
    let card = lock(&state.preview).clone();
    if let Some(card) = card {
        let _ = app.emit(PREVIEW_EVENT, Some(&card));
        if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
            show_without_focus(&w);
        }
    }
}

/// Close the card's window if it was only prepared (no capture was taken).
fn drop_unused_preview(app: &AppHandle, state: &CaptureState) {
    let showing = lock(&state.preview).is_some();
    if !showing && let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
}

fn close_preview(app: &AppHandle, state: &CaptureState) {
    let card = lock(&state.preview).take();
    if let Some(card) = card {
        settle_closed_card(state, card);
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
    let window = WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App(route.into()))
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
        .inner_size(PREVIEW_WIDTH, PREVIEW_HEIGHT)
        .build()
        .map_err(|e| AppError::Other(format!("Could not open the capture preview: {e}")))?;
    if let Some(d) = display {
        let area = work_area(&app.state::<AppState>().capture, d);
        place(&window, card_frame(area), area.scale);
    }
    float_over_full_screen(&window);
    Ok(())
}

#[tauri::command]
pub fn capture_preview_context(state: tauri::State<'_, AppState>) -> Option<PreviewCard> {
    lock(&state.capture.preview).clone()
}

/// The card on screen, if its buttons allow `allowed`.
fn card_for(state: &CaptureState, allowed: impl Fn(&PreviewCard) -> bool, refusal: &str) -> Result<PreviewCard> {
    lock(&state.preview)
        .clone()
        .filter(|c| allowed(c))
        .ok_or_else(|| AppError::Validation(refusal.to_string()))
}

/// Copy link on the card: the link minted for this capture, again.
#[tauri::command]
pub fn capture_preview_copy_link(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let url = lock(&state.capture.preview)
        .as_ref()
        .and_then(|c| c.share_url.clone())
        .ok_or_else(|| AppError::Validation("This capture has no link yet.".into()))?;
    app.clipboard()
        .write_text(url)
        .map_err(|e| AppError::Other(format!("Could not copy the link: {e}")))
}

/// "Create link" on a card whose capture reached the drive without one (the
/// link failed, copying links is off, or it was revoked): mint it now through
/// the same share path, and copy it.
#[tauri::command]
pub async fn capture_preview_mint_link(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let card = card_for(&state.capture, |c| c.actions.mint_link, "This capture can't get a link right now.")?;
    let account_id = state.current_account_id()?;
    let source = match (&card.placed_path, card.remote) {
        (Some(placed), true) => super::deliver::LinkSource::External(placed.clone()),
        _ => super::deliver::LinkSource::Synced {
            label: card.drive_label.clone(),
            rel_path: card.rel_path.clone(),
        },
    };
    match super::deliver::mint(&state, &account_id, &source).await {
        Ok(link) => {
            let copied = app.clipboard().write_text(link.share_url.clone()).is_ok();
            update_card(&app, &state.capture, card.id, |c| {
                c.share_url = Some(link.share_url);
                c.share_token = Some(link.share_token);
                c.link = LinkState::Public { copied };
                c.status = with_link_fields(&c.status, copied, None);
            });
            Ok(())
        }
        Err(message) => {
            update_card(&app, &state.capture, card.id, |c| {
                c.link = LinkState::Failed { message: message.clone() };
                c.status = with_link_fields(&c.status, false, Some(message.clone()));
            });
            Err(AppError::Validation(message))
        }
    }
}

/// The status with its older link fields brought in line with the link.
fn with_link_fields(status: &PreviewStatus, link_copied: bool, link_error: Option<String>) -> PreviewStatus {
    match status {
        PreviewStatus::Uploaded { .. } => PreviewStatus::Uploaded { link_copied, link_error },
        PreviewStatus::Syncing { .. } => PreviewStatus::Syncing { link_copied, link_error },
        other => other.clone(),
    }
}

/// Revoke on the card: the public link this capture made stops working,
/// through the same revoke the Shares page uses.
#[tauri::command]
pub async fn capture_preview_revoke_link(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card = card_for(&state.capture, |c| c.actions.revoke_link, "This capture has no link to revoke.")?;
    let token = card
        .share_token
        .clone()
        .ok_or_else(|| AppError::Validation("This capture has no link to revoke.".into()))?;
    crate::shares::commands::hcfs_revoke_share(state.clone(), token).await?;
    update_card(&app, &state.capture, card.id, |c| {
        c.share_url = None;
        c.share_token = None;
        c.link = LinkState::Revoked;
        c.status = with_link_fields(&c.status, false, None);
    });
    Ok(())
}

/// Reveal in Finder / Show in Explorer: the capture's file in the drive's
/// synced folder on this machine.
#[tauri::command]
pub async fn capture_preview_reveal(state: tauri::State<'_, AppState>) -> Result<()> {
    let card = card_for(&state.capture, |c| c.actions.reveal, "This capture isn't in a folder on this computer.")?;
    let path = card
        .placed_path
        .ok_or_else(|| AppError::Validation("This capture isn't in a folder on this computer.".into()))?;
    tauri::async_runtime::spawn_blocking(move || crate::utils::reveal::reveal_path(&path))
        .await
        .map_err(|e| AppError::Other(format!("Reveal cancelled: {e}")))?
}

/// Throw away a capture that could not be uploaded: its file is deleted and
/// its card does not come back.
#[tauri::command]
pub fn capture_preview_discard(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card = card_for(&state.capture, |c| c.actions.discard, "There is nothing to discard.")?;
    lock(&state.capture.preview).take();
    lock(&state.capture.parked).take_if(|p| p.id == card.id);
    remove_temp_dir(&card.file_path);
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
    Ok(())
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
    let card = lock(&state.capture.preview)
        .clone()
        .ok_or_else(|| AppError::Validation("There is no capture to show.".into()))?;
    show_main_window(&app);
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

/// The card's Upgrade, offered when the upload failed because the plan is
/// full: the main window comes forward on the plans. The card stays, so the
/// capture can be retried once there is room.
#[tauri::command]
pub fn capture_preview_upgrade(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    card_for(&state.capture, |c| c.actions.upgrade, "There is no capture waiting for more storage.")?;
    show_main_window(&app);
    let _ = app.emit(OPEN_PLANS_EVENT, ());
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// The card closed itself (its timer, or ×). Only card `id`: a newer card that
/// opened in the meantime stays. A failed capture comes back on the next one.
#[tauri::command]
pub fn capture_preview_dismiss(state: tauri::State<'_, AppState>, app: AppHandle, id: u64) {
    let current = lock(&state.capture.preview).as_ref().map(|c| c.id);
    if current == Some(id) {
        close_preview(&app, &state.capture);
    }
}

/// Retry on a card whose upload failed: the same file, the same drive.
#[tauri::command]
pub fn capture_preview_retry(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card = {
        let mut g = lock(&state.capture.preview);
        let card = g
            .as_ref()
            .filter(|c| c.can_retry())
            .cloned()
            .ok_or_else(|| AppError::Validation("There is nothing to retry.".into()))?;
        let uploading = PreviewCard {
            status: PreviewStatus::Uploading,
            ..card
        }
        .refreshed();
        *g = Some(uploading.clone());
        uploading
    };
    lock(&state.capture.parked).take_if(|p| p.id == card.id);
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
    let problem = match shortcut::apply(&app, accelerator.as_deref()) {
        Ok(()) => None,
        Err(e) => {
            tracing::warn!(error = %e, "capture shortcut not registered");
            Some(shortcut_problem_text(&e))
        }
    };
    *lock(&state.capture.shortcut_problem) = problem;
    Ok(())
}

/// Rust's sentence for a shortcut that did not register, as Settings shows it.
fn shortcut_problem_text(e: &AppError) -> String {
    match e {
        AppError::Validation(message) => message.clone(),
        other => other.to_string(),
    }
}

#[tauri::command]
pub async fn capture_get_shortcut(state: tauri::State<'_, AppState>) -> Result<ShortcutSetting> {
    Ok(ShortcutSetting {
        accelerator: shortcut::load(state.pool()?).await?,
        default_accelerator: shortcut::DEFAULT_SHORTCUT.to_string(),
        problem: lock(&state.capture.shortcut_problem).clone(),
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
    lock(&state.capture.shortcut_problem).take();
    shortcut::save(pool, next).await
}

/// A press of the system-wide shortcut. It toggles (`shortcut::action_for`):
/// Stop and Cancel run here; Start goes through the main window so its
/// refusals reach the same dialogs as the Capture button.
pub fn on_shortcut(app: &AppHandle) {
    let state = app.state::<AppState>();
    let signed_in = state.current_account_id().is_ok();
    match shortcut::action_for(state.capture.current(), signed_in) {
        ShortcutAction::Start => {
            let _ = app.emit(shortcut::SHORTCUT_EVENT, ());
        }
        ShortcutAction::Stop => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = stop_inner(&app).await {
                    tracing::warn!(error = %e, "capture shortcut: stop refused");
                }
            });
        }
        ShortcutAction::Cancel => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = cancel_inner(&app).await {
                    tracing::warn!(error = %e, "capture shortcut: cancel refused");
                }
            });
        }
        ShortcutAction::ShowMainWindow => show_main_window(app),
        ShortcutAction::FocusCapture => focus_active_ui(app, &state.capture),
    }
}

/// Signing out: a capture still choosing or recording is cancelled (its
/// delivery would fail with no account, and nobody owns its pill), the cards
/// go (a failed capture must not come back for whoever signs in next), and
/// the shortcut is unregistered until the next sign-in registers it again.
/// A recording already being saved finishes on its own. Called from
/// `auth::logout::logout_full` before the session is cleared.
pub async fn end_for_logout(app: &AppHandle) {
    let state = app.state::<AppState>();
    if matches!(
        state.capture.current(),
        CapturePhase::Selecting { .. } | CapturePhase::Capturing { .. } | CapturePhase::Recording { .. } | CapturePhase::Paused { .. }
    ) && let Err(e) = cancel_inner(app).await
    {
        tracing::warn!(error = %e, "capture not cancelled at sign-out");
    }
    lock(&state.capture.parked).take();
    lock(&state.capture.preview).take();
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.close();
    }
    if let Err(e) = shortcut::apply(app, None) {
        tracing::warn!(error = %e, "capture shortcut not unregistered at sign-out");
    }
}

/// At launch: remove capture folders a crash or an abandoned start left
/// empty for a day, or holding only leftovers for a week. A folder holding a
/// capture (a recording the helper saved when the app died, a screenshot that
/// never uploaded) is never removed (`screenshot::is_orphan`). Runs on its
/// own thread; never delays start-up.
pub fn reclaim_capture_tmp_at_launch() {
    let spawned = std::thread::Builder::new().name("capture-tmp-reclaim".into()).spawn(|| {
        let Ok(root) = super::screenshot::capture_tmp_root() else { return };
        let removed = super::screenshot::reclaim_orphans(&root, std::time::SystemTime::now(), &[]);
        if removed > 0 {
            tracing::info!(removed, "removed old capture temp folders");
        }
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "capture temp folders not checked");
    }
}

// ---------------------------------------------------------------------------
// The camera window (`camera.rs` decides; this opens, moves and closes it).
// ---------------------------------------------------------------------------

/// Put the camera window in the shape the session wants now, or take it away,
/// and tell the camera page and the pill. Called after everything that can
/// change it: start, mode, options, the drawn area, Record, the pill's
/// toggle, stop, cancel. One at a time: two overlapping calls could leave a
/// camera window up after the session ended.
async fn sync_camera(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _serial = state.capture.camera_lock.lock().await;
    let options = match state.pool() {
        Ok(pool) => bar::load_options(pool).await.unwrap_or_default().for_system(camera_only_supported()),
        Err(_) => CaptureOptions::default(),
    };
    let recording = *lock(&state.capture.recording_camera);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    let phase = state.capture.current();
    let wanted = camera::wanted_shape(phase, &options, recording, hidden);
    let previous = std::mem::replace(&mut *lock(&state.capture.camera_shape), wanted);
    // In area mode the bubble goes inside the drawn area, or it is not filmed
    // (gliding there while choosing); when Record is pressed it jumps inside
    // whatever is recorded if it is not there already.
    let anchored = match wanted.and_then(|shape| area_bubble_frame(&state.capture, phase, shape, options.camera_size)) {
        Some((frame, scale)) => Some((frame, scale, true)),
        None => recording_bubble_frame(app, phase, wanted, options.camera_size)
            .await
            .map(|(frame, scale)| (frame, scale, false)),
    };
    let mid_recording = matches!(phase, CapturePhase::Recording { .. } | CapturePhase::Paused { .. });

    match (wanted, app.get_webview_window(CAMERA_LABEL)) {
        // Hidden from the pill mid-recording: ordered out, not closed, so it
        // keeps its window number (a window recording films the camera by
        // that number) and comes back where it was.
        (None, Some(window)) if mid_recording => {
            let _ = window.hide();
        }
        (None, Some(window)) => {
            let _ = window.close();
            state.capture.camera_window_number.store(0, Ordering::SeqCst);
        }
        (None, None) => {}
        (Some(shape), Some(window)) => {
            if let Some((frame, scale, animate)) = anchored {
                set_camera_frame(&window, frame, scale, animate);
            } else if previous != Some(shape) && !mid_recording {
                place_camera(app, &window, shape, options.camera_size);
            }
            show_without_focus(&window);
        }
        (Some(shape), None) => {
            if let Err(e) = open_camera_window(app, shape, options.camera_size, anchored.map(|(f, scale, _)| (f, scale))) {
                tracing::warn!(error = %e, "camera window could not open");
            }
        }
    }
    if wanted.is_none() {
        lock(&state.capture.bubble_frame).take();
    }
    let camera_state = camera_state_for(app, wanted, hidden, &options).await;
    let _ = app.emit(CAMERA_STATE_EVENT, camera_state);
}

/// Where the bubble goes while an area recording is being chosen: inside the
/// drawn area's bottom-left corner, in the area's display's points.
fn area_bubble_frame(state: &CaptureState, phase: CapturePhase, shape: CameraShape, size: CameraSize) -> Option<(camera::Frame, f64)> {
    let CapturePhase::Selecting {
        kind: CaptureKind::Recording,
        mode: CaptureMode::Area,
    } = phase
    else {
        return None;
    };
    if shape != CameraShape::Bubble {
        return None;
    }
    let Some(Selection::Area { display_id, rect }) = *lock(&state.pending) else {
        return None;
    };
    let display = lock(&state.displays).iter().find(|d| d.id == display_id).cloned()?;
    let origin = display_area(&display);
    let drawn = camera::Frame {
        x: origin.x + rect.x,
        y: origin.y + rect.y,
        width: rect.width,
        height: rect.height,
    };
    Some((camera::bubble_in_area(size, drawn), origin.scale))
}

/// Where the bubble jumps when Record is pressed: inside what is recorded
/// (the area, the window, or the recorded display), unless it is wholly
/// there already. Only at `Capturing` a recording with a bubble: while
/// recording it stays wherever the user drags it.
async fn recording_bubble_frame(app: &AppHandle, phase: CapturePhase, shape: Option<CameraShape>, size: CameraSize) -> Option<(camera::Frame, f64)> {
    let recording_starts = matches!(
        phase,
        CapturePhase::Capturing {
            kind: CaptureKind::Recording
        }
    );
    if !recording_starts || shape != Some(CameraShape::Bubble) {
        return None;
    }
    let state = app.state::<AppState>();
    let selection = (*lock(&state.capture.selection))?;
    let display_of = |id: u32| lock(&state.capture.displays).iter().find(|d| d.id == id).cloned();
    let (filmed, scale) = match selection {
        Selection::Area { display_id, rect } => {
            let origin = display_area(&display_of(display_id)?);
            let region = camera::Frame {
                x: origin.x + rect.x,
                y: origin.y + rect.y,
                width: rect.width,
                height: rect.height,
            };
            (camera::Filmed::Region(region), origin.scale)
        }
        Selection::Screen { display_id } => {
            let display = display_of(display_id)?;
            let area = display_area(&display);
            let usable = work_area(&state.capture, &display);
            (
                camera::Filmed::Display {
                    area: area.frame(),
                    usable: usable.frame(),
                },
                area.scale,
            )
        }
        Selection::Window { window_id } => {
            if !bar::WINDOW_RECORDING_ADDS_CAMERA {
                return None;
            }
            let frame = tauri::async_runtime::spawn_blocking(move || window_frame_blocking(window_id))
                .await
                .ok()
                .flatten()?;
            (camera::Filmed::Region(frame), 1.0)
        }
    };
    let current = app.get_webview_window(CAMERA_LABEL).and_then(|w| current_camera_frame(&w));
    camera::bubble_for_recording(current, size, filmed).map(|f| (f, scale))
}

/// A window's frame in global points, for placing the bubble inside it. The
/// only platform that adds the camera to a window recording is macOS, where
/// xcap's coordinates are already points.
#[cfg(target_os = "macos")]
fn window_frame_blocking(window_id: u32) -> Option<camera::Frame> {
    let f = super::targets::window_frame(window_id)?;
    Some(camera::Frame {
        x: f64::from(f.x),
        y: f64::from(f.y),
        width: f64::from(f.width),
        height: f64::from(f.height),
    })
}

#[cfg(not(target_os = "macos"))]
fn window_frame_blocking(_window_id: u32) -> Option<camera::Frame> {
    None
}

/// What the camera page and the pill are told: the shape, the chosen camera
/// by id AND name (the webview finds a platform-listed camera by name),
/// whether a recording is under way, and whether the camera is in the video.
async fn camera_state_for(app: &AppHandle, shape: Option<CameraShape>, hidden: bool, options: &CaptureOptions) -> CameraState {
    let state = app.state::<AppState>();
    let device_name = match &options.camera_device {
        Some(id) => camera_name(app, id).await,
        None => None,
    };
    let phase = state.capture.current();
    let camera_filmed = match (phase, shape) {
        (CapturePhase::Selecting { kind, mode }, _) => options.camera_filmed(kind, mode),
        (_, Some(CameraShape::Stage)) => true,
        // A window recording films that one window only.
        (_, Some(CameraShape::Bubble)) => !matches!(*lock(&state.capture.selection), Some(Selection::Window { .. })),
        (_, None) => false,
    };
    CameraState {
        shape,
        hidden,
        device_id: options.camera_device.clone(),
        device_name,
        size: options.camera_size,
        recording: camera::is_recording(phase),
        camera_filmed,
    }
}

/// The name of camera `id`, from the lists already read, else from the
/// system (once: the list is kept).
async fn camera_name(app: &AppHandle, id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let known = |list: &Mutex<Vec<CameraDevice>>| lock(list).iter().find(|c| c.id == id).map(|c| c.name.clone());
    if let Some(name) = known(&state.capture.native_cameras).or_else(|| known(&state.capture.cameras)) {
        return Some(name);
    }
    let listed = refresh_native_cameras(app).await;
    listed.into_iter().find(|c| c.id == id).map(|c| c.name)
}

/// Read the system's cameras again and keep the list.
async fn refresh_native_cameras(app: &AppHandle) -> Vec<CameraDevice> {
    let listed = tauri::async_runtime::spawn_blocking(recording::list_cameras).await.unwrap_or_default();
    lock(&app.state::<AppState>().capture.native_cameras).clone_from(&listed);
    listed
}

/// The recording is over (stopped, cancelled or failed): forget its camera.
async fn end_camera(app: &AppHandle) {
    let state = app.state::<AppState>();
    lock(&state.capture.recording_camera).take();
    state.capture.camera_hidden.store(false, Ordering::SeqCst);
    sync_camera(app).await;
}

/// The bar display's usable area, and its scale.
fn bar_work_area(app: &AppHandle) -> Option<(camera::Frame, f64)> {
    let state = app.state::<AppState>();
    let display = lock(&state.capture.bar_display).clone()?;
    let area = work_area(&state.capture, &display);
    Some((area.frame(), area.scale))
}

fn camera_frame(app: &AppHandle, shape: CameraShape, size: CameraSize) -> Option<(camera::Frame, f64)> {
    let (area, scale) = bar_work_area(app)?;
    Some((camera::frame(shape, size, area), scale))
}

fn place_camera(app: &AppHandle, window: &tauri::WebviewWindow, shape: CameraShape, size: CameraSize) {
    if let Some((f, scale)) = camera_frame(app, shape, size) {
        set_camera_frame(window, f, scale, false);
    }
}

/// Move and size the camera window in one step. On macOS `animate` lets AppKit
/// glide it there (`-[NSWindow setFrame:display:animate:]`), which is smoother
/// than any series of moves from here; elsewhere it jumps, and the page's own
/// fade covers it.
fn set_camera_frame(window: &tauri::WebviewWindow, f: camera::Frame, scale: f64, animate: bool) {
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
            place(window, f, scale);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = animate;
        place(window, f, scale);
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

fn open_camera_window(app: &AppHandle, shape: CameraShape, size: CameraSize, anchored: Option<(camera::Frame, f64)>) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let route = if cfg!(dev) { "capture-camera" } else { "capture-camera.html" };
    let builder = WebviewWindowBuilder::new(app, CAMERA_LABEL, WebviewUrl::App(route.into()))
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
    let window = builder.build().map_err(|e| AppError::Other(format!("Could not open the camera: {e}")))?;
    if let Some((f, scale)) = anchored.or_else(|| camera_frame(app, shape, size)) {
        place(&window, f, scale);
    }
    raise_camera(&window);
    show_without_focus(&window);
    remember_camera_window_number(app, &window);
    spawn_camera_hover_watch(app.clone());
    Ok(())
}

/// Read the camera window's system window number once, on the main thread,
/// without waiting for it: camera only records that window, and Record looks
/// it up from here instead of blocking on AppKit.
#[cfg(target_os = "macos")]
fn remember_camera_window_number(app: &AppHandle, window: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};
    let target = window.clone();
    let app = app.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns_window) = target.ns_window() {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: this window's live NSWindow, read on the main thread;
            // `windowNumber` only returns an integer.
            let n: isize = unsafe { msg_send![ns_window, windowNumber] };
            if let Ok(n) = u64::try_from(n) {
                app.state::<AppState>().capture.camera_window_number.store(n, Ordering::SeqCst);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn remember_camera_window_number(_app: &AppHandle, _window: &tauri::WebviewWindow) {}

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
/// recording is started with. Camera-only recordings record the stage. Read
/// from what the window reported when it opened; asked for (briefly) only if
/// that has not arrived yet.
#[cfg(target_os = "macos")]
async fn camera_window_id(app: &AppHandle) -> Option<u32> {
    use objc::{msg_send, sel, sel_impl};

    let known = app.state::<AppState>().capture.camera_window_number.load(Ordering::SeqCst);
    if known > 0 {
        return u32::try_from(known).ok();
    }
    let window = app.get_webview_window(CAMERA_LABEL)?;
    let target = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
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
    let number = tokio::time::timeout(std::time::Duration::from_millis(500), rx).await.ok()?.ok()??;
    u32::try_from(number).ok().filter(|n| *n > 0)
}

// Async to match the macOS version, which waits on the main thread.
#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)]
async fn camera_window_id(_app: &AppHandle) -> Option<u32> {
    None
}

/// The camera page's first read: the shape to draw and the device to open.
#[tauri::command]
pub async fn capture_camera_context(app: AppHandle) -> Result<CameraState> {
    let state = app.state::<AppState>();
    let options = bar::load_options(state.pool()?).await?.for_system(camera_only_supported());
    let shape = *lock(&state.capture.camera_shape);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    Ok(camera_state_for(&app, shape, hidden, &options).await)
}

/// The camera page found these cameras (its own `deviceId`s). The bar lists
/// them only where the system list is empty (see [`camera_list`]).
#[tauri::command]
pub fn capture_set_cameras(state: tauri::State<'_, AppState>, app: AppHandle, cameras: Vec<CameraDevice>) {
    let cameras = recording::tidy_devices(cameras);
    let native = lock(&state.capture.native_cameras).clone();
    {
        let mut g = lock(&state.capture.cameras);
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
    let webview = lock(&app.state::<AppState>().capture.cameras).clone();
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

    let shape = *lock(&state.capture.camera_shape);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    // The page restyles (round / 16:9) as the window starts to move.
    let camera_state = camera_state_for(&app, shape, hidden, &options).await;
    let _ = app.emit(CAMERA_STATE_EVENT, camera_state);

    // Only a bubble changes size; the camera-only stage is the recording.
    if shape != Some(CameraShape::Bubble) || previous == size {
        return Ok(size);
    }
    let (Some(window), Some((area, scale))) = (app.get_webview_window(CAMERA_LABEL), bar_work_area(&app)) else {
        return Ok(size);
    };
    let current = current_camera_frame(&window);
    let target = match camera::bubble_side(size) {
        None => {
            // Going full: remember where the bubble was, to go back there.
            if previous != CameraSize::Full {
                *lock(&state.capture.bubble_frame) = current;
            }
            camera::frame(CameraShape::Bubble, size, area)
        }
        Some(side) => {
            let from = if previous == CameraSize::Full {
                *lock(&state.capture.bubble_frame)
            } else {
                current
            };
            match from {
                Some(from) => camera::resize_bubble(from, side, area),
                None => camera::frame(CameraShape::Bubble, size, area),
            }
        }
    };
    set_camera_frame(&window, target, scale, true);
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
            if *lock(&state.capture.recording_camera) != Some(CameraShape::Bubble) {
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
    if *lock(&state.capture.recording_camera) != Some(CameraShape::Bubble) {
        return Err(AppError::Validation("This recording has no camera bubble to hide.".into()));
    }
    let was_hidden = state.capture.camera_hidden.fetch_xor(true, Ordering::SeqCst);
    sync_camera(&app).await;
    // Whether the bubble is on screen now.
    Ok(was_hidden)
}

/// The session's lifecycle over `CaptureState` with a fake recorder: what
/// happens between the phase moving and the windows following it. The
/// `AppHandle` half (windows, events) is pinned in `tests/capture_wiring.rs`.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    /// Windows' work area in physical pixels, as `read_work_areas` turns it
    /// into the area's own logical units.
    fn windows_area(x: i32, y: i32, width: u32, height: u32, scale: f64) -> LogicalArea {
        LogicalArea {
            x: f64::from(x) / scale,
            y: f64::from(y) / scale,
            width: f64::from(width) / scale,
            height: f64::from(height) / scale,
            scale,
        }
    }

    /// The card lands bottom-right of the work area in that monitor's own
    /// pixels, on a 150 % laptop and on the 100 % monitor beside it, with
    /// the taskbar at the bottom, the left or the top.
    #[test]
    fn the_card_sits_above_the_taskbar_in_each_monitors_own_pixels() {
        let margin = 16;
        // 150 % laptop, taskbar at the bottom (72 px tall at 150 %).
        let laptop = windows_area(0, 0, 2880, 1728, 1.5);
        let p = physical_frame(card_frame(laptop), laptop.scale);
        assert_eq!(p.width, 474, "316 points at 150 %");
        assert_eq!(p.height, 495, "330 points at 150 %");
        assert_eq!(p.x + i32::try_from(p.width).unwrap(), 2880 - margin * 3 / 2);
        assert_eq!(p.y + i32::try_from(p.height).unwrap(), 1728 - margin * 3 / 2);

        // 100 % monitor to its right, taskbar on the LEFT (work area starts
        // 48 px in): the card stays at the right edge.
        let monitor = windows_area(2880 + 48, 0, 1920 - 48, 1080, 1.0);
        let p = physical_frame(card_frame(monitor), monitor.scale);
        assert_eq!(p.x + i32::try_from(p.width).unwrap(), 2880 + 1920 - margin);
        assert_eq!(p.y + i32::try_from(p.height).unwrap(), 1080 - margin);

        // Taskbar at the TOP: the work area starts lower, and the card's
        // bottom is the display's bottom less the margin.
        let top_bar = windows_area(0, 48, 1920, 1080 - 48, 1.0);
        let p = physical_frame(card_frame(top_bar), top_bar.scale);
        assert_eq!(p.y + i32::try_from(p.height).unwrap(), 1080 - margin);
    }

    /// A monitor left of or above the primary has negative pixels; the card
    /// is still placed inside it, never on the primary.
    #[test]
    fn a_card_on_a_monitor_left_of_the_primary_stays_on_it() {
        let left = windows_area(-2560, -200, 2560, 1400, 1.25);
        let p = physical_frame(card_frame(left), left.scale);
        assert!(p.x < 0 && p.x > -2560, "{p:?}");
        assert_eq!(p.x + i32::try_from(p.width).unwrap(), -20, "16 points of margin at 125 %");
        // 330 points is 412.5 pixels at 125 %: within a pixel of the margin.
        assert!((p.y + i32::try_from(p.height).unwrap() - (1200 - 20)).abs() <= 1, "{p:?}");
    }

    /// A frame is never placed empty, whatever the scale.
    #[test]
    fn a_physical_frame_is_never_empty() {
        let tiny = camera::Frame {
            x: 0.0,
            y: 0.0,
            width: 0.2,
            height: 0.0,
        };
        let p = physical_frame(tiny, 1.0);
        assert_eq!((p.width, p.height), (1, 1));
    }

    #[derive(Default)]
    struct Calls {
        stop: AtomicUsize,
        cancel: AtomicUsize,
        pause: AtomicUsize,
    }

    struct FakeRecorder {
        calls: Arc<Calls>,
        panic_on_stop: bool,
        microphone: bool,
    }

    impl FakeRecorder {
        fn boxed(calls: &Arc<Calls>) -> Box<dyn Recorder> {
            Box::new(Self {
                calls: calls.clone(),
                panic_on_stop: false,
                microphone: true,
            })
        }
    }

    impl Recorder for FakeRecorder {
        fn pause(&mut self) -> Result<()> {
            self.calls.pause.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn resume(&mut self) -> Result<()> {
            Ok(())
        }
        fn stop(self: Box<Self>) -> Result<PathBuf> {
            self.calls.stop.fetch_add(1, Ordering::SeqCst);
            assert!(!self.panic_on_stop, "the helper crashed");
            Ok(PathBuf::from("/tmp/capture-x/Recording.mp4"))
        }
        fn cancel(self: Box<Self>) -> Result<()> {
            self.calls.cancel.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn elapsed_secs(&self) -> u64 {
            7
        }
        fn microphone(&self) -> bool {
            self.microphone
        }
    }

    const START_REC: CaptureEvent = CaptureEvent::Start {
        kind: CaptureKind::Recording,
        mode: CaptureMode::Screen,
    };

    fn quiet(_: PhaseEvent) {}

    /// A session at "Starting recording…": Record pressed, recorder starting.
    fn starting() -> CaptureState {
        let state = CaptureState::default();
        state.apply(START_REC, quiet).unwrap();
        state.apply(CaptureEvent::Selected, quiet).unwrap();
        state
    }

    fn recording(calls: &Arc<Calls>) -> CaptureState {
        let state = starting();
        assert!(state.adopt_recorder(FakeRecorder::boxed(calls), quiet).is_ok());
        state
    }

    #[test]
    fn a_started_recorder_is_adopted_while_the_session_waits_for_it() {
        let calls = Arc::new(Calls::default());
        let state = starting();
        let mut seen = Vec::new();
        let Ok(phase) = state.adopt_recorder(FakeRecorder::boxed(&calls), |e| seen.push(e)) else {
            panic!("a waiting session adopts its recorder");
        };
        assert_eq!(
            phase,
            CapturePhase::Recording {
                elapsed_secs: 0,
                microphone: true
            }
        );
        assert_eq!(seen.len(), 1, "the new phase is broadcast");
        assert!(state.take_recorder().is_some());
    }

    /// A Cancel during "Starting recording…" must not leave the helper
    /// recording the screen with no pill and nothing to stop it.
    #[test]
    fn a_cancel_while_the_recorder_starts_hands_it_back_to_be_cancelled() {
        let calls = Arc::new(Calls::default());
        let state = starting();
        state.apply(CaptureEvent::Cancel, quiet).unwrap();
        let Err(orphan) = state.adopt_recorder(FakeRecorder::boxed(&calls), quiet) else {
            panic!("a cancelled session must not adopt the recorder");
        };
        orphan.cancel().unwrap();
        assert_eq!(calls.cancel.load(Ordering::SeqCst), 1);
        assert!(state.take_recorder().is_none(), "nothing is left recording");
        assert_eq!(state.current(), CapturePhase::Idle);
    }

    /// NT-18: the stop task owns the recorder once saving began.
    #[test]
    fn cancel_while_saving_is_refused_and_leaves_the_stop_to_finish() {
        let calls = Arc::new(Calls::default());
        let state = recording(&calls);
        state.apply(CaptureEvent::Stop, quiet).unwrap();
        let recorder = state.take_recorder().expect("the stop task takes it");
        assert!(state.apply(CaptureEvent::Cancel, quiet).is_err());
        assert_eq!(state.current(), CapturePhase::Finalizing);
        recorder.stop().unwrap();
        assert_eq!(calls.cancel.load(Ordering::SeqCst), 0);
        state.apply(CaptureEvent::Captured, quiet).unwrap();
        assert_eq!(state.current(), CapturePhase::Idle);
    }

    /// A helper that crashes on Stop still ends the session, and its folder
    /// is handed over to be removed.
    #[test]
    fn a_crash_while_saving_still_ends_the_session() {
        let calls = Arc::new(Calls::default());
        let state = starting();
        let recorder = Box::new(FakeRecorder {
            calls: calls.clone(),
            panic_on_stop: true,
            microphone: false,
        });
        assert!(state.adopt_recorder(recorder, quiet).is_ok());
        *lock(&state.recording_dir) = Some(PathBuf::from("/tmp/capture-x"));
        state.apply(CaptureEvent::Stop, quiet).unwrap();
        let recorder = state.take_recorder().unwrap();
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| recorder.stop()));
        assert!(crashed.is_err());
        // What `fail_capture` does with the session itself.
        assert!(state.apply(CaptureEvent::Failed, quiet).is_ok());
        let (left, dir) = state.take_leftovers();
        assert!(left.is_none());
        assert_eq!(dir, Some(PathBuf::from("/tmp/capture-x")));
        assert_eq!(state.current(), CapturePhase::Idle);
    }

    /// A failure after the phase moved (a start that errored) ends the
    /// session and returns the recorder, so it is cancelled, never leaked.
    #[test]
    fn a_failed_start_returns_the_session_to_idle_with_nothing_running() {
        let calls = Arc::new(Calls::default());
        let state = recording(&calls);
        state.apply(CaptureEvent::Failed, quiet).unwrap();
        let (recorder, _) = state.take_leftovers();
        recorder.expect("the recorder is handed back").cancel().unwrap();
        assert_eq!(calls.cancel.load(Ordering::SeqCst), 1);
        assert_eq!(state.current(), CapturePhase::Idle);
        // And a new capture can start.
        assert!(state.apply(START_REC, quiet).is_ok());
    }

    /// A panic while the recorder was locked must not make it unreachable:
    /// it would keep recording until the app quits.
    #[test]
    fn a_poisoned_recorder_lock_still_gives_the_recorder_up() {
        let calls = Arc::new(Calls::default());
        let state = Arc::new(recording(&calls));
        let poisoner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.recorder.lock().unwrap();
            panic!("poison the recorder lock");
        })
        .join();
        assert!(state.recorder.is_poisoned());
        assert!(state.take_recorder().is_some());
    }

    #[test]
    fn restart_goes_back_to_starting_and_can_adopt_a_new_recorder() {
        let calls = Arc::new(Calls::default());
        let state = recording(&calls);
        state.apply(CaptureEvent::Restart, quiet).unwrap();
        let (old, _) = state.take_leftovers();
        old.unwrap().cancel().unwrap();
        assert!(state.adopt_recorder(FakeRecorder::boxed(&calls), quiet).is_ok());
        assert_eq!(calls.cancel.load(Ordering::SeqCst), 1);
        assert!(matches!(state.current(), CapturePhase::Recording { elapsed_secs: 0, .. }));
    }

    /// Two changes racing are broadcast in the order they happened.
    #[test]
    fn phase_events_are_numbered_in_order() {
        let calls = Arc::new(Calls::default());
        let state = recording(&calls);
        let mut seen = Vec::new();
        state.apply(CaptureEvent::Tick { elapsed_secs: 3 }, |e| seen.push(e)).unwrap();
        state.apply(CaptureEvent::Cancel, |e| seen.push(e)).unwrap();
        assert!(seen[0].seq < seen[1].seq);
        assert_eq!(seen[1].phase, CapturePhase::Idle);
        assert_eq!(state.snapshot().seq, seen[1].seq, "a seed carries the latest number");
    }

    /// The tray follows the broadcasts: a whole recording, from Record to
    /// saved, as the tray would write it. The last write clears the time.
    #[test]
    fn a_saved_recording_leaves_no_time_in_the_menu_bar() {
        let calls = Arc::new(Calls::default());
        let state = CaptureState::default();
        let mut tray = Vec::new();
        let mut write = |e: PhaseEvent| {
            if newest_for_tray(&state.tray_seq, e.seq) {
                tray.push(tray_status::tray_text_for(e.phase).title);
            }
        };
        state.apply(START_REC, &mut write).unwrap();
        state.apply(CaptureEvent::Selected, &mut write).unwrap();
        assert!(state.adopt_recorder(FakeRecorder::boxed(&calls), &mut write).is_ok());
        state.apply(CaptureEvent::Tick { elapsed_secs: 14 }, &mut write).unwrap();
        state.apply(CaptureEvent::Pause, &mut write).unwrap();
        state.apply(CaptureEvent::Resume, &mut write).unwrap();
        state.apply(CaptureEvent::Tick { elapsed_secs: 15 }, &mut write).unwrap();
        state.apply(CaptureEvent::Stop, &mut write).unwrap();
        state.apply(CaptureEvent::Captured, &mut write).unwrap();
        assert_eq!(tray, ["", "", "◼ 00:00", "◼ 00:14", "❚❚ 00:14", "◼ 00:14", "◼ 00:15", "", ""]);
    }

    /// What actually reaches the status item: only changes. A screenshot
    /// writes nothing, a recording its time and one clear at the end.
    #[test]
    fn the_tray_is_written_only_when_the_text_changes() {
        let calls = Arc::new(Calls::default());
        let state = CaptureState::default();
        let written = std::cell::RefCell::new(Vec::<String>::new());
        let write = |e: PhaseEvent| {
            if newest_for_tray(&state.tray_seq, e.seq) {
                let text = tray_status::tray_text_for(e.phase);
                let mut last = lock(&state.tray_last);
                if tray_status::tray_needs_write(last.as_ref(), &text) {
                    written.borrow_mut().push(text.title.clone());
                    *last = Some(text);
                }
            }
        };
        let shot = CaptureEvent::Start {
            kind: CaptureKind::Screenshot,
            mode: CaptureMode::Area,
        };
        state.apply(shot, write).unwrap();
        state.apply(CaptureEvent::Selected, write).unwrap();
        state.apply(CaptureEvent::Captured, write).unwrap();
        assert!(written.borrow().is_empty(), "a screenshot leaves the icon alone: {written:?}");
        state.apply(START_REC, write).unwrap();
        state.apply(CaptureEvent::Selected, write).unwrap();
        assert!(state.adopt_recorder(FakeRecorder::boxed(&calls), write).is_ok());
        state.apply(CaptureEvent::Tick { elapsed_secs: 1 }, write).unwrap();
        state.apply(CaptureEvent::Stop, write).unwrap();
        state.apply(CaptureEvent::Captured, write).unwrap();
        assert_eq!(*written.borrow(), ["◼ 00:00", "◼ 00:01", ""]);
        assert_eq!(
            state.current(),
            CapturePhase::Idle,
            "the session ends at Idle, where a click opens the popover"
        );
    }

    /// A tray write posted from a worker that runs after a newer one (run
    /// inline on the main thread) is dropped, so a stale time never returns.
    #[test]
    fn a_late_tray_write_never_puts_an_older_time_back() {
        let shown = AtomicU64::new(0);
        assert!(newest_for_tray(&shown, 1));
        assert!(newest_for_tray(&shown, 3));
        assert!(!newest_for_tray(&shown, 2), "older than what the tray shows");
        assert!(!newest_for_tray(&shown, 3), "already shown");
        assert!(newest_for_tray(&shown, 4));
    }

    #[test]
    fn a_phase_event_is_the_phase_plus_its_number() {
        let e = PhaseEvent {
            phase: CapturePhase::Recording {
                elapsed_secs: 5,
                microphone: true,
            },
            seq: 9,
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({ "phase": "recording", "elapsedSecs": 5, "microphone": true, "seq": 9 })
        );
        let idle = PhaseEvent {
            phase: CapturePhase::Idle,
            seq: 1,
        };
        assert_eq!(serde_json::to_value(idle).unwrap(), serde_json::json!({ "phase": "idle", "seq": 1 }));
    }

    /// A window open behind the app being captured must not jump in front
    /// of it (or into the recording) when the capture ends.
    #[test]
    fn the_main_window_comes_back_as_it_was() {
        assert_eq!(restore_plan(false, false), MainRestore::Leave);
        assert_eq!(restore_plan(true, false), MainRestore::Behind);
        assert_eq!(restore_plan(true, true), MainRestore::Front);
    }

    #[test]
    fn the_pending_event_carries_the_area_or_nothing() {
        let rect = crate::capture::geometry::LogicalRect {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert_eq!(
            serde_json::to_value(PendingPayload::of(Some(Selection::Area { display_id: 7, rect }))).unwrap(),
            serde_json::json!({ "displayId": 7, "rect": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 } })
        );
        assert_eq!(
            serde_json::to_value(PendingPayload::of(None)).unwrap(),
            serde_json::json!({ "displayId": null, "rect": null })
        );
    }

    #[test]
    fn the_failed_payload_says_whether_a_card_shows_it() {
        let v = serde_json::to_value(FailedPayload {
            message: "x".into(),
            card_showing: true,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "message": "x", "cardShowing": true }));
    }
}
