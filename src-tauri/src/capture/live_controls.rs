//! What the recording pill may change while a recording runs: mute the
//! microphone, switch to another microphone or camera, and resize the camera
//! bubble. Pure decisions, tested on every OS; `commands.rs` asks the
//! recorder and moves the windows.
//!
//! The file must follow every change without a stop or a restart:
//! - **Mute** writes silence in place of the microphone (the recorder keeps
//!   the device open), so the one audio track stays continuous and in step
//!   with the picture, and system audio goes on.
//! - **Switching the microphone** is done by the recorder in its running
//!   stream; the moment the device changes is silence, placed by timestamp.
//! - **The camera** is a window that is filmed (`camera.rs`), so switching
//!   it is the camera page opening the other device (a short freeze in the
//!   video), and resizing it is moving the window, inside what is filmed.
//!
//! Where the pill offers each is [`support_for`]: only where the recorder
//! has the control, and never where the pill (and so its menus) is filmed.

use serde::Serialize;

use super::bar::CameraShape;
use super::camera::Frame;
use super::rollout::Platform;
use super::session::CapturePhase;
use super::support::pill_filmed;

/// Which live controls a platform has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSupport {
    pub mute_microphone: bool,
    pub switch_microphone: bool,
    pub switch_camera: bool,
    pub resize_camera: bool,
}

/// What `platform`'s pill may offer mid-recording.
///
/// macOS has them all (the Swift helper's `mute`, `unmute` and
/// `switch_microphone`). Windows has the camera ones, which only move and
/// re-point the camera window the recorder films; its recorder child has no
/// microphone controls yet. Linux has none: the pill is filmed there
/// ([`pill_filmed`]), so its menus would be in the video.
#[must_use]
pub const fn support_for(platform: Platform) -> LiveSupport {
    let camera = !pill_filmed(platform);
    let microphone = matches!(platform, Platform::MacOs);
    LiveSupport {
        mute_microphone: microphone,
        switch_microphone: microphone,
        switch_camera: camera,
        resize_camera: camera,
    }
}

/// The live microphone of a recording, held by the session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveMicrophone {
    /// The recording records a microphone at all.
    pub recorded: bool,
    pub muted: bool,
    /// The microphone recorded now (the platform's id); `None` = the system
    /// default.
    pub device: Option<String>,
}

/// What the pill draws for the microphone (`capture_microphone_state`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneState {
    pub recorded: bool,
    pub muted: bool,
    pub device_id: Option<String>,
    /// The pill shows the mute button.
    pub can_mute: bool,
    /// The pill shows the microphone menu.
    pub can_switch: bool,
}

/// A change the pill asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MicrophoneAction {
    Mute(bool),
    Switch(Option<String>),
}

/// What a [`MicrophoneAction`] needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophoneStep {
    /// Already so: nothing to ask the recorder.
    Nothing,
    /// Ask the recorder, then [`LiveMicrophone::apply`] what it agreed to.
    AskRecorder,
}

/// Why a live change is refused, in the words the pill shows.
pub const NOT_RECORDING: &str = "No recording is in progress.";
pub const NO_MICROPHONE: &str = "This recording has no microphone.";
pub const NO_CAMERA: &str = "This recording has no camera.";
pub const CAMERA_IN_RECORDER: &str = "The camera can't be changed during this recording.";

/// Whether the session is recording (paused counts: the file is open).
#[must_use]
pub const fn is_live(phase: CapturePhase) -> bool {
    matches!(phase, CapturePhase::Recording { .. } | CapturePhase::Paused { .. })
}

impl LiveMicrophone {
    /// A recording has just started: heard, on the device it opened.
    #[must_use]
    pub fn started(recorded: bool, device: Option<String>) -> Self {
        Self {
            recorded,
            muted: false,
            device: if recorded { normalise(device) } else { None },
        }
    }

    /// What the pill draws.
    #[must_use]
    pub fn state(&self, support: LiveSupport) -> MicrophoneState {
        MicrophoneState {
            recorded: self.recorded,
            muted: self.muted,
            device_id: self.device.clone(),
            can_mute: self.recorded && support.mute_microphone,
            can_switch: self.recorded && support.switch_microphone,
        }
    }

    /// What `action` needs now.
    ///
    /// # Errors
    ///
    /// The pill's line: no recording, no microphone in it, or no such
    /// control on this platform.
    pub fn plan(&self, phase: CapturePhase, support: LiveSupport, action: &MicrophoneAction) -> Result<MicrophoneStep, &'static str> {
        if !is_live(phase) {
            return Err(NOT_RECORDING);
        }
        if !self.recorded {
            return Err(NO_MICROPHONE);
        }
        match action {
            MicrophoneAction::Mute(_) if !support.mute_microphone => Err(super::recording::LIVE_MICROPHONE_UNSUPPORTED),
            MicrophoneAction::Switch(_) if !support.switch_microphone => Err(super::recording::LIVE_MICROPHONE_UNSUPPORTED),
            MicrophoneAction::Mute(muted) if *muted == self.muted => Ok(MicrophoneStep::Nothing),
            MicrophoneAction::Switch(device) if normalise(device.clone()) == self.device => Ok(MicrophoneStep::Nothing),
            _ => Ok(MicrophoneStep::AskRecorder),
        }
    }

    /// The recorder agreed to `action`. Switching keeps the mute: a muted
    /// microphone stays muted on the new device.
    pub fn apply(&mut self, action: &MicrophoneAction) {
        match action {
            MicrophoneAction::Mute(muted) => self.muted = *muted,
            MicrophoneAction::Switch(device) => self.device = normalise(device.clone()),
        }
    }
}

/// An empty id is the system default, like none.
fn normalise(device: Option<String>) -> Option<String> {
    device.filter(|d| !d.trim().is_empty())
}

/// Whether the pill may switch the camera now: a recording with a camera
/// window (bubble or stage) that the recorder does not hold itself.
///
/// # Errors
///
/// The pill's line for why not.
pub fn camera_switch(phase: CapturePhase, camera: Option<CameraShape>, recorder_owns_camera: bool, support: LiveSupport) -> Result<(), &'static str> {
    if !is_live(phase) {
        return Err(NOT_RECORDING);
    }
    if camera.is_none() {
        return Err(NO_CAMERA);
    }
    if recorder_owns_camera || !support.switch_camera {
        return Err(CAMERA_IN_RECORDER);
    }
    Ok(())
}

/// The pill's camera controls, as the camera state tells them: `switch`
/// for the camera menu (a bubble, hidden or not, or the stage), `resize`
/// for the size choices (a bubble on screen).
#[must_use]
pub fn camera_controls(
    phase: CapturePhase,
    camera: Option<CameraShape>,
    hidden: bool,
    recorder_owns_camera: bool,
    support: LiveSupport,
) -> (bool, bool) {
    let switch = camera_switch(phase, camera, recorder_owns_camera, support).is_ok();
    let resize = is_live(phase) && support.resize_camera && camera == Some(CameraShape::Bubble) && !hidden;
    (switch, resize)
}

/// How tall the pill's window grows while one of its menus is open.
pub const MENU_HEIGHT: f64 = 300.0;

/// The pill's window while a menu is open: the same width, `menu_height`
/// taller, grown upward so the pill itself stays where it is, or downward
/// when the pill is too near the top of the usable area (`work`). Returns
/// the frame and whether the menu is above the pill.
#[must_use]
pub fn pill_with_menu(pill: Frame, work: Frame, menu_height: f64) -> (Frame, bool) {
    let room_above = pill.y - work.y;
    let room_below = (work.y + work.height) - (pill.y + pill.height);
    let above = room_above >= menu_height || room_above >= room_below;
    let y = if above { pill.y - menu_height } else { pill.y };
    (
        Frame {
            x: pill.x,
            y,
            width: pill.width,
            height: pill.height + menu_height,
        },
        above,
    )
}

/// The pill's window once the menu closes: back to `height` with the pill
/// where it was (the bottom of the grown window when the menu was above).
#[must_use]
pub fn pill_without_menu(grown: Frame, height: f64, above: bool) -> Frame {
    Frame {
        x: grown.x,
        y: if above { grown.y + grown.height - height } else { grown.y },
        width: grown.width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: CapturePhase = CapturePhase::Recording {
        elapsed_secs: 3,
        microphone: true,
    };
    const PAUSED: CapturePhase = CapturePhase::Paused {
        elapsed_secs: 3,
        microphone: true,
    };
    const MAC: LiveSupport = support_for(Platform::MacOs);

    #[test]
    fn each_platform_offers_only_what_its_recorder_can_do_and_never_in_a_filmed_pill() {
        assert_eq!(
            support_for(Platform::MacOs),
            LiveSupport {
                mute_microphone: true,
                switch_microphone: true,
                switch_camera: true,
                resize_camera: true
            }
        );
        let windows = support_for(Platform::Windows);
        assert!(!windows.mute_microphone && !windows.switch_microphone);
        assert!(windows.switch_camera && windows.resize_camera);
        for linux in [Platform::LinuxX11, Platform::LinuxWayland] {
            assert_eq!(
                support_for(linux),
                LiveSupport {
                    mute_microphone: false,
                    switch_microphone: false,
                    switch_camera: false,
                    resize_camera: false
                },
                "{linux:?}: the pill is filmed there"
            );
        }
    }

    #[test]
    fn mute_and_unmute_ask_the_recorder_once_and_keep_the_state() {
        let mut mic = LiveMicrophone::started(true, Some("usb-1".into()));
        assert!(!mic.muted, "a recording starts heard");
        assert_eq!(mic.plan(LIVE, MAC, &MicrophoneAction::Mute(true)), Ok(MicrophoneStep::AskRecorder));
        mic.apply(&MicrophoneAction::Mute(true));
        assert!(mic.state(MAC).muted);
        // Already muted: nothing to ask, while paused too.
        assert_eq!(mic.plan(PAUSED, MAC, &MicrophoneAction::Mute(true)), Ok(MicrophoneStep::Nothing));
        assert_eq!(mic.plan(PAUSED, MAC, &MicrophoneAction::Mute(false)), Ok(MicrophoneStep::AskRecorder));
        mic.apply(&MicrophoneAction::Mute(false));
        assert!(!mic.state(MAC).muted);
    }

    #[test]
    fn switching_keeps_the_mute_and_skips_the_device_already_recorded() {
        let mut mic = LiveMicrophone::started(true, None);
        mic.apply(&MicrophoneAction::Mute(true));
        assert_eq!(mic.plan(LIVE, MAC, &MicrophoneAction::Switch(None)), Ok(MicrophoneStep::Nothing));
        assert_eq!(
            mic.plan(LIVE, MAC, &MicrophoneAction::Switch(Some(String::new()))),
            Ok(MicrophoneStep::Nothing),
            "an empty id is the default"
        );
        let usb = MicrophoneAction::Switch(Some("usb-1".into()));
        assert_eq!(mic.plan(LIVE, MAC, &usb), Ok(MicrophoneStep::AskRecorder));
        mic.apply(&usb);
        let state = mic.state(MAC);
        assert_eq!(state.device_id.as_deref(), Some("usb-1"));
        assert!(state.muted, "still muted on the new microphone");
        assert_eq!(mic.plan(LIVE, MAC, &usb), Ok(MicrophoneStep::Nothing));
    }

    #[test]
    fn the_microphone_cannot_change_outside_a_recording_or_without_one() {
        let mic = LiveMicrophone::started(true, None);
        for phase in [CapturePhase::Idle, CapturePhase::Finalizing] {
            assert_eq!(mic.plan(phase, MAC, &MicrophoneAction::Mute(true)), Err(NOT_RECORDING));
        }
        let none = LiveMicrophone::started(false, Some("usb-1".into()));
        assert_eq!(none.device, None);
        assert_eq!(none.plan(LIVE, MAC, &MicrophoneAction::Mute(true)), Err(NO_MICROPHONE));
        let state = none.state(MAC);
        assert!(!state.can_mute && !state.can_switch, "nothing to offer without a microphone");
        let windows = support_for(Platform::Windows);
        assert_eq!(
            mic.plan(LIVE, windows, &MicrophoneAction::Mute(true)),
            Err(crate::capture::recording::LIVE_MICROPHONE_UNSUPPORTED)
        );
        assert!(!mic.state(windows).can_mute);
    }

    #[test]
    fn the_camera_switches_for_a_bubble_or_the_stage_unless_the_recorder_holds_it() {
        assert_eq!(camera_switch(LIVE, Some(CameraShape::Bubble), false, MAC), Ok(()));
        assert_eq!(camera_switch(PAUSED, Some(CameraShape::Stage), false, MAC), Ok(()));
        assert_eq!(camera_switch(LIVE, None, false, MAC), Err(NO_CAMERA));
        assert_eq!(
            camera_switch(CapturePhase::Idle, Some(CameraShape::Bubble), false, MAC),
            Err(NOT_RECORDING)
        );
        // Camera only on Wayland: the recorder has the device.
        assert_eq!(camera_switch(LIVE, Some(CameraShape::Stage), true, MAC), Err(CAMERA_IN_RECORDER));
        assert_eq!(
            camera_switch(LIVE, Some(CameraShape::Bubble), false, support_for(Platform::LinuxX11)),
            Err(CAMERA_IN_RECORDER)
        );
    }

    #[test]
    fn only_a_bubble_on_screen_is_resized_from_the_pill() {
        assert_eq!(camera_controls(LIVE, Some(CameraShape::Bubble), false, false, MAC), (true, true));
        assert_eq!(
            camera_controls(LIVE, Some(CameraShape::Bubble), true, false, MAC),
            (true, false),
            "hidden"
        );
        assert_eq!(
            camera_controls(LIVE, Some(CameraShape::Stage), false, false, MAC),
            (true, false),
            "the stage is the video"
        );
        let selecting = CapturePhase::Selecting {
            kind: crate::capture::session::CaptureKind::Recording,
            mode: crate::capture::session::CaptureMode::Screen,
        };
        assert_eq!(
            camera_controls(selecting, Some(CameraShape::Bubble), false, false, MAC),
            (false, false),
            "the bubble's own strip does it while choosing"
        );
    }

    #[test]
    fn the_menu_opens_above_the_pill_and_below_it_near_the_top() {
        let work = Frame {
            x: 0.0,
            y: 25.0,
            width: 1440.0,
            height: 800.0,
        };
        let pill = Frame {
            x: 550.0,
            y: 740.0,
            width: 340.0,
            height: 60.0,
        };
        let (grown, above) = pill_with_menu(pill, work, MENU_HEIGHT);
        assert!(above);
        assert!((grown.y + grown.height - (pill.y + pill.height)).abs() < 1e-9, "the pill does not move");
        assert_eq!(pill_without_menu(grown, pill.height, above), pill);

        let high = Frame { y: 40.0, ..pill };
        let (grown, above) = pill_with_menu(high, work, MENU_HEIGHT);
        assert!(!above, "no room above: the menu opens below");
        assert!((grown.y - high.y).abs() < 1e-9);
        assert_eq!(pill_without_menu(grown, high.height, above), high);
    }
}
