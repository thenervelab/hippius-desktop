//! Camera and microphone access for the capture webviews (plan XP-7).
//!
//! WebView2 asks its host before `getUserMedia` may open a camera or a
//! microphone, and a host that never answers leaves the request denied: the
//! camera bubble stays black and the bar's microphone meter never moves.
//! Hippius answers for exactly two kinds of window: the camera bubble
//! (`capture-camera`) and the capture overlays (`capture-overlay-*`, where
//! the bar's meter lives), and only for the app's own pages. Every other
//! window, and every other kind of permission, keeps WebView2's default.
//!
//! Windows' own privacy switches still apply on top
//! (`permissions::windows_privacy_blocks`): when they block desktop apps,
//! no answer here can open the device.
//!
//! macOS asks through WKWebView and its TCC prompt; Linux's WebKitGTK
//! handler is Phase 5 of `docs/plans/2026-10-01-capture-windows-linux.md`.

use super::commands::{CAMERA_LABEL, OVERLAY_LABEL_PREFIX};

/// The windows whose pages may open a camera or a microphone.
#[must_use]
pub fn allows_capture_devices(label: &str) -> bool {
    label == CAMERA_LABEL || label.starts_with(OVERLAY_LABEL_PREFIX)
}

/// Whether a page at `uri` is one of the app's own: the bundled pages
/// (`tauri.localhost`, http or https) or the dev server on loopback. A page
/// the webview was navigated away to never gets the devices.
#[must_use]
pub fn is_app_origin(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("http://").or_else(|| uri.strip_prefix("https://")) else {
        return uri.starts_with("tauri://");
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once(':').map_or(
        authority,
        |(host, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) { host } else { authority }
        },
    );
    matches!(host, "tauri.localhost" | "localhost" | "127.0.0.1" | "[::1]")
}

/// Let the pages of `window` open the camera and the microphone, if it is
/// one of the capture windows. A no-op off Windows.
pub fn allow_capture_devices(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if allows_capture_devices(window.label()) {
        let label = window.label().to_string();
        let attached = window.with_webview(move |webview| {
            if let Err(e) = windows_impl::attach(&webview) {
                tracing::warn!(window = %label, error = %e, "could not let the capture window open the camera and microphone");
            }
        });
        if let Err(e) = attached {
            tracing::warn!(error = %e, "could not reach the capture window's webview");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows_impl {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    /// Answer the webview's camera and microphone requests from the app's
    /// own pages with Allow.
    pub fn attach(webview: &tauri::webview::PlatformWebview) -> Result<(), String> {
        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            let mut uri = String::new();
            // SAFETY: reads on the event's own argument object, on the
            // webview's thread, during the event.
            unsafe {
                args.PermissionKind(&raw mut kind)?;
                // webview2-com's PWSTR is windows 0.61's, which this crate
                // cannot name (it depends on 0.62): let the call infer it.
                #[allow(clippy::default_trait_access)]
                let mut raw = Default::default();
                if args.Uri(&raw mut raw).is_ok() {
                    uri = webview2_com::take_pwstr(raw);
                }
            }
            let wanted = kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
            if wanted && super::is_app_origin(&uri) {
                // SAFETY: as above.
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the controller and its webview are live (this runs inside
        // `with_webview`, on the webview's thread); the handler is kept
        // alive by the webview once added.
        unsafe {
            let core = webview.controller().CoreWebView2().map_err(|e| e.to_string())?;
            core.add_PermissionRequested(&handler, &raw mut token).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the bubble and the overlays (the bar's meter) may open devices;
    /// the main window, the pill and the card never get them.
    #[test]
    fn only_the_camera_and_overlay_windows_open_devices() {
        assert!(allows_capture_devices("capture-camera"));
        assert!(allows_capture_devices("capture-overlay-65537"));
        for label in ["main", "capture-controls", "capture-preview", "tray-panel", "capture-camera-old"] {
            assert!(!allows_capture_devices(label), "{label}");
        }
    }

    #[test]
    fn only_the_apps_own_pages_get_the_devices() {
        for uri in [
            "http://tauri.localhost/capture-camera.html",
            "https://tauri.localhost/capture-overlay.html?display=1",
            "http://localhost:3000/capture-camera",
            "http://127.0.0.1:3000/x",
            "tauri://localhost/capture-camera.html",
        ] {
            assert!(is_app_origin(uri), "{uri}");
        }
        for uri in [
            "https://example.com/",
            "https://tauri.localhost.evil.com/",
            "http://localhost.evil.com:3000/",
            "file:///C:/x.html",
            "",
        ] {
            assert!(!is_app_origin(uri), "{uri}");
        }
    }
}
