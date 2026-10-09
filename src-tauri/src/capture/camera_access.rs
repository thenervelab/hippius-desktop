//! Asking for the camera before the bubble opens it, on Linux.
//!
//! WebKitGTK 2.50 and later open every camera through the xdg-desktop-portal
//! Camera interface (`PipeWireCaptureDeviceManager`): `IsCameraPresent`,
//! then `AccessCamera`, then the PipeWire remote the portal hands back. The
//! portal asks the user once per app ("Turn On Camera?") and keeps the
//! answer, for a regular .deb or AppImage install as much as for a Flatpak.
//! Left to WebKit, that question came up from inside the bubble's
//! `getUserMedia`, with Hippius's own windows (kept above everything through
//! XWayland) over it: easy to miss, and a missed or dismissed question is
//! stored as "no", after which every camera request was refused without a
//! word. The bubble then said only "Camera unavailable".
//!
//! So Hippius asks first, itself, as the bubble is about to open: the same
//! portal call, made while the capture windows step aside so the system's
//! question is on top. The bubble waits on the answer (it shows "Allow
//! camera access" and never calls `getUserMedia` meanwhile) and opens the
//! camera only once the portal said yes; WebKit's own request then finds
//! the stored yes and asks nothing. A "no", or camera access switched off
//! for every app (GNOME's Privacy, Camera switch), is shown on the bubble
//! and under the bar's camera row with where to change it.
//!
//! An older WebKitGTK opens `/dev/video*` directly and never asks the
//! portal, so for it the question is harmless (the answer is kept for when
//! the system updates WebKit). Where no portal answers (none installed, or
//! no Camera interface), nothing is blocked: the bubble tries as before and
//! says what failed if it fails.
//!
//! The microphone needs none of this: Linux has no microphone portal for an
//! app outside a sandbox, the bar's meter and the recorder read it through
//! GStreamer in the app's own processes, and no capture page calls
//! `getUserMedia` for audio.
//!
//! macOS asks through its own camera prompt (WKWebView and TCC) and Windows
//! has the privacy switches (`privacy`); neither goes through here.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use serde::Serialize;

use super::rollout::Platform;

/// What the system said about the camera, as far as Hippius knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraAccess {
    /// Not asked yet, or nothing to ask (no portal, not Linux): the bubble
    /// opens the camera and reports any failure itself.
    Unknown,
    /// The system's question is on screen; the bubble waits.
    Asking,
    /// The portal said yes.
    Granted,
    /// The user said no, now or earlier (the portal keeps the answer).
    Denied,
    /// Camera access is switched off for every app.
    TurnedOff,
}

impl CameraAccess {
    const fn to_u8(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Asking => 1,
            Self::Granted => 2,
            Self::Denied => 3,
            Self::TurnedOff => 4,
        }
    }

    const fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Asking,
            2 => Self::Granted,
            3 => Self::Denied,
            4 => Self::TurnedOff,
            _ => Self::Unknown,
        }
    }

    /// Whether the bubble may call `getUserMedia` now.
    #[must_use]
    pub const fn lets_the_page_open(self) -> bool {
        matches!(self, Self::Unknown | Self::Granted)
    }
}

/// The bar's camera row when the user said no.
pub const CAMERA_DENIED_LINUX: &str =
    "Hippius isn't allowed to use the camera. Allow it in Settings, Privacy, Camera, then turn the camera off and on again.";
/// The bar's camera row when camera access is off for every app.
pub const CAMERA_TURNED_OFF_LINUX: &str =
    "Camera access is turned off for all apps. Turn it on in Settings, Privacy, Camera, then turn the camera off and on again.";

/// Where the camera's privacy switch is on each system, for the bubble's
/// line ("Allow Hippius in ...").
#[must_use]
pub const fn privacy_place(platform: Platform) -> &'static str {
    match platform {
        Platform::MacOs => "System Settings, Privacy & Security, Camera",
        Platform::Windows => "Settings, Privacy & security, Camera",
        Platform::LinuxX11 | Platform::LinuxWayland => "Settings, Privacy, Camera",
    }
}

/// The bar's line for the camera row, if the system keeps the camera from
/// Hippius.
#[must_use]
pub const fn bar_line(access: CameraAccess) -> Option<&'static str> {
    match access {
        CameraAccess::Denied => Some(CAMERA_DENIED_LINUX),
        CameraAccess::TurnedOff => Some(CAMERA_TURNED_OFF_LINUX),
        CameraAccess::Unknown | CameraAccess::Asking | CameraAccess::Granted => None,
    }
}

/// Whether to ask the portal as the bubble opens. Only Linux asks. A
/// "yes" is kept for the rest of the run; anything else is asked again each
/// time the bubble opens, which costs nothing when the portal has the
/// answer stored (it replies at once, without a dialog) and picks up a
/// switch the user has just flipped in Settings.
#[must_use]
pub const fn should_ask(platform: Platform, access: CameraAccess) -> bool {
    matches!(platform, Platform::LinuxX11 | Platform::LinuxWayland) && !matches!(access, CameraAccess::Granted | CameraAccess::Asking)
}

/// What Hippius knows about the camera this run, kept on `CaptureState`.
#[derive(Debug, Default)]
pub struct AccessState {
    access: AtomicU8,
    /// Whether the portal sees a camera: 0 not known, 1 yes, 2 no.
    present: AtomicU8,
    asking: AtomicBool,
}

impl AccessState {
    /// What Hippius knows now.
    #[must_use]
    pub fn current(&self) -> CameraAccess {
        CameraAccess::from_u8(self.access.load(Ordering::SeqCst))
    }

    /// Whether the portal saw a camera when last asked; `None` before then
    /// or without a portal.
    #[must_use]
    pub fn camera_present(&self) -> Option<bool> {
        match self.present.load(Ordering::SeqCst) {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }

    /// Claim the one question in flight; `false` when one is already asked.
    #[must_use]
    pub fn begin_asking(&self) -> bool {
        if self.asking.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.access.store(CameraAccess::Asking.to_u8(), Ordering::SeqCst);
        true
    }

    /// The question is answered.
    pub fn finish_asking(&self, access: CameraAccess, present: Option<bool>) {
        self.access.store(access.to_u8(), Ordering::SeqCst);
        self.present.store(
            match present {
                Some(true) => 1,
                Some(false) => 2,
                None => 0,
            },
            Ordering::SeqCst,
        );
        self.asking.store(false, Ordering::SeqCst);
    }
}

/// How the portal's reply reads, apart from ashpd so it is tested everywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalReply {
    Allowed,
    /// The request's Response said "cancelled": the user said no, now or before.
    Refused,
    /// The call itself failed with this D-Bus error name.
    Error(String),
    /// Nobody serves the Camera portal here.
    Missing,
}

/// What a portal reply means for the bubble.
#[must_use]
pub fn access_from(reply: &PortalReply) -> CameraAccess {
    match reply {
        PortalReply::Allowed => CameraAccess::Granted,
        PortalReply::Refused => CameraAccess::Denied,
        // xdg-desktop-portal answers NotAllowed, before any dialog, when
        // camera access is switched off for everyone (its lockdown setting).
        PortalReply::Error(name) if name.ends_with(".NotAllowed") => CameraAccess::TurnedOff,
        PortalReply::Error(_) | PortalReply::Missing => CameraAccess::Unknown,
    }
}

/// Ask the Camera portal, returning what it said and whether it sees a
/// camera. Never panics and never fails: a portal that cannot be reached is
/// `Unknown`, and the bubble then tries by itself.
#[cfg(target_os = "linux")]
pub async fn ask_portal() -> (CameraAccess, Option<bool>) {
    use ashpd::desktop::camera::Camera;

    let camera = match Camera::new().await {
        Ok(camera) => camera,
        Err(e) => {
            let reply = reply_of(&e);
            tracing::info!(error = %e, "camera: no camera portal to ask, the bubble opens the camera itself");
            return (access_from(&reply), None);
        }
    };
    let present = match camera.is_present().await {
        Ok(present) => Some(present),
        Err(e) => {
            tracing::info!(error = %e, "camera: the portal did not say whether a camera is present");
            None
        }
    };
    let reply = match camera.request_access(ashpd::desktop::camera::CameraAccessOptions::default()).await {
        Ok(request) => match request.response() {
            Ok(()) => PortalReply::Allowed,
            Err(e) => reply_of(&e),
        },
        Err(e) => reply_of(&e),
    };
    let access = access_from(&reply);
    tracing::info!(?reply, ?access, ?present, "camera: the system answered the camera question");
    (access, present)
}

#[cfg(target_os = "linux")]
fn reply_of(e: &ashpd::Error) -> PortalReply {
    use ashpd::desktop::ResponseError;

    match e {
        ashpd::Error::Response(ResponseError::Cancelled) => PortalReply::Refused,
        ashpd::Error::Response(ResponseError::Other) => PortalReply::Error("response.Other".into()),
        ashpd::Error::PortalNotFound(_) => PortalReply::Missing,
        ashpd::Error::Portal(ashpd::PortalError::NotAllowed(_)) => PortalReply::Error("org.freedesktop.portal.Error.NotAllowed".into()),
        ashpd::Error::Zbus(ashpd::zbus::Error::MethodError(name, _, _)) => {
            let name = name.as_str();
            if super::linux_portal::is_missing_service(name) {
                PortalReply::Missing
            } else {
                PortalReply::Error(name.to_string())
            }
        }
        other => PortalReply::Error(other.to_string()),
    }
}

/// Nothing to ask off Linux.
#[cfg(not(target_os = "linux"))]
#[allow(clippy::unused_async)]
pub async fn ask_portal() -> (CameraAccess, Option<bool>) {
    (CameraAccess::Unknown, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_linux_asks_and_a_yes_is_kept() {
        for platform in [Platform::LinuxX11, Platform::LinuxWayland] {
            assert!(should_ask(platform, CameraAccess::Unknown), "{platform:?}");
            assert!(
                should_ask(platform, CameraAccess::Denied),
                "a no is asked again: Settings may have changed"
            );
            assert!(should_ask(platform, CameraAccess::TurnedOff));
            assert!(!should_ask(platform, CameraAccess::Granted));
            assert!(!should_ask(platform, CameraAccess::Asking), "one question at a time");
        }
        for platform in [Platform::MacOs, Platform::Windows] {
            assert!(!should_ask(platform, CameraAccess::Unknown), "{platform:?}");
        }
    }

    #[test]
    fn the_portals_replies_read_as_the_bubble_needs() {
        assert_eq!(access_from(&PortalReply::Allowed), CameraAccess::Granted);
        assert_eq!(access_from(&PortalReply::Refused), CameraAccess::Denied);
        assert_eq!(
            access_from(&PortalReply::Error("org.freedesktop.portal.Error.NotAllowed".into())),
            CameraAccess::TurnedOff
        );
        // Anything else blocks nothing: the bubble tries and says what failed.
        assert_eq!(access_from(&PortalReply::Missing), CameraAccess::Unknown);
        assert_eq!(
            access_from(&PortalReply::Error("org.freedesktop.DBus.Error.Timeout".into())),
            CameraAccess::Unknown
        );
    }

    #[test]
    fn the_bubble_waits_while_asking_and_stops_after_a_no() {
        assert!(CameraAccess::Unknown.lets_the_page_open());
        assert!(CameraAccess::Granted.lets_the_page_open());
        assert!(!CameraAccess::Asking.lets_the_page_open());
        assert!(!CameraAccess::Denied.lets_the_page_open());
        assert!(!CameraAccess::TurnedOff.lets_the_page_open());
    }

    #[test]
    fn the_bar_says_what_to_do_in_plain_words() {
        assert_eq!(bar_line(CameraAccess::Denied), Some(CAMERA_DENIED_LINUX));
        assert_eq!(bar_line(CameraAccess::TurnedOff), Some(CAMERA_TURNED_OFF_LINUX));
        assert_eq!(bar_line(CameraAccess::Granted), None);
        assert_eq!(bar_line(CameraAccess::Asking), None);
        for line in [CAMERA_DENIED_LINUX, CAMERA_TURNED_OFF_LINUX] {
            assert!(line.contains("Settings, Privacy, Camera"), "{line}");
            assert!(!line.contains('\u{2014}'), "no em dashes in user copy");
        }
    }

    #[test]
    fn the_state_round_trips_and_one_question_is_in_flight() {
        for access in [
            CameraAccess::Unknown,
            CameraAccess::Asking,
            CameraAccess::Granted,
            CameraAccess::Denied,
            CameraAccess::TurnedOff,
        ] {
            assert_eq!(CameraAccess::from_u8(access.to_u8()), access);
        }
        assert_eq!(serde_json::to_value(CameraAccess::TurnedOff).unwrap(), serde_json::json!("turnedOff"));
        let state = AccessState::default();
        assert_eq!(state.current(), CameraAccess::Unknown);
        assert_eq!(state.camera_present(), None);
        assert!(state.begin_asking());
        assert!(!state.begin_asking(), "a second question waits for the first");
        assert_eq!(state.current(), CameraAccess::Asking);
        state.finish_asking(CameraAccess::Granted, Some(true));
        assert_eq!(state.current(), CameraAccess::Granted);
        assert_eq!(state.camera_present(), Some(true));
        assert!(state.begin_asking(), "free again once answered");
        state.finish_asking(CameraAccess::Denied, Some(false));
        assert_eq!(state.camera_present(), Some(false));
    }

    #[test]
    fn each_system_names_its_own_privacy_page() {
        assert!(privacy_place(Platform::MacOs).starts_with("System Settings"));
        assert!(privacy_place(Platform::Windows).contains("Privacy & security"));
        assert_eq!(privacy_place(Platform::LinuxWayland), privacy_place(Platform::LinuxX11));
    }
}
