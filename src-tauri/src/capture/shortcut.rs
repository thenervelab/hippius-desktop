//! The system-wide shortcuts: a one-step area screenshot from any app
//! (`capture::instant`), and the capture bar opened on Record. A press of
//! either during a recording stops it.
//!
//! Two shortcuts ([`ShortcutKind`]), each stored, changed and turned off on
//! its own in Settings. Screenshot: default Cmd+Shift+2 on macOS and
//! Ctrl+Shift+2 on Windows and Linux, next to macOS's own Cmd+Shift+3/4/5/6
//! and unused by the system. Record: the same keys plus Option (Alt), so
//! Cmd+Option+Shift+2 or Ctrl+Alt+Shift+2. The two can never be the same keys
//! ([`check_not_taken`]), and a Record shortcut never set is off when the
//! user already gave its default keys to the screenshot ([`resolve`]), so an
//! upgrade never takes keys someone chose. Each system's own capture
//! shortcuts are refused ([`reserved_by`]): macOS's Cmd+Shift+3 to 6,
//! Windows' Snipping Tool, Print Screen and Game Bar keys, and the Print
//! Screen keys GNOME and KDE take for their screenshot tools.
//!
//! How it is registered differs on Linux. On X11 the plugin grabs the keys
//! like it does on macOS and Windows ([`plugin_grabs_keys`]). A Wayland app
//! cannot grab keys at all: where the desktop has the GlobalShortcuts portal
//! (KDE Plasma, GNOME 48 and later) the shortcut is bound through it
//! (`shortcut_portal`), and elsewhere Settings gives the command to bind in
//! the desktop's own keyboard settings (`hippius --capture`, which reaches
//! this app through the single-instance handler). The Record shortcut is
//! always that second kind on Wayland: the portal session binds the one
//! screenshot shortcut, so Settings gives `hippius --record` to bind in the
//! desktop's keyboard settings (`support::record_shortcut_for`).
//!
//! Ctrl+Shift+2 is also Windows Terminal's "new tab with profile 2" and an
//! Excel format shortcut, which a global registration takes away from them.
//! Whether Windows moves to another default (`Alt+Shift+2` is proposed) is an
//! open product decision; saved shortcuts are kept either way.
//!
//! Both toggle, decided here ([`action_for`]): a press stops a running
//! recording, or closes the bar while choosing. Otherwise it emits
//! [`SHORTCUT_EVENT`] and the main window's `CaptureHost` starts the capture
//! ([`ShortcutStart`]: the instant area screenshot, or the bar on Record)
//! through the same start as the Capture button, so a missing drive or permission is
//! answered by the same dialogs. Signed out, there is no `CaptureHost`, so it
//! brings Hippius forward to sign in instead of doing nothing.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::session::{CaptureKind, CapturePhase};
// AppError is only raised where a shortcut can be registered.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use crate::error::AppError;
use crate::error::Result;

/// What one press of the shortcut does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
    /// Open the bar (through the main window, for its refusal dialogs).
    Start,
    /// Stop the recording and save it.
    Stop,
    /// Close the bar.
    Cancel,
    /// Bring the main window forward: nobody is signed in to capture for.
    ShowMainWindow,
    /// Nothing to toggle: a capture is being taken or saved.
    FocusCapture,
}

/// The shortcut toggles: stop what is recording, close what is choosing,
/// otherwise start. Signed out, it shows the app so the user can sign in.
#[must_use]
pub fn action_for(phase: CapturePhase, signed_in: bool) -> ShortcutAction {
    match phase {
        CapturePhase::Recording { .. } | CapturePhase::Paused { .. } => ShortcutAction::Stop,
        CapturePhase::Selecting { .. } => ShortcutAction::Cancel,
        CapturePhase::Capturing { .. } | CapturePhase::Finalizing if signed_in => ShortcutAction::FocusCapture,
        _ if !signed_in => ShortcutAction::ShowMainWindow,
        _ => ShortcutAction::Start,
    }
}

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+2";
/// The screenshot keys plus Option (Alt): Cmd+Option+Shift+2 on macOS,
/// Ctrl+Alt+Shift+2 on Windows and Linux.
pub const DEFAULT_RECORD_SHORTCUT: &str = "CommandOrControl+Alt+Shift+2";
pub const SHORTCUT_EVENT: &str = "capture_shortcut_pressed";

/// Which of the two system-wide shortcuts. The IPC takes it as `kind`;
/// left out it is the screenshot one, which is what older callers mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutKind {
    /// The one-step area screenshot.
    #[default]
    Screenshot,
    /// The capture bar, opened on Record.
    Record,
}

impl ShortcutKind {
    pub const ALL: [Self; 2] = [Self::Screenshot, Self::Record];

    /// Where it is stored. The screenshot's key predates the Record
    /// shortcut and is kept, so nobody's saved choice is lost.
    const fn key(self) -> &'static str {
        match self {
            Self::Screenshot => "capture_shortcut_v1",
            Self::Record => "capture_record_shortcut_v1",
        }
    }

    #[must_use]
    pub const fn default_accelerator(self) -> &'static str {
        match self {
            Self::Screenshot => DEFAULT_SHORTCUT,
            Self::Record => DEFAULT_RECORD_SHORTCUT,
        }
    }

    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::Screenshot => Self::Record,
            Self::Record => Self::Screenshot,
        }
    }

    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            Self::Screenshot => 0,
            Self::Record => 1,
        }
    }

    /// The refusal when `self` is set to the keys the other one already has.
    #[must_use]
    pub const fn taken_message(self) -> &'static str {
        match self {
            Self::Screenshot => TAKEN_BY_RECORD,
            Self::Record => TAKEN_BY_SCREENSHOT,
        }
    }

    /// What a press asks the main window to start.
    #[must_use]
    pub const fn start(self) -> ShortcutStart {
        match self {
            Self::Screenshot => ShortcutStart::PRESSED,
            Self::Record => ShortcutStart::RECORD,
        }
    }
}

/// Setting the Record shortcut to the screenshot shortcut's keys.
pub const TAKEN_BY_SCREENSHOT: &str = "Those keys already take a screenshot. Choose different keys for recording.";
/// Setting the screenshot shortcut to the Record shortcut's keys.
pub const TAKEN_BY_RECORD: &str = "Those keys already start a recording. Choose different keys for screenshots.";

/// What [`SHORTCUT_EVENT`] asks the main window to start, passed on as is
/// to `capture_start`: the one-step area screenshot (`capture::instant`)
/// for the screenshot shortcut, the capture bar on Record for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ShortcutStart {
    pub instant: bool,
    /// The kind the bar opens on; absent for the instant screenshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<CaptureKind>,
}

impl ShortcutStart {
    pub const PRESSED: Self = Self { instant: true, kind: None };
    pub const RECORD: Self = Self {
        instant: false,
        kind: Some(CaptureKind::Recording),
    };
}

/// Stored for "turned off", so it is told apart from "never set" (the default).
const OFF: &str = "off";

/// macOS keeps these for its own screenshot tools; registering one would
/// either fail or take the system's shortcut away.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const MACOS_RESERVED: [&str; 4] = ["Command+Shift+3", "Command+Shift+4", "Command+Shift+5", "Command+Shift+6"];

/// Windows' own capture keys: Snipping Tool (Win+Shift+S), Print Screen with
/// and without Win or Alt, and the Game Bar's record and screenshot keys.
/// Taking one would break the system's capture for as long as Hippius runs.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const WINDOWS_RESERVED: [&str; 6] = [
    "Super+Shift+S",
    "PrintScreen",
    "Super+PrintScreen",
    "Alt+PrintScreen",
    "Super+Alt+R",
    "Super+Alt+PrintScreen",
];

/// The Print Screen keys GNOME and KDE take for their own screenshot tools
/// (GNOME: Print, Shift+Print, Alt+Print; KDE Spectacle: Print, Meta+Print,
/// Meta+Shift+Print), and GNOME's own screen recording key.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const LINUX_RESERVED: [&str; 6] = [
    "PrintScreen",
    "Shift+PrintScreen",
    "Alt+PrintScreen",
    "Super+PrintScreen",
    "Super+Shift+PrintScreen",
    "Control+Alt+Shift+R",
];

/// Which system's reserved shortcuts apply.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutSystem {
    MacOs,
    Windows,
    Linux,
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const THIS_SYSTEM: ShortcutSystem = if cfg!(windows) {
    ShortcutSystem::Windows
} else if cfg!(target_os = "linux") {
    ShortcutSystem::Linux
} else {
    ShortcutSystem::MacOs
};

/// The refusal for a shortcut `system` keeps for itself, or `None`.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn reserved_by(system: ShortcutSystem, shortcut: &tauri_plugin_global_shortcut::Shortcut) -> Option<&'static str> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;

    let (list, refusal): (&[&str], &'static str) = match system {
        ShortcutSystem::MacOs => (&MACOS_RESERVED, "macOS uses that shortcut for its own screenshots. Choose another."),
        ShortcutSystem::Windows => (
            &WINDOWS_RESERVED,
            "Windows uses that shortcut for its own screenshots and recordings. Choose another.",
        ),
        ShortcutSystem::Linux => (
            &LINUX_RESERVED,
            "Your desktop uses that shortcut for its own screenshots or recordings. Choose another.",
        ),
    };
    list.iter()
        .filter_map(|r| Shortcut::from_str(r).ok())
        .any(|r| r.mods == shortcut.mods && r.key == shortcut.key)
        .then_some(refusal)
}

/// What Settings shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSetting {
    /// The active shortcut, or `None` when turned off.
    pub accelerator: Option<String>,
    pub default_accelerator: String,
    /// Why the saved shortcut is not working right now (it could not be
    /// registered when the app started), in Rust's words; `None` when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// Wayland's shortcut portal: how the desktop describes the shortcut it
    /// bound ("Ctrl+Shift+2"), which may differ from `accelerator` (the
    /// desktop has the last word); `None` while nothing is bound or elsewhere.
    pub desktop_trigger: Option<String>,
    /// The desktop's own dialog can change it (the portal's version 2).
    pub can_change_in_desktop: bool,
    /// Where the shortcut lives in the desktop's keyboard settings: whether
    /// Hippius's entry is there (`Some(false)`: Hippius can add it, on
    /// GNOME); `None` where Hippius cannot add one.
    pub added_to_desktop: Option<bool>,
}

/// The refusal when the system says the shortcut is taken.
pub const HELD_BY_ANOTHER_APP: &str = "Another app is already using that shortcut. Choose another.";
/// The same refusal when a second Hippius is running (the installed app
/// beside a development build, say): the likely holder is that copy.
pub const HELD_BY_ANOTHER_HIPPIUS: &str = "Another copy of Hippius is using this shortcut. Quit it, or choose another.";

/// The sentence for a shortcut the system refused to register.
#[must_use]
#[cfg_attr(not(any(target_os = "macos", windows, target_os = "linux")), allow(dead_code))]
pub fn held_message(another_hippius_running: bool) -> &'static str {
    if another_hippius_running {
        HELD_BY_ANOTHER_HIPPIUS
    } else {
        HELD_BY_ANOTHER_APP
    }
}

/// Whether a running app is another copy of Hippius: not this process, and
/// either this app's bundle identifier or the app's name (a development
/// build runs unbundled, under its binary's name).
#[must_use]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_other_hippius(pid: i32, own_pid: i32, bundle_id: Option<&str>, name: Option<&str>, identifier: &str) -> bool {
    pid != own_pid && (bundle_id == Some(identifier) || name.is_some_and(|n| n.eq_ignore_ascii_case("hippius")))
}

/// Whether another copy of Hippius is running, from the system's list of
/// running apps (one call, no process scan).
#[cfg(target_os = "macos")]
fn another_hippius_running(identifier: &str) -> bool {
    use objc::{class, msg_send, sel, sel_impl};

    let Ok(own) = i32::try_from(std::process::id()) else {
        return false;
    };
    let text = |s: cocoa::base::id| -> Option<String> {
        if s.is_null() {
            return None;
        }
        // SAFETY: `s` is a non-nil NSString; UTF8String is valid while it lives.
        let c: *const std::os::raw::c_char = unsafe { msg_send![s, UTF8String] };
        (!c.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(c) }.to_string_lossy().into_owned())
    };
    objc::rc::autoreleasepool(|| {
        // SAFETY: read-only NSWorkspace / NSRunningApplication queries, which
        // may be made from any thread; every object is checked for nil.
        unsafe {
            let workspace: cocoa::base::id = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return false;
            }
            let apps: cocoa::base::id = msg_send![workspace, runningApplications];
            if apps.is_null() {
                return false;
            }
            let count: usize = msg_send![apps, count];
            (0..count).any(|i| {
                let app: cocoa::base::id = msg_send![apps, objectAtIndex: i];
                if app.is_null() {
                    return false;
                }
                let pid: i32 = msg_send![app, processIdentifier];
                let bundle: cocoa::base::id = msg_send![app, bundleIdentifier];
                let name: cocoa::base::id = msg_send![app, localizedName];
                is_other_hippius(pid, own, text(bundle).as_deref(), text(name).as_deref(), identifier)
            })
        }
    })
}

/// Windows and Linux have no cheap equivalent worth the risk here; the plain
/// refusal is said instead.
#[cfg(any(windows, target_os = "linux"))]
fn another_hippius_running(_identifier: &str) -> bool {
    false
}

/// The shortcut of `kind` in force: its default when never set, `None` when
/// turned off (see [`resolve`] for a Record shortcut never set).
pub async fn load(pool: &SqlitePool, kind: ShortcutKind) -> Result<Option<String>> {
    let [screenshot, record] = load_both(pool).await?;
    Ok(match kind {
        ShortcutKind::Screenshot => screenshot,
        ShortcutKind::Record => record,
    })
}

/// Both shortcuts in force, screenshot first, resolved together.
pub async fn load_both(pool: &SqlitePool) -> Result<[Option<String>; 2]> {
    use crate::utils::preferences::get_user_preference_internal as read;
    let screenshot = read(pool, ShortcutKind::Screenshot.key()).await?;
    let record = read(pool, ShortcutKind::Record.key()).await?;
    Ok(resolve(screenshot.as_deref(), record.as_deref()))
}

/// What is stored, as the shortcuts in force: one never set is its default,
/// "off" is off. A Record shortcut never set is off when its default is the
/// keys the screenshot shortcut has: someone who moved the screenshot to
/// Cmd+Option+Shift+2 before Record existed keeps it, and the upgrade adds
/// nothing that fights it.
#[must_use]
pub fn resolve(screenshot: Option<&str>, record: Option<&str>) -> [Option<String>; 2] {
    let screenshot = stored_to_active(ShortcutKind::Screenshot, screenshot);
    let never_set = matches!(record, None | Some(""));
    let record = stored_to_active(ShortcutKind::Record, record).filter(|r| !(never_set && screenshot.as_deref().is_some_and(|s| same_keys(s, r))));
    [screenshot, record]
}

fn stored_to_active(kind: ShortcutKind, raw: Option<&str>) -> Option<String> {
    match raw {
        None | Some("") => Some(kind.default_accelerator().to_string()),
        Some(OFF) => None,
        Some(accel) => Some(accel.to_string()),
    }
}

pub async fn save(pool: &SqlitePool, kind: ShortcutKind, accelerator: Option<&str>) -> Result<()> {
    crate::utils::preferences::save_user_preference_internal(pool, kind.key(), accelerator.unwrap_or(OFF)).await
}

/// Whether two accelerators are the same keys on this system
/// ("CommandOrControl+Shift+2" is "Shift+Command+2" on a Mac). Text that
/// does not parse is compared as text, ignoring case.
#[must_use]
pub fn same_keys(a: &str, b: &str) -> bool {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::Shortcut;
        if let (Ok(a), Ok(b)) = (Shortcut::from_str(a.trim()), Shortcut::from_str(b.trim())) {
            return a.mods == b.mods && a.key == b.key;
        }
    }
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Refuse `accelerator` for `kind` when the other shortcut (`other`, the
/// one in force) has the same keys: one press cannot both screenshot and
/// record. Turning one off (`None`) is always allowed.
///
/// # Errors
///
/// [`crate::error::AppError::Validation`] with the sentence Settings shows.
pub fn check_not_taken(kind: ShortcutKind, accelerator: Option<&str>, other: Option<&str>) -> Result<()> {
    match (accelerator, other) {
        (Some(a), Some(o)) if same_keys(a, o) => Err(crate::error::AppError::Validation(kind.taken_message().into())),
        _ => Ok(()),
    }
}

/// Parse `accelerator` and refuse one that would misbehave as a system-wide
/// shortcut: no modifier (it would swallow a plain key in every app) or one of
/// macOS's own capture shortcuts.
///
/// # Errors
///
/// [`AppError::Validation`] with the sentence Settings shows.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
pub fn validate(accelerator: &str) -> Result<tauri_plugin_global_shortcut::Shortcut> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

    let shortcut = Shortcut::from_str(accelerator.trim())
        .map_err(|_| AppError::Validation("That isn't a shortcut Hippius can use. Try a modifier with a letter or number.".into()))?;
    // The system's own capture keys first: Print Screen alone is refused as
    // Windows' key, not as "needs a modifier".
    if let Some(refusal) = reserved_by(THIS_SYSTEM, &shortcut) {
        return Err(AppError::Validation(refusal.into()));
    }
    let needs = Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT;
    if !shortcut.mods.intersects(needs) {
        return Err(AppError::Validation(needs_modifier(THIS_SYSTEM).into()));
    }
    Ok(shortcut)
}

/// The refusal for a shortcut without a real modifier, in the names this
/// system's keyboards print.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
const fn needs_modifier(system: ShortcutSystem) -> &'static str {
    match system {
        ShortcutSystem::MacOs => "Use Command, Control or Option in the shortcut, so it doesn't take over a key in every app.",
        ShortcutSystem::Windows => "Use Ctrl, Alt or the Windows key in the shortcut, so it doesn't take over a key in every app.",
        ShortcutSystem::Linux => "Use Ctrl, Alt or Super in the shortcut, so it doesn't take over a key in every app.",
    }
}

/// Whether this session registers the shortcut through the plugin's key
/// grab: macOS, Windows and Linux on X11. A Wayland session gives no app a
/// key grab (the plugin's X11 grab would only see keys typed into XWayland
/// windows), so `main.rs` does not register the plugin there and the
/// shortcut goes through the portal or the desktop's settings instead.
#[must_use]
pub fn plugin_grabs_keys() -> bool {
    plugin_grabs_keys_on(super::rollout::current_platform())
}

#[must_use]
pub const fn plugin_grabs_keys_on(platform: super::rollout::Platform) -> bool {
    !matches!(platform, super::rollout::Platform::LinuxWayland)
}

/// The keys each kind has registered with the plugin now (screenshot,
/// Record), so a change unregisters only its own and a press is told apart.
/// Never held across a plugin call: the press handler reads it.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
static REGISTERED: std::sync::Mutex<[Option<tauri_plugin_global_shortcut::Shortcut>; 2]> = std::sync::Mutex::new([None, None]);

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn registered() -> std::sync::MutexGuard<'static, [Option<tauri_plugin_global_shortcut::Shortcut>; 2]> {
    REGISTERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Which shortcut a press of `pressed` is, given what is registered: the
/// Record one only when it holds exactly those keys, the screenshot one
/// otherwise (the one shortcut every older build had).
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[must_use]
pub fn kind_pressed(
    registered: &[Option<tauri_plugin_global_shortcut::Shortcut>; 2],
    pressed: &tauri_plugin_global_shortcut::Shortcut,
) -> ShortcutKind {
    let is = |s: &Option<tauri_plugin_global_shortcut::Shortcut>| s.is_some_and(|s| s.mods == pressed.mods && s.key == pressed.key);
    if is(&registered[ShortcutKind::Record.index()]) {
        ShortcutKind::Record
    } else {
        ShortcutKind::Screenshot
    }
}

/// Make `accelerator` the registered shortcut of `kind` (or none), leaving
/// the other one alone.
///
/// # Errors
///
/// [`AppError::Validation`] when the shortcut is invalid or another app holds it.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
pub fn apply(app: &tauri::AppHandle, kind: ShortcutKind, accelerator: Option<&str>) -> Result<()> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    if !plugin_grabs_keys() {
        // Wayland: the plugin is not registered (its state would be
        // missing). The portal binds the screenshot shortcut, or nothing
        // does; the Record one lives in the desktop's keyboard settings
        // (`hippius --record`), so there is nothing to bind here.
        #[cfg(target_os = "linux")]
        if kind == ShortcutKind::Screenshot {
            return super::shortcut_portal::apply(app, accelerator);
        }
        if let Some(accelerator) = accelerator {
            validate(accelerator)?;
        }
        return Ok(());
    }
    // Refused before the old keys go, so a bad choice leaves them working.
    let shortcut = accelerator.map(validate).transpose()?;
    let gs = app.global_shortcut();
    let previous = registered()[kind.index()].take();
    if let Some(previous) = previous {
        let _ = gs.unregister(previous);
    }
    let Some(shortcut) = shortcut else {
        return Ok(());
    };
    gs.register(shortcut).map_err(|_| {
        let identifier = app.config().identifier.clone();
        AppError::Validation(held_message(another_hippius_running(&identifier)).into())
    })?;
    registered()[kind.index()] = Some(shortcut);
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub fn apply(_app: &tauri::AppHandle, _kind: ShortcutKind, _accelerator: Option<&str>) -> Result<()> {
    Ok(())
}

/// The plugin, with the one handler both capture shortcuts share; which
/// one was pressed is [`kind_pressed`], what it does is [`action_for`],
/// carried out by `commands::on_shortcut_of`.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::ShortcutState;

    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let kind = kind_pressed(&registered(), shortcut);
                super::commands::on_shortcut_of(app, kind);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::capture::session::{CaptureKind, CaptureMode};

    /// The press asks the main window for the one-step area screenshot; the
    /// frontend passes `instant` straight on to `capture_start`.
    #[test]
    fn a_press_asks_for_the_instant_screenshot() {
        assert_eq!(
            serde_json::to_value(ShortcutStart::PRESSED).unwrap(),
            serde_json::json!({ "instant": true })
        );
    }

    #[test]
    fn the_shortcut_toggles_what_is_running() {
        let recording = CapturePhase::Recording {
            elapsed_secs: 3,
            microphone: true,
        };
        let paused = CapturePhase::Paused {
            elapsed_secs: 3,
            microphone: true,
        };
        let selecting = CapturePhase::Selecting {
            kind: CaptureKind::Screenshot,
            mode: CaptureMode::Area,
        };
        assert_eq!(action_for(recording, true), ShortcutAction::Stop);
        assert_eq!(action_for(paused, true), ShortcutAction::Stop);
        assert_eq!(action_for(selecting, true), ShortcutAction::Cancel);
        assert_eq!(action_for(CapturePhase::Idle, true), ShortcutAction::Start);
        for busy in [
            CapturePhase::Capturing {
                kind: CaptureKind::Recording,
            },
            CapturePhase::Finalizing,
        ] {
            assert_eq!(action_for(busy, true), ShortcutAction::FocusCapture, "{busy:?}");
        }
    }

    /// Signed out there is nothing to capture for: the app comes forward to
    /// sign in, rather than the press doing nothing at all. A recording that
    /// somehow outlived the session still stops.
    #[test]
    fn signed_out_the_shortcut_brings_hippius_forward() {
        assert_eq!(action_for(CapturePhase::Idle, false), ShortcutAction::ShowMainWindow);
        assert_eq!(action_for(CapturePhase::Finalizing, false), ShortcutAction::ShowMainWindow);
        let recording = CapturePhase::Recording {
            elapsed_secs: 1,
            microphone: false,
        };
        assert_eq!(action_for(recording, false), ShortcutAction::Stop);
    }

    #[test]
    fn never_set_is_the_default_and_off_is_off() {
        let screenshot = |raw| stored_to_active(ShortcutKind::Screenshot, raw);
        assert_eq!(screenshot(None).as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(screenshot(Some("")).as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(screenshot(Some("off")), None);
        assert_eq!(screenshot(Some("Alt+Shift+C")).as_deref(), Some("Alt+Shift+C"));
        let record = |raw| stored_to_active(ShortcutKind::Record, raw);
        assert_eq!(record(None).as_deref(), Some(DEFAULT_RECORD_SHORTCUT));
        assert_eq!(record(Some("off")), None);
    }

    /// The Record shortcut is the screenshot's keys plus Option (Alt), on
    /// every system, and stored under a key of its own so the screenshot's
    /// saved choice is untouched.
    #[test]
    fn the_record_shortcut_is_the_screenshot_keys_plus_option() {
        assert_eq!(DEFAULT_RECORD_SHORTCUT, "CommandOrControl+Alt+Shift+2");
        assert_eq!(ShortcutKind::Record.default_accelerator(), DEFAULT_RECORD_SHORTCUT);
        assert_eq!(ShortcutKind::Screenshot.default_accelerator(), DEFAULT_SHORTCUT);
        assert_eq!(ShortcutKind::Screenshot.key(), "capture_shortcut_v1");
        assert_ne!(ShortcutKind::Record.key(), ShortcutKind::Screenshot.key());
        assert!(!same_keys(DEFAULT_SHORTCUT, DEFAULT_RECORD_SHORTCUT));
        assert_eq!(ShortcutKind::default(), ShortcutKind::Screenshot, "older callers send no kind");
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn the_record_default_is_valid_and_not_a_system_shortcut() {
        assert!(validate(DEFAULT_RECORD_SHORTCUT).is_ok());
        for system in [ShortcutSystem::MacOs, ShortcutSystem::Windows, ShortcutSystem::Linux] {
            assert_eq!(reserved_by(system, &parsed(DEFAULT_RECORD_SHORTCUT)), None, "{system:?}");
        }
    }

    /// A Record press opens the bar on Record; the screenshot's payload is
    /// unchanged, so an older main window still reads it.
    #[test]
    fn a_record_press_asks_for_the_bar_on_record() {
        assert_eq!(
            serde_json::to_value(ShortcutKind::Record.start()).unwrap(),
            serde_json::json!({ "instant": false, "kind": "recording" })
        );
        assert_eq!(ShortcutKind::Screenshot.start(), ShortcutStart::PRESSED);
    }

    /// Upgrading: a Record shortcut never set is its default, unless the
    /// user already gave those keys to the screenshot; then it stays off
    /// rather than fighting their choice. One they set or turned off is
    /// kept as it is.
    #[test]
    fn an_upgrade_gets_the_record_default_unless_the_screenshot_has_those_keys() {
        let [screenshot, record] = resolve(None, None);
        assert_eq!(screenshot.as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(record.as_deref(), Some(DEFAULT_RECORD_SHORTCUT));

        let [screenshot, record] = resolve(Some("Control+Alt+C"), None);
        assert_eq!(screenshot.as_deref(), Some("Control+Alt+C"));
        assert_eq!(record.as_deref(), Some(DEFAULT_RECORD_SHORTCUT));

        // The same keys written another way still collide.
        let [screenshot, record] = resolve(Some(DEFAULT_RECORD_SHORTCUT), None);
        assert_eq!(screenshot.as_deref(), Some(DEFAULT_RECORD_SHORTCUT));
        assert_eq!(record, None);
        let [_, record] = resolve(Some("Shift+Alt+CommandOrControl+2"), Some(""));
        assert_eq!(record, None);

        // A screenshot shortcut turned off takes no keys.
        let [screenshot, record] = resolve(Some("off"), None);
        assert_eq!(screenshot, None);
        assert_eq!(record.as_deref(), Some(DEFAULT_RECORD_SHORTCUT));

        // A choice made for Record is never second-guessed.
        assert_eq!(resolve(None, Some("off"))[1], None);
        assert_eq!(resolve(None, Some("Control+Alt+R"))[1].as_deref(), Some("Control+Alt+R"));
    }

    /// One press cannot do both: each refuses the other's keys with its own
    /// sentence, however they are written. Turning one off always works.
    #[test]
    fn neither_shortcut_may_take_the_others_keys() {
        let Err(AppError::Validation(msg)) = check_not_taken(ShortcutKind::Record, Some("CommandOrControl+Shift+2"), Some(DEFAULT_SHORTCUT)) else {
            panic!("refused");
        };
        assert_eq!(msg, TAKEN_BY_SCREENSHOT);
        let Err(AppError::Validation(msg)) = check_not_taken(
            ShortcutKind::Screenshot,
            Some("Shift+Alt+CommandOrControl+2"),
            Some(DEFAULT_RECORD_SHORTCUT),
        ) else {
            panic!("refused");
        };
        assert_eq!(msg, TAKEN_BY_RECORD);
        assert!(check_not_taken(ShortcutKind::Record, Some("Control+Alt+R"), Some(DEFAULT_SHORTCUT)).is_ok());
        assert!(check_not_taken(ShortcutKind::Record, None, Some(DEFAULT_SHORTCUT)).is_ok());
        assert!(check_not_taken(ShortcutKind::Screenshot, Some(DEFAULT_SHORTCUT), None).is_ok());
        for msg in [TAKEN_BY_SCREENSHOT, TAKEN_BY_RECORD] {
            assert!(!msg.contains('\u{2014}'));
        }
    }

    /// A press is the Record shortcut only when Record holds exactly those
    /// keys; anything else is the screenshot one, as before.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn a_press_is_told_apart_by_its_keys() {
        let screenshot = parsed(DEFAULT_SHORTCUT);
        let record = parsed(DEFAULT_RECORD_SHORTCUT);
        let both = [Some(screenshot), Some(record)];
        assert_eq!(kind_pressed(&both, &record), ShortcutKind::Record);
        assert_eq!(kind_pressed(&both, &screenshot), ShortcutKind::Screenshot);
        assert_eq!(kind_pressed(&[Some(screenshot), None], &record), ShortcutKind::Screenshot);
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn the_default_is_a_valid_shortcut() {
        assert!(validate(DEFAULT_SHORTCUT).is_ok());
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn a_shortcut_needs_a_real_modifier() {
        assert!(matches!(validate("Shift+2"), Err(AppError::Validation(_))));
        assert!(matches!(validate("F"), Err(AppError::Validation(_))));
        assert!(matches!(validate("not a shortcut"), Err(AppError::Validation(_))));
        assert!(validate("Control+Alt+C").is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_its_own_screenshot_shortcuts() {
        for reserved in ["Command+Shift+3", "Cmd+Shift+4", "CommandOrControl+Shift+5", "Super+Shift+6"] {
            assert!(matches!(validate(reserved), Err(AppError::Validation(_))), "{reserved}");
        }
        assert!(validate("Command+Shift+7").is_ok());
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    fn parsed(accelerator: &str) -> tauri_plugin_global_shortcut::Shortcut {
        use std::str::FromStr;
        tauri_plugin_global_shortcut::Shortcut::from_str(accelerator).unwrap()
    }

    /// Windows' Snipping Tool, Print Screen and Game Bar keys are refused
    /// with a Windows sentence; macOS's own are not Windows' business.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn windows_keeps_its_own_capture_shortcuts() {
        for reserved in [
            "Super+Shift+S",
            "Shift+Super+S",
            "PrintScreen",
            "Super+PrintScreen",
            "Alt+PrintScreen",
            "Super+Alt+R",
            "Alt+Super+R",
            "Super+Alt+PrintScreen",
        ] {
            let refusal = reserved_by(ShortcutSystem::Windows, &parsed(reserved));
            assert_eq!(
                refusal,
                Some("Windows uses that shortcut for its own screenshots and recordings. Choose another."),
                "{reserved}"
            );
        }
        for free in ["Control+Shift+2", "Alt+Shift+2", "Super+Shift+3", "Control+Alt+R", "Super+R"] {
            assert_eq!(reserved_by(ShortcutSystem::Windows, &parsed(free)), None, "{free}");
        }
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn macos_reserves_only_its_own_on_its_own_list() {
        assert!(reserved_by(ShortcutSystem::MacOs, &parsed("Super+Shift+4")).is_some());
        assert_eq!(reserved_by(ShortcutSystem::MacOs, &parsed("Super+Shift+S")), None);
        assert_eq!(reserved_by(ShortcutSystem::MacOs, &parsed("PrintScreen")), None);
    }

    /// On Windows, Print Screen alone says it is Windows' key, not that it
    /// lacks a modifier.
    #[cfg(windows)]
    #[test]
    fn print_screen_is_refused_as_windows_own() {
        let Err(AppError::Validation(msg)) = validate("PrintScreen") else {
            panic!("refused");
        };
        assert!(msg.starts_with("Windows uses that shortcut"), "{msg}");
        assert!(matches!(validate("Super+Shift+S"), Err(AppError::Validation(_))));
        assert!(validate("Alt+Shift+2").is_ok());
    }

    /// The default is not changed here (an open product decision), and it
    /// is not one the system keeps.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn the_default_is_not_a_system_shortcut_anywhere() {
        assert_eq!(DEFAULT_SHORTCUT, "CommandOrControl+Shift+2");
        for system in [ShortcutSystem::MacOs, ShortcutSystem::Windows, ShortcutSystem::Linux] {
            assert_eq!(reserved_by(system, &parsed(DEFAULT_SHORTCUT)), None, "{system:?}");
        }
    }

    /// GNOME's and KDE's screenshot keys and GNOME's recording key are
    /// refused on Linux with a sentence that names no system, since the
    /// desktop (not "Linux") owns them; the other systems' keys are not
    /// Linux's business.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn linux_desktops_keep_their_own_capture_keys() {
        for reserved in [
            "PrintScreen",
            "Shift+PrintScreen",
            "Alt+PrintScreen",
            "Super+PrintScreen",
            "Shift+Super+PrintScreen",
            "Control+Alt+Shift+R",
        ] {
            assert_eq!(
                reserved_by(ShortcutSystem::Linux, &parsed(reserved)),
                Some("Your desktop uses that shortcut for its own screenshots or recordings. Choose another."),
                "{reserved}"
            );
        }
        for free in ["Control+Shift+2", "Super+Shift+S", "Super+Alt+R", "Control+Alt+R"] {
            assert_eq!(reserved_by(ShortcutSystem::Linux, &parsed(free)), None, "{free}");
        }
    }

    /// The modifier refusal names the keys printed on that system's
    /// keyboards; no em dashes in any of them.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn the_modifier_refusal_names_this_systems_keys() {
        assert!(needs_modifier(ShortcutSystem::MacOs).contains("Command, Control or Option"));
        assert!(needs_modifier(ShortcutSystem::Windows).contains("Windows key"));
        assert!(needs_modifier(ShortcutSystem::Linux).contains("Super"));
        for system in [ShortcutSystem::MacOs, ShortcutSystem::Windows, ShortcutSystem::Linux] {
            assert!(!needs_modifier(system).contains('\u{2014}'));
        }
    }

    /// The plugin's key grab works everywhere but Wayland, where no app may
    /// grab keys; `main.rs` registers the plugin only where this is true.
    #[test]
    fn only_wayland_has_no_key_grab() {
        use crate::capture::rollout::Platform;
        for platform in [Platform::MacOs, Platform::Windows, Platform::LinuxX11] {
            assert!(plugin_grabs_keys_on(platform), "{platform:?}");
        }
        assert!(!plugin_grabs_keys_on(Platform::LinuxWayland));
    }

    #[tokio::test]
    async fn turning_it_off_is_remembered() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let screenshot = ShortcutKind::Screenshot;
        assert_eq!(load(&pool, screenshot).await.unwrap().as_deref(), Some(DEFAULT_SHORTCUT));
        save(&pool, screenshot, None).await.unwrap();
        assert_eq!(load(&pool, screenshot).await.unwrap(), None);
        save(&pool, screenshot, Some("Control+Alt+C")).await.unwrap();
        assert_eq!(load(&pool, screenshot).await.unwrap().as_deref(), Some("Control+Alt+C"));
    }

    /// The two are kept apart: changing or turning off one never touches
    /// the other, and a fresh database has both defaults.
    #[tokio::test]
    async fn the_record_shortcut_is_kept_on_its_own() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let (screenshot, record) = (ShortcutKind::Screenshot, ShortcutKind::Record);
        assert_eq!(
            load_both(&pool).await.unwrap(),
            [Some(DEFAULT_SHORTCUT.to_string()), Some(DEFAULT_RECORD_SHORTCUT.to_string())]
        );
        save(&pool, record, Some("Control+Alt+R")).await.unwrap();
        assert_eq!(load(&pool, record).await.unwrap().as_deref(), Some("Control+Alt+R"));
        assert_eq!(load(&pool, screenshot).await.unwrap().as_deref(), Some(DEFAULT_SHORTCUT));
        save(&pool, record, None).await.unwrap();
        assert_eq!(load(&pool, record).await.unwrap(), None);
        assert_eq!(load(&pool, screenshot).await.unwrap().as_deref(), Some(DEFAULT_SHORTCUT));
        save(&pool, screenshot, None).await.unwrap();
        assert_eq!(load(&pool, record).await.unwrap(), None, "still off");
    }

    /// Someone who moved the screenshot to the Record default's keys before
    /// Record existed upgrades with Record off, read from the database.
    #[tokio::test]
    async fn an_upgrade_never_takes_keys_the_user_chose() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        save(&pool, ShortcutKind::Screenshot, Some("Alt+Shift+Command+2")).await.unwrap();
        let [screenshot, record] = load_both(&pool).await.unwrap();
        assert_eq!(screenshot.as_deref(), Some("Alt+Shift+Command+2"));
        #[cfg(target_os = "macos")]
        assert_eq!(record, None, "Cmd+Option+Shift+2 is already the screenshot's");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(record.as_deref(), Some(DEFAULT_RECORD_SHORTCUT), "Ctrl+Alt+Shift+2 is free here");
    }

    /// The installed Hippius held Cmd+Shift+2 while a development build ran:
    /// Settings says which app holds it when it is another copy of Hippius.
    #[test]
    fn a_shortcut_held_by_another_hippius_says_so() {
        assert_eq!(
            held_message(true),
            "Another copy of Hippius is using this shortcut. Quit it, or choose another."
        );
        assert_eq!(held_message(false), "Another app is already using that shortcut. Choose another.");
        // The installed app, by its bundle identifier.
        assert!(is_other_hippius(20, 10, Some("hippius.com"), Some("Hippius"), "hippius.com"));
        // A development build, unbundled, by its name.
        assert!(is_other_hippius(20, 10, None, Some("Hippius"), "hippius.com"));
        // Not this process, and not another app.
        assert!(!is_other_hippius(10, 10, Some("hippius.com"), Some("Hippius"), "hippius.com"));
        assert!(!is_other_hippius(20, 10, Some("com.apple.Safari"), Some("Safari"), "hippius.com"));
        assert!(!is_other_hippius(20, 10, None, None, "hippius.com"));
    }
}
