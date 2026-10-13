//! Camera and microphone access for the capture webviews on Linux (plan
//! XP-7, Phase 5): WebKitGTK's half of `webview_media`.
//!
//! wry never turns WebKitGTK's media stream on, so `getUserMedia` does not
//! exist in a Tauri page there, and WebKitGTK denies every permission
//! request nobody answers. For the capture windows only (the camera bubble
//! and the overlays, `webview_media::allows_capture_devices`) this turns the
//! media stream on and allows the two requests a camera needs: the device
//! itself (`UserMediaPermissionRequest`) and the device names
//! (`DeviceInfoPermissionRequest`, without which the bubble cannot find the
//! chosen camera by name), and only for the app's own pages
//! (`webview_media::is_app_origin`). Every other window and every other
//! kind of request keeps WebKitGTK's default.
//!
//! This runs once the window is built, when its page is already loading. A
//! page whose document exists before the media stream is on has no
//! `navigator.mediaDevices` for its whole life, so a page that already
//! finished loading is loaded again (`needs_reload`). Each answer is logged
//! with the `camera:` prefix, next to the camera page's own reports
//! (`camera_report`), so a log shows whether the request reached the app.

use webkit2gtk::glib::prelude::*;
use webkit2gtk::{
    DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
};

use super::webview_media::is_app_origin;

/// Whether a page must be loaded again for the media stream to reach it:
/// the setting was off, and the page (one of the app's) already finished
/// loading, so its document was made without `navigator.mediaDevices`. A
/// page still loading picks the setting up (WebKit sends it ahead of the
/// document).
#[must_use]
pub fn needs_reload(was_on: bool, loading: bool, uri: Option<&str>) -> bool {
    !was_on && !loading && uri.is_some_and(is_app_origin)
}

/// The page's path, for the log (no query, nothing else).
fn page_of(uri: &str) -> &str {
    let rest = uri.split_once("://").map_or(uri, |(_, rest)| rest);
    let path = rest.find('/').map_or("/", |i| &rest[i..]);
    path.split(['?', '#']).next().unwrap_or("/")
}

/// Turn the media stream on in `webview` and answer its camera and
/// microphone requests from the app's own pages.
pub fn attach(webview: &tauri::webview::PlatformWebview) {
    let view = webview.inner();
    // SAFETY: plain getters of the loaded library's version numbers.
    let version = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    };
    let mut was_on = true;
    if let Some(settings) = WebViewExt::settings(&view) {
        was_on = settings.enables_media_stream();
        settings.set_enable_media_stream(true);
    }
    let uri = view.uri().map(|u| u.to_string());
    let page = uri.as_deref().map_or("(none)", page_of).to_string();
    tracing::info!(
        webkit = %format!("{}.{}.{}", version.0, version.1, version.2),
        page = %page,
        loading = view.is_loading(),
        "camera: media stream on for a capture window"
    );
    view.connect_permission_request(|view, request| {
        let device = request.downcast_ref::<UserMediaPermissionRequest>();
        let names = request.is::<DeviceInfoPermissionRequest>();
        if device.is_none() && !names {
            // Not ours to decide: WebKitGTK's default.
            return false;
        }
        let what = device.map_or_else(
            || "device names".to_string(),
            |d| match (d.is_for_video_device(), d.is_for_audio_device()) {
                (true, true) => "camera and microphone".to_string(),
                (true, false) => "camera".to_string(),
                (false, true) => "microphone".to_string(),
                (false, false) => "a device".to_string(),
            },
        );
        let uri = view.uri().map(|u| u.to_string()).unwrap_or_default();
        if is_app_origin(&uri) {
            tracing::info!(page = %page_of(&uri), "camera: allowed a request for the {what}");
            request.allow();
        } else {
            tracing::warn!("camera: denied a request for the {what} from a page that is not the app's");
            request.deny();
        }
        true
    });
    if needs_reload(was_on, view.is_loading(), uri.as_deref()) {
        tracing::info!(page = %page, "camera: page loaded before the media stream was on, loading it again");
        view.reload();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_finished_app_page_without_the_media_stream_is_reloaded() {
        let camera = Some("tauri://localhost/capture-camera.html");
        assert!(needs_reload(false, false, camera));
        assert!(!needs_reload(false, true, camera), "still loading: it gets the setting");
        assert!(!needs_reload(true, false, camera), "was on already");
        assert!(!needs_reload(false, false, None), "nothing loaded");
        assert!(!needs_reload(false, false, Some("https://example.com/")));
    }

    #[test]
    fn the_log_names_the_page_only() {
        assert_eq!(page_of("tauri://localhost/capture-camera.html"), "/capture-camera.html");
        assert_eq!(
            page_of("http://tauri.localhost/capture-overlay.html?display=1#x"),
            "/capture-overlay.html"
        );
        assert_eq!(page_of("http://localhost:3000"), "/");
    }
}
