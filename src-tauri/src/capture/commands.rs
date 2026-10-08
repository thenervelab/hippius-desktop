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
use super::destination::{self, CaptureDestination};
use super::preview::{LinkState, PreviewCard, PreviewStatus};
use super::recording::{self, Microphone, RecordOptions, Recorder};
use super::screenshot::Selection;
use super::session::{CaptureEvent, CaptureKind, CaptureMode, CapturePhase, TransitionError, transition};
use super::share;
use super::shortcut::{self, ShortcutAction, ShortcutKind, ShortcutSetting};
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
/// The camera window listed the cameras it can use, or the system's list
/// changed while the bar is up.
pub const CAMERAS_EVENT: &str = "capture_cameras";
/// The system's microphones changed while the bar is up (`device_watch`).
pub const MICROPHONES_EVENT: &str = "capture_microphones";
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
/// A sound source went away mid-recording and the recording goes on without
/// it (`DeviceLost`): the pill says so in Rust's words.
pub const DEVICE_LOST_EVENT: &str = "capture_device_lost";
/// To the pill: the recording's microphone changed (muted, unmuted, another
/// device, or a recording started or ended): `live_controls::MicrophoneState`.
pub const MICROPHONE_STATE_EVENT: &str = "capture_microphone_state";
/// To the pill: seconds left before a recording begins (Wayland counts down
/// there, after the desktop's dialog), or `null` once it has.
pub const PILL_COUNTDOWN_EVENT: &str = "capture_pill_countdown";

/// What [`DEVICE_LOST_EVENT`] carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLost {
    /// `microphone` or `systemAudio`.
    pub device: String,
    pub message: &'static str,
}

impl DeviceLost {
    #[must_use]
    pub fn new(device: String) -> Self {
        let message = recording::device_lost_message(&device);
        Self { device, message }
    }
}

/// Overlay windows are labelled `capture-overlay-<display id>`, which is also
/// the glob the overlay's capability file grants.
pub const OVERLAY_LABEL_PREFIX: &str = "capture-overlay-";
pub const CONTROLS_LABEL: &str = "capture-controls";
pub const PREVIEW_LABEL: &str = "capture-preview";
pub const CAMERA_LABEL: &str = "capture-camera";
/// The camera bubble's controls mid-recording (`bubble_controls`): a window
/// of their own over the bubble, because the bubble's own window is filmed.
pub const BUBBLE_CONTROLS_LABEL: &str = "capture-bubble-controls";
/// Wayland's area selection: one full-screen window showing the chosen
/// monitor's picture to draw the area on (`area_pick`).
pub const AREA_LABEL: &str = "capture-area";

/// The card's window, in logical points; the card fills it.
const PREVIEW_WIDTH: f64 = 316.0;
/// Tall enough for the picture, three lines (a recording's notice takes two),
/// the progress or timer bar and the buttons; at 290 the top of the picture
/// was clipped. The card sits at the window's bottom, so a shorter card leaves
/// the top of the window empty and transparent.
const PREVIEW_HEIGHT: f64 = 346.0;
/// Gap between the card and the display's bottom-right corner.
const PREVIEW_MARGIN: f64 = 16.0;
/// The recording pill's window, in logical points.
const CONTROLS_WIDTH: f64 = 380.0;
const CONTROLS_HEIGHT: f64 = 60.0;
/// Gap between the pill and the bottom of the usable area.
const CONTROLS_MARGIN: f64 = 24.0;
/// How often the displays are checked while a capture is open.
const DISPLAY_WATCH_EVERY: std::time::Duration = std::time::Duration::from_millis(1500);
/// How often the pointer's display is read while the bar is up. Two checks
/// on another display move the bar (`bar::bar_follow`), so it follows within
/// half a second without jumping as the pointer crosses a display.
const BAR_FOLLOW_EVERY: std::time::Duration = std::time::Duration::from_millis(250);
/// A card follows the sync engine's row for at most this long.
const SYNC_FOLLOW_LIMIT: std::time::Duration = std::time::Duration::from_hours(2);

pub(super) const MAIN_WINDOW_LABEL: &str = "main";
/// One display frame and a little: time for the window server to drop a
/// card that was just ordered out, before the screen is read.
const CARD_GONE_SETTLE: std::time::Duration = std::time::Duration::from_millis(32);

/// Whether this build can capture screenshots at all: macOS and Windows
/// through xcap, Linux through x11rb on X11 and the desktop's screenshot
/// portal on Wayland (`linux_x11`, `linux_portal`).
pub const CAPTURE_SUPPORTED: bool = cfg!(any(target_os = "macos", windows, target_os = "linux"));

/// Whether screenshots are offered here: built for this platform, and the
/// platform is on this build's lane (`rollout`). Every surface asks this, so
/// a platform still on staging is simply unsupported on beta and production.
#[must_use]
pub fn capture_supported() -> bool {
    CAPTURE_SUPPORTED && super::rollout::allows(super::rollout::Feature::Screenshots)
}

/// Whether camera only (the stage) can be recorded here: it records the
/// camera window by its system window id (macOS's window number, Windows'
/// HWND, the XID on X11), which those recorders take. Wayland has no window
/// id to give, so there the recorder opens the camera itself, and only
/// where this machine has what that needs (`support::camera_only`).
#[must_use]
pub fn camera_only_supported() -> bool {
    recording::recording_supported() && super::support::camera_only(super::rollout::current_platform(), recording::recorder_camera_available())
}

/// Whether this recording's camera is opened by the recorder (camera only
/// on Wayland), so the stage page must let go of it.
fn recorder_opens_camera(shape: Option<CameraShape>) -> bool {
    shape == Some(CameraShape::Stage) && super::support::camera_by_recorder(super::rollout::current_platform())
}

/// A lock that survives a panic elsewhere: a poisoned recorder lock must not
/// make the recorder unreachable (it would keep recording until quit).
pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `capture_state_changed`: the phase, plus a number that only goes up, so a
/// listener that seeded itself from `capture_state` can drop an older event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PhaseEvent {
    #[serde(flatten)]
    pub phase: CapturePhase,
    pub seq: u64,
    /// Seconds left before a Free plan recording stops on its own, sent only
    /// in the last minute (`allowance::remaining_to_show`), for the pill to
    /// show instead of the time recorded.
    #[serde(rename = "remainingSecs", skip_serializing_if = "Option::is_none")]
    pub remaining_secs: Option<u64>,
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
    /// Why each saved shortcut (screenshot, Record; `ShortcutKind::index`)
    /// could not be registered at start-up, for Settings
    /// (`ShortcutSetting::problem`); cleared once that one registers.
    shortcut_problems: Mutex<[Option<String>; 2]>,
    /// Whether the main window was on screen when the capture started, so it
    /// comes back only if it was there to begin with.
    restore_main: AtomicBool,
    /// Whether it was also the key window: only then does it come back to
    /// the front. A window merely open behind other apps goes back behind.
    main_was_focused: AtomicBool,
    /// This session is the shortcut's one-step area screenshot
    /// ([`super::instant`]): no bar, no area drawn in advance, no timer.
    instant: AtomicBool,
    /// The app that was frontmost when the capture started (its process id),
    /// handed the keyboard back when the overlays close.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    previous_app: Mutex<Option<i32>>,
    /// Live recording backend, if any.
    recorder: Mutex<Option<Box<dyn Recorder>>>,
    /// The capture bar's microphone meter; stopped whenever the phase leaves
    /// choosing a recording, before the recorder opens the microphone.
    pub(crate) mic_meter: super::mic_meter::MicMeter,
    /// The folder the live recording writes into, removed if it is thrown away.
    recording_dir: Mutex<Option<PathBuf>>,
    /// What the live recording records, so Restart can start it again.
    selection: Mutex<Option<Selection>>,
    /// Cancels the elapsed-time tick task.
    tick_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// The live recording's length limit in seconds of recorded time, 0 for
    /// none. Decided from the plan as the recording starts (`allowance`).
    recording_limit_secs: AtomicU64,
    /// The live recording reached its length limit and is being stopped for
    /// it: its card says so, with an Upgrade.
    stopped_at_limit: AtomicBool,
    /// The last recording tier seen per account (`allowance::TierCache`).
    pub(crate) recording_tiers: super::allowance::TierCache,
    /// Recordings in each account's captures drive, briefly cached
    /// (`recording_allowance::CountCache`).
    pub(crate) recording_counts: super::recording_allowance::CountCache,
    /// The display the capture bar is on; the preview card opens there too.
    bar_display: Mutex<Option<DisplayTarget>>,
    /// The displays of this capture, as last listed.
    displays: Mutex<Vec<DisplayTarget>>,
    /// Each display's usable area, read once per capture (and again when the
    /// displays change) instead of asking AppKit each time a window is placed.
    work_areas: Mutex<HashMap<u32, LogicalArea>>,
    /// Which display watch is current (see `spawn_display_watch`).
    display_watch: AtomicU64,
    /// Which bar follow is current (see `spawn_bar_follow`).
    bar_follow: AtomicU64,
    /// The bar's overlay holds the bar on its display: a countdown, a capture
    /// in flight, a drag or the share picker would be lost if it moved
    /// (`capture_hold_bar`).
    bar_held: AtomicBool,
    /// The area drawn so far, on whichever display, for the Capture button.
    pending: Mutex<Option<Selection>>,
    /// A still of the selection taken as a recording starts: its card's
    /// picture only when the saved file gives none (`poster::pick`).
    poster: Mutex<Option<String>>,
    /// The card in the corner, if one is showing.
    pub(super) preview: Mutex<Option<PreviewCard>>,
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
    /// The camera window's system window number (the XID on X11), read once
    /// when it opens (0 = not known yet). Camera only records that window,
    /// and a window recording draws the bubble from it.
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
    /// and Windows, where the bubble's controls are shown from it.
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    camera_hover: AtomicBool,
    /// Which hover watch is current (see `spawn_camera_hover_watch`).
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    camera_watch: AtomicU64,
    /// The pill's "Start now" during a countdown after the desktop's dialog
    /// (`count_down_in_pill`).
    countdown_skip: AtomicBool,
    /// The picture open in the screenshot editor, if any (`editor.rs`).
    pub(super) editor: Mutex<Option<super::editor::EditorSession>>,
    /// Numbers editor sessions, so a save meant for a replaced one is refused.
    pub(super) editor_seq: AtomicU64,
    /// Where the editor's last save went, for the main window's "Copy link".
    pub(super) editor_saved: Mutex<Option<super::editor::SavedEdit>>,
    /// A Wayland area being drawn on the chosen monitor's picture
    /// (`draw_area`): the picture, the step, and where the drawn area goes.
    area_pick: Mutex<Option<AreaPick>>,
    /// The live recording's microphone: muted, and which device
    /// (`live_controls`). Reset at every start and ending.
    live_microphone: Mutex<super::live_controls::LiveMicrophone>,
    /// A pill menu is open and the pill's window has grown for it: whether
    /// above the pill (`live_controls::pill_with_menu`).
    pill_menu: Mutex<Option<bool>>,
    /// The monitor a Wayland area's stream covers, in GDK's layout (and its
    /// scale), when the compositor said which (`fill_stream_monitor`): where
    /// the pill must stay out of the area.
    area_monitor: Mutex<Option<(super::area_pick::MonitorBox, f64)>>,
    /// A Wayland screenshot's still of the desktop, which its overlays show
    /// and its selection is cut from (`frozen_shot`); `None` elsewhere.
    frozen: Mutex<Option<super::frozen_shot::FrozenDesktop>>,
}

/// A Wayland area recording between the desktop's dialog and its crop.
struct AreaPick {
    step: super::area_pick::AreaStep,
    still: recording::protocol::StreamStill,
    /// The area drawn when the picture comes up (`area_pick::initial_area`).
    initial: Option<recording::protocol::StreamCrop>,
    /// Taken once, by the first area that maps onto the picture.
    chosen: Option<tokio::sync::oneshot::Sender<recording::protocol::StreamCrop>>,
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

    /// The camera the recording keeps (`None` before Record, or without one).
    /// Read through here, once per use: a second `lock` of the same mutex in
    /// one statement waits on the first guard, which lives to the end of the
    /// statement, and that thread never wakes. It once did exactly that in
    /// `camera_state_for`, on every capture: Record then hung for good
    /// (no pill, no bubble, the bar gone) until Escape.
    fn recording_camera(&self) -> Option<CameraShape> {
        *lock(&self.recording_camera)
    }

    /// The pill's camera menu and size choices (`live_controls::camera_controls`).
    fn pill_camera_controls(&self, phase: CapturePhase, hidden: bool, support: super::live_controls::LiveSupport) -> (bool, bool) {
        let camera = self.recording_camera();
        super::live_controls::camera_controls(phase, camera, hidden, recorder_opens_camera(camera), support)
    }

    /// The live recording's length limit, `None` for none.
    fn recording_limit(&self) -> Option<std::time::Duration> {
        match self.recording_limit_secs.load(Ordering::SeqCst) {
            0 => None,
            secs => Some(std::time::Duration::from_secs(secs)),
        }
    }

    fn set_recording_limit(&self, limit: Option<std::time::Duration>) {
        self.recording_limit_secs.store(limit.map_or(0, |l| l.as_secs().max(1)), Ordering::SeqCst);
    }

    /// Whether a recording with `recorded_secs` of recorded time is due to
    /// stop at its limit: running (not paused) and at or past it.
    fn at_recording_limit(&self, recorded_secs: u64) -> bool {
        matches!(self.current(), CapturePhase::Recording { .. }) && super::allowance::limit_reached(recorded_secs, self.recording_limit())
    }

    /// `phase` as broadcast, numbered `seq`, with the time left before the
    /// recording's limit when it is close.
    fn phase_event(&self, phase: CapturePhase, seq: u64) -> PhaseEvent {
        let remaining_secs = match phase {
            CapturePhase::Recording { elapsed_secs, .. } | CapturePhase::Paused { elapsed_secs, .. } => {
                super::allowance::remaining_to_show(elapsed_secs, self.recording_limit())
            }
            _ => None,
        };
        PhaseEvent { phase, seq, remaining_secs }
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
        emit(self.phase_event(next, self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1));
        Ok(next)
    }

    /// The phase again, under a new number, so every surface re-reads it
    /// (the displays changed under an open capture bar).
    fn rebroadcast(&self, emit: impl FnOnce(PhaseEvent)) {
        let guard = lock(&self.phase);
        emit(self.phase_event(guard.unwrap_or(CapturePhase::Idle), self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1));
    }

    fn snapshot(&self) -> PhaseEvent {
        let guard = lock(&self.phase);
        self.phase_event(guard.unwrap_or(CapturePhase::Idle), self.phase_seq.load(Ordering::SeqCst))
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
        emit(self.phase_event(next, self.phase_seq.fetch_add(1, Ordering::SeqCst) + 1));
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
    // The microphone is the recorder's from here on: the meter lets go of it
    // before the recorder starts (`mic_meter` says why they never overlap).
    if !super::mic_meter::meter_may_run(event.phase) {
        app.state::<AppState>().capture.mic_meter.stop();
    }
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
                let was = last.as_ref().map_or(tray_status::TrayGlyph::None, tray_status::tray_glyph_of);
                let now = tray_status::tray_glyph_of(&text);
                write_tray_text(&handle, &text);
                // Linux: the recording's own menu first, so the main window,
                // told on release, puts back its menu and its icon together.
                #[cfg(target_os = "linux")]
                write_tray_menu(&handle, super::tray_recording_menu::menu_write(was, now));
                if tray_status::TRAY_ICON_MARKS_RECORDING {
                    write_tray_glyph(&handle, tray_status::icon_write(was, now));
                }
                *last = Some(text);
            }
        }
    });
    if let Err(e) = posted {
        tracing::debug!(error = %e, "could not update the tray for the capture phase");
    }
}

/// The main window put a new menu, often on a new icon, on the tray
/// (`tray::status_menu::tray_menu_attached`): while a recording runs, its
/// time, its mark (Windows, Linux) and its menu (Linux) go back on, since
/// the new icon or the page's menu just replaced them
/// ([`tray_status::text_to_restore`]). Called from a synchronous command,
/// so on the main thread, where the posted writes of [`show_phase_in_tray`]
/// also run; the phase lock is held only to read the phase.
pub fn restore_recording_in_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(text) = tray_status::text_to_restore(state.capture.current()) else {
        return;
    };
    let mut last = lock(&state.capture.tray_last);
    let glyph = tray_status::tray_glyph_of(&text);
    tracing::info!("tray: new icon or menu during a recording, its marks go back on");
    write_tray_text(app, &text);
    #[cfg(target_os = "linux")]
    write_tray_menu(app, super::tray_recording_menu::menu_write(tray_status::TrayGlyph::None, glyph));
    if tray_status::TRAY_ICON_MARKS_RECORDING {
        write_tray_glyph(app, tray_status::icon_write(tray_status::TrayGlyph::None, glyph));
    }
    *last = Some(text);
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

/// The recording's mark came off the tray icon (Windows): the main window
/// puts its own icon (syncing, synced) back (`useTraySync.ts`).
pub const TRAY_ICON_RELEASED_EVENT: &str = "capture_tray_icon_released";

/// The app's tray icon as bundled, decoded once.
fn tray_base_icon() -> Option<&'static image::RgbaImage> {
    static BASE: std::sync::OnceLock<Option<image::RgbaImage>> = std::sync::OnceLock::new();
    BASE.get_or_init(|| {
        image::load_from_memory(include_bytes!("../../icons/TrayIcon.png"))
            .map(|i| i.to_rgba8())
            .inspect_err(|e| tracing::debug!(error = %e, "could not decode the tray icon"))
            .ok()
    })
    .as_ref()
}

/// The tray icon with `glyph`'s dot, built once per glyph.
fn marked_tray_icon(glyph: tray_status::TrayGlyph) -> Option<tauri::image::Image<'static>> {
    static RECORDING: std::sync::OnceLock<Option<image::RgbaImage>> = std::sync::OnceLock::new();
    static PAUSED: std::sync::OnceLock<Option<image::RgbaImage>> = std::sync::OnceLock::new();
    let slot = match glyph {
        tray_status::TrayGlyph::Recording => &RECORDING,
        tray_status::TrayGlyph::Paused => &PAUSED,
        tray_status::TrayGlyph::None => return None,
    };
    let icon = slot
        .get_or_init(|| tray_base_icon().and_then(|base| tray_status::marked_icon(base, glyph)))
        .as_ref()?;
    Some(tauri::image::Image::new_owned(icon.as_raw().clone(), icon.width(), icon.height()))
}

/// Mark the tray icon while a recording runs, or put the app's icon back
/// (plan XP-15). Windows and Linux ([`tray_status::TRAY_ICON_MARKS_RECORDING`]):
/// Windows' tray shows no title, and many Linux panels no label. The main
/// window owns the icon otherwise; on
/// release it is told to re-apply its own, since only it knows whether a
/// sync is running.
fn write_tray_glyph(app: &AppHandle, write: tray_status::IconWrite) {
    let Some(tray) = app.tray_by_id(tray_status::TRAY_ID) else {
        return;
    };
    match write {
        tray_status::IconWrite::Keep => {}
        tray_status::IconWrite::Mark(glyph) => {
            if let Some(icon) = marked_tray_icon(glyph)
                && let Err(e) = tray.set_icon(Some(icon))
            {
                tracing::debug!(error = %e, "could not mark the tray icon");
            }
        }
        tray_status::IconWrite::Release => {
            if let Some(base) = tray_base_icon() {
                let icon = tauri::image::Image::new_owned(base.as_raw().clone(), base.width(), base.height());
                if let Err(e) = tray.set_icon(Some(icon)) {
                    tracing::debug!(error = %e, "could not put the tray icon back");
                }
            }
            let _ = app.emit(TRAY_ICON_RELEASED_EVENT, ());
        }
    }
}

/// Linux: while a recording runs, the tray's menu is the recording's own
/// (`tray_recording_menu`): AppIndicator sends no click, so the menu is the
/// only way to reach Stop from the tray. Written only when what it offers
/// changes; on release the main window puts back its own menu, on the same
/// `capture_tray_icon_released` that `write_tray_glyph` sends.
#[cfg(target_os = "linux")]
fn write_tray_menu(app: &AppHandle, write: super::tray_recording_menu::MenuWrite) {
    use super::tray_recording_menu::{MenuWrite, items_for};
    use tauri::menu::{Menu, MenuItem};

    let MenuWrite::Set(glyph) = write else {
        // Release: `write_tray_glyph` tells the main window, which rebuilds
        // its menu with its icon. Keep: nothing changed.
        return;
    };
    let Some(tray) = app.tray_by_id(tray_status::TRAY_ID) else {
        return;
    };
    listen_to_recording_menu(app);
    tracing::info!(?glyph, "tray: the recording's menu goes on the icon");
    let items: Vec<MenuItem<tauri::Wry>> = items_for(glyph)
        .into_iter()
        .filter_map(|item| MenuItem::with_id(app, item.id, item.text, true, None::<&str>).ok())
        .collect();
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    match Menu::with_items(app, &refs) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                tracing::debug!(error = %e, "could not put the recording's menu on the tray");
            }
        }
        Err(e) => tracing::debug!(error = %e, "could not build the recording's tray menu"),
    }
}

/// The app-wide menu listener for the recording's tray items, added once
/// (Tauri keeps every listener added, so adding one per write would run
/// each click many times). Other menus' items are ignored by id.
///
/// Added at start-up (`main.rs` setup), before any recording's menu exists,
/// and again (a no-op) by the first menu write: it used to be added only
/// inside that first write, which runs from a posted main-thread task. Each
/// click is logged with what it did, so a click that changes nothing still
/// leaves a line in `~/.hippius/logs`, and is read against the session's
/// phase now ([`tray_recording_menu::effect_for`]), never against the menu
/// it came from, which can be a beat behind.
///
/// [`tray_recording_menu::effect_for`]: super::tray_recording_menu::effect_for
#[cfg(target_os = "linux")]
pub fn listen_to_recording_menu(app: &AppHandle) {
    static LISTENING: std::sync::Once = std::sync::Once::new();
    LISTENING.call_once(|| {
        app.on_menu_event(|app, event| {
            let Some(action) = super::tray_recording_menu::action_for(event.id().0.as_str()) else {
                return;
            };
            on_recording_menu_item(app, action);
        });
        tracing::info!("tray: listening for the recording menu's items");
    });
}

/// One click on the recording's tray menu (Linux), carried out on the
/// session exactly as the pill's buttons are: the same commands.
#[cfg(target_os = "linux")]
fn on_recording_menu_item(app: &AppHandle, action: super::tray_recording_menu::Action) {
    use super::tray_recording_menu::{Effect, effect_for};
    let phase = app.state::<AppState>().capture.current();
    let effect = effect_for(action, phase);
    tracing::info!(?action, ?effect, "tray: recording menu item clicked");
    let app = app.clone();
    match effect {
        Effect::Ignore => {}
        Effect::ShowControls => {
            if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
                bring_controls_back(&w);
            } else {
                tracing::warn!("tray menu: no recording controls to show");
            }
        }
        Effect::OpenMain => {
            if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                bring_main_forward(&main);
                // The user took the app back: the recording's end leaves it
                // up, as when it gets the keyboard (which a desktop's focus
                // stealing prevention may withhold from a tray click).
                on_main_window_focused(&app);
            } else {
                tracing::warn!("tray menu: no main window to open");
            }
        }
        Effect::Stop => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = stop_inner(&app).await {
                    tracing::warn!(error = %e, "tray menu: stop refused");
                }
            });
        }
        Effect::Pause => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = capture_pause(app).await {
                    tracing::warn!(error = %e, "tray menu: pause refused");
                }
            });
        }
        Effect::Resume => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = capture_resume(app).await {
                    tracing::warn!(error = %e, "tray menu: resume refused");
                }
            });
        }
    }
}

/// "Show recording controls": the pill back on screen even when it is
/// already "visible" but minimised or covered, which a plain show (a no-op
/// on a shown window) left as it was, so the item looked dead.
#[cfg(target_os = "linux")]
fn bring_controls_back(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    if window.is_visible().unwrap_or(false) {
        // Raise without taking the keyboard from the app being recorded.
        let _ = window.set_always_on_top(false);
        let _ = window.set_always_on_top(true);
    } else {
        show_without_focus(window);
    }
}

/// A left click on the tray icon, received by `tray::panel` before it opens
/// anything. During a recording the click also brings the recording's pill
/// back, without taking the keyboard from the app being recorded, and does
/// NOT stop it (the pill has Stop). The route is the popover when signed in,
/// in every phase, else the main window ([`tray_status::tray_click_route`]).
pub fn on_tray_click(app: &AppHandle, signed_in: bool) -> TrayClickRoute {
    let state = app.state::<AppState>();
    let route = tray_status::tray_click_route(signed_in, state.capture.current());
    if route.shows_recording_controls() {
        if let Some(w) = app.get_webview_window(CONTROLS_LABEL) {
            show_without_focus(&w);
        } else {
            tracing::warn!("tray click during a recording found no recording controls");
        }
    }
    route
}

/// The Dock icon was clicked (macOS "reopen"). The main window comes
/// forward unless it is already up ([`super::own_windows::reopen_shows_main`]):
/// during a recording it is hidden and the pill is a visible window, so
/// AppKit's own "has visible windows" left the Dock icon doing nothing.
pub fn on_app_reopen(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let visible = main.is_visible().unwrap_or(false);
    let minimized = main.is_minimized().unwrap_or(false);
    let state = app.state::<AppState>();
    let phase = state.capture.current();
    if super::own_windows::reopen_shows_main(phase, visible, minimized) {
        tracing::info!(visible, minimized, "dock: the main window comes forward");
        bring_main_forward(&main);
    } else if super::own_windows::choosing_or_taking(phase) {
        // The overlays stay in front and keep the keyboard.
        focus_active_ui(app, &state.capture);
    }
}

/// Hippius became the active app (macOS; `activation::watch`). During a
/// recording with the main window hidden, Cmd+Tab to Hippius shows it
/// ([`super::own_windows::activation_shows_main`]); a click on the pill or
/// the card, or the tray popover taking focus, does not.
#[cfg(target_os = "macos")]
pub fn on_app_activated(app: &AppHandle) {
    let phase = app.state::<AppState>().capture.current();
    if !super::own_windows::recording_on(phase) {
        return;
    }
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let main_visible = main.is_visible().unwrap_or(false);
    let popover_visible = app
        .get_webview_window(crate::tray::panel::PANEL_LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    let mouse_down = super::activation::mouse_down();
    if super::own_windows::activation_shows_main(phase, main_visible, mouse_down, popover_visible) {
        tracing::info!("switched to Hippius during a recording: the main window comes forward");
        bring_main_forward(&main);
    }
}

/// The main window got the keyboard. During a recording that is the user
/// taking it back (Dock, Cmd+Tab, the tray's Open Hippius): the recording's
/// end then leaves it where it is and keeps the keyboard in Hippius, instead
/// of pushing it behind or handing focus to the app the capture began from.
pub fn on_main_window_focused(app: &AppHandle) {
    let state = app.state::<AppState>();
    if super::own_windows::focus_keeps_main(state.capture.current()) {
        state.capture.restore_main.store(false, Ordering::SeqCst);
        state.capture.main_was_focused.store(false, Ordering::SeqCst);
        lock(&state.capture.previous_app).take();
    }
}

/// Wayland: watch a capture window (the pill, the camera bubble, its
/// controls, the card) for the dock or Alt+Tab raising it in place of the
/// hidden main window ([`on_capture_window_focused`]). Nothing elsewhere.
fn watch_capture_window_focus(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    if super::rollout::current_platform() == super::rollout::Platform::LinuxWayland {
        super::focus_watch_gtk::watch(window);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// A capture window took the keyboard (Wayland, `focus_watch_gtk`). With the
/// pointer elsewhere and a recording on, that is the dock or Alt+Tab
/// raising it, since the main window is hidden and they cannot see it
/// ([`super::own_windows::capture_window_focus_shows_main`]): the main window
/// comes forward and, as with the tray's Open Hippius, the recording's end
/// then leaves it up.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) fn on_capture_window_focused(app: &AppHandle, label: &str, pointer_over: bool, since_mapped: Option<std::time::Duration>) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let platform = super::rollout::current_platform();
    let on_screen = super::own_windows::main_on_screen(platform, main.is_visible().unwrap_or(false), main.is_minimized().unwrap_or(false));
    let phase = app.state::<AppState>().capture.current();
    if super::own_windows::capture_window_focus_shows_main(platform, phase, on_screen, pointer_over, since_mapped) {
        tracing::info!(
            window = label,
            "a capture window was raised from the dock or Alt+Tab: the main window comes forward"
        );
        bring_main_forward(&main);
        on_main_window_focused(app);
    }
}

fn bring_main_forward(main: &tauri::WebviewWindow) {
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
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
    lock(&state.capture.frozen).take();
    close_overlays(app);
    close_controls(app);
    drop_unused_preview(app, &state.capture);
    restore_main_window(app, &state.capture);
    hand_focus_back(app, &state.capture);
    end_camera(app).await;
    // Closing the desktop's screen-sharing dialog is a cancel, not a failure.
    if failed && recording::cancelled_in_picker(e) {
        tracing::info!("screen sharing cancelled in the desktop's dialog");
        return;
    }
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

/// Put the app's own windows away so they are not in the shot, remembering
/// whether the main window was on screen and in front, and which app the
/// user was in. The main window is hidden, or minimized on X11 so the dock
/// can still bring it back ([`super::own_windows::main_away`]).
async fn hide_own_windows(app: &AppHandle, state: &CaptureState) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let platform = super::rollout::current_platform();
        let visible = super::own_windows::main_on_screen(platform, main.is_visible().unwrap_or(false), main.is_minimized().unwrap_or(false));
        state.restore_main.store(visible, Ordering::SeqCst);
        state
            .main_was_focused
            .store(visible && main.is_focused().unwrap_or(false), Ordering::SeqCst);
        if visible {
            match super::own_windows::main_away(platform) {
                super::own_windows::MainAway::Hidden => {
                    let _ = main.hide();
                }
                super::own_windows::MainAway::Minimized => {
                    let _ = main.minimize();
                }
            }
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
    let plan = restore_plan(visible, focused);
    // Minimized rather than hidden (X11): a minimized window counts as
    // shown, so it is unminimized first or it would stay in the dock.
    if plan != MainRestore::Leave && super::own_windows::main_away(super::rollout::current_platform()) == super::own_windows::MainAway::Minimized {
        let _ = main.unminimize();
    }
    match plan {
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

/// The main window's system window number (macOS), read on the main thread
/// without blocking it: a recording films it while leaving the rest of
/// Hippius out (`own_windows`). `None` if it cannot be read in time.
#[cfg(target_os = "macos")]
async fn main_window_number(app: &AppHandle) -> Option<u32> {
    use objc::{msg_send, sel, sel_impl};
    let main = app.get_webview_window(MAIN_WINDOW_LABEL)?;
    let target = main.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    main.run_on_main_thread(move || {
        let n = target.ns_window().ok().map(|ns_window| {
            let ns_window = ns_window.cast::<objc::runtime::Object>();
            // SAFETY: this window's live NSWindow, read on the main thread;
            // `windowNumber` only returns an integer.
            let n: isize = unsafe { msg_send![ns_window, windowNumber] };
            n
        });
        let _ = tx.send(n);
    })
    .ok()?;
    let n = tokio::time::timeout(std::time::Duration::from_millis(300), rx).await.ok()?.ok()??;
    u32::try_from(n).ok().filter(|n| *n > 0)
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)]
async fn main_window_number(_app: &AppHandle) -> Option<u32> {
    None
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
    // The bar is going: nothing needs live device lists until it is back.
    super::device_watch::stop();
    for (label, window) in app.webview_windows() {
        // The Wayland area window is a selection surface too.
        if label.starts_with(OVERLAY_LABEL_PREFIX) || label == AREA_LABEL {
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
/// out, the bar opens on whatever was used last. `instant` (the shortcut)
/// is the one-step area screenshot instead ([`super::instant`]): no bar, the
/// pointer a crosshair at once, the shot taken when the drag ends.
///
/// Refusals are structured so the UI can answer each one:
/// `NotReady(ScreenRecordingPermission)` → the permission explainer (which
/// asks macOS through `capture_request_permission`; asking here as well put
/// two dialogs on screen at once).
/// A capture already in progress is brought forward, not refused.
#[tauri::command]
pub async fn capture_start(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    kind: Option<CaptureKind>,
    mode: Option<CaptureMode>,
    instant: Option<bool>,
) -> Result<()> {
    if !capture_supported() {
        return Err(AppError::Validation("Screen capture isn't available on this system yet.".into()));
    }
    let recording_ok = recording::recording_supported();
    if kind == Some(CaptureKind::Recording)
        && let Some(why) = recording::recording_unavailable()
    {
        return Err(AppError::Validation(why.line().into()));
    }
    // A Record start (the tray, a menu, the record shortcut) on a free plan
    // whose recordings are used up is refused before any window opens. A
    // capture already under way is brought forward below, never refused.
    if kind == Some(CaptureKind::Recording) && state.capture.current() == CapturePhase::Idle {
        super::recording_allowance::require_can_start(&state).await?;
    }
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    // No question about where captures go: the first capture sets its own
    // destination up (`setup::ensure`). Started now, while the user chooses
    // what to capture, so a drive made for it is ready by the time the file
    // is; delivery waits for the same setup, never a second one.
    if destination::load(pool, &account_id).await?.is_none() {
        let app = app.clone();
        let account_id = account_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = super::setup::ensure(&app, &account_id).await {
                tracing::warn!(error = %e, "capture setup could not start; the capture will try again");
            }
        });
    }
    if !super::permissions::screen_capture_granted() {
        return Err(AppError::NotReady(NotReadyKind::ScreenRecordingPermission));
    }

    let mut options = bar::load_options(pool).await?.for_system(camera_only_supported());
    let surfaces = super::support::surfaces();
    let choice = super::instant::start_choice(
        &surfaces,
        instant.unwrap_or(false),
        (kind, mode),
        (options.last_kind, options.last_mode),
        recording_ok,
    );
    let (kind, mode) = (choice.kind, choice.mode);
    let plan = super::support::start_plan(&surfaces, kind);

    match advance(&app, &state.capture, CaptureEvent::Start { kind, mode }) {
        Ok(_) => {}
        Err(_) if state.capture.current() != CapturePhase::Idle => {
            focus_active_ui(&app, &state.capture);
            return Ok(());
        }
        Err(e) => return Err(e),
    }
    state.capture.instant.store(choice.instant, Ordering::SeqCst);
    warm_recording_count(&app, recording_ok);
    if choice.remember {
        options.last_kind = kind;
        options.last_mode = mode;
        if let Err(e) = bar::save_options(pool, options.clone()).await {
            tracing::warn!(error = %e, "capture bar: last mode not remembered");
        }
    }
    let areas = bar::load_areas(pool).await.unwrap_or_default();

    bring_back_failed_card(&app, &state.capture);
    hide_own_windows(&app, &state.capture).await;
    if matches!(plan, super::support::StartPlan::Frozen | super::support::StartPlan::SystemPicker) {
        start_without_live_overlay(&app, &state.capture, plan);
        return Ok(());
    }
    // Below Windows 10 2004, and anywhere on Linux (X11 has no content
    // protection), nothing can be kept out of a capture; each overlay also
    // checks for itself as it opens (`open_overlay`).
    state.capture.ui_in_grabs.store(
        cfg!(target_os = "linux") || !super::permissions::windows_excludes_from_capture(super::permissions::windows_build()),
        Ordering::SeqCst,
    );
    let opened = if plan == super::support::StartPlan::Panel {
        open_panel(&app, &state.capture).await
    } else {
        open_capture_ui(&app, &state.capture, &areas).await
    };
    if let Err(e) = opened {
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
    // The panel is no display's overlay: nothing for the watch to follow.
    if plan != super::support::StartPlan::Panel {
        spawn_display_watch(app.clone());
        spawn_bar_follow(app.clone());
    }
    Ok(())
}

/// While the user chooses, read the recording count in the background, so a
/// Record press on the bar does not wait on the drive's listing
/// (`recording_allowance::warm`). Nothing where this computer cannot record.
fn warm_recording_count(app: &AppHandle, recording_ok: bool) {
    if !recording_ok {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        super::recording_allowance::warm(&app.state::<AppState>()).await;
    });
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
    // An instant shot starts with nothing drawn: the user drags a new area.
    let instant = state.instant.load(Ordering::SeqCst);
    *lock(&state.pending) = if instant {
        None
    } else {
        host_display.as_ref().and_then(|d| remembered_area(areas, d))
    };
    *lock(&state.bar_display) = host_display;
    state.bar_held.store(false, Ordering::SeqCst);
    lock(&state.displays).clone_from(&displays);
    refresh_work_areas(app, state, &displays).await;
    for display in &displays {
        open_overlay(app, display, Some(display.id) == host, instant).await?;
    }
    Ok(())
}

/// Wayland's recording panel: the capture bar alone in one ordinary window,
/// with no selection surface (Hippius can neither cover the screen nor see
/// other windows there); its Record opens the desktop's screen-sharing
/// dialog (`support::system_picker_selection`). It is the overlay page in
/// `capture-overlay-0`, so the overlay's capability and media permission
/// cover it, and every path that closes overlays closes it.
///
/// The window is transparent and only as big as what is in it: it opens at
/// `PANEL_FIRST_SIZE` and the page fits it to the bar, its sources and any
/// open menu (`capture_panel_fit`). The compositor decides where it goes.
async fn open_panel(app: &AppHandle, state: &CaptureState) -> Result<()> {
    let display = panel_display(app);
    *lock(&state.pending) = None;
    *lock(&state.bar_display) = Some(display.clone());
    *lock(&state.displays) = vec![display.clone()];
    let label = format!("{OVERLAY_LABEL_PREFIX}{}", display.id);
    if let Some(stale) = app.get_webview_window(&label) {
        let _ = stale.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let window = build_overlay(app, &label, &display, false)?;
    let (width, height) = super::support::PANEL_FIRST_SIZE;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let _ = window.center();
    window
        .show()
        .map_err(|e| AppError::Other(format!("Could not show the capture panel: {e}")))?;
    let _ = window.set_focus();
    Ok(())
}

/// Wayland's recording panel: size its window to what the page measured
/// (`width` x `height` CSS pixels, its margin included), so only the bar's
/// own glass shows and nothing around it catches clicks. Opening a menu
/// grows it, closing one shrinks it back. A page that is not the panel is
/// refused.
#[tauri::command]
pub fn capture_panel_fit(app: AppHandle, width: f64, height: f64) -> Result<()> {
    let state = app.state::<AppState>();
    // On Wayland a recording is chosen in the panel; a screenshot is chosen
    // on full-screen frozen overlays (`frozen_shot`), which must never be
    // resized to a bar's size.
    let panel_open = matches!(state.capture.current(), CapturePhase::Selecting { .. })
        && super::rollout::current_platform() == super::rollout::Platform::LinuxWayland
        && lock(&state.capture.frozen).is_none();
    if !panel_open {
        return Err(AppError::Validation("No capture panel is open.".into()));
    }
    let label = format!("{OVERLAY_LABEL_PREFIX}{}", super::support::PANEL_DISPLAY_ID);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| AppError::Validation("No capture panel is open.".into()))?;
    let Some((w, h)) = super::support::panel_window_size(width, height) else {
        return Err(AppError::Validation("The capture panel's size is not a size.".into()));
    };
    // Logical pixels are the page's CSS pixels at every scale (1x, 2x and
    // GNOME's fractional scaling alike), so no scale factor is applied.
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| AppError::Other(format!("Could not size the capture panel: {e}")))
}

/// The display the panel stands for: the primary monitor as GTK reports it
/// (Hippius has no display list of its own on Wayland), under the panel's id.
fn panel_display(app: &AppHandle) -> DisplayTarget {
    let monitor = app.primary_monitor().ok().flatten();
    let (width, height, scale) = monitor
        .as_ref()
        .map_or((1920, 1080, 1.0), |m| (m.size().width, m.size().height, m.scale_factor()));
    DisplayTarget {
        id: super::support::PANEL_DISPLAY_ID,
        name: String::new(),
        x: 0,
        y: 0,
        width,
        height,
        scale_factor: scale,
        is_primary: true,
    }
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

/// X11: the pointer in root pixels, the space RandR places the displays in.
#[cfg(target_os = "linux")]
fn cursor_point(_app: &AppHandle, _displays: &[DisplayTarget]) -> Option<(f64, f64)> {
    super::linux_x11::cursor_point()
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn cursor_point(_app: &AppHandle, _displays: &[DisplayTarget]) -> Option<(f64, f64)> {
    None
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn list_displays_blocking() -> Result<Vec<DisplayTarget>> {
    super::targets::list_displays()
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn list_displays_blocking() -> Result<Vec<DisplayTarget>> {
    Ok(Vec::new())
}

/// The overlay for `display`. Only the one hosting the bar takes the
/// keyboard: focusing every overlay left the last one focused, which was not
/// necessarily the bar's, and on Windows each focus could inject an Alt press.
async fn open_overlay(app: &AppHandle, display: &DisplayTarget, hosts_bar: bool, instant: bool) -> Result<()> {
    let label = format!("{OVERLAY_LABEL_PREFIX}{}", display.id);
    // A previous session's overlay may still be on its way out.
    if let Some(stale) = app.get_webview_window(&label) {
        let _ = stale.destroy();
    }
    let window = if let Ok(w) = build_overlay(app, &label, display, instant) {
        w
    } else {
        // The label frees once the event loop has destroyed the old one.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        build_overlay(app, &label, display, instant)?
    };
    // Content protection is asked for, not promised: on Windows it is
    // `SetWindowDisplayAffinity`, whose failure tao discards. Read it back;
    // if it did not hold, this session's screenshot closes the overlays
    // first rather than photographing the dimmed selection UI.
    if !kept_out_of_captures(&window) {
        let capture = &app.state::<AppState>().capture;
        // Linux knows from the start (no content protection there); only a
        // surprise is worth a warning.
        if !capture.ui_in_grabs.load(Ordering::SeqCst) {
            tracing::warn!(
                build = ?super::permissions::windows_build(),
                "the capture overlay is not excluded from screen captures here; overlays will close before the grab"
            );
        }
        capture.ui_in_grabs.store(true, Ordering::SeqCst);
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
    cover_whole_display(&window);
    if hosts_bar {
        let _ = window.set_focus();
    }
    Ok(())
}

/// X11 window managers keep an ordinary window clear of the panels (GNOME's
/// top bar, KDE's panel), so an overlay sized to the display would be pushed
/// down and every area read back shifted by the panel's height. A
/// full-screen window covers the whole monitor it is on, panels included,
/// and its (0, 0) is the display's. Elsewhere the overlay's level does it.
#[cfg(target_os = "linux")]
fn cover_whole_display(window: &tauri::WebviewWindow) {
    if let Err(e) = window.set_fullscreen(true) {
        tracing::warn!(error = %e, "capture overlay not made full screen; it may stop short of the panels");
    }
}

#[cfg(not(target_os = "linux"))]
fn cover_whole_display(_window: &tauri::WebviewWindow) {}

fn build_overlay(app: &AppHandle, label: &str, display: &DisplayTarget, instant: bool) -> Result<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // Same split as the tray panel: the dev server serves `/capture-overlay`,
    // the static export only `capture-overlay.html`. `instant` lets the page
    // show the crosshair before its context has loaded.
    let route = if cfg!(dev) { "capture-overlay" } else { "capture-overlay.html" };
    let instant = if instant { "&instant=1" } else { "" };
    let url = WebviewUrl::App(format!("{route}?display={}{instant}", display.id).into());
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
        // Only the overlay hosting the bar is focused, and Hippius is often
        // not the active app when the shortcut opens it. Without this the
        // press on an overlay that is not the key window only brings it
        // forward and never reaches the page, so a drag outside the area
        // drew nothing and the area stayed where it was. macOS only; the
        // other platforms deliver that press already.
        .accept_first_mouse(true)
        .visible(false)
        .build()
        .map_err(|e| AppError::Other(format!("Could not open the capture overlay: {e}")))
        .inspect(|window| {
            // The bar's microphone meter calls `getUserMedia` here too.
            super::webview_media::allow_capture_devices(window);
        })
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
            // No native shadow on any platform: on a transparent window it is
            // drawn from the window's rectangle (DWM on Windows, AppKit on
            // macOS), not the pill's rounded shape, so it framed the pill in a
            // border. The page draws its own shadow, sized to fit the window.
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            // Out of the recording. On macOS the helper leaves it out itself,
            // so it stays visible to other apps' screen sharing
            // (`own_windows`); Windows can only protect it.
            .content_protected(super::own_windows::content_protected(
                super::rollout::current_platform(),
                super::own_windows::OwnWindow::Pill,
            ))
            .focused(false)
            // Pause and Stop answer the first click, like the card's buttons.
            .accept_first_mouse(true)
            .inner_size(CONTROLS_WIDTH, CONTROLS_HEIGHT)
            .visible(false)
            .build()
            .map_err(|e| AppError::Other(format!("Could not open the recording controls: {e}")))?;
        raise_above_menu_bar(&window);
        watch_capture_window_focus(&window);
        // Lay the page out at its full height at once (macOS), before it
        // first draws: the pill is in the middle of it, where the window
        // shows it (`live_controls::fixed_menu_room`).
        if let Some(frame) = current_camera_frame(&window) {
            set_pill_frame(&window, frame, 1.0, None);
        }
        window
    };
    if !window.is_visible().unwrap_or(false) {
        let state = app.state::<AppState>();
        if let Some(d) = lock(&state.capture.bar_display).clone() {
            let area = work_area(&state.capture, &d);
            let usual = camera::Frame {
                x: area.x + (area.width - CONTROLS_WIDTH) / 2.0,
                y: area.y + area.height - CONTROLS_HEIGHT - CONTROLS_MARGIN,
                width: CONTROLS_WIDTH,
                height: CONTROLS_HEIGHT,
            };
            let frame = pill_clear_of_area(&state.capture, &d, area).unwrap_or(usual);
            // Placed at its own size: a menu left open last time is gone.
            lock(&state.capture.pill_menu).take();
            set_pill_frame(&window, frame, area.scale, None);
        }
    }
    if show {
        show_without_focus(&window);
    }
    Ok(())
}

/// Where nothing keeps the pill out of the video (Linux), an area recording
/// on the bar's display gets the pill outside the area
/// ([`camera::pill_outside`]); `None` keeps the usual bottom centre.
fn pill_clear_of_area(state: &CaptureState, bar: &DisplayTarget, work: LogicalArea) -> Option<camera::Frame> {
    if !super::support::pill_filmed(super::rollout::current_platform()) {
        return None;
    }
    let Some(Selection::Area { display_id, rect }) = *lock(&state.selection) else {
        return None;
    };
    if display_id != bar.id {
        return None;
    }
    let origin = display_area(bar);
    let recorded = camera::Frame {
        x: origin.x + rect.x,
        y: origin.y + rect.y,
        width: rect.width,
        height: rect.height,
    };
    camera::pill_outside(work.frame(), recorded, (CONTROLS_WIDTH, CONTROLS_HEIGHT), CONTROLS_MARGIN)
}

/// A Wayland area recording: put the pill outside the area just drawn
/// ([`camera::pill_outside`] on the monitor the stream covers, mapped by
/// [`super::area_pick::area_on_monitor`]); with no room anywhere, the
/// monitor's bottom centre. Only where the pill is filmed and the monitor
/// is known. A compositor that places windows itself (GNOME's own Wayland
/// session ignores an app's window position) keeps it where it put it.
fn place_pill_clear_of_stream_area(app: &AppHandle, area: recording::protocol::StreamCrop, stream: (u32, u32)) {
    if !super::support::pill_filmed(super::rollout::current_platform()) {
        return;
    }
    let Some((monitor, scale)) = *lock(&app.state::<AppState>().capture.area_monitor) else {
        tracing::info!("capture area: the stream's monitor is unknown; the pill stays where the desktop put it");
        return;
    };
    let Some(window) = app.get_webview_window(CONTROLS_LABEL) else {
        return;
    };
    let frame = pill_frame_for_stream_area(monitor, area, stream);
    tracing::info!(?frame, "capture area: the pill goes outside the recorded area");
    place(&window, frame, scale);
}

/// Where the pill goes for a Wayland area: outside the area on its monitor
/// (below, above, beside), else the monitor's bottom centre.
fn pill_frame_for_stream_area(monitor: super::area_pick::MonitorBox, area: recording::protocol::StreamCrop, stream: (u32, u32)) -> camera::Frame {
    let screen = camera::Frame {
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
    };
    let bottom_centre = camera::Frame {
        x: screen.x + (screen.width - CONTROLS_WIDTH) / 2.0,
        y: screen.y + screen.height - CONTROLS_HEIGHT - CONTROLS_MARGIN,
        width: CONTROLS_WIDTH,
        height: CONTROLS_HEIGHT,
    };
    super::area_pick::area_on_monitor(area, stream, monitor)
        .and_then(|recorded| camera::pill_outside(screen, recorded, (CONTROLS_WIDTH, CONTROLS_HEIGHT), CONTROLS_MARGIN))
        .unwrap_or(bottom_centre)
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
            let instant = state.capture.instant.load(Ordering::SeqCst);
            if let Err(e) = open_overlay(app, display, false, instant).await {
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

// ── The bar following the pointer ──────────────────────────────────────────

/// Move the bar to the display the pointer is on while the user is choosing,
/// as macOS's own capture bar follows the active display. The bar is chosen
/// once, under the pointer, when the capture starts; without this it stayed
/// there when the user went on to another display. Every display already has
/// its overlay, so only which one draws the bar changes. One follow at a
/// time; it ends when the choosing does.
fn spawn_bar_follow(app: AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.capture.bar_follow.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(BAR_FOLLOW_EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut seen_before = None;
        loop {
            interval.tick().await;
            let state = app.state::<AppState>();
            if state.capture.bar_follow.load(Ordering::SeqCst) != generation || !matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
                break;
            }
            let displays = lock(&state.capture.displays).clone();
            let under_pointer = bar::display_under(&displays, cursor_point(&app, &displays));
            let bar = lock(&state.capture.bar_display).as_ref().map(|d| d.id);
            let held = state.capture.bar_held.load(Ordering::SeqCst);
            if let Some(target) = bar::bar_follow(bar, under_pointer, seen_before, held)
                && let Some(display) = displays.into_iter().find(|d| d.id == target)
            {
                move_bar(&app, &state.capture, display);
            }
            seen_before = under_pointer;
        }
    });
}

/// Hand the bar to `display`'s overlay. Skipped while that overlay is not up
/// yet (a display plugged in a moment ago): the next check tries again.
fn move_bar(app: &AppHandle, state: &CaptureState, display: DisplayTarget) {
    let Some(overlay) = app.get_webview_window(&format!("{OVERLAY_LABEL_PREFIX}{}", display.id)) else {
        return;
    };
    // The card waiting hidden goes to the bar's display too, where the
    // capture it will show is being chosen; one already showing stays put.
    if let Some(card) = app.get_webview_window(PREVIEW_LABEL)
        && !card.is_visible().unwrap_or(true)
    {
        let area = work_area(state, &display);
        place(&card, card_frame(area), area.scale);
    }
    *lock(&state.bar_display) = Some(display);
    // The overlays re-read their context: the new one draws the bar, the old
    // one stops. The pill, still hidden, is placed on the bar's display when
    // it comes on screen (`open_controls`).
    state.rebroadcast(|e| emit_phase(app, e));
    // The keyboard goes with the bar: Return, Escape and Space act on it.
    let _ = overlay.set_focus();
}

/// The bar's overlay holds the bar on its display (`held` true) or lets it
/// follow the pointer again (false): see [`spawn_bar_follow`].
#[tauri::command]
pub fn capture_hold_bar(state: tauri::State<'_, AppState>, held: bool) {
    state.capture.bar_held.store(held, Ordering::SeqCst);
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
    /// Which devices Windows' privacy settings block, and the camera's line
    /// (the bar offers "Open Settings" under a blocked row).
    #[serde(flatten)]
    pub privacy: super::privacy::DevicePrivacy,
    pub destination: Option<CaptureDestination>,
    /// The area already drawn, on this display or another. At the start of a
    /// capture it is the area last drawn on the bar's display, fitted to it.
    pub pending: Option<Selection>,
    /// The shortcut's one-step area screenshot ([`super::instant`]): the page
    /// draws no bar and takes the shot when the drag ends.
    pub instant: bool,
    /// This window is Wayland's recording panel (the bar alone; the
    /// desktop's dialog chooses), not a display's overlay.
    pub panel: bool,
    /// The overlay is drawn over a still of the desktop
    /// ([`capture_overlay_backdrop`]), hidden while a countdown runs.
    pub frozen: bool,
}

#[tauri::command]
pub async fn capture_overlay_context(state: tauri::State<'_, AppState>, display_id: u32) -> Result<OverlayContext> {
    let CapturePhase::Selecting { mode, kind } = state.capture.current() else {
        return Err(AppError::Validation("No capture is waiting for a selection.".into()));
    };
    let surfaces = super::support::surfaces();
    let plan = super::support::start_plan(&surfaces, kind);
    // Only the live overlay lists windows: the panel's desktop dialog and
    // Wayland's still have none.
    let windows = if mode == CaptureMode::Window && plan == super::support::StartPlan::Overlay {
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
    let instant = state.capture.instant.load(Ordering::SeqCst);
    let frozen = lock(&state.capture.frozen).is_some();
    Ok(OverlayContext {
        panel: plan == super::support::StartPlan::Panel,
        frozen,
        mode,
        display_id,
        kind,
        windows,
        hosts_bar,
        countdown_secs: super::instant::countdown_secs(instant, super::support::countdown_secs(&surfaces, options.countdown_secs(kind), kind)),
        instant,
        camera_filmed: options.camera_filmed(kind, mode),
        options,
        recording_available: recording::recording_supported(),
        microphone_available: recording::microphone_supported(),
        show_clicks_available: recording::show_clicks_supported(),
        camera_only_available: camera_only_supported(),
        recording_availability: recording::RecordingAvailability::now(),
        surfaces,
        privacy: super::privacy::device_privacy(),
        destination,
        pending,
    })
}

/// The still of `display_id`'s monitor a Wayland screenshot is chosen on (a
/// JPEG data URL), read once by its overlay; `None` without one. Kept out
/// of the context, which is read again on every mode switch.
#[tauri::command]
pub fn capture_overlay_backdrop(state: tauri::State<'_, AppState>, display_id: u32) -> Option<String> {
    let index = usize::try_from(display_id).ok()?;
    lock(&state.capture.frozen).as_ref()?.backdrops.get(index).cloned()
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
        return Err(AppError::Validation(why.line().into()));
    }
    let was = match state.capture.current() {
        CapturePhase::Selecting { kind, .. } => Some(kind),
        _ => None,
    };
    advance(&app, &state.capture, CaptureEvent::SetMode { kind, mode })?;
    // Wayland: a screenshot is chosen on the frozen overlay and a recording
    // on the panel, so switching kind swaps the windows.
    if let Some(next) = was.and_then(|was| super::support::switch_plan(&super::support::surfaces(), was, kind)) {
        swap_selection_windows(&app, next).await?;
    }
    // Space during an instant shot is not a choice made on the bar: the bar
    // opens where the user left it next time.
    if super::instant::remembers_mode_switch(state.capture.instant.load(Ordering::SeqCst)) {
        let pool = state.pool()?;
        let options = CaptureOptions {
            last_kind: kind,
            last_mode: mode,
            ..bar::load_options(pool).await?
        };
        bar::save_options(pool, options).await?;
    }
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
            return Err(AppError::Validation(why.line().into()));
        }
        if !camera_only_supported() {
            return Err(AppError::Validation(
                "Recording the camera on its own isn't available on this system yet.".into(),
            ));
        }
        if super::support::camera_by_recorder(super::rollout::current_platform()) {
            // Wayland: no window to film; the recorder opens the camera
            // itself (`begin_recording` names it), so the selection is only
            // nominal and no desktop dialog is asked.
            Selection::Screen {
                display_id: super::support::PANEL_DISPLAY_ID,
            }
        } else {
            // Camera only: what is recorded is the stage window itself.
            let window_id = camera_window_id(&app)
                .await
                .ok_or_else(|| AppError::Validation("The camera isn't on screen yet. Try again in a moment.".into()))?;
            Selection::Window { window_id }
        }
    } else if kind == CaptureKind::Recording && super::support::surfaces().record_selection == super::support::SelectionUi::SystemPicker {
        // The panel: the desktop's screen-sharing dialog chooses the window
        // or screen once the recorder asks it.
        super::support::system_picker_selection(mode)
    } else {
        let pending = *lock(&state.capture.pending);
        // Entire screen: the display under the pointer, as a click takes it.
        let displays = lock(&state.capture.displays).clone();
        // Wayland tells an app nothing of the pointer: the bar's display.
        let frozen = lock(&state.capture.frozen).is_some();
        let under_pointer = if frozen {
            None
        } else {
            bar::display_under(&displays, cursor_point(&app, &displays))
        };
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
        countdown_secs: super::support::countdown_secs(&super::support::surfaces(), options.countdown_secs(kind), kind),
        camera_filmed: options.camera_filmed(kind, mode),
        options,
    })
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn windows_on_display_blocking(display_id: u32) -> Result<Vec<WindowTarget>> {
    let display = super::targets::list_displays()?
        .into_iter()
        .find(|d| d.id == display_id)
        .ok_or_else(|| AppError::Validation("That display is no longer connected.".into()))?;
    super::targets::windows_on_display(&display)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
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
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
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

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
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

/// No app icons on the picker's tiles off macOS yet; the tile shows the
/// app's name.
#[cfg(any(windows, target_os = "linux"))]
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
    // The bar's Record (and an overlay click, the share picker, camera only):
    // a free plan whose recordings are used up is refused here, the bar
    // still up, so the user can upgrade or take a screenshot instead.
    if kind == CaptureKind::Recording {
        super::recording_allowance::require_can_start(&state).await?;
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
    let frozen = lock(&state.capture.frozen).take();
    let taken = if let Some(frozen) = frozen {
        // Wayland: cut from the still the overlay showed (a fresh one after
        // a countdown).
        take_from_still(app, selection, frozen).await
    } else {
        let clear = state.capture.ui_in_grabs.load(Ordering::SeqCst);
        if clear {
            clear_screen_for_grab(app).await;
        } else if super::own_windows::hide_card_for_screenshot(super::rollout::current_platform()) {
            hide_card_for_grab(app).await;
        }
        take_screenshot(selection, clear).await
    };
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

/// A screenshot through the desktop's own screenshot tool (Wayland). The
/// session is `Capturing` while the tool is open: the tool is the selection.
/// Cancelling in the tool ends the session as a cancel (no toast, no failed
/// card); anything else that goes wrong ends in [`fail_capture`].
async fn system_picker_screenshot(app: &AppHandle) {
    let state = app.state::<AppState>();
    if advance(app, &state.capture, CaptureEvent::Selected).is_err() {
        // Ended meanwhile (signed out): nothing was asked yet.
        return;
    }
    match take_with_system_picker(app).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = advance(app, &state.capture, CaptureEvent::Cancel);
            drop_unused_preview(app, &state.capture);
            restore_main_window(app, &state.capture);
            hand_focus_back(app, &state.capture);
        }
        Err(e) => fail_capture(app, &e).await,
    }
}

/// Ask the portal, move its file into a fresh capture folder under the
/// Hippius name, show the card, and start delivery. `Ok(false)` = the user
/// cancelled in the desktop's tool.
async fn take_with_system_picker(app: &AppHandle) -> Result<bool> {
    let state = app.state::<AppState>();
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let answer = super::linux_portal::request(true).await;
    let settled = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // Named for when it was taken, not when the tool opened.
            let name = super::naming::capture_file_name(CaptureKind::Screenshot, chrono::Local::now().naive_local());
            let shot = super::linux_portal::settle(answer, &dir.join(name))?;
            Ok::<_, AppError>(match shot {
                super::linux_portal::PortalShot::Taken { path, image } => {
                    let thumbnail = image.and_then(|i| super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(i)).ok());
                    Some((path, thumbnail))
                }
                super::linux_portal::PortalShot::Cancelled => None,
            })
        })
        .await
        .map_err(|e| AppError::Other(format!("capture task failed: {e}")))
        .and_then(|r| r)
    };
    let (path, thumbnail) = match settled {
        Ok(Some(taken)) => taken,
        Ok(None) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Ok(false);
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    restore_main_window(app, &state.capture);
    let card_id = open_preview(app, CaptureKind::Screenshot, &path, thumbnail).await;
    // The session ends here: the file exists, and the card owns the upload.
    if let Err(e) = advance(app, &state.capture, CaptureEvent::Captured) {
        let _ = std::fs::remove_dir_all(&dir);
        close_preview(app, &state.capture);
        return Err(e);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
    });
    Ok(true)
}

// ── Wayland: screenshots on a still of the desktop ──────────────────────────

/// A screenshot start with no live overlay (Wayland): the card is prepared
/// hidden, as for an overlay, and either the overlay is drawn over a still
/// of the desktop taken once the main window is gone ([`frozen_screenshot`],
/// the desktop's own tool if none) or the desktop's tool chooses at once
/// ([`system_picker_screenshot`]). A still left by an ended session was
/// dropped there (`fail_capture`, `cancel_inner`, `finish_screenshot`).
fn start_without_live_overlay(app: &AppHandle, state: &CaptureState, plan: super::support::StartPlan) {
    if let Err(e) = open_preview_window(app, None) {
        tracing::warn!(error = %e, "capture preview card not prepared");
    }
    let app = app.clone();
    if plan == super::support::StartPlan::Frozen {
        // The card from an earlier capture comes back once the still is in.
        tauri::async_runtime::spawn(async move { frozen_screenshot(&app).await });
    } else {
        show_card_if_any(&app, state);
        tauri::async_runtime::spawn(async move { system_picker_screenshot(&app).await });
    }
}

/// A Wayland screenshot on Hippius's own overlay, drawn over a still of the
/// desktop (`frozen_shot`): the same bar, keys, timer and instant shortcut
/// as elsewhere, area and entire screen only. The session stays `Selecting`
/// while the still is taken. A still the portal refuses, or one that does
/// not fit the monitors, hands over to the desktop's own tool
/// ([`system_picker_screenshot`]), so the user is never stuck.
async fn frozen_screenshot(app: &AppHandle) {
    let state = app.state::<AppState>();
    let frozen = freeze_desktop(app).await;
    // Ended meanwhile (signed out, or the bar switched to Record): nothing
    // is shown.
    if !matches!(
        state.capture.current(),
        CapturePhase::Selecting {
            kind: CaptureKind::Screenshot,
            ..
        }
    ) {
        return;
    }
    let Some((frozen, scales, primary)) = frozen else {
        tracing::info!("capture: no still of the desktop; the desktop's screenshot tool takes over");
        system_picker_screenshot(app).await;
        return;
    };
    if let Err(e) = open_frozen_overlays(app, frozen, &scales, primary).await {
        fail_capture(app, &e).await;
    }
}

/// The still and the monitors it is laid onto (with each one's GDK scale and
/// which is primary), or `None` when either cannot be had. The main window
/// was hidden by `capture_start`, and a card left from an earlier capture
/// goes too, so neither is in the picture.
async fn freeze_desktop(app: &AppHandle) -> Option<(super::frozen_shot::FrozenDesktop, Vec<f64>, Option<usize>)> {
    hide_card_for_grab(app).await;
    tokio::time::sleep(super::linux_x11::COMPOSITOR_SETTLE * 2).await;
    let image = portal_still().await?;
    let (monitors, scales, primary) = wayland_monitors(app).await;
    let built = tauri::async_runtime::spawn_blocking(move || super::frozen_shot::FrozenDesktop::new(image, monitors))
        .await
        .ok()
        .flatten();
    if built.is_none() {
        tracing::warn!("capture: the desktop's still does not match its monitors");
    }
    built.map(|frozen| (frozen, scales, primary))
}

/// One non-interactive portal picture of the whole desktop, in memory. The
/// portal's file (GNOME writes it under Pictures) is moved into a capture
/// folder and that folder removed once read, so no copy is left behind.
async fn portal_still() -> Option<image::RgbaImage> {
    let answer = super::linux_portal::request(false).await;
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root().ok()?).ok()?;
    let settled = tauri::async_runtime::spawn_blocking(move || {
        let shot = super::linux_portal::settle(answer, &dir.join("desktop.png"));
        let _ = std::fs::remove_dir_all(&dir);
        shot
    })
    .await
    .ok()?;
    match settled {
        Ok(super::linux_portal::PortalShot::Taken { image: Some(image), .. }) => Some(image),
        Ok(super::linux_portal::PortalShot::Taken { image: None, .. }) => {
            tracing::warn!("capture: the desktop's still could not be read");
            None
        }
        Ok(super::linux_portal::PortalShot::Cancelled) => {
            tracing::info!("capture: the desktop declined a still of the screen");
            None
        }
        Err(e) => {
            tracing::info!(error = %e, "capture: no still of the desktop");
            None
        }
    }
}

/// GDK's monitors in its own order (the order `fullscreen_on_monitor` takes),
/// each one's scale, and which is primary.
#[cfg(target_os = "linux")]
async fn wayland_monitors(app: &AppHandle) -> (Vec<super::area_pick::MonitorBox>, Vec<f64>, Option<usize>) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let posted = app.run_on_main_thread(move || {
        use gtk::prelude::*;
        let Some(display) = gtk::gdk::Display::default() else {
            let _ = tx.send((Vec::new(), Vec::new(), None));
            return;
        };
        let primary = display.primary_monitor();
        let mut monitors = Vec::new();
        let mut scales = Vec::new();
        let mut primary_index = None;
        for i in 0..display.n_monitors() {
            let Some(m) = display.monitor(i) else { continue };
            if primary.as_ref() == Some(&m) {
                primary_index = Some(monitors.len());
            }
            let g = m.geometry();
            monitors.push(super::area_pick::MonitorBox {
                x: f64::from(g.x()),
                y: f64::from(g.y()),
                width: f64::from(g.width()),
                height: f64::from(g.height()),
            });
            scales.push(f64::from(m.scale_factor().max(1)));
        }
        let _ = tx.send((monitors, scales, primary_index));
    });
    if posted.is_err() {
        return (Vec::new(), Vec::new(), None);
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), rx)
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::unused_async)]
async fn wayland_monitors(_app: &AppHandle) -> (Vec<super::area_pick::MonitorBox>, Vec<f64>, Option<usize>) {
    (Vec::new(), Vec::new(), None)
}

/// An overlay per monitor, each full screen on its own monitor over its
/// part of the still, the bar on the primary one. No display watch and no
/// bar follow: the still cannot follow a change, and Wayland gives no
/// pointer position to follow.
async fn open_frozen_overlays(app: &AppHandle, frozen: super::frozen_shot::FrozenDesktop, scales: &[f64], primary: Option<usize>) -> Result<()> {
    let state = app.state::<AppState>();
    let bar = super::frozen_shot::bar_monitor(frozen.monitors.len(), primary);
    let displays = super::frozen_shot::display_targets(&frozen.monitors, scales, bar);
    let instant = state.capture.instant.load(Ordering::SeqCst);
    let areas = match state.pool() {
        Ok(pool) => bar::load_areas(pool).await.unwrap_or_default(),
        Err(_) => bar::RememberedAreas::default(),
    };
    let host = displays.get(bar).cloned();
    *lock(&state.capture.pending) = if instant {
        None
    } else {
        host.as_ref().and_then(|d| remembered_area(&areas, d))
    };
    *lock(&state.capture.bar_display) = host;
    state.capture.bar_held.store(false, Ordering::SeqCst);
    lock(&state.capture.displays).clone_from(&displays);
    *lock(&state.capture.frozen) = Some(frozen);
    for (index, display) in displays.iter().enumerate() {
        open_frozen_overlay(app, display, index, index == bar, instant).await?;
    }
    show_card_if_any(app, &state.capture);
    Ok(())
}

async fn open_frozen_overlay(app: &AppHandle, display: &DisplayTarget, index: usize, hosts_bar: bool, instant: bool) -> Result<()> {
    let label = format!("{OVERLAY_LABEL_PREFIX}{}", display.id);
    // The panel (`capture-overlay-0`) may still be on its way out after a
    // switch from Record.
    if let Some(stale) = app.get_webview_window(&label) {
        let _ = stale.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let window = build_overlay(app, &label, display, instant)?;
    fullscreen_on_monitor(&window, index);
    window
        .show()
        .map_err(|e| AppError::Other(format!("Could not show the capture overlay: {e}")))?;
    if hosts_bar {
        let _ = window.set_focus();
    }
    Ok(())
}

/// Full screen on GDK's monitor `index` (an app cannot place a window on
/// Wayland, but may ask for full screen on a given output).
#[cfg(target_os = "linux")]
fn fullscreen_on_monitor(window: &tauri::WebviewWindow, index: usize) {
    let target = window.clone();
    let posted = window.run_on_main_thread(move || {
        use gtk::prelude::*;
        let Ok(gtk_window) = target.gtk_window() else {
            let _ = target.set_fullscreen(true);
            return;
        };
        match (WidgetExt::screen(&gtk_window), i32::try_from(index)) {
            (Some(screen), Ok(i)) => gtk_window.fullscreen_on_monitor(&screen, i),
            _ => gtk_window.fullscreen(),
        }
    });
    if posted.is_err() {
        let _ = window.set_fullscreen(true);
    }
}

#[cfg(not(target_os = "linux"))]
fn fullscreen_on_monitor(window: &tauri::WebviewWindow, _index: usize) {
    let _ = window.set_fullscreen(true);
}

/// The bar switched kind where the two are chosen in different windows
/// (Wayland): the frozen overlays give way to the panel for Record, the
/// panel to a fresh still for a screenshot. A panel that cannot open ends
/// the session, or it would sit in `Selecting` with nothing on screen.
async fn swap_selection_windows(app: &AppHandle, next: super::support::StartPlan) -> Result<()> {
    let state = app.state::<AppState>();
    lock(&state.capture.frozen).take();
    close_overlays(app);
    match next {
        super::support::StartPlan::Panel => {
            let opened = open_panel(app, &state.capture).await;
            if let Err(e) = &opened {
                fail_capture(app, e).await;
            }
            opened
        }
        super::support::StartPlan::Frozen => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { frozen_screenshot(&app).await });
            Ok(())
        }
        // Never a switch target: those surfaces serve both kinds.
        super::support::StartPlan::Overlay | super::support::StartPlan::SystemPicker => Ok(()),
    }
}

/// The selection cut from the still its overlay showed, or, after a
/// countdown, from a fresh still taken once the overlays are gone
/// (`frozen_shot::retakes`; the frozen one if the fresh one cannot be had).
async fn take_from_still(
    app: &AppHandle,
    selection: Selection,
    frozen: super::frozen_shot::FrozenDesktop,
) -> Result<(image::RgbaImage, Option<String>, PathBuf)> {
    let state = app.state::<AppState>();
    let saved = bar::load_options(state.pool()?).await.unwrap_or_default();
    let count = super::instant::countdown_secs(
        state.capture.instant.load(Ordering::SeqCst),
        super::support::countdown_secs(
            &super::support::surfaces(),
            saved.countdown_secs(CaptureKind::Screenshot),
            CaptureKind::Screenshot,
        ),
    );
    let fresh = if super::frozen_shot::retakes(count) {
        clear_screen_for_grab(app).await;
        tokio::time::sleep(super::linux_x11::COMPOSITOR_SETTLE * 2).await;
        portal_still().await
    } else {
        None
    };
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let name = super::naming::capture_file_name(CaptureKind::Screenshot, chrono::Local::now().naive_local());
    let path = dir.join(name);
    let cut = tauri::async_runtime::spawn_blocking(move || {
        let image = frozen
            .cut_latest(selection, fresh.as_ref())
            .ok_or_else(|| AppError::Validation("Drag to select an area to capture.".into()))?;
        let thumbnail = super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(image.clone())).ok();
        Ok::<_, AppError>((image, thumbnail))
    })
    .await
    .map_err(|e| AppError::Other(format!("capture task failed: {e}")))
    .and_then(|r| r);
    match cut {
        Ok((image, thumbnail)) => Ok((image, thumbnail, path)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// The plan decides the recording's length limit, once, as it starts
/// (`allowance`). Read alongside the recorder's own start, so it adds no
/// wait; with no account or no verdict there is no limit.
fn spawn_tier_lookup(app: &AppHandle) -> tauri::async_runtime::JoinHandle<Option<super::allowance::RecordingTier>> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let account = state.current_session_account().ok()?;
        super::allowance::recording_tier(state.inner(), &account).await
    })
}

/// Start the recorder on `selection`. Failures return to the caller, which
/// ends the session through [`fail_capture`]; a session cancelled while the
/// recorder was starting ends quietly, with the recorder cancelled.
async fn begin_recording(app: &AppHandle, selection: Selection) -> Result<()> {
    let state = app.state::<AppState>();
    let saved = bar::load_options(state.pool()?).await.unwrap_or_default();
    let surfaces = super::support::surfaces();
    let system_picker = surfaces.record_selection == super::support::SelectionUi::SystemPicker;
    // Camera only on Wayland: the recorder opens the camera the stage
    // showed (the stage page lets go of it as the phase moves on), and no
    // desktop dialog is asked.
    let camera = if recorder_opens_camera(*lock(&state.capture.recording_camera)) {
        let name = match &saved.camera_device {
            Some(id) => camera_name(app, id).await,
            None => None,
        };
        Some(recording::protocol::CameraPick {
            id: saved.camera_device.clone(),
            name,
        })
    } else {
        None
    };
    let restore_token = if system_picker && camera.is_none() {
        let displays = app.available_monitors().map_or(0, |m| m.len());
        super::screencast_token::for_start(state.pool()?, selection, displays).await
    } else {
        None
    };
    // macOS leaves Hippius out of a screen or area recording in the helper,
    // all but the main window (filmed like any app if the user brings it
    // into the picture) and the bubble (`own_windows`).
    let own_windows_filmed = if super::own_windows::recorder_leaves_app_out(super::rollout::current_platform()) {
        super::own_windows::filmed_own_windows(main_window_number(app).await, filmed_camera_window(&state.capture))
    } else {
        Vec::new()
    };
    let options = RecordOptions {
        microphone: saved.microphone && recording::microphone_supported(),
        microphone_device: saved.microphone_device.clone(),
        show_clicks: saved.show_clicks && recording::show_clicks_supported(),
        system_audio: saved.system_audio && surfaces.system_audio,
        camera_window: filmed_camera_window(&state.capture),
        own_windows_filmed,
        restore_token,
        pick_area: camera.is_none() && super::support::picks_area_after_dialog(&surfaces, selection),
        camera,
    };
    let microphone_device = options.microphone_device.clone();
    let tmp_root = super::screenshot::capture_tmp_root()?;
    refuse_a_synced_temp(&state, &tmp_root).await?;
    let tier_lookup = spawn_tier_lookup(app);
    let dir = super::screenshot::fresh_capture_dir(&tmp_root)?;
    *lock(&state.capture.recording_dir) = Some(dir.clone());
    let name = super::naming::capture_file_name(CaptureKind::Recording, chrono::Local::now().naive_local());
    let path = dir.join(name);

    // The pill says "Starting recording…" straight after the countdown; the
    // recorder can take a second or two to begin.
    if let Err(e) = open_controls(app, true) {
        tracing::warn!(error = %e, "recording controls could not open");
    }

    // A still of the selection, the preview card's fallback picture when the
    // saved file gives none (`poster::pick`; the card prefers a frame of the
    // file, which has the camera bubble in it). Best effort: a recording
    // without a picture on its card is still a recording. Taken in memory and
    // alongside the recorder's start, so it adds nothing to the wait before
    // recording begins.
    // With the system picker Hippius cannot read the screen itself, and the
    // selection is not chosen yet: no still.
    let poster_task = tauri::async_runtime::spawn_blocking(move || {
        if system_picker {
            return None;
        }
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
    let mut recorder = started?;
    // A Wayland area: the desktop's dialog chose the monitor; the area is
    // drawn on its picture now, and only then does the recording start.
    if let Some(still) = recorder.take_area_still() {
        recorder = draw_area(app, recorder, still).await?;
    }
    if system_picker && let Ok(pool) = state.pool() {
        super::screencast_token::remember(pool, recorder.restore_token()).await;
    }
    // The desktop's dialog came between Record and now, so the countdown
    // runs here, in the pill, with the recording held paused.
    let count = super::support::countdown_after_picker(&surfaces, saved.record_countdown_secs, CaptureKind::Recording);
    if count > 0 {
        recorder = count_down_in_pill(app, recorder, count).await?;
    }

    let tier = tier_lookup.await.ok().flatten();
    state.capture.set_recording_limit(super::allowance::max_recording(tier));
    state.capture.stopped_at_limit.store(false, Ordering::SeqCst);
    let recorded_microphone = recorder.microphone();
    if let Err(orphan) = state.capture.adopt_recorder(recorder, |e| emit_phase(app, e)) {
        // Cancelled (or ended) while the recorder was starting. It must not
        // keep recording the screen with no pill and nothing to stop it.
        let dir = lock(&state.capture.recording_dir).take();
        discard_recording(Some(orphan), dir).await;
        close_controls(app);
        end_camera(app).await;
        return Ok(());
    }
    // Every recording (a restart too) starts heard, on the device it opened.
    set_live_microphone(app, super::live_controls::LiveMicrophone::started(recorded_microphone, microphone_device));
    // The pill's camera menu (sizes, another camera) is offered only once the
    // recording runs (`live_controls::camera_controls`), and the last camera
    // state it heard was sent at Record, when it was still `Capturing`: without
    // this the pill never offered the bubble's sizes or another camera.
    announce_camera(app).await;
    // The main window stays hidden until the recording ends: it would be in
    // the video, and it would take the keyboard from the app being recorded.
    if let Err(e) = open_controls(app, true) {
        tracing::warn!(error = %e, "recording controls could not open");
    }
    spawn_tick_loop(app.clone());
    Ok(())
}

/// Show the chosen monitor's picture full screen, wait for the area drawn
/// on it (`capture_area_choose`), and crop the recorder to it in the
/// stream's own pixels (`area_pick`). A cancel at any step (Escape, the
/// pill, sign-out) moves the phase on: the recorder is handed back
/// uncropped and [`adopt_recorder`] gives it to be thrown away, as for any
/// cancel while starting. Left undrawn for [`area_pick::DRAW_WITHIN`], the
/// recording ends as quietly as a cancelled dialog.
///
/// [`area_pick::DRAW_WITHIN`]: super::area_pick::DRAW_WITHIN
async fn draw_area(app: &AppHandle, recorder: Box<dyn Recorder>, still: recording::protocol::StreamStill) -> Result<Box<dyn Recorder>> {
    use super::area_pick::{AreaEvent, AreaStep, DRAW_WITHIN, next};
    let state = app.state::<AppState>();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let placement = still.placement;
    let stream = (still.width, still.height);
    // The last area recorded comes back drawn; the first time, a centred
    // half of the screen (`area_pick::initial_area`).
    let remembered = match state.pool() {
        Ok(pool) => bar::load_areas(pool)
            .await
            .ok()
            .and_then(|areas| areas.get(&super::area_pick::REMEMBERED_AREA_ID).copied()),
        Err(_) => None,
    };
    *lock(&state.capture.area_monitor) = None;
    *lock(&state.capture.area_pick) = Some(AreaPick {
        step: next(AreaStep::Choosing, AreaEvent::StillArrived).unwrap_or(AreaStep::Drawing),
        initial: super::area_pick::initial_area(remembered, stream),
        still,
        chosen: Some(tx),
    });
    let end = |event: AreaEvent| {
        let mut slot = lock(&state.capture.area_pick);
        if let Some(pick) = slot.as_mut()
            && let Some(step) = next(pick.step, event)
        {
            pick.step = step;
        }
        slot.take();
    };
    if let Err(e) = open_area_window(app, placement) {
        end(AreaEvent::Failed);
        return Err(e);
    }
    let deadline = std::time::Instant::now() + DRAW_WITHIN;
    let chosen = loop {
        let starting = matches!(
            state.capture.current(),
            CapturePhase::Capturing {
                kind: CaptureKind::Recording
            }
        );
        if !starting {
            break Ok(None);
        }
        if std::time::Instant::now() >= deadline {
            break Err(());
        }
        match tokio::time::timeout(std::time::Duration::from_millis(100), &mut rx).await {
            Ok(Ok(area)) => break Ok(Some(area)),
            Ok(Err(_)) => break Ok(None),
            Err(_) => {}
        }
    };
    if let Some(window) = app.get_webview_window(AREA_LABEL) {
        let _ = window.destroy();
    }
    let area = match chosen {
        Ok(Some(area)) => area,
        // Cancelled meanwhile: `adopt_recorder` refuses it and it is thrown
        // away there.
        Ok(None) => {
            end(AreaEvent::Cancelled);
            return Ok(recorder);
        }
        Err(()) => {
            end(AreaEvent::Cancelled);
            tracing::info!("capture area: nothing drawn in time; the recording is given up");
            return Err(AppError::Other(recording::protocol::PICKER_CANCELLED.into()));
        }
    };
    if let Ok(pool) = state.pool() {
        let kept = super::geometry::LogicalRect {
            x: f64::from(area.x),
            y: f64::from(area.y),
            width: f64::from(area.width),
            height: f64::from(area.height),
        };
        if let Err(e) = bar::remember_area(pool, super::area_pick::REMEMBERED_AREA_ID, kept).await {
            tracing::debug!(error = %e, "could not remember the recorded area");
        }
    }
    // The pill goes outside the area where the desktop lets a window be
    // placed (it is filmed on Linux), before the first cropped picture.
    place_pill_clear_of_stream_area(app, area, stream);
    // The selection window is in the stream until the compositor has
    // taken it down; the first cropped picture must not show it.
    tokio::time::sleep(super::linux_x11::COMPOSITOR_SETTLE * 2).await;
    let (recorder, cropped) = tauri::async_runtime::spawn_blocking(move || {
        let mut recorder = recorder;
        let cropped = recorder.crop(area);
        (recorder, cropped)
    })
    .await
    .map_err(|e| AppError::Other(format!("recording task failed: {e}")))?;
    end(if cropped.is_ok() { AreaEvent::Started } else { AreaEvent::Failed });
    cropped.map(|()| recorder)
}

/// The full-screen window the area is drawn in, over the monitor the stream
/// shows when the compositor said where that is.
fn open_area_window(app: &AppHandle, placement: Option<recording::protocol::StreamPlacement>) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(stale) = app.get_webview_window(AREA_LABEL) {
        let _ = stale.destroy();
    }
    // The tray panel's dev/export split.
    let route = if cfg!(dev) { "capture-area" } else { "capture-area.html" };
    let window = WebviewWindowBuilder::new(app, AREA_LABEL, WebviewUrl::App(route.into()))
        .title("Choose the area to record")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
        .map_err(|e| AppError::Other(format!("Could not open the area selection: {e}")))?;
    fill_stream_monitor(&window, placement);
    window
        .show()
        .map_err(|e| AppError::Other(format!("Could not show the area selection: {e}")))?;
    let _ = window.set_focus();
    Ok(())
}

/// Full screen on the monitor the stream covers (GTK's own monitor
/// geometry is the layout the portal places streams in), or wherever the
/// compositor puts a full-screen window when the portal did not say.
#[cfg(target_os = "linux")]
fn fill_stream_monitor(window: &tauri::WebviewWindow, placement: Option<recording::protocol::StreamPlacement>) {
    let target = window.clone();
    let posted = window.run_on_main_thread(move || {
        use gtk::prelude::*;
        let Ok(gtk_window) = target.gtk_window() else {
            let _ = target.set_fullscreen(true);
            return;
        };
        let display = WidgetExt::display(&gtk_window);
        let monitors: Vec<super::area_pick::MonitorBox> = (0..display.n_monitors())
            .filter_map(|i| display.monitor(i))
            .map(|m| {
                let g = m.geometry();
                super::area_pick::MonitorBox {
                    x: f64::from(g.x()),
                    y: f64::from(g.y()),
                    width: f64::from(g.width()),
                    height: f64::from(g.height()),
                }
            })
            .collect();
        let index = super::area_pick::monitor_for(placement, &monitors);
        // Kept for the pill: it is placed outside the area on this monitor
        // once the area is drawn (`place_pill_clear_of_stream_area`).
        if let Some(i) = index
            && let (Some(m), Some(gdk_monitor)) = (monitors.get(i), display.monitor(i32::try_from(i).unwrap_or(0)))
        {
            let scale = f64::from(gdk_monitor.scale_factor().max(1));
            *lock(&target.app_handle().state::<AppState>().capture.area_monitor) = Some((*m, scale));
        }
        match (index, WidgetExt::screen(&gtk_window)) {
            (Some(index), Some(screen)) => gtk_window.fullscreen_on_monitor(&screen, i32::try_from(index).unwrap_or(0)),
            _ => gtk_window.fullscreen(),
        }
    });
    if posted.is_err() {
        let _ = window.set_fullscreen(true);
    }
}

#[cfg(not(target_os = "linux"))]
fn fill_stream_monitor(window: &tauri::WebviewWindow, _placement: Option<recording::protocol::StreamPlacement>) {
    let _ = window.set_fullscreen(true);
}

/// What the area window draws on: the monitor's picture (a JPEG data URL)
/// and its size in the stream's pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaContext {
    pub picture: String,
    pub stream_width: u32,
    pub stream_height: u32,
    /// The area to show already drawn, as fractions of the picture: the
    /// last one recorded, else a centred half of the screen.
    pub initial_area: Option<super::area_pick::PictureFraction>,
}

/// The area window's picture, while an area is being drawn.
#[tauri::command]
pub fn capture_area_context(state: tauri::State<'_, AppState>) -> Result<AreaContext> {
    let slot = lock(&state.capture.area_pick);
    match slot.as_ref() {
        Some(pick) if pick.step == super::area_pick::AreaStep::Drawing => Ok(AreaContext {
            picture: format!("data:image/jpeg;base64,{}", pick.still.jpeg),
            stream_width: pick.still.width,
            stream_height: pick.still.height,
            initial_area: pick
                .initial
                .and_then(|area| super::area_pick::fraction_of(area, (pick.still.width, pick.still.height))),
        }),
        _ => Err(AppError::Validation("No area is waiting to be drawn.".into())),
    }
}

/// The area drawn on the picture: `drawn` in the page's CSS pixels, `shown`
/// where the page showed the picture. Mapped onto the stream's pixels here
/// (`area_pick::stream_area`); a rectangle with nothing of the picture in
/// it is refused with the line the bar shows, and the page stays up.
#[tauri::command]
pub fn capture_area_choose(
    state: tauri::State<'_, AppState>,
    drawn: super::geometry::LogicalRect,
    shown: super::area_pick::ShownPicture,
) -> Result<()> {
    use super::area_pick::{AreaEvent, next, stream_area};
    let mut slot = lock(&state.capture.area_pick);
    let pick = slot
        .as_mut()
        .ok_or_else(|| AppError::Validation("No area is waiting to be drawn.".into()))?;
    let Some(step) = next(pick.step, AreaEvent::AreaChosen) else {
        return Err(AppError::Validation("No area is waiting to be drawn.".into()));
    };
    let area = stream_area(drawn, shown, (pick.still.width, pick.still.height))
        .ok_or_else(|| AppError::Validation("Drag to select an area to record.".into()))?;
    let sender = pick
        .chosen
        .take()
        .ok_or_else(|| AppError::Validation("No area is waiting to be drawn.".into()))?;
    pick.step = step;
    sender
        .send(area)
        .map_err(|_| AppError::Validation("No area is waiting to be drawn.".into()))
}

/// Count `secs` down in the pill with the recorder paused, then resume it.
/// The recorder has already started (the desktop's dialog is answered), so
/// a pause keeps the count out of the video; a recorder that cannot pause
/// records straight away. A Cancel from the pill during the count moves the
/// phase on, which ends the count; [`adopt_recorder`] then hands the
/// recorder back to be thrown away, as for any cancel while starting.
async fn count_down_in_pill(app: &AppHandle, mut recorder: Box<dyn Recorder>, secs: u8) -> Result<Box<dyn Recorder>> {
    let state = app.state::<AppState>();
    let (mut recorder, paused) = tauri::async_runtime::spawn_blocking(move || {
        let paused = recorder
            .pause()
            .inspect_err(|e| tracing::warn!(error = %e, "could not hold the recording for its countdown"))
            .is_ok();
        (recorder, paused)
    })
    .await
    .map_err(|e| AppError::Other(format!("recording task failed: {e}")))?;
    if !paused {
        return Ok(recorder);
    }
    state.capture.countdown_skip.store(false, Ordering::SeqCst);
    'count: for left in (1..=secs).rev() {
        let _ = app.emit_to(CONTROLS_LABEL, PILL_COUNTDOWN_EVENT, Some(left));
        for _ in 0..10 {
            let starting = matches!(
                state.capture.current(),
                CapturePhase::Capturing {
                    kind: CaptureKind::Recording
                }
            );
            if !starting || state.capture.countdown_skip.swap(false, Ordering::SeqCst) {
                break 'count;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    let _ = app.emit_to(CONTROLS_LABEL, PILL_COUNTDOWN_EVENT, None::<u8>);
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = recorder.resume() {
            tracing::warn!(error = %e, "could not resume the recording after its countdown");
        }
        recorder
    })
    .await
    .map_err(|e| AppError::Other(format!("recording task failed: {e}")))
}

/// What the pill needs besides the phase: whether it is filmed here (it then
/// stays small until pointed at) and, the first time ever, the line saying
/// so. The line is marked seen as it is handed out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlsContext {
    pub compact: bool,
    pub filmed_note: Option<&'static str>,
    /// The room the page keeps above and below the pill for a menu, in
    /// points (`live_controls::fixed_menu_room`): the page is laid out once
    /// at that height (macOS), or, at 0, it is the window's own size.
    pub menu_room: f64,
}

const PILL_NOTE_SEEN_KEY: &str = "capture_pill_note_seen_v1";

#[tauri::command]
pub async fn capture_controls_context(state: tauri::State<'_, AppState>) -> Result<ControlsContext> {
    let compact = super::support::pill_filmed(super::rollout::current_platform());
    let mut filmed_note = None;
    if compact {
        let pool = state.pool()?;
        let seen = crate::utils::preferences::get_user_preference_internal(pool, PILL_NOTE_SEEN_KEY).await?;
        if seen.is_none() {
            crate::utils::preferences::save_user_preference_internal(pool, PILL_NOTE_SEEN_KEY, "1").await?;
            filmed_note = Some(super::support::PILL_FILMED_NOTE);
        }
    }
    Ok(ControlsContext {
        compact,
        filmed_note,
        menu_room: super::live_controls::fixed_menu_room(super::rollout::current_platform()),
    })
}

/// The pill's "Start now" during the countdown after the desktop's dialog.
#[tauri::command]
pub fn capture_skip_countdown(state: tauri::State<'_, AppState>) {
    state.capture.countdown_skip.store(true, Ordering::SeqCst);
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
    let (elapsed, died, lost) = match state.capture.recorder.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(r) => (r.elapsed_secs(), r.take_death(), r.take_lost_device()),
            None => return Tick::Done,
        },
        Err(std::sync::TryLockError::Poisoned(p)) => match p.into_inner().as_ref() {
            Some(r) => (r.elapsed_secs(), r.take_death(), r.take_lost_device()),
            None => return Tick::Done,
        },
        Err(std::sync::TryLockError::WouldBlock) => return Tick::Continue,
    };
    // A microphone unplugged mid-recording: the recording goes on, and the
    // pill says so (one a tick; another waits for the next).
    if let Some(device) = lost {
        tracing::warn!(%device, "a sound source went away; recording goes on without it");
        let _ = app.emit(DEVICE_LOST_EVENT, DeviceLost::new(device));
    }
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
    // A Free plan recording at its length limit ends exactly as Stop would:
    // saved, uploaded and shared as usual, its card saying why.
    if state.capture.at_recording_limit(elapsed) {
        tracing::info!(recorded_secs = elapsed, "recording reached the plan's length limit; stopping it");
        state.capture.stopped_at_limit.store(true, Ordering::SeqCst);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = stop_inner(&app).await {
                tracing::warn!(error = %e, "could not save the recording that reached its length limit");
            }
        });
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

/// A card left on screen by an earlier capture (or a failed one brought
/// back) is not content protected on macOS (`own_windows`), so it goes
/// before the screen is read. `is_visible` answers through the event loop,
/// after the hide, so the window is ordered out when it says false; one
/// more frame lets the window server drop it. The new capture's card shows
/// once the picture is taken.
async fn hide_card_for_grab(app: &AppHandle) {
    let Some(card) = app.get_webview_window(PREVIEW_LABEL) else {
        return;
    };
    if !card.is_visible().unwrap_or(false) {
        return;
    }
    let _ = card.hide();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while card.is_visible().unwrap_or(false) && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    tokio::time::sleep(CARD_GONE_SETTLE).await;
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

/// macOS's `sharingType = none` holds wherever the app runs.
#[cfg(target_os = "macos")]
fn kept_out_of_captures(_window: &tauri::WebviewWindow) -> bool {
    true
}

/// Linux has no content protection: X11 reads whatever is on screen.
#[cfg(not(any(windows, target_os = "macos")))]
fn kept_out_of_captures(_window: &tauri::WebviewWindow) -> bool {
    false
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

/// X11: no portable "the compositor has redrawn" signal, so wait out a
/// couple of frames (`linux_x11::COMPOSITOR_SETTLE`, spike L1).
#[cfg(target_os = "linux")]
fn settle_compositor() {
    std::thread::sleep(super::linux_x11::COMPOSITOR_SETTLE);
}

#[cfg(not(any(windows, target_os = "linux")))]
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

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn capture_blocking(selection: Selection) -> Result<image::RgbaImage> {
    super::screenshot::capture_image(selection)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
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
/// drive was changed since. A card opened before the captures drive was set
/// up (the first capture) asks `setup::ensure` instead, and so does its
/// Retry while there is none; such a capture is kept on this computer
/// meanwhile (`keep_here`), never lost, and the user is asked where captures
/// go when nobody has said.
async fn deliver_and_announce(app: &AppHandle, path: &Path, card_id: Option<u64>) {
    let state = app.state::<AppState>();
    let started_ms = chrono::Utc::now().timestamp_millis();
    let card_destination = card_id.and_then(|id| {
        lock(&state.capture.preview)
            .as_ref()
            .filter(|c| c.id == id && !c.kept_locally)
            .map(|c| c.destination.clone())
    });
    let outcome = async {
        let account_id = state.current_account_id()?;
        let pool = state.pool()?;
        let destination = match card_destination {
            Some(d) => d,
            None => match super::setup::ensure(app, &account_id).await? {
                super::setup::Ensured::Ready(d) => {
                    if let Some(id) = card_id {
                        adopt_destination(app, &account_id, id, &d).await;
                    }
                    d
                }
                super::setup::Ensured::Kept(kept) => return Ok(Delivery::KeptHere(kept)),
            },
        };
        let (mint_link, open_link) = bar::load_options(pool).await.map_or((true, true), |o| (o.copy_link, o.open_link));
        let placed = super::deliver::place(&state, app.clone(), &account_id, &destination, path).await?;
        Ok::<_, AppError>(Delivery::Placed {
            account_id,
            destination,
            mint_link,
            open_link,
            placed,
        })
    }
    .await;

    match outcome {
        Ok(Delivery::KeptHere(kept)) => keep_here(app, path, card_id, &kept).await,
        Ok(Delivery::Placed {
            account_id,
            destination,
            mint_link,
            open_link,
            placed,
        }) => {
            announce_placed(app, card_id, &destination, &placed, mint_link, started_ms);
            // A recording counts toward the free plan's limit from now on,
            // before the server lists it (`recording_allowance`).
            super::recording_allowance::note_delivered(&state, &account_id, &destination, &placed.file_name).await;
            let minted = if mint_link {
                super::deliver::link_for(&state, &account_id, &destination, &placed).await
            } else {
                super::deliver::Minted::default()
            };
            let delivered = super::deliver::Delivered::from_parts(&placed, &minted, &destination);
            let copied = copy_link_to_clipboard(app, delivered.share_url.as_deref());
            if open_link {
                open_link_in_browser(app, delivered.share_url.as_deref());
            }
            // The upload landed (or, synced, the file is in the drive's own
            // folder), so the temp copy has served its purpose, unless a
            // direct upload still needs it to make a link later.
            let editable = card_id.is_some() && super::editor::EditableFormat::from_name(&delivered.file_name).is_some();
            let keep = super::deliver::keep_temp_after_upload(delivered.via_sync, delivered.share_url.is_some(), editable);
            if !keep {
                // Only ever the capture's own temp folder: a capture sent
                // from the folder it was kept in on this computer is in the
                // user's drive folder, which holds their other captures.
                remove_temp_dir(path);
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

/// A picture edited from the tray's Annotate, outside every drive, filed
/// as a new screenshot: the card shows it and it is delivered exactly like
/// a fresh capture (`editor::save_as_new_capture`).
pub(super) async fn deliver_as_new_screenshot(app: &AppHandle, path: &Path, thumbnail: Option<String>) {
    let card_id = open_preview(app, CaptureKind::Screenshot, path, thumbnail).await;
    let (app, path) = (app.clone(), path.to_path_buf());
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &path, card_id).await;
    });
}

/// The recorder writes the file while it records, so where it writes must be
/// somewhere no drive's sync engine can pick it up before delivery places it
/// (a half-written recording would upload as a broken file). The temp root
/// is a hidden app folder, which the engine never walks; this refuses to
/// record should that ever stop being true.
async fn refuse_a_synced_temp(state: &AppState, tmp_root: &Path) -> Result<()> {
    let (Ok(account_id), Ok(pool)) = (state.current_account_id(), state.pool()) else {
        return Ok(());
    };
    let roots: Vec<PathBuf> = destination::drives_here(pool, &account_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|d| d.path)
        .collect();
    if super::recording_allowance::unsynced_by_every_drive(tmp_root, &roots) {
        Ok(())
    } else {
        tracing::error!("the capture temp folder is inside a synced drive; not recording");
        Err(AppError::Validation(
            "Hippius can't record right now: its temporary folder is inside a synced folder.".into(),
        ))
    }
}

/// Where [`deliver_and_announce`] got to.
enum Delivery {
    /// In the drive (or on its way through the sync engine).
    Placed {
        account_id: String,
        destination: CaptureDestination,
        mint_link: bool,
        open_link: bool,
        placed: super::deliver::Placed,
    },
    /// No captures drive yet: keep it on this computer.
    KeptHere(super::setup::Kept),
}

/// Recordings an earlier build HELD on this computer at the free plan's
/// limit (`held_recordings`): released once per sign-in, oldest first, as
/// many as the plan allows now, each delivered like a fresh recording (card,
/// upload, link). Nothing is held any more, so this only empties what is
/// there; one left over waits for the next sign-in.
pub(crate) fn spawn_release_held(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        release_held(&app).await;
    });
}

async fn release_held(app: &AppHandle) {
    use super::held_recordings as held;
    let state = app.state::<AppState>();
    let (Ok(account), Ok(account_id), Ok(pool)) = (state.current_session_account(), state.current_account_id(), state.pool()) else {
        return;
    };
    let waiting = match held::list_held(pool, &account_id).await {
        Ok(waiting) if !waiting.is_empty() => waiting,
        Ok(_) => return,
        Err(e) => {
            tracing::warn!(error = %e, "held recordings not read");
            return;
        }
    };
    let tier = super::allowance::recording_tier(&state, &account).await;
    let counted = match tier {
        Some(t) if super::recording_allowance::is_limited(t) => super::recording_allowance::recording_count(&state, &account_id).await,
        _ => None,
    };
    let n = held::release_count(tier, counted, waiting.len());
    let mut released = 0;
    for recording in waiting.iter().take(n) {
        match held::unseal_for_release(&state, &account_id, recording).await {
            Ok(path) => {
                released += 1;
                let card_id = open_preview(app, CaptureKind::Recording, &path, recording.thumbnail.clone()).await;
                deliver_and_announce(app, &path, card_id).await;
            }
            Err(e) => tracing::warn!(error = %e, "held recording could not be released; kept held"),
        }
    }
    tracing::info!(released, still_held = waiting.len() - released, "held recordings checked");
}

/// A card opened before its drive existed takes the drive setup chose: its
/// name, whether it is synced here, and where Retry sends it from now on.
async fn adopt_destination(app: &AppHandle, account_id: &str, id: u64, chosen: &CaptureDestination) {
    let state = app.state::<AppState>();
    let remote = match state.pool() {
        Ok(pool) => !destination::is_local(pool, account_id, &chosen.label).await,
        Err(_) => true,
    };
    update_card(app, &state.capture, id, |card| {
        card.drive_label.clone_from(&chosen.label);
        card.drive_name.clone_from(&chosen.display_name);
        card.rel_path = chosen.rel_path(&card.file_name);
        card.remote = remote;
        card.destination = chosen.clone();
        card.kept_locally = false;
    });
}

/// No captures drive for this capture yet: keep it where `kept` says (the
/// chosen folder, or Hippius's own while nobody has chosen) and say so, with
/// what to do next. Never a dead end: the card offers Retry and Reveal (and
/// Upgrade for a full plan), the next capture tries again, and when nobody
/// has said where captures go the main window asks.
async fn keep_here(app: &AppHandle, path: &Path, card_id: Option<u64>, kept_as: &super::setup::Kept) {
    let state = app.state::<AppState>();
    let kept = tauri::async_runtime::spawn_blocking({
        let (dir, path) = (kept_as.dir.clone(), path.to_path_buf());
        move || super::deliver::keep_in_folder(&dir, &path)
    })
    .await
    .map_err(|e| AppError::Other(format!("capture keep task failed: {e}")))
    .and_then(|r| r);
    let kept = match kept {
        Ok(kept) => {
            remove_temp_dir(path);
            kept
        }
        Err(e) => {
            // Not even a local folder: the temp copy stays for Retry.
            tracing::warn!(error = %e, "capture could not be kept in the drive folder; left where it was");
            path.to_path_buf()
        }
    };
    let message = kept_as.message.clone();
    let reason = kept_as.reason;
    let file_name = kept.file_name().map(|n| n.to_string_lossy().into_owned());
    let shown = card_id.is_some_and(|id| {
        update_card(app, &state.capture, id, |card| {
            card.status = PreviewStatus::Failed {
                message: message.clone(),
                reason,
                retryable: true,
            };
            if !kept_as.place.is_empty() {
                card.drive_name.clone_from(&kept_as.place);
            }
            card.remote = false;
            card.kept_locally = true;
            if let Some(name) = &file_name {
                card.file_name.clone_from(name);
            }
            card.placed_path = (kept != path).then(|| kept.clone());
            card.file_path.clone_from(&kept);
        })
    });
    let _ = app.emit(
        FAILED_EVENT,
        FailedPayload {
            message: message.clone(),
            card_showing: shown,
        },
    );
    if !shown {
        notify(app, "Capture saved on this computer".into(), message);
    }
    if kept_as.ask {
        super::setup::ask_for_location(app);
    }
}

/// The captures drive was just set up (or its folder chosen): send the
/// capture the card is keeping on this computer, as Retry does, link and
/// all. Returns its file, which the caller then leaves for this delivery.
pub(super) fn redeliver_kept_card(app: &AppHandle) -> Option<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let card = {
        let mut g = lock(&state.capture.preview);
        let card = g.as_ref().filter(|c| c.kept_locally && c.can_retry()).cloned()?;
        let uploading = PreviewCard {
            status: PreviewStatus::Uploading,
            ..card
        }
        .refreshed();
        *g = Some(uploading.clone());
        uploading
    };
    let _ = app.emit(PREVIEW_EVENT, Some(&card));
    let file = card.file_path.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        deliver_and_announce(&app, &card.file_path, Some(card.id)).await;
    });
    Some(file)
}

pub(super) fn notify(app: &AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "capture notification not shown");
    }
}

/// Open a capture's new link in the default browser, as Zight does. Best
/// effort: the link is already on the clipboard and on the card.
fn open_link_in_browser(app: &AppHandle, url: Option<&str>) {
    use tauri_plugin_opener::OpenerExt;
    let Some(url) = url else { return };
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        tracing::warn!(error = %e, "capture link not opened in the browser");
    }
}

/// Put `url` on the clipboard; whether it got there.
pub(super) fn copy_link_to_clipboard(app: &AppHandle, url: Option<&str>) -> bool {
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
    let rel_path = destination.rel_path(&placed.file_name);
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
/// file the engine has not started on (queued behind other files, or not
/// picked up) is finished by its link ([`super::preview::link_finishes_card`]):
/// the capture waits for its own upload, never for the rest of the sync.
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
            if super::preview::link_finishes_card(&card, &row) {
                tracing::info!(
                    card = id,
                    ?row,
                    "capture card finished by its link: the sync engine has not started on it"
                );
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
                FileStatus::Pending => SyncRow::Queued,
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
    // Read and cleared before anything can fail, so a later recording's
    // card never inherits it.
    let at_limit = state.capture.stopped_at_limit.swap(false, Ordering::SeqCst);
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
    // Pauses left out; a whole number of seconds, so the middle of the
    // second it is in is the better guess for where the stills are asked.
    let recorded_secs = f64::from(u32::try_from(recorder.elapsed_secs()).unwrap_or(u32::MAX)) + 0.5;
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

    // The card's picture comes from the saved file, so it shows what the
    // video shows: the camera bubble, or the camera-only stage, which has no
    // screen to screenshot. The still taken at start is only the fallback.
    let at_start = lock(&state.capture.poster).take();
    let recorded = path.clone();
    let from_file = tauri::async_runtime::spawn_blocking(move || super::poster::from_recording(&recorded, recorded_secs))
        .await
        .ok()
        .flatten();
    let poster = super::poster::pick(from_file, at_start);
    let card_id = open_preview(app, CaptureKind::Recording, &path, poster).await;
    if at_limit && let Some(id) = card_id {
        update_card(app, &state.capture, id, |card| card.stopped_at_free_limit = true);
    }
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
    lock(&state.capture.frozen).take();
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
    // A restart starts a new recording: refused before the take is thrown
    // away, so a refusal leaves the recording going. The pill has no room
    // for the dialog and the main window would be filmed, so a notification
    // says why.
    if let Err(refused) = super::recording_allowance::require_can_start(&state).await {
        use super::recording_allowance::{LIMIT_BODY, LIMIT_TITLE};
        notify(&app, LIMIT_TITLE.into(), LIMIT_BODY.into());
        return Err(refused);
    }
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

/// The bar's "Open Settings" under a camera or microphone row that Windows'
/// privacy settings block (`privacy::device_privacy`): the Settings page
/// holding that device's switches. `device` is `camera` or `microphone`;
/// anything else, or any other system, is refused, so the webview can never
/// open an arbitrary URI through it.
#[tauri::command]
pub fn capture_open_privacy_settings(app: AppHandle, device: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let uri = super::privacy::settings_uri_for(super::rollout::current_platform(), &device)
        .ok_or_else(|| AppError::Validation("There is no privacy setting to open here.".into()))?;
    app.opener()
        .open_url(uri, None::<&str>)
        .map_err(|e| AppError::Other(format!("Could not open Settings: {e}")))
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

// ── The preview card ────────────────────────────────────────────────────────

/// Show the card for a capture that is about to upload. Returns its id, or
/// `None` when the card could not be opened (the notification covers it).
/// A failed capture the card was showing is kept for the next capture.
async fn open_preview(app: &AppHandle, kind: CaptureKind, path: &Path, thumbnail: Option<String>) -> Option<u64> {
    let state = app.state::<AppState>();
    let account_id = state.current_account_id().ok()?;
    let pool = state.pool().ok()?;
    // No destination yet: this is the first capture, and delivery sets one
    // up (`setup::ensure`). The card opens at once all the same, naming the
    // drive that would be made; delivery puts the real one on it.
    let stored = destination::load(pool, &account_id).await.ok().flatten();
    let awaiting_setup = stored.is_none();
    let destination = stored.unwrap_or_else(|| {
        let name = super::naming::DEFAULT_DRIVE_NAME;
        CaptureDestination::own(name, name)
    });
    let remote = !awaiting_setup && !destination::is_local(pool, &account_id, &destination.label).await;
    let file_name = path.file_name()?.to_str()?.to_string();

    let id = state.capture.preview_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let card = PreviewCard {
        id,
        kind,
        rel_path: destination.rel_path(&file_name),
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
        kept_locally: awaiting_setup,
        stopped_at_free_limit: false,
        notice: None,
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
pub(super) fn update_card(app: &AppHandle, state: &CaptureState, id: u64, change: impl FnOnce(&mut PreviewCard)) -> bool {
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
        // Out of any later screenshot or recording. On macOS by other means
        // (the helper leaves the app out, a screenshot hides a visible card
        // first), so it shows in other apps' screen sharing (`own_windows`).
        .content_protected(super::own_windows::content_protected(
            super::rollout::current_platform(),
            super::own_windows::OwnWindow::Card,
        ))
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
    watch_capture_window_focus(&window);
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

/// Where the pointer is over the card's window, in its CSS pixels from the
/// top left (it may be outside the window). The card asks while its
/// auto-hide timer runs: macOS sends no hover to a window that is not key,
/// and the card never is, so hovering it would not hold it there.
/// Not async, so it runs on the main thread, where AppKit is read.
#[tauri::command]
pub fn capture_preview_pointer(app: AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window(PREVIEW_LABEL)?;
    pointer_in_window(&app, &window)
}

#[cfg(target_os = "macos")]
fn pointer_in_window(_app: &AppHandle, window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    use cocoa::foundation::{NSPoint, NSRect};
    use objc::{msg_send, sel, sel_impl};

    let ns_window = window.ns_window().ok()?.cast::<objc::runtime::Object>();
    // SAFETY: `ns_window` is this window's live NSWindow; both are reads, on
    // the main thread (a sync command). The point is in window points from
    // the bottom left, the content view's height turns it top down.
    unsafe {
        let p: NSPoint = msg_send![ns_window, mouseLocationOutsideOfEventStream];
        let view: *mut objc::runtime::Object = msg_send![ns_window, contentView];
        if view.is_null() {
            return None;
        }
        let frame: NSRect = msg_send![view, frame];
        Some((p.x, frame.size.height - p.y))
    }
}

#[cfg(not(target_os = "macos"))]
fn pointer_in_window(app: &AppHandle, window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let at = window.inner_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(((cursor.x - f64::from(at.x)) / scale, (cursor.y - f64::from(at.y)) / scale))
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
    /// The capture is in the captures drive (at its root): the Captures page
    /// shows it, rather than Drive.
    captures_drive: bool,
}

/// Show in folder: bring Hippius forward where the capture is.
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
            captures_drive: card.destination.folder.is_empty() && !card.kept_locally,
            subfolder: card.destination.folder.clone(),
            file_name: card.file_name,
        },
    );
    close_preview(&app, &state.capture);
    Ok(())
}

/// The card's Upgrade, offered when the upload failed because the plan is
/// full, or when a Free plan recording stopped at its length limit: the main
/// window comes forward on the plans. The card stays, so the capture can be
/// retried once there is room.
#[tauri::command]
pub fn capture_preview_upgrade(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    card_for(&state.capture, |c| c.actions.upgrade, "There is no capture to upgrade for.")?;
    show_main_window(&app);
    let _ = app.emit(OPEN_PLANS_EVENT, ());
    Ok(())
}

/// The capture bar asks the recording gate before its countdown, so a
/// refused Record says so at once instead of after counting down. Record
/// itself asks the same gate again (`select_inner`).
#[tauri::command]
pub async fn capture_check_recording_start(state: tauri::State<'_, AppState>) -> Result<()> {
    super::recording_allowance::require_can_start(&state).await
}

/// The recording limit dialog's Upgrade, from the capture bar: the bar
/// closes and the main window opens the plans (`capture_open_plans`, where
/// every upgrade prompt goes).
#[tauri::command]
pub async fn capture_limit_upgrade(app: AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
        cancel_inner(&app).await?;
    }
    show_main_window(&app);
    let _ = app.emit(OPEN_PLANS_EVENT, ());
    Ok(())
}

pub(super) fn show_main_window(app: &AppHandle) {
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

/// Register both saved shortcuts. Called when the signed-in app mounts; a
/// shortcut another app took since is logged, not raised, so start-up never
/// fails over it (Settings says so when the user looks).
#[tauri::command]
pub async fn capture_sync_shortcut(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let in_force = shortcut::load_both(state.pool()?).await?;
    let mut problems: [Option<String>; 2] = [None, None];
    for kind in ShortcutKind::ALL {
        problems[kind.index()] = register_shortcut(&app, kind, in_force[kind.index()].as_deref());
    }
    *lock(&state.capture.shortcut_problems) = problems;
    // The signed-in app is up: recordings an earlier build held are
    // released if the plan allows them now.
    spawn_release_held(&app);
    Ok(())
}

/// Register `accelerator` as the shortcut of `kind`, answering why it did
/// not register (Rust's sentence for Settings), or `None`. The Record
/// shortcut is held only where this computer can record: keys that open a
/// bar which then refuses would be taken from every other app for nothing.
fn register_shortcut(app: &AppHandle, kind: ShortcutKind, accelerator: Option<&str>) -> Option<String> {
    let accelerator = accelerator.filter(|_| kind != ShortcutKind::Record || recording::recording_supported());
    shortcut::apply(app, kind, accelerator).err().map(|e| {
        tracing::warn!(error = %e, ?kind, "capture shortcut not registered");
        shortcut_problem_text(&e)
    })
}

/// Rust's sentence for a shortcut that did not register, as Settings shows it.
fn shortcut_problem_text(e: &AppError) -> String {
    match e {
        AppError::Validation(message) => message.clone(),
        other => other.to_string(),
    }
}

/// What Settings shows for the shortcut of `kind` (the screenshot one when
/// left out, as older callers mean).
#[tauri::command]
pub async fn capture_get_shortcut(state: tauri::State<'_, AppState>, kind: Option<ShortcutKind>) -> Result<ShortcutSetting> {
    let kind = kind.unwrap_or_default();
    let surfaces = super::support::surfaces();
    let route = match kind {
        ShortcutKind::Screenshot => surfaces.shortcut.via,
        ShortcutKind::Record => surfaces.record_shortcut.via,
    };
    // Only the screenshot shortcut is ever bound through the portal, and
    // only it can be added to GNOME's settings for the user.
    let portal = kind == ShortcutKind::Screenshot && route == super::support::ShortcutVia::Portal;
    let problem = lock(&state.capture.shortcut_problems)[kind.index()]
        .clone()
        .or_else(|| portal.then(super::shortcut_portal::problem).flatten());
    let desktop_trigger = if portal { super::shortcut_portal::trigger() } else { None };
    let can_change_in_desktop = portal
        && desktop_trigger.is_some()
        && matches!(
            super::shortcut_portal::status(),
            super::shortcut_portal::PortalStatus::Available { configurable: true }
        );
    let added_to_desktop = if kind == ShortcutKind::Screenshot && route == super::support::ShortcutVia::DesktopSettings {
        desktop_shortcut_added().await
    } else {
        None
    };
    Ok(ShortcutSetting {
        accelerator: shortcut::load(state.pool()?, kind).await?,
        default_accelerator: kind.default_accelerator().to_string(),
        problem,
        desktop_trigger,
        can_change_in_desktop,
        added_to_desktop,
    })
}

/// Whether Hippius can add the shortcut to the desktop's own settings
/// itself (GNOME), and whether it has; `None` where it cannot.
#[cfg(target_os = "linux")]
async fn desktop_shortcut_added() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(super::desktop_shortcut::gnome_shortcut_added)
        .await
        .ok()
        .flatten()
}

#[cfg(not(target_os = "linux"))]
#[allow(clippy::unused_async)]
async fn desktop_shortcut_added() -> Option<bool> {
    None
}

/// Open the desktop's own dialog to change the capture shortcut (Wayland's
/// GlobalShortcuts portal, version 2).
#[tauri::command]
pub async fn capture_configure_shortcut(app: AppHandle) -> Result<()> {
    #[cfg(target_os = "linux")]
    return super::shortcut_portal::configure(&app).await;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err(AppError::Validation("Change the shortcut here in Settings.".into()))
    }
}

/// Add the capture shortcut to the desktop's own keyboard settings (GNOME on
/// Wayland without the shortcut portal): the saved shortcut, or the default
/// when it is off, runs `hippius --capture`.
#[tauri::command]
pub async fn capture_add_desktop_shortcut(state: tauri::State<'_, AppState>) -> Result<()> {
    let accelerator = shortcut::load(state.pool()?, ShortcutKind::Screenshot)
        .await?
        .unwrap_or_else(|| shortcut::DEFAULT_SHORTCUT.to_string());
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || super::desktop_shortcut::add_gnome_shortcut(&accelerator))
        .await
        .map_err(|e| AppError::Other(format!("adding the shortcut failed: {e}")))?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = accelerator;
        Err(AppError::Validation("Change the shortcut here in Settings.".into()))
    }
}

/// Change the shortcut of `kind` (the screenshot one when left out; `None`
/// turns it off). The other shortcut's keys are refused
/// (`shortcut::check_not_taken`). Registered before it is saved, so a
/// shortcut another app holds is refused and the old one stays.
#[tauri::command]
pub async fn capture_set_shortcut(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    accelerator: Option<String>,
    kind: Option<ShortcutKind>,
) -> Result<()> {
    let kind = kind.unwrap_or_default();
    let pool = state.pool()?;
    let before = shortcut::load_both(pool).await?;
    let previous = before[kind.index()].clone();
    let next = accelerator.as_deref().map(str::trim).filter(|a| !a.is_empty());
    shortcut::check_not_taken(kind, next, before[kind.other().index()].as_deref())?;
    if let Err(e) = shortcut::apply(&app, kind, next) {
        let _ = shortcut::apply(&app, kind, previous.as_deref());
        return Err(e);
    }
    lock(&state.capture.shortcut_problems)[kind.index()] = None;
    shortcut::save(pool, kind, next).await?;
    // A Record shortcut never set follows the screenshot's (`shortcut::
    // resolve`): moving the screenshot off the Record default's keys turns
    // the Record default on now, not at the next launch.
    let other = kind.other();
    let after = shortcut::load(pool, other).await?;
    if after != before[other.index()] {
        let problem = register_shortcut(&app, other, after.as_deref());
        lock(&state.capture.shortcut_problems)[other.index()] = problem;
    }
    Ok(())
}

/// A press of the screenshot shortcut (the plugin's handler goes through
/// [`on_shortcut_of`]; this is the portal's and `hippius --capture`'s).
pub fn on_shortcut(app: &AppHandle) {
    on_shortcut_of(app, ShortcutKind::Screenshot);
}

/// A press of the Record shortcut from outside the plugin
/// (`hippius --record`, a Wayland desktop's own shortcut).
pub fn on_record_shortcut(app: &AppHandle) {
    on_shortcut_of(app, ShortcutKind::Record);
}

/// A press of a system-wide shortcut. Both toggle the same way
/// (`shortcut::action_for`): Stop and Cancel run here; Start goes through
/// the main window with what `kind` starts (`ShortcutKind::start`: the
/// instant screenshot, or the bar on Record), so its refusals reach the
/// same dialogs as the Capture button.
pub fn on_shortcut_of(app: &AppHandle, kind: ShortcutKind) {
    let state = app.state::<AppState>();
    let signed_in = state.current_account_id().is_ok();
    match shortcut::action_for(state.capture.current(), signed_in) {
        ShortcutAction::Start => {
            let _ = app.emit(shortcut::SHORTCUT_EVENT, kind.start());
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
    for kind in ShortcutKind::ALL {
        if let Err(e) = shortcut::apply(app, kind, None) {
            tracing::warn!(error = %e, ?kind, "capture shortcut not unregistered at sign-out");
        }
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
    let (filmed, scale) = filmed_now(app).await?;
    let current = app.get_webview_window(CAMERA_LABEL).and_then(|w| current_camera_frame(&w));
    camera::bubble_for_recording(current, size, filmed).map(|f| (f, scale))
}

/// What the recording films, in the camera window's global points, with the
/// scale to place a window there: the area, the window's frame now, or the
/// recorded display. `None` when it cannot be said (no selection, a Wayland
/// area, a window recording that leaves the bubble out).
async fn filmed_now(app: &AppHandle) -> Option<(camera::Filmed, f64)> {
    let state = app.state::<AppState>();
    let selection = (*lock(&state.capture.selection))?;
    let display_of = |id: u32| lock(&state.capture.displays).iter().find(|d| d.id == id).cloned();
    let (filmed, scale) = match selection {
        // A Wayland area is drawn after Record, on the stream's picture,
        // and Wayland places no window anyway.
        Selection::Area { rect, .. } if rect.width <= 0.0 || rect.height <= 0.0 => return None,
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
            if !bar::window_recording_adds_camera() {
                return None;
            }
            let native = tauri::async_runtime::spawn_blocking(move || super::targets::window_frame(window_id))
                .await
                .ok()
                .flatten()?;
            let displays = lock(&state.capture.displays).clone();
            let (frame, scale) = camera::window_region(native, &displays, super::targets::COORDS_ARE_LOGICAL)?;
            (camera::Filmed::Region(frame), scale)
        }
    };
    Some((filmed, scale))
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
        // A window recording films that one window, plus the bubble where
        // the recorder adds it.
        (_, Some(CameraShape::Bubble)) => {
            bar::window_recording_adds_camera() || !matches!(*lock(&state.capture.selection), Some(Selection::Window { .. }))
        }
        (_, None) => false,
    };
    let recording = camera::is_recording(phase);
    let (switch_from_pill, resize_from_pill) = state.capture.pill_camera_controls(phase, hidden, live_support());
    CameraState {
        shape,
        hidden,
        device_id: options.camera_device.clone(),
        device_name,
        size: options.camera_size,
        recording,
        camera_filmed,
        // Camera only on Wayland: the recorder opens the camera from Record
        // on, so the stage page lets go of it (one owner per device).
        recorder_owns_camera: recording && recorder_opens_camera(shape),
        switch_from_pill,
        resize_from_pill,
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
    close_bubble_controls(app);
    lock(&state.capture.recording_camera).take();
    state.capture.camera_hidden.store(false, Ordering::SeqCst);
    // The pill's device menus may have started the device watch.
    if !matches!(state.capture.current(), CapturePhase::Selecting { .. }) {
        super::device_watch::stop();
    }
    if *lock(&state.capture.live_microphone) != super::live_controls::LiveMicrophone::default() {
        set_live_microphone(app, super::live_controls::LiveMicrophone::default());
    }
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
    watch_capture_window_focus(&window);
    // WebView2 asks the app before `getUserMedia` may open the camera.
    super::webview_media::allow_capture_devices(&window);
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

/// X11: the camera window's XID, read once on the GTK thread, so a window
/// recording can draw the bubble in (`filmed_camera_window`). Wayland has
/// no window ids and stores nothing.
#[cfg(target_os = "linux")]
fn remember_camera_window_number(app: &AppHandle, window: &tauri::WebviewWindow) {
    use gtk::glib::Cast;
    use gtk::prelude::WidgetExt;
    if super::rollout::current_platform() != super::rollout::Platform::LinuxX11 {
        return;
    }
    let target = window.clone();
    let app = app.clone();
    let _ = window.run_on_main_thread(move || {
        let xid = target
            .gtk_window()
            .ok()
            .and_then(|gtk| gtk.window())
            .and_then(|gdk| gdk.downcast::<gdkx11::X11Window>().ok())
            .map(|x11| x11.xid());
        if let Some(n) = xid.filter(|x| *x > 0) {
            app.state::<AppState>().capture.camera_window_number.store(n, Ordering::SeqCst);
        }
    });
}

/// Windows: the camera window's HWND (its low 32 bits, xcap's id, which the
/// recorder child sign-extends back), so a window recording composites the
/// bubble (`wgc::WithCamera`). It was never stored here, so the child was
/// never given the bubble.
#[cfg(windows)]
fn remember_camera_window_number(app: &AppHandle, window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        #[allow(clippy::cast_possible_truncation)]
        let id = u64::from(hwnd.0 as usize as u32);
        if id > 0 {
            app.state::<AppState>().capture.camera_window_number.store(id, Ordering::SeqCst);
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn remember_camera_window_number(_app: &AppHandle, _window: &tauri::WebviewWindow) {}

/// Watch the pointer over the camera window while it exists.
///
/// It tells the camera page when the pointer is over it, so its size strip
/// shows on hover while choosing: AppKit does not reliably deliver hover to a
/// webview whose window is not the key window, and the camera never is.
///
/// Mid-recording it shows the bubble's own controls (`bubble_controls`) on
/// hover, in their own window over the bubble, which the recording leaves
/// out: hidden while the bubble moves (dragged, or gliding to a new size)
/// and shown again where it stops. The webview's own hover cannot do this
/// on any platform: the controls' window covers part of the bubble, so the
/// bubble's page would see the pointer leave as it reached them.
#[cfg(any(target_os = "macos", windows))]
fn spawn_camera_hover_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "macos")]
        let primary_height = {
            let primary_height = tauri::async_runtime::spawn_blocking(list_displays_blocking)
                .await
                .ok()
                .and_then(std::result::Result::ok)
                .and_then(|d| d.iter().find(|d| d.is_primary).or_else(|| d.first()).map(|d| f64::from(d.height)));
            let Some(primary_height) = primary_height else { return };
            primary_height
        };
        #[cfg(not(target_os = "macos"))]
        let primary_height = 0.0;
        let state = app.state::<AppState>();
        let platform = super::rollout::current_platform();
        // One watch at a time: a camera window reopened while an older watch
        // is still between ticks retires that one.
        let generation = state.capture.camera_watch.fetch_add(1, Ordering::SeqCst) + 1;
        state.capture.camera_hover.store(false, Ordering::SeqCst);
        let mut interval = tokio::time::interval(BUBBLE_HOVER_EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_frame: Option<camera::Frame> = None;
        let mut controls_shown = false;
        loop {
            interval.tick().await;
            if state.capture.camera_watch.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = app.get_webview_window(CAMERA_LABEL) else { break };
            let Some(frame) = current_camera_frame(&window) else { continue };
            let Some((px, py)) = pointer_point(&app, &window, primary_height) else {
                continue;
            };
            let over = frame.contains(px, py);
            if state.capture.camera_hover.swap(over, Ordering::SeqCst) != over {
                let _ = app.emit_to(CAMERA_LABEL, CAMERA_HOVER_EVENT, over);
            }

            let moving = super::bubble_controls::moved(last_frame, frame);
            last_frame = Some(frame);
            let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
            let offered = super::bubble_controls::offered(platform, state.capture.current(), state.capture.recording_camera(), hidden);
            if !offered {
                if controls_shown {
                    hide_bubble_controls(&app);
                    controls_shown = false;
                }
                continue;
            }
            // Built hidden as soon as it may be needed, so the first hover
            // does not wait for a webview to load.
            let Some(controls) = bubble_controls_window(&app) else { continue };
            let show = super::bubble_controls::shown(offered, over, moving);
            if show == controls_shown {
                continue;
            }
            if show {
                let size = match state.pool() {
                    Ok(pool) => bar::load_options(pool).await.map(|o| o.camera_size).unwrap_or_default(),
                    Err(_) => CameraSize::default(),
                };
                let scale = window.scale_factor().unwrap_or(1.0);
                place(&controls, super::bubble_controls::frame(frame, size), scale);
                show_bubble_controls(&controls);
            } else {
                let _ = controls.hide();
            }
            controls_shown = show;
        }
        // The camera window is gone: so is anything shown over it.
        close_bubble_controls(&app);
    });
}

/// Linux: the webview's own hover is enough for the strip while choosing,
/// and there are no bubble controls mid-recording (they would be filmed).
#[cfg(not(any(target_os = "macos", windows)))]
fn spawn_camera_hover_watch(_app: AppHandle) {}

/// How often the pointer is checked against the bubble.
#[cfg(any(target_os = "macos", windows))]
const BUBBLE_HOVER_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// The pointer in the same logical points as [`current_camera_frame`]:
/// macOS from `+[NSEvent mouseLocation]` (bottom-left origin, flipped by the
/// primary display's height); Windows from Tauri's physical cursor over the
/// camera window's own scale.
#[cfg(target_os = "macos")]
fn pointer_point(_app: &AppHandle, _window: &tauri::WebviewWindow, primary_height: f64) -> Option<(f64, f64)> {
    use cocoa::foundation::NSPoint;
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: a class method that only reads the pointer position.
    let p: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    Some((p.x, primary_height - p.y))
}

#[cfg(windows)]
fn pointer_point(app: &AppHandle, window: &tauri::WebviewWindow, _primary_height: f64) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let scale = window.scale_factor().ok()?.max(1.0);
    Some((cursor.x / scale, cursor.y / scale))
}

/// The bubble's controls' window, built hidden on first need. Not focused and
/// answering the first click (the bubble is never key, and neither is this),
/// above the bubble, and left out of the recording: by the helper on macOS
/// (it films only the main window and the bubble of Hippius's windows), by
/// content protection on Windows (`own_windows::content_protected`).
#[cfg(any(target_os = "macos", windows))]
fn bubble_controls_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(w) = app.get_webview_window(BUBBLE_CONTROLS_LABEL) {
        return Some(w);
    }
    let route = if cfg!(dev) {
        "capture-bubble-controls"
    } else {
        "capture-bubble-controls.html"
    };
    let built = WebviewWindowBuilder::new(app, BUBBLE_CONTROLS_LABEL, WebviewUrl::App(route.into()))
        .title("Hippius camera controls")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .content_protected(super::own_windows::content_protected(
            super::rollout::current_platform(),
            super::own_windows::OwnWindow::BubbleControls,
        ))
        .focused(false)
        // Pause and the sizes answer the first click, like the pill's.
        .accept_first_mouse(true)
        .inner_size(super::bubble_controls::WIDTH, super::bubble_controls::HEIGHT)
        .visible(false)
        .build();
    match built {
        Ok(window) => {
            raise_bubble_controls(&window);
            watch_capture_window_focus(&window);
            Some(window)
        }
        Err(e) => {
            tracing::warn!(error = %e, "the camera's controls could not open");
            None
        }
    }
}

/// Above the bubble (level 1001), so the strip is never under the picture.
#[cfg(target_os = "macos")]
fn raise_bubble_controls(window: &tauri::WebviewWindow) {
    set_window_level(window, Some(1002));
}

#[cfg(windows)]
fn raise_bubble_controls(_window: &tauri::WebviewWindow) {}

/// Show the controls without taking the keyboard from the recorded app, and
/// (Windows) on top of the bubble, which is topmost too.
#[cfg(any(target_os = "macos", windows))]
fn show_bubble_controls(window: &tauri::WebviewWindow) {
    show_without_focus(window);
    #[cfg(windows)]
    {
        let _ = window.set_always_on_top(true);
    }
}

#[cfg(any(target_os = "macos", windows))]
fn hide_bubble_controls(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(BUBBLE_CONTROLS_LABEL) {
        let _ = w.hide();
    }
}

/// The recording is over or the camera went: the controls go with it.
fn close_bubble_controls(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(BUBBLE_CONTROLS_LABEL) {
        let _ = w.destroy();
    }
}

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

/// The camera window's HWND, which is also xcap's window id on Windows, so
/// camera only records it like any other window (the recorder trims the
/// stage's margin). The handle's low 32 bits: handles are 32-bit values
/// sign-extended to the pointer size, and the recorder extends it back.
#[cfg(windows)]
#[allow(clippy::unused_async)]
async fn camera_window_id(app: &AppHandle) -> Option<u32> {
    let window = app.get_webview_window(CAMERA_LABEL)?;
    let hwnd = window.hwnd().ok()?;
    #[allow(clippy::cast_possible_truncation)]
    let id = hwnd.0 as usize as u32;
    (id != 0).then_some(id)
}

/// The camera window's XID on X11, which is its id in the window list too
/// (`_NET_CLIENT_LIST`), so camera only records it with `ximagesrc xid=`
/// and the recorder trims the stage's margin. Read on the main thread,
/// where GTK lives. None on Wayland, which has no window ids.
#[cfg(target_os = "linux")]
async fn camera_window_id(app: &AppHandle) -> Option<u32> {
    use gtk::glib::Cast;
    use gtk::prelude::WidgetExt;
    if super::rollout::current_platform() != super::rollout::Platform::LinuxX11 {
        return None;
    }
    let window = app.get_webview_window(CAMERA_LABEL)?;
    let target = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let xid = target
                .gtk_window()
                .ok()
                .and_then(|gtk| gtk.window())
                .and_then(|gdk| gdk.downcast::<gdkx11::X11Window>().ok())
                .map(|x11| x11.xid());
            let _ = tx.send(xid);
        })
        .ok()?;
    let xid = tokio::time::timeout(std::time::Duration::from_millis(500), rx).await.ok()?.ok()??;
    u32::try_from(xid).ok().filter(|id| *id > 0)
}

// Async to match the macOS version, which waits on the main thread.
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[allow(clippy::unused_async)]
async fn camera_window_id(_app: &AppHandle) -> Option<u32> {
    None
}

/// The camera page's first read: the shape to draw and the device to open.
#[tauri::command]
pub async fn capture_camera_context(app: AppHandle) -> Result<CameraState> {
    current_camera_state(&app).await
}

/// The camera state now, for the window as it is (nothing is moved).
async fn current_camera_state(app: &AppHandle) -> Result<CameraState> {
    let state = app.state::<AppState>();
    let options = bar::load_options(state.pool()?).await?.for_system(camera_only_supported());
    let shape = *lock(&state.capture.camera_shape);
    let hidden = state.capture.camera_hidden.load(Ordering::SeqCst);
    Ok(camera_state_for(app, shape, hidden, &options).await)
}

/// Tell the camera page and the pill the camera state again, for a change
/// that moves no window: the phase reaching `Recording`, which turns on the
/// pill's camera menu (`live_controls::camera_controls`).
async fn announce_camera(app: &AppHandle) {
    match current_camera_state(app).await {
        Ok(camera_state) => {
            let _ = app.emit(CAMERA_STATE_EVENT, camera_state);
        }
        Err(e) => tracing::debug!(error = %e, "camera state not announced"),
    }
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
    watch_devices(&app);
    let native = refresh_native_cameras(&app).await;
    let webview = lock(&app.state::<AppState>().capture.cameras).clone();
    camera_list(native, webview)
}

/// Keep the bar's device lists live while it is up: the first read starts
/// the watcher (`device_watch`), and every change it reports replaces the
/// system's camera list and is sent to the bar, so a phone or USB device
/// that arrives after a menu was read still shows up. A no-op while one runs.
fn watch_devices(app: &AppHandle) {
    let app = app.clone();
    super::device_watch::ensure_running(move |lists| {
        let state = app.state::<AppState>();
        lock(&state.capture.native_cameras).clone_from(&lists.cameras);
        let webview = lock(&state.capture.cameras).clone();
        let _ = app.emit(CAMERAS_EVENT, camera_list(lists.cameras, webview));
        if recording::microphone_supported() {
            let _ = app.emit(MICROPHONES_EVENT, lists.microphones);
        }
    });
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

    if super::live_controls::is_live(state.capture.current()) {
        // From the pill: the bubble is filmed, so the file follows the
        // window. Only a bubble changes size; the stage is the recording.
        if previous != size && *lock(&state.capture.recording_camera) == Some(CameraShape::Bubble) {
            resize_bubble_while_recording(&app, previous, size, hidden).await;
        }
        return Ok(size);
    }
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

/// The pill's size choice mid-recording: the bubble's window is resized
/// inside what is filmed (`camera::resized_while_recording`), so the camera
/// in the file changes size with it. A hidden bubble is resized too, without
/// the glide, so it comes back at the size the pill shows.
async fn resize_bubble_while_recording(app: &AppHandle, previous: CameraSize, size: CameraSize, hidden: bool) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window(CAMERA_LABEL) else {
        return;
    };
    let Some(current) = current_camera_frame(&window) else {
        return;
    };
    let bounds = match filmed_now(app).await {
        Some((filmed, scale)) => Some((filmed.bounds(), scale)),
        None => bar_work_area(app),
    };
    let Some((bounds, scale)) = bounds else {
        return;
    };
    let before_full = *lock(&state.capture.bubble_frame);
    if size == CameraSize::Full && previous != CameraSize::Full {
        *lock(&state.capture.bubble_frame) = Some(current);
    }
    let target = camera::resized_while_recording(current, previous, size, before_full, bounds);
    set_camera_frame(&window, target, scale, !hidden);
}

/// The live controls this platform's pill offers (`live_controls`).
fn live_support() -> super::live_controls::LiveSupport {
    super::live_controls::support_for(super::rollout::current_platform())
}

/// Keep the recording's microphone and tell the pill.
fn set_live_microphone(app: &AppHandle, mic: super::live_controls::LiveMicrophone) {
    let state = app.state::<AppState>();
    let now = mic.state(live_support());
    *lock(&state.capture.live_microphone) = mic;
    let _ = app.emit_to(CONTROLS_LABEL, MICROPHONE_STATE_EVENT, now);
}

/// The pill's first read of the recording's microphone.
#[tauri::command]
pub fn capture_microphone_state(state: tauri::State<'_, AppState>) -> super::live_controls::MicrophoneState {
    lock(&state.capture.live_microphone).state(live_support())
}

/// Ask the recorder for a microphone change, then keep and announce it.
/// The recorder answers first: a refused switch (the microphone went away)
/// leaves the old one recording and the pill showing it.
async fn change_microphone(app: &AppHandle, action: super::live_controls::MicrophoneAction) -> Result<super::live_controls::MicrophoneState> {
    use super::live_controls::{MicrophoneAction, MicrophoneStep};
    let state = app.state::<AppState>();
    let step = lock(&state.capture.live_microphone)
        .plan(state.capture.current(), live_support(), &action)
        .map_err(|line| AppError::Validation(line.into()))?;
    if step == MicrophoneStep::AskRecorder {
        let asked = action.clone();
        with_recorder(app, move |r| match asked {
            MicrophoneAction::Mute(muted) => r.set_microphone_muted(muted),
            MicrophoneAction::Switch(device) => r.switch_microphone(device),
        })
        .await?;
    }
    let mut mic = lock(&state.capture.live_microphone).clone();
    mic.apply(&action);
    let now = mic.state(live_support());
    set_live_microphone(app, mic);
    Ok(now)
}

/// The pill's microphone button: mute (`true`) or unmute mid-recording.
/// Muted, the recording keeps one continuous audio track with silence in
/// place of the microphone; system audio goes on.
#[tauri::command]
pub async fn capture_microphone_mute(app: AppHandle, muted: bool) -> Result<super::live_controls::MicrophoneState> {
    change_microphone(&app, super::live_controls::MicrophoneAction::Mute(muted)).await
}

/// The pill's microphone menu: record `device` (`None` = the system
/// default) from now on, without stopping. Saved as the bar's choice too,
/// so the next recording starts on it.
#[tauri::command]
pub async fn capture_microphone_switch(app: AppHandle, device: Option<String>) -> Result<super::live_controls::MicrophoneState> {
    let device = device.filter(|d| !d.trim().is_empty());
    let now = change_microphone(&app, super::live_controls::MicrophoneAction::Switch(device.clone())).await?;
    let state = app.state::<AppState>();
    if let Ok(pool) = state.pool()
        && let Ok(mut options) = bar::load_options(pool).await
        && options.microphone_device != device
    {
        options.microphone_device = device;
        if bar::save_options(pool, options.clone()).await.is_ok() {
            let _ = app.emit(OPTIONS_EVENT, options.normalized());
        }
    }
    Ok(now)
}

/// The pill's camera menu: show `device` (`None` = the default camera) in
/// the camera window from now on, mid-recording. The window is what is
/// filmed, so the recording goes on and shows the other camera once the page
/// has opened it. Saved as the bar's choice too.
#[tauri::command]
pub async fn capture_camera_switch(app: AppHandle, device: Option<String>) -> Result<()> {
    let state = app.state::<AppState>();
    let recording_camera = *lock(&state.capture.recording_camera);
    super::live_controls::camera_switch(
        state.capture.current(),
        recording_camera,
        recorder_opens_camera(recording_camera),
        live_support(),
    )
    .map_err(|line| AppError::Validation(line.into()))?;
    let device = device.filter(|d| !d.trim().is_empty());
    let pool = state.pool()?;
    let mut options = bar::load_options(pool).await?;
    if options.camera_device != device {
        options.camera_device = device;
        bar::save_options(pool, options.clone()).await?;
        let _ = app.emit(OPTIONS_EVENT, options.normalized());
    }
    sync_camera(&app).await;
    Ok(())
}

/// Where the pill's menu opens (`capture_controls_menu`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PillMenu {
    pub above: bool,
}

/// Where a pill menu WILL open, without moving anything: the side the
/// page anchors the pill to before it asks for the room
/// (`capture_controls_menu`). Where the page grows with its window
/// (Windows), a pill drawn at the window's top while the window grew upward
/// showed a menu's height higher for a moment; anchored to the bottom
/// first, it stays put. An open menu answers its own side.
#[tauri::command]
pub fn capture_controls_menu_side(app: AppHandle) -> Result<PillMenu> {
    let state = app.state::<AppState>();
    if let Some(above) = *lock(&state.capture.pill_menu) {
        return Ok(PillMenu { above });
    }
    let window = app
        .get_webview_window(CONTROLS_LABEL)
        .ok_or_else(|| AppError::Validation(super::live_controls::NOT_RECORDING.into()))?;
    let current = current_camera_frame(&window).ok_or_else(|| AppError::Other("The recording controls have no frame.".into()))?;
    let work = work_area_at(&state.capture, current).map_or(current, |(work, _)| work);
    Ok(PillMenu {
        above: super::live_controls::menu_above(current, work, super::live_controls::MENU_HEIGHT),
    })
}

/// A pill menu opens (`open`) or closes: the pill's window grows to hold it
/// (above the pill, or below it near the top of the screen) and shrinks
/// back, the pill itself staying put (`set_pill_frame`). The window is left
/// out of the recording like the pill, so the menu is never in the video.
#[tauri::command]
pub async fn capture_controls_menu(app: AppHandle, open: bool) -> Result<PillMenu> {
    let state = app.state::<AppState>();
    let window = app
        .get_webview_window(CONTROLS_LABEL)
        .ok_or_else(|| AppError::Validation(super::live_controls::NOT_RECORDING.into()))?;
    let current = current_camera_frame(&window).ok_or_else(|| AppError::Other("The recording controls have no frame.".into()))?;
    let mut menu = lock(&state.capture.pill_menu);
    match (open, *menu) {
        (true, Some(above)) => Ok(PillMenu { above }),
        (true, None) => {
            let (work, scale) = work_area_at(&state.capture, current).unwrap_or((current, 1.0));
            let (grown, above) = super::live_controls::pill_with_menu(current, work, super::live_controls::MENU_HEIGHT);
            *menu = Some(above);
            set_pill_frame(&window, grown, scale, Some(above));
            Ok(PillMenu { above })
        }
        (false, Some(above)) => {
            let scale = work_area_at(&state.capture, current).map_or(1.0, |(_, scale)| scale);
            let back = super::live_controls::pill_without_menu(current, CONTROLS_HEIGHT, above);
            *menu = None;
            set_pill_frame(&window, back, scale, None);
            Ok(PillMenu { above })
        }
        (false, None) => Ok(PillMenu { above: true }),
    }
}

/// Move and size the pill's window in one step, with a menu open above
/// (`Some(true)`), below (`Some(false)`) or none.
///
/// macOS: the page keeps the same height in every state
/// (`live_controls::page_height`, the pill with a menu's room above and
/// below) and is placed inside the window so the pill's row lands on the
/// same screen points (`live_controls::page_top`). The page and the window
/// change in the same main-thread turn, with screen updates held until both
/// are done, and the page is never resized, so no stale picture of it can
/// show the pill anywhere else. Elsewhere the page is the window's size and
/// [`place`] moves it; the pill page anchors the pill first.
fn set_pill_frame(window: &tauri::WebviewWindow, f: camera::Frame, scale: f64, menu: Option<bool>) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::foundation::{NSPoint, NSRect, NSSize};
        use objc::{class, msg_send, sel, sel_impl};

        let room = super::live_controls::fixed_menu_room(super::rollout::Platform::MacOs);
        let page_height = super::live_controls::page_height(CONTROLS_HEIGHT, room);
        let top = super::live_controls::page_top(menu, room);
        let hopped = window.with_webview(move |webview| {
            let page = webview.inner().cast::<objc::runtime::Object>();
            let ns_window = webview.ns_window().cast::<objc::runtime::Object>();
            if page.is_null() || ns_window.is_null() {
                return;
            }
            // SAFETY: this window's live NSWindow and its WKWebView, touched
            // on the main thread (`with_webview` runs there); `screens` is
            // checked before use.
            unsafe {
                let screens: cocoa::base::id = msg_send![class!(NSScreen), screens];
                let count: usize = if screens.is_null() { 0 } else { msg_send![screens, count] };
                if count == 0 {
                    return;
                }
                let primary: cocoa::base::id = msg_send![screens, objectAtIndex: 0usize];
                let primary_frame: NSRect = msg_send![primary, frame];
                let () = msg_send![ns_window, disableScreenUpdatesUntilFlush];
                // The page keeps its size whatever the window does (no
                // autoresizing), and is pinned by its bottom-left corner in
                // the window's content view (AppKit: y up), computed for the
                // window's NEW height so it holds once the window has grown.
                let () = msg_send![page, setAutoresizingMask: 0usize];
                // The whole page is the page's viewport. WebKit otherwise
                // treats the part of a WKWebView above its window's top as
                // obscured (automatic content insets, meant for a title
                // bar): with the menu room above the window, the viewport
                // lost `room` points at the top, so the pill was laid out
                // `room` points lower, below the window, and never seen.
                let public: bool = msg_send![page, respondsToSelector: sel!(setObscuredContentInsets:)];
                if public {
                    let () = msg_send![page, setObscuredContentInsets: NoInsets::default()];
                }
                let automatic: bool = msg_send![page, respondsToSelector: sel!(_setAutomaticallyAdjustsContentInsets:)];
                if automatic {
                    let () = msg_send![page, _setAutomaticallyAdjustsContentInsets: objc::runtime::NO];
                }
                let top_inset: bool = msg_send![page, respondsToSelector: sel!(_setTopContentInset:)];
                if top_inset {
                    let () = msg_send![page, _setTopContentInset: 0.0f64];
                }
                let page_frame = NSRect::new(NSPoint::new(0.0, f.height - top - page_height), NSSize::new(f.width, page_height));
                let () = msg_send![page, setFrame: page_frame];
                // AppKit's origin is the primary display's bottom-left, y up.
                let rect = NSRect::new(
                    NSPoint::new(f.x, primary_frame.size.height - (f.y + f.height)),
                    NSSize::new(f.width, f.height),
                );
                let () = msg_send![ns_window, setFrame: rect display: objc::runtime::YES animate: objc::runtime::NO];
            }
        });
        if hopped.is_err() {
            place(window, f, scale);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = menu;
        place(window, f, scale);
    }
}

/// `NSEdgeInsets` of zero, for `-[WKWebView setObscuredContentInsets:]`.
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
#[allow(dead_code)] // read by WebKit, not by Rust
struct NoInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

/// The usable area (and its scale) of the display under `frame`'s centre.
fn work_area_at(state: &CaptureState, frame: camera::Frame) -> Option<(camera::Frame, f64)> {
    let (cx, cy) = (frame.x + frame.width / 2.0, frame.y + frame.height / 2.0);
    let displays = lock(&state.displays).clone();
    let display = displays
        .iter()
        .find(|d| display_area(d).frame().contains(cx, cy))
        .cloned()
        .or_else(|| lock(&state.bar_display).clone())?;
    let area = work_area(state, &display);
    Some((area.frame(), area.scale))
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
pub async fn capture_microphones(app: AppHandle) -> Vec<Microphone> {
    if !recording::microphone_supported() {
        return Vec::new();
    }
    watch_devices(&app);
    tauri::async_runtime::spawn_blocking(recording::list_microphones)
        .await
        .unwrap_or_default()
}

/// Start the capture bar's microphone meter on `device` (the id the bar
/// lists; none = the system default), sending `capture_mic_level`. Answers
/// the meter's generation for [`capture_mic_meter_stop`], or `None` where
/// there is no meter (no helper, no microphone recording, or the session is
/// not choosing a recording). Measured by the helper, never the webview: see
/// `capture::mic_meter`.
#[tauri::command]
pub async fn capture_mic_meter_start(app: AppHandle, device: Option<String>) -> Result<Option<u64>> {
    let state = app.state::<AppState>();
    if !super::mic_meter::meter_may_run(state.capture.snapshot().phase) {
        return Ok(None);
    }
    let emitter = app.clone();
    let task_app = app.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        let state = task_app.state::<AppState>();
        let wanted = device.clone();
        state.capture.mic_meter.start(
            device,
            || recording::meter_command(wanted.as_deref()),
            move |level| {
                let _ = emitter.emit(super::mic_meter::LEVEL_EVENT, level);
            },
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("microphone meter task failed: {e}")))?;
    let generation = match started {
        Ok(generation) => generation,
        Err(reason) => {
            tracing::debug!(%reason, "no microphone meter");
            return Ok(None);
        }
    };
    // The phase may have moved on while the meter started; `emit_phase`
    // stopped whatever was running then, so stop this one if it was late.
    if !super::mic_meter::meter_may_run(state.capture.snapshot().phase) {
        state.capture.mic_meter.stop_if(generation);
        return Ok(None);
    }
    Ok(Some(generation))
}

/// Stop the meter started as `generation`. A newer meter (another
/// microphone chosen) is left running.
#[tauri::command]
pub fn capture_mic_meter_stop(state: tauri::State<'_, AppState>, generation: u64) {
    state.capture.mic_meter.stop_if(generation);
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
        assert_eq!(p.height, 519, "346 points at 150 %");
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
        // 346 points is 432.5 pixels at 125 %: within a pixel of the margin.
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

    /// A round bubble placed in physical pixels (Windows) stays square at
    /// every common scale, wherever it sits, so the page draws a circle.
    #[test]
    fn a_round_bubble_is_square_in_pixels_at_every_scale() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 3.0] {
            for side in [camera::BUBBLE_SIZE, camera::LARGE_BUBBLE_SIZE, 187.0] {
                let f = camera::Frame {
                    x: 33.5,
                    y: 517.25,
                    width: side,
                    height: side,
                };
                let p = physical_frame(f, scale);
                assert_eq!(p.width, p.height, "{side} pt at {scale}x");
            }
        }
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

    /// A Free plan recording is due to stop at its limit only while it runs
    /// (a paused one waits for Resume), and its broadcasts carry the time
    /// left only in the last minute. No limit, nothing of either.
    #[test]
    fn the_length_limit_stops_a_running_recording_and_counts_down_its_last_minute() {
        let calls = Arc::new(Calls::default());
        let state = recording(&calls);
        assert!(!state.at_recording_limit(10_000), "no limit, never due");
        state.set_recording_limit(super::super::allowance::max_recording(Some(super::super::allowance::RecordingTier::Free)));
        assert!(!state.at_recording_limit(299));
        assert!(state.at_recording_limit(300));

        let mut seen = Vec::new();
        state.apply(CaptureEvent::Tick { elapsed_secs: 239 }, |e| seen.push(e)).unwrap();
        state.apply(CaptureEvent::Tick { elapsed_secs: 240 }, |e| seen.push(e)).unwrap();
        state.apply(CaptureEvent::Pause, |e| seen.push(e)).unwrap();
        assert_eq!(seen.iter().map(|e| e.remaining_secs).collect::<Vec<_>>(), [None, Some(60), Some(60)]);
        assert!(!state.at_recording_limit(300), "a paused recording is not cut");
        assert_eq!(serde_json::to_value(seen[2]).unwrap()["remainingSecs"], 60);
        assert_eq!(state.snapshot().remaining_secs, Some(60), "a seed carries it too");

        state.set_recording_limit(super::super::allowance::max_recording(Some(super::super::allowance::RecordingTier::Paid)));
        assert_eq!(state.snapshot().remaining_secs, None);
        assert!(serde_json::to_value(state.snapshot()).unwrap().get("remainingSecs").is_none());
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
            remaining_secs: None,
        };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            serde_json::json!({ "phase": "recording", "elapsedSecs": 5, "microphone": true, "seq": 9 })
        );
        let idle = PhaseEvent {
            phase: CapturePhase::Idle,
            seq: 1,
            remaining_secs: None,
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

    /// A Wayland area recording: the pill goes just below the area when it
    /// fits on the monitor, else above it, else beside it, and only with no
    /// room anywhere at the monitor's bottom centre. Never inside the area:
    /// the pill is filmed on Linux.
    #[test]
    fn the_pill_stays_out_of_a_wayland_area() {
        use crate::capture::area_pick::MonitorBox;
        use crate::capture::recording::protocol::StreamCrop;
        let monitor = MonitorBox {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let inside = |f: camera::Frame, a: camera::Frame| f.x < a.x + a.width && f.x + f.width > a.x && f.y < a.y + a.height && f.y + f.height > a.y;
        let on_screen = |f: camera::Frame| f.x >= 0.0 && f.y >= 0.0 && f.x + f.width <= 1920.0 && f.y + f.height <= 1080.0;
        // The centred half on a 2x stream: below it, centred under it.
        let area = StreamCrop {
            x: 960,
            y: 540,
            width: 1920,
            height: 1080,
        };
        let below = pill_frame_for_stream_area(monitor, area, (3840, 2160));
        assert_eq!((below.x, below.y), ((1920.0 - CONTROLS_WIDTH) / 2.0, 270.0 + 540.0 + CONTROLS_MARGIN));
        // Down to the bottom edge: above it.
        let low = StreamCrop {
            x: 400,
            y: 600,
            width: 800,
            height: 480,
        };
        let above = pill_frame_for_stream_area(monitor, low, (1920, 1080));
        assert_eq!((above.y,), (600.0 - CONTROLS_MARGIN - CONTROLS_HEIGHT,));
        // As tall as the screen: beside it.
        let tall = StreamCrop {
            x: 0,
            y: 0,
            width: 1200,
            height: 1080,
        };
        let beside = pill_frame_for_stream_area(monitor, tall, (1920, 1080));
        assert!(beside.x >= 1200.0);
        for (a, f) in [(area, below), (low, above), (tall, beside)] {
            let recorded = crate::capture::area_pick::area_on_monitor(a, if a == area { (3840, 2160) } else { (1920, 1080) }, monitor).unwrap();
            assert!(!inside(f, recorded), "{f:?} is inside {recorded:?}");
            assert!(on_screen(f), "{f:?} is off screen");
        }
        // The whole screen leaves no room: the usual bottom centre.
        let whole = StreamCrop {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let fallback = pill_frame_for_stream_area(monitor, whole, (1920, 1080));
        assert_eq!(
            (fallback.x, fallback.y),
            ((1920.0 - CONTROLS_WIDTH) / 2.0, 1080.0 - CONTROLS_HEIGHT - CONTROLS_MARGIN)
        );
    }

    /// Every camera state the bubble and the pill are sent reads the
    /// recording's camera. It used to lock that mutex twice in one
    /// statement, so the first capture of a run hung its thread for good
    /// holding the lock, and Record (which sets the recording's camera) then
    /// waited forever: no pill, no bubble, only Escape. Run on its own
    /// thread with a deadline, so a regression fails instead of hanging.
    #[test]
    fn the_pill_camera_controls_read_the_recording_camera_without_waiting_on_themselves() {
        use crate::capture::live_controls::support_for;
        use crate::capture::rollout::Platform;
        let state = Arc::new(starting());
        *lock(&state.recording_camera) = Some(CameraShape::Bubble);
        let live = CapturePhase::Recording {
            elapsed_secs: 3,
            microphone: true,
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = Arc::clone(&state);
        std::thread::spawn(move || {
            let _ = tx.send(reader.pill_camera_controls(live, false, support_for(Platform::MacOs)));
        });
        let controls = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("reading the recording's camera deadlocked");
        assert_eq!(controls, (true, true), "a live bubble on macOS: switch and resize from the pill");
        // The lock is free again: Record and the recording's end can take it.
        assert!(state.recording_camera.try_lock().is_ok());
        // Hidden, the bubble keeps its camera menu but offers no sizes.
        assert_eq!(state.pill_camera_controls(live, true, support_for(Platform::MacOs)), (true, false));
    }

    /// The camera state sent at Record (`Capturing`) offers the pill no
    /// camera menu, and the one for `Recording` does, so the state must be
    /// sent again once the recorder is adopted (`announce_camera` in
    /// `begin_recording`, pinned in `capture_wiring.rs`). It was not, and
    /// the pill never offered the bubble's sizes or another camera.
    #[test]
    fn the_pill_camera_menu_turns_on_only_once_the_recording_runs() {
        use crate::capture::live_controls::support_for;
        use crate::capture::rollout::Platform;
        let state = starting();
        *lock(&state.recording_camera) = Some(CameraShape::Bubble);
        let mac = support_for(Platform::MacOs);
        let at_record = CapturePhase::Capturing {
            kind: CaptureKind::Recording,
        };
        assert_eq!(state.pill_camera_controls(at_record, false, mac), (false, false));
        let calls = Arc::new(Calls::default());
        let Ok(running) = state.adopt_recorder(FakeRecorder::boxed(&calls), quiet) else {
            panic!("the recorder is adopted while starting");
        };
        assert_eq!(
            state.pill_camera_controls(running, false, mac),
            (true, true),
            "the state the pill hears after adopt differs from the one sent at Record"
        );
    }
}
