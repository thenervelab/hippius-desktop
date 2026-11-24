//! Settings › Devices: the account's linked phones and computers, and
//! unlinking one.

use super::registration::devices_api;
use super::store;
use super::wire::{DeviceRecord, device_kind, device_labels, is_device_id, platform_name};
use crate::app_state::AppState;
use crate::error::{AppError, Result};
use serde::Serialize;
use tracing::{info, warn};

/// One device, ready to show.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDevice {
    pub device_id: String,
    pub platform: String,
    pub platform_name: &'static str,
    pub kind: &'static str,
    pub label: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub is_this_device: bool,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListing {
    /// `false`: the server refuses devices for this account in a way a
    /// retry will not change.
    pub available: bool,
    pub devices: Vec<AccountDevice>,
}

/// The rows, labelled, this computer first, then the most recently active
/// (the creation time stands in for a device that never reported activity).
pub fn device_rows(devices: &[DeviceRecord], this_device: Option<&str>) -> Vec<AccountDevice> {
    let labels = device_labels(devices);
    let mut rows: Vec<AccountDevice> = devices
        .iter()
        .map(|d| AccountDevice {
            device_id: d.device_id.clone(),
            platform: d.platform.clone(),
            platform_name: platform_name(&d.platform),
            kind: device_kind(&d.platform),
            label: labels.get(&d.device_id).cloned().unwrap_or_else(|| "Device".into()),
            created_at: d.created_at,
            last_active_at: d.last_active_at,
            is_this_device: this_device == Some(d.device_id.as_str()),
        })
        .collect();
    let active = |d: &AccountDevice| if d.last_active_at > 0 { d.last_active_at } else { d.created_at };
    rows.sort_by(|a, b| {
        b.is_this_device
            .cmp(&a.is_this_device)
            .then_with(|| active(b).cmp(&active(a)))
            .then_with(|| a.label.cmp(&b.label))
    });
    rows
}

/// The account's linked devices.
///
/// # Errors
///
/// `Validation("Couldn't load your devices.")` when the server cannot be
/// read now; a `403`/`404` is `available: false` instead.
#[tauri::command]
pub async fn list_account_devices(state: tauri::State<'_, AppState>, account_id: String) -> Result<DeviceListing> {
    let account_id = state.require_session_account(&account_id)?;
    let api = devices_api(&state, &account_id).await?;
    let devices = match api.list().await {
        Ok(devices) => devices,
        Err(r) if r.is_unavailable() => return Ok(DeviceListing::default()),
        Err(r) => {
            warn!(status = r.status, code = ?r.code, "devices: the list could not be read");
            return Err(AppError::Validation("Couldn't load your devices.".into()));
        }
    };
    let saved = store::load(state.pool()?, &account_id).await.unwrap_or_default();
    Ok(DeviceListing {
        available: true,
        devices: device_rows(&devices, saved.device_id.as_deref()),
    })
}

/// Unlink one of the account's devices. This computer's own device is
/// refused: signing out is how it leaves.
#[tauri::command]
pub async fn unlink_account_device(state: tauri::State<'_, AppState>, account_id: String, device_id: String) -> Result<()> {
    let account_id = state.require_session_account(&account_id)?;
    if !is_device_id(&device_id) {
        return Err(AppError::Validation("That device isn't on your account.".into()));
    }
    let saved = store::load(state.pool()?, &account_id).await.unwrap_or_default();
    if saved.device_id.as_deref() == Some(device_id.as_str()) {
        return Err(AppError::Validation("This is the computer you're using. Sign out to remove it.".into()));
    }
    let api = devices_api(&state, &account_id).await?;
    api.unlink(&device_id).await.map_err(|r| {
        warn!(status = r.status, code = ?r.code, "devices: unlink refused");
        AppError::Validation("Couldn't unlink this device. Try again.".into())
    })?;
    info!("devices: a device was unlinked");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: char, model: &str, created: i64, active: i64, platform: &str) -> DeviceRecord {
        DeviceRecord {
            device_id: id.to_string().repeat(32),
            platform: platform.into(),
            name: "n".into(),
            model_id: None,
            model_name: Some(model.into()),
            created_at: created,
            last_active_at: active,
        }
    }

    #[test]
    fn this_computer_first_then_most_recently_active() {
        let devices = [
            device('a', "Pixel 8", 1, 100, "android"),
            device('b', "Pixel 8", 2, 300, "android"),
            device('c', "ThinkPad", 3, 50, "linux"),
            device('d', "iPad", 4, 0, "ios"),
        ];
        let rows = device_rows(&devices, Some(&"c".repeat(32)));
        let order: Vec<_> = rows.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(order, vec!["ThinkPad", "Pixel 8 (2)", "Pixel 8", "iPad"]);
        assert!(rows[0].is_this_device && !rows[1].is_this_device);
        assert_eq!((rows[0].platform_name, rows[0].kind), ("Linux", "computer"));
        assert_eq!((rows[1].platform_name, rows[1].kind), ("Android", "phone"));
    }
}
