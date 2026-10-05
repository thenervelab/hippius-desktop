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

use webkit2gtk::glib::prelude::*;
use webkit2gtk::{DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};

use super::webview_media::is_app_origin;

/// Turn the media stream on in `webview` and answer its camera and
/// microphone requests from the app's own pages.
pub fn attach(webview: &tauri::webview::PlatformWebview) {
    let view = webview.inner();
    if let Some(settings) = WebViewExt::settings(&view) {
        settings.set_enable_media_stream(true);
    }
    view.connect_permission_request(|view, request| {
        let media = request.is::<UserMediaPermissionRequest>() || request.is::<DeviceInfoPermissionRequest>();
        if !media {
            // Not ours to decide: WebKitGTK's default.
            return false;
        }
        if view.uri().is_some_and(|uri| is_app_origin(&uri)) {
            request.allow();
        } else {
            request.deny();
        }
        true
    });
}
