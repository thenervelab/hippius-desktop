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

/// `(major, minor)` of this Mac's macOS, read once per launch. `None` off
/// macOS or when it cannot be read.
///
/// The one cache every capture check shares (the permission pane's name and
/// the recording feature gates): `sw_vers` is a process spawn, the answer
/// cannot change while the app runs, and every surface that shows a Capture
/// button asks several times.
#[must_use]
pub fn macos_version() -> Option<(u64, u64)> {
    static VERSION: std::sync::OnceLock<Option<(u64, u64)>> = std::sync::OnceLock::new();
    *VERSION.get_or_init(read_macos_version)
}

/// The macOS major version, from [`macos_version`].
#[must_use]
pub fn macos_major() -> Option<u64> {
    macos_version().map(|(major, _)| major)
}

#[cfg(target_os = "macos")]
fn read_macos_version() -> Option<(u64, u64)> {
    let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(target_os = "macos"))]
fn read_macos_version() -> Option<(u64, u64)> {
    None
}

/// Windows 10 version 2004: the first build where `WDA_EXCLUDEFROMCAPTURE`
/// keeps a window out of every capture API and Windows.Graphics.Capture can
/// hide its cursor. Below it, screenshots still work (the overlays are
/// closed before the grab) and recording reports `osTooOld`.
pub const WINDOWS_CAPTURE_FLOOR_BUILD: u32 = 19041;

/// This Windows' build number (19045, 22631, 26100…), read once per launch.
/// `None` off Windows or when it cannot be read.
///
/// `RtlGetVersion`, not `GetVersionEx`: the latter reports whatever the
/// app's manifest claims compatibility with, not the system it runs on.
#[must_use]
pub fn windows_build() -> Option<u32> {
    static BUILD: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *BUILD.get_or_init(read_windows_build)
}

#[cfg(windows)]
fn read_windows_build() -> Option<u32> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: u32::try_from(std::mem::size_of::<OSVERSIONINFOW>()).ok()?,
        ..Default::default()
    };
    // SAFETY: `info` is a properly sized OSVERSIONINFOW whose size field is
    // set, as RtlGetVersion requires; it only writes into it.
    let status = unsafe { RtlGetVersion(&raw mut info) };
    status.is_ok().then_some(info.dwBuildNumber)
}

#[cfg(not(windows))]
fn read_windows_build() -> Option<u32> {
    None
}

/// Whether Windows can keep the capture UI out of a screenshot on this
/// build. An unreadable build is trusted to be current (the runtime check in
/// `commands::open_overlay` still catches a refusal).
#[must_use]
pub const fn windows_excludes_from_capture(build: Option<u32>) -> bool {
    match build {
        Some(build) => build >= WINDOWS_CAPTURE_FLOOR_BUILD,
        None => true,
    }
}

/// `"15.1.1\n"` to `(15, 1)`, `"26"` to `(26, 0)`; anything unreadable is
/// `None`, which no feature gate passes.
#[cfg(any(target_os = "macos", test))]
fn parse_version(text: &str) -> Option<(u64, u64)> {
    let mut parts = text.trim().split('.').map(|p| p.parse::<u64>().ok());
    match (parts.next().flatten(), parts.next()) {
        (Some(major), None) => Some((major, 0)),
        (Some(major), Some(Some(minor))) => Some((major, minor)),
        _ => None,
    }
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
    fn a_version_string_reads_as_major_and_minor() {
        assert_eq!(parse_version("14.6.1\n"), Some((14, 6)));
        assert_eq!(parse_version("15.1.1\n"), Some((15, 1)));
        assert_eq!(parse_version("26\n"), Some((26, 0)));
        assert_eq!(parse_version("13.0"), Some((13, 0)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("garbage"), None);
        assert_eq!(parse_version("14.x"), None);
        assert_eq!(parse_version("x.y"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_version_is_read_once() {
        let first = macos_version();
        assert!(first.is_some_and(|v| v >= (11, 0)), "the app floor is 11.0, got {first:?}");
        assert_eq!(macos_version(), first);
        assert_eq!(macos_major(), first.map(|(m, _)| m));
    }

    /// Windows 10 2004 (19041) is the floor; 1909 (18363) is below it.
    #[test]
    fn windows_2004_is_the_capture_floor() {
        assert!(windows_excludes_from_capture(Some(19041)));
        assert!(windows_excludes_from_capture(Some(26100)), "Windows 11 24H2");
        assert!(!windows_excludes_from_capture(Some(18363)), "Windows 10 1909");
        assert!(windows_excludes_from_capture(None));
    }

    /// Read once, and only on Windows.
    #[test]
    fn the_windows_build_is_read_on_windows_only() {
        let build = windows_build();
        if cfg!(windows) {
            assert!(build.is_some_and(|b| b >= 10240), "a Windows 10+ build, got {build:?}");
        } else {
            assert_eq!(build, None);
        }
        assert_eq!(windows_build(), build);
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
