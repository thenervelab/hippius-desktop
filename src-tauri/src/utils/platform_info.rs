//! Platform / OS info exposed to the frontend.
//!
//! Replaces `navigator.platform` (deprecated) for UI rendering decisions
//! like file manager labels and video codec support detection on macOS
//! WKWebView.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "macos", "windows", or "linux"
    pub os: String,
    /// "Finder", "Explorer", or "Files"
    pub file_manager_label: String,
    /// Whether MKV container is supported (false on macOS WKWebView)
    pub supports_mkv: bool,
    /// Whether 3GP container is supported (false on macOS WKWebView)
    pub supports_3gp: bool,
    /// Whether the bundled WebView can play the HEVC QuickTime motion carried
    /// by Hippius Live Photos. WebKitGTK on Linux currently cannot.
    pub supports_live_photo_motion: bool,
    /// Whether the file viewer plays videos itself. False on Linux, where
    /// WebKitGTK hands playback to the distro's GStreamer and a screen
    /// recording (H.264 in MP4) showed a black frame and a spinner; the
    /// viewer offers Download and the system's video player instead, as it
    /// does for PDFs there.
    pub supports_in_app_video: bool,
}

/// Return platform-specific info so the frontend doesn't need `navigator.platform`.
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    info_for(os)
}

/// The answer for `os` ("macos", "windows", anything else is Linux), so
/// every platform's decisions are tested on every OS.
fn info_for(os: &str) -> PlatformInfo {
    let file_manager_label = match os {
        "macos" => "Finder",
        "windows" => "Explorer",
        _ => "Files",
    };

    let is_macos = os == "macos";
    let is_linux = !matches!(os, "macos" | "windows");

    PlatformInfo {
        os: os.to_string(),
        file_manager_label: file_manager_label.to_string(),
        supports_mkv: !is_macos,
        supports_3gp: !is_macos,
        supports_live_photo_motion: !is_linux,
        supports_in_app_video: !is_linux,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_photo_motion_capability_matches_the_desktop_webview_policy() {
        let info = get_platform_info();

        assert_eq!(info.supports_live_photo_motion, info.os != "linux");
    }

    /// Linux plays no video in the viewer (WebKitGTK showed a recording as
    /// a black frame); macOS and Windows keep the built-in player.
    #[test]
    fn only_linux_hands_videos_to_the_system_player() {
        assert!(!info_for("linux").supports_in_app_video);
        assert!(info_for("macos").supports_in_app_video);
        assert!(info_for("windows").supports_in_app_video);
        assert_eq!(get_platform_info().supports_in_app_video, get_platform_info().os != "linux");
    }
}
