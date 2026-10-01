//! `--list-microphones`: the active WASAPI capture endpoints (USB, Bluetooth
//! hands-free, virtual cables, a Phone Link microphone), named as Windows
//! names them, the default input marked. The endpoint id is what the
//! recorder opens, so the recording side never matches by name.
//!
//! The app tidies the list (`recording::tidy_devices`: default first, each
//! once), so this prints what Windows says. It prints its own row type, in
//! the shape the app reads `MediaDevice` from, so the child does not
//! depend on fields only the app's side carries.

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture, eConsole};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ};

use serde::Serialize;

use super::com;

/// One microphone, as `--list-microphones` prints it (the keys the app's
/// `recording::MediaDevice` reads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// The microphones, or none when Windows cannot say.
pub fn list_microphones() -> Vec<Listed> {
    let _com = com::Apartment::enter();
    list().unwrap_or_else(|e| {
        let _ = super::writeln_stderr(&format!("the microphones could not be listed: {e}"));
        Vec::new()
    })
}

fn list() -> windows::core::Result<Vec<Listed>> {
    // SAFETY: COM calls inside this thread's apartment on objects created
    // here; the id strings WASAPI allocates are freed with CoTaskMemFree.
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let default_id = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok().and_then(|d| endpoint_id(&d));
        let collection = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        let count = collection.GetCount()?;
        let mut out = Vec::new();
        for i in 0..count {
            let Ok(device) = collection.Item(i) else {
                continue;
            };
            let Some(id) = endpoint_id(&device) else {
                continue;
            };
            let name = friendly_name(&device).unwrap_or_default();
            out.push(Listed {
                is_default: default_id.as_deref() == Some(id.as_str()),
                id,
                name,
            });
        }
        Ok(out)
    }
}

/// # Safety
/// `device` is a live endpoint in this thread's apartment.
unsafe fn endpoint_id(device: &IMMDevice) -> Option<String> {
    // SAFETY: per the contract; the string is copied, then freed.
    unsafe {
        let raw = device.GetId().ok()?;
        let id = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0.cast()));
        id
    }
}

/// # Safety
/// `device` is a live endpoint in this thread's apartment.
unsafe fn friendly_name(device: &IMMDevice) -> Option<String> {
    // SAFETY: per the contract.
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = value.to_string();
        (!name.trim().is_empty()).then_some(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the child prints is what the app's device list reads.
    #[test]
    fn a_listed_microphone_reads_back_as_the_apps_device() {
        let line = serde_json::to_string(&vec![Listed {
            id: "{0.0.1.00000000}.{guid}".into(),
            name: "Microphone (USB Audio)".into(),
            is_default: true,
        }])
        .unwrap();
        let devices = crate::capture::recording::helper::parse_devices(&line);
        assert_eq!(devices.len(), 1);
        assert_eq!((devices[0].name.as_str(), devices[0].is_default), ("Microphone (USB Audio)", true));
    }
}
