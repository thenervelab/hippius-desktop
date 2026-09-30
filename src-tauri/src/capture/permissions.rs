//! Whether the OS lets this app read the screen.
//!
//! Only macOS asks. Its Screen Recording permission has no Info.plist key and
//! no way to be granted up front: `CGRequestScreenCaptureAccess` shows the
//! system prompt ONCE, the user then has to switch Hippius on in System
//! Settings, and the grant only takes effect after the app is relaunched.
//! Without it a capture does not fail — it returns the desktop wallpaper with
//! every other app's windows blanked out — so the check has to run first and
//! the refusal has to be a structured error the UI can explain.
//!
//! Nothing here runs at launch. Like the folder-access prompts the entitlements
//! file avoids, the permission is asked for only when the user first captures.

/// Whether a capture taken now would see other apps' windows.
#[cfg(target_os = "macos")]
pub fn screen_capture_granted() -> bool {
    // SAFETY: a CoreGraphics query with no arguments and no preconditions,
    // available since macOS 10.15 (the app's floor is 11.0).
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Show the system prompt, if macOS still will. Returns the current answer,
/// which stays `false` until the user has granted it AND relaunched the app.
#[cfg(target_os = "macos")]
pub fn request_screen_capture() -> bool {
    // SAFETY: as above. Shows the prompt at most once per app; later calls
    // return the stored answer without UI.
    unsafe { CGRequestScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Windows asks for nothing: any desktop app can capture the screen.
#[cfg(not(target_os = "macos"))]
pub fn screen_capture_granted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture() -> bool {
    true
}

/// The System Settings pane where the user switches the permission on.
pub const SCREEN_RECORDING_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// The macOS major version, read once per launch. `None` off macOS or when
/// it cannot be read.
///
/// `sw_vers` is asked once and remembered: a version does not change while
/// the app runs, and a process spawn per question adds up on a slow disk.
#[must_use]
pub fn macos_major() -> Option<u64> {
    static MAJOR: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
    *MAJOR.get_or_init(read_macos_major)
}

#[cfg(target_os = "macos")]
fn read_macos_major() -> Option<u64> {
    let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
    parse_major(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(target_os = "macos"))]
fn read_macos_major() -> Option<u64> {
    None
}

/// `"14.6.1"` → 14.
fn parse_major(version: &str) -> Option<u64> {
    version.trim().split('.').next()?.parse().ok()
}

/// What System Settings calls the Screen Recording pane on this Mac, for the
/// permission dialog's instructions. macOS 14 renamed it; `None` off macOS,
/// where nothing is asked.
#[must_use]
pub fn permission_pane_name(on_macos: bool, major: Option<u64>) -> Option<&'static str> {
    if !on_macos {
        return None;
    }
    Some(if major.is_some_and(|m| m >= 14) {
        "Screen & System Audio Recording"
    } else {
        "Screen Recording"
    })
}

/// What the permission dialog's button did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionRequest {
    /// Already granted (a relaunch picked it up).
    Granted,
    /// macOS showed its own prompt; nothing else was opened, so there is
    /// only ever one ask on screen.
    Prompted,
    /// macOS no longer prompts (it only does once), so System Settings was
    /// opened on the pane instead.
    OpenedSettings,
}

/// Whether the button should ask macOS (the first time) or open the pane.
#[must_use]
pub fn next_request_step(granted: bool, asked_before: bool) -> PermissionRequest {
    if granted {
        PermissionRequest::Granted
    } else if asked_before {
        PermissionRequest::OpenedSettings
    } else {
        PermissionRequest::Prompted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pane_is_named_as_this_macos_names_it() {
        assert_eq!(permission_pane_name(true, Some(15)), Some("Screen & System Audio Recording"));
        assert_eq!(permission_pane_name(true, Some(14)), Some("Screen & System Audio Recording"));
        assert_eq!(permission_pane_name(true, Some(13)), Some("Screen Recording"));
        assert_eq!(permission_pane_name(true, Some(11)), Some("Screen Recording"));
        assert_eq!(permission_pane_name(true, None), Some("Screen Recording"));
        assert_eq!(permission_pane_name(false, Some(15)), None);
    }

    #[test]
    fn a_version_string_reads_as_its_major() {
        assert_eq!(parse_major("14.6.1\n"), Some(14));
        assert_eq!(parse_major("26.0"), Some(26));
        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("x.y"), None);
    }

    /// macOS prompts once; asking again shows nothing, so the second press
    /// must open the pane rather than appear to do nothing.
    #[test]
    fn the_button_prompts_once_then_opens_settings() {
        assert_eq!(next_request_step(false, false), PermissionRequest::Prompted);
        assert_eq!(next_request_step(false, true), PermissionRequest::OpenedSettings);
        assert_eq!(next_request_step(true, true), PermissionRequest::Granted);
    }
}
