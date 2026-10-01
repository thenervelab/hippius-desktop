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
//! macOS asks through its own prompts and Linux has no such switches, so
//! both report nothing blocked.

use serde::Serialize;

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

/// What this machine's switches say now.
#[must_use]
pub fn device_privacy() -> DevicePrivacy {
    device_privacy_for(
        super::rollout::current_platform(),
        super::recording::recording_supported(),
        super::permissions::windows_privacy_blocks,
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
    fn settings_open_only_on_windows_and_only_for_the_two_devices() {
        assert_eq!(settings_uri_for(Platform::Windows, "camera"), Some("ms-settings:privacy-webcam"));
        assert_eq!(settings_uri_for(Platform::Windows, "microphone"), Some("ms-settings:privacy-microphone"));
        assert_eq!(settings_uri_for(Platform::Windows, "location"), None, "never an arbitrary page");
        assert_eq!(settings_uri_for(Platform::MacOs, "camera"), None);
        assert_eq!(settings_uri_for(Platform::LinuxX11, "microphone"), None);
    }
}
