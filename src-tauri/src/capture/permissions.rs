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
