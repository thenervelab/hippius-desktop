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

    let file_manager_label = match os {
        "macos" => "Finder",
        "windows" => "Explorer",
        _ => "Files",
    };

    let is_macos = cfg!(target_os = "macos");

    PlatformInfo {
        os: os.to_string(),
        file_manager_label: file_manager_label.to_string(),
        supports_mkv: !is_macos,
        supports_3gp: !is_macos,
        supports_live_photo_motion: os != "linux",
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
}
