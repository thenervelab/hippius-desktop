//! Windows' camera and microphone privacy switches, as the capture bar shows
//! them (plan Phase 5).
//!
//! A desktop app gets no prompt on Windows: when Settings, Privacy &
//! security, Camera or Microphone keeps desktop apps out, the device simply
//! does not open (the bubble stays on its placeholder, the meter stays dark,
//! the recording has no voice). So the bar says so under the row and offers
//! to open the right Settings page. Which switch is off is read from the
//! ConsentStore each time the bar opens (`permissions::windows_privacy_blocks`),
//! since the user may have just flipped it.
//!
//! macOS asks through its own prompts, so it reports nothing blocked. Linux
//! asks its Camera portal before the bubble opens the camera
//! (`camera_access`); after a no, or with camera access off for every app,
//! the camera row says so here too.

use serde::Serialize;

use super::camera_access::CameraAccess;
use super::permissions::PrivacyDevice;
use super::rollout::Platform;

/// The camera row's line when Windows keeps desktop apps from the camera.
pub const CAMERA_BLOCKED_WINDOWS: &str =
    "Windows is blocking the camera. Turn on camera access for desktop apps in Settings, Privacy & security, Camera.";

/// Which devices Windows' privacy settings keep from Hippius right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyBlocks {
    pub microphone: bool,
    pub camera: bool,
}

/// What the capture bar shows about the privacy switches, flattened into the
/// overlay's context.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrivacy {
    /// A blocked device's row offers "Open Settings"
    /// (`capture_open_privacy_settings`). The microphone's line is
    /// `microphoneUnavailableMessage`, as before.
    pub privacy_blocked: PrivacyBlocks,
    /// Why the camera cannot be used, in Rust's words; `None` when it can.
    pub camera_unavailable_message: Option<&'static str>,
}

/// The decision, apart from the registry so it is tested everywhere. Only
/// Windows has the switches, and only a build that records offers the
/// camera and microphone at all.
#[must_use]
pub fn device_privacy_for(platform: Platform, recording: bool, blocked: impl Fn(PrivacyDevice) -> bool) -> DevicePrivacy {
    if platform != Platform::Windows || !recording {
        return DevicePrivacy::default();
    }
    let blocks = PrivacyBlocks {
        microphone: blocked(PrivacyDevice::Microphone),
        camera: blocked(PrivacyDevice::Camera),
    };
    DevicePrivacy {
        privacy_blocked: blocks,
        camera_unavailable_message: blocks.camera.then_some(CAMERA_BLOCKED_WINDOWS),
    }
}

/// Linux's camera row: what the system answered when Hippius asked for the
/// camera (`camera_access`), in the same field Windows' switch uses.
#[must_use]
pub fn with_linux_camera(privacy: DevicePrivacy, platform: Platform, recording: bool, camera: CameraAccess) -> DevicePrivacy {
    if !matches!(platform, Platform::LinuxX11 | Platform::LinuxWayland) || !recording {
        return privacy;
    }
    DevicePrivacy {
        camera_unavailable_message: super::camera_access::bar_line(camera),
        ..privacy
    }
}

/// What this machine's switches say now, with Linux's last camera answer.
#[must_use]
pub fn device_privacy(linux_camera: CameraAccess) -> DevicePrivacy {
    let platform = super::rollout::current_platform();
    let recording = super::recording::recording_supported();
    with_linux_camera(
        device_privacy_for(platform, recording, super::permissions::windows_privacy_blocks),
        platform,
        recording,
        linux_camera,
    )
}

/// The Settings page for a device the bar names (`camera` or
/// `microphone`), on a platform that has one.
#[must_use]
pub fn settings_uri_for(platform: Platform, device: &str) -> Option<&'static str> {
    if platform != Platform::Windows {
        return None;
    }
    match device {
        "camera" => Some(PrivacyDevice::Camera.settings_uri()),
        "microphone" => Some(PrivacyDevice::Microphone.settings_uri()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_windows_that_records_reports_its_switches() {
        let all_blocked = |_| true;
        for platform in [Platform::MacOs, Platform::LinuxX11, Platform::LinuxWayland] {
            assert_eq!(device_privacy_for(platform, true, all_blocked), DevicePrivacy::default(), "{platform:?}");
        }
        assert_eq!(
            device_privacy_for(Platform::Windows, false, all_blocked),
            DevicePrivacy::default(),
            "no recorder, no camera or microphone rows"
        );
    }

    #[test]
    fn a_blocked_camera_gets_its_line_and_each_device_its_own_flag() {
        let camera_only = device_privacy_for(Platform::Windows, true, |d| d == PrivacyDevice::Camera);
        assert_eq!(
            camera_only,
            DevicePrivacy {
                privacy_blocked: PrivacyBlocks {
                    microphone: false,
                    camera: true
                },
                camera_unavailable_message: Some(CAMERA_BLOCKED_WINDOWS),
            }
        );
        let mic_only = device_privacy_for(Platform::Windows, true, |d| d == PrivacyDevice::Microphone);
        assert!(mic_only.privacy_blocked.microphone);
        assert!(!mic_only.privacy_blocked.camera);
        assert_eq!(mic_only.camera_unavailable_message, None);
        assert!(!CAMERA_BLOCKED_WINDOWS.contains('\u{2014}'), "no em dashes in user copy");
    }

    /// The shape the bar reads.
    #[test]
    fn it_serializes_for_the_bar() {
        let v = serde_json::to_value(device_privacy_for(Platform::Windows, true, |_| true)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "privacyBlocked": { "microphone": true, "camera": true },
                "cameraUnavailableMessage": CAMERA_BLOCKED_WINDOWS,
            })
        );
    }

    #[test]
    fn linux_says_why_the_camera_is_refused_and_nothing_else_changes() {
        for platform in [Platform::LinuxX11, Platform::LinuxWayland] {
            let base = device_privacy_for(platform, true, |_| true);
            assert_eq!(
                with_linux_camera(base, platform, true, CameraAccess::Denied).camera_unavailable_message,
                Some(super::super::camera_access::CAMERA_DENIED_LINUX)
            );
            assert_eq!(
                with_linux_camera(base, platform, true, CameraAccess::TurnedOff).camera_unavailable_message,
                Some(super::super::camera_access::CAMERA_TURNED_OFF_LINUX)
            );
            for fine in [CameraAccess::Unknown, CameraAccess::Asking, CameraAccess::Granted] {
                assert_eq!(with_linux_camera(base, platform, true, fine), DevicePrivacy::default(), "{fine:?}");
            }
            assert_eq!(
                with_linux_camera(base, platform, false, CameraAccess::Denied),
                DevicePrivacy::default(),
                "no recorder, no camera row"
            );
        }
        // Windows keeps its own switch's line; macOS has none.
        let windows = device_privacy_for(Platform::Windows, true, |_| true);
        assert_eq!(with_linux_camera(windows, Platform::Windows, true, CameraAccess::Denied), windows);
        assert_eq!(
            with_linux_camera(DevicePrivacy::default(), Platform::MacOs, true, CameraAccess::Denied),
            DevicePrivacy::default()
        );
    }

    #[test]
    fn settings_open_only_on_windows_and_only_for_the_two_devices() {
        assert_eq!(settings_uri_for(Platform::Windows, "camera"), Some("ms-settings:privacy-webcam"));
        assert_eq!(settings_uri_for(Platform::Windows, "microphone"), Some("ms-settings:privacy-microphone"));
        assert_eq!(settings_uri_for(Platform::Windows, "location"), None, "never an arbitrary page");
        assert_eq!(settings_uri_for(Platform::MacOs, "camera"), None);
        assert_eq!(settings_uri_for(Platform::LinuxX11, "microphone"), None);
    }
}
