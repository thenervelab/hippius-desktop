//! `--watch-devices` on Windows: the bar's lists stay live while it is up.
//! Microphones through `IMMNotificationClient` (an endpoint added, removed,
//! enabled or disabled, or a new default input); cameras through
//! `CM_Register_Notification` on the camera device-interface class (a USB
//! camera plugged in, a Phone Link camera turned on, a virtual camera
//! registered). Each nudges the shared loop ([`super::super::watch`]), which
//! re-reads both lists with the same calls `--list-microphones` and
//! `--list-cameras` make and prints them when they changed.

use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, PoisonError};

use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_NOTIFY_ACTION, CM_NOTIFY_EVENT_DATA, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_0, CM_NOTIFY_FILTER_0_0, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
    CM_Register_Notification, CM_Unregister_Notification, CR_SUCCESS, HCMNOTIFICATION,
};
use windows::Win32::Media::Audio::{IMMDeviceEnumerator, IMMNotificationClient, MMDeviceEnumerator};
use windows::Win32::Media::KernelStreaming::{KSCATEGORY_VIDEO, KSCATEGORY_VIDEO_CAMERA};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::core::GUID;

use super::super::watch::{self, Timing, Wake};
use super::{com, devices};

/// The endpoint callback, in its own module so the lints `#[implement]`'s
/// generated code trips stay there.
#[allow(clippy::ref_as_ptr, clippy::inline_always, non_snake_case)]
mod endpoints {
    use std::sync::mpsc::Sender;
    use std::sync::{Mutex, PoisonError};

    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Media::Audio::{DEVICE_STATE, EDataFlow, ERole, IMMNotificationClient, IMMNotificationClient_Impl};
    use windows::core::{PCWSTR, implement};

    use super::super::super::watch::Wake;

    /// Tells the loop an audio endpoint changed. Windows calls it on its own
    /// threads and asks that it never block: a send on an unbounded
    /// channel does not.
    #[implement(IMMNotificationClient)]
    pub(super) struct Endpoints(pub(super) Mutex<Sender<Wake>>);

    impl Endpoints_Impl {
        fn nudge(&self) {
            let _ = self.0.lock().unwrap_or_else(PoisonError::into_inner).send(Wake::Changed);
        }
    }

    impl IMMNotificationClient_Impl for Endpoints_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
            self.nudge();
            Ok(())
        }
        fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            self.nudge();
            Ok(())
        }
        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            self.nudge();
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, _flow: EDataFlow, _role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
            self.nudge();
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
            // Fired constantly (volume, jack state); a rename is caught by
            // the slow poll instead.
            Ok(())
        }
    }
}

/// The camera-arrival callback's context: the loop's sender.
type CameraNudge = Mutex<Sender<Wake>>;

/// Called by the configuration manager on its own thread for every camera
/// interface that arrives or leaves.
unsafe extern "system" fn camera_changed(
    _notify: HCMNOTIFICATION,
    context: *const core::ffi::c_void,
    _action: CM_NOTIFY_ACTION,
    _data: *const CM_NOTIFY_EVENT_DATA,
    _size: u32,
) -> u32 {
    if !context.is_null() {
        // SAFETY: `context` is the `CameraNudge` boxed in `run`, which
        // outlives every registration (they are unregistered first).
        let nudge = unsafe { &*context.cast::<CameraNudge>() };
        let _ = nudge.lock().unwrap_or_else(PoisonError::into_inner).send(Wake::Changed);
    }
    0
}

/// Register for arrivals and removals of `class` interfaces.
fn register_class(class: GUID, context: &CameraNudge) -> Option<HCMNOTIFICATION> {
    let filter = CM_NOTIFY_FILTER {
        cbSize: u32::try_from(std::mem::size_of::<CM_NOTIFY_FILTER>()).unwrap_or(0),
        Flags: 0,
        FilterType: CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
        Reserved: 0,
        u: CM_NOTIFY_FILTER_0 {
            DeviceInterface: CM_NOTIFY_FILTER_0_0 { ClassGuid: class },
        },
    };
    let mut handle = HCMNOTIFICATION::default();
    // SAFETY: the filter and handle are live locals; the context pointer
    // stays valid until the registration is removed (see `camera_changed`).
    let result = unsafe {
        CM_Register_Notification(
            &raw const filter,
            Some(std::ptr::from_ref(context).cast()),
            Some(camera_changed),
            &raw mut handle,
        )
    };
    (result == CR_SUCCESS).then_some(handle)
}

/// Watch until stdin closes. Returns the process's exit code.
#[must_use]
pub fn run() -> i32 {
    let _com = com::Apartment::enter();
    let (tx, rx) = mpsc::channel();
    watch::stop_on_stdin_close(tx.clone());

    // Microphones. Without the enumerator the slow poll still runs.
    // SAFETY: COM calls in this thread's apartment; the client is
    // unregistered before it and the enumerator are dropped.
    let enumerator: Option<IMMDeviceEnumerator> = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok();
    let client: IMMNotificationClient = endpoints::Endpoints(Mutex::new(tx.clone())).into();
    let registered = enumerator
        .as_ref()
        .is_some_and(|e| unsafe { e.RegisterEndpointNotificationCallback(&client) }.is_ok());
    if !registered {
        let _ = super::writeln_stderr("watch: microphone changes are not announced; polling instead");
    }

    // Cameras: KSCATEGORY_VIDEO_CAMERA is the class Windows 10 and later
    // register cameras under (Phone Link and frame-server cameras too);
    // KSCATEGORY_VIDEO covers an older driver that registers only that.
    let nudge: Box<CameraNudge> = Box::new(Mutex::new(tx.clone()));
    let cameras: Vec<HCMNOTIFICATION> = [KSCATEGORY_VIDEO_CAMERA, KSCATEGORY_VIDEO]
        .into_iter()
        .filter_map(|class| register_class(class, &nudge))
        .collect();
    if cameras.is_empty() {
        let _ = super::writeln_stderr("watch: camera changes are not announced; polling instead");
    }
    // The loop ends when stdin closes, not when every sender is gone.
    drop(tx);

    let out = std::io::stdout();
    watch::serve(
        &rx,
        || watch::line(&devices::list_cameras(), &devices::list_microphones()),
        out.lock(),
        Timing::default(),
    );

    for handle in cameras {
        // SAFETY: a handle CM_Register_Notification returned, removed once.
        // Unregistering waits for a callback in flight, so `nudge` is not
        // freed under one.
        let _ = unsafe { CM_Unregister_Notification(handle) };
    }
    drop(nudge);
    if registered && let Some(enumerator) = &enumerator {
        // SAFETY: the client registered above, on the same enumerator.
        let _ = unsafe { enumerator.UnregisterEndpointNotificationCallback(&client) };
    }
    0
}
