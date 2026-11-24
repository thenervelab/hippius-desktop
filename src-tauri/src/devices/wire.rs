//! Wire types of hcfs-server's `/v1/devices` routes, read strictly, and the
//! labels devices are shown by.
//!
//! The pinned hcfs-client has no devices calls, so the desktop reads the
//! replies itself (`devices.md`). A list is read strictly: a reply whose
//! `devices` is not an array, or with ANY entry that is not a device, is
//! unreadable as a whole, never a shorter list. A shorter list would make
//! this computer think it was unlinked and sign the account out.

use serde::Deserialize;
use std::collections::HashMap;

/// One linked device.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    pub device_id: String,
    /// `android`, `ios`, `macos`, `windows`, `linux`, or a later platform.
    pub platform: String,
    pub name: String,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub last_active_at: i64,
}

/// A device id: 32 lowercase hex characters.
pub fn is_device_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// One device, strictly: every required field present with its type and a
/// well-formed id.
pub fn parse_device(value: serde_json::Value) -> Option<DeviceRecord> {
    let device: DeviceRecord = serde_json::from_value(value).ok()?;
    (is_device_id(&device.device_id) && !device.platform.is_empty()).then_some(device)
}

/// `GET /v1/devices`: `{"devices": [...]}`, all or nothing.
pub fn parse_device_list(body: &str) -> Option<Vec<DeviceRecord>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let entries = value.get("devices")?.as_array()?;
    entries.iter().cloned().map(parse_device).collect()
}

/// What a device is called before duplicates are told apart: its model,
/// else its name, else "Device".
fn base_label(device: &DeviceRecord) -> String {
    [device.model_name.as_deref(), Some(device.name.as_str())]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("Device")
        .to_string()
}

/// Each device's label by id. Devices that would share a label keep it for
/// the oldest; the later ones get " (2)", " (3)" in the order they were
/// added. The Devices section and the file details' "Uploaded from" both
/// read these, so a device has one name everywhere (the mobile app and the
/// web Drive label the same way).
pub fn device_labels(devices: &[DeviceRecord]) -> HashMap<String, String> {
    let mut by_base: HashMap<String, Vec<&DeviceRecord>> = HashMap::new();
    for device in devices {
        by_base.entry(base_label(device)).or_default().push(device);
    }
    let mut labels = HashMap::new();
    for (base, mut group) in by_base {
        group.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.device_id.cmp(&b.device_id)));
        for (i, device) in group.into_iter().enumerate() {
            let label = if i == 0 { base.clone() } else { format!("{base} ({})", i + 1) };
            labels.insert(device.device_id.clone(), label);
        }
    }
    labels
}

/// The platform as people say it.
pub fn platform_name(platform: &str) -> &'static str {
    match platform {
        "ios" => "iPhone",
        "android" => "Android",
        "macos" => "Mac",
        "windows" => "Windows",
        "linux" => "Linux",
        _ => "Device",
    }
}

/// Which icon a platform gets: `phone`, `computer`, or `other`.
pub fn device_kind(platform: &str) -> &'static str {
    match platform {
        "ios" | "android" => "phone",
        "macos" | "windows" | "linux" => "computer",
        _ => "other",
    }
}

/// This computer's platform, as the server names it.
pub fn this_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Why a devices call did not succeed. These routes answer a flat
/// `{error, message}` (no envelope).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DeviceRefusal {
    /// The HTTP status; 0 when no answer arrived.
    pub status: u16,
    pub code: Option<String>,
}

impl DeviceRefusal {
    pub fn no_answer() -> Self {
        Self::default()
    }

    pub fn from_body(status: u16, body: &str) -> Self {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        let inner = value.get("Error").unwrap_or(&value);
        let code = inner.get("error").and_then(serde_json::Value::as_str).map(str::to_string);
        Self { status, code }
    }

    /// A 2xx whose body is not what the route promises.
    pub fn unreadable(status: u16) -> Self {
        Self {
            status,
            code: Some("unreadable".into()),
        }
    }

    /// The account has registered 100 devices.
    pub fn is_device_limit(&self) -> bool {
        self.status == 409 && self.code.as_deref() == Some("device_limit")
    }

    /// The server does not offer devices to this account, and asking again
    /// will not change that (an older server, or a refused account).
    pub fn is_unavailable(&self) -> bool {
        matches!(self.status, 403 | 404)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: char, name: &str, model: Option<&str>, created: i64) -> serde_json::Value {
        let mut v = serde_json::json!({
            "device_id": id.to_string().repeat(32), "platform": "ios", "name": name,
            "created_at": created, "last_active_at": created + 10, "camera_uploads_backup_id": null
        });
        if let Some(m) = model {
            v["model_name"] = serde_json::json!(m);
        }
        v
    }

    #[test]
    fn a_list_parses_whole_or_not_at_all() {
        let ok = serde_json::json!({ "devices": [device('a', "Ada's iPhone", Some("iPhone 15"), 1)] }).to_string();
        assert_eq!(parse_device_list(&ok).expect("parses").len(), 1);
        // A future field is fine.
        let extra = serde_json::json!({ "devices": [{ "device_id": "b".repeat(32), "platform": "visionos", "name": "x",
            "created_at": 1, "last_active_at": 2, "camera_uploads_backup_id": null, "new_field": 3 }] })
        .to_string();
        assert_eq!(parse_device_list(&extra).expect("parses")[0].platform, "visionos");
        // One bad entry spoils the list: it must never read as a shorter one.
        let one_bad = serde_json::json!({ "devices": [device('a', "x", None, 1), { "device_id": "short", "platform": "ios",
            "name": "y", "created_at": 1, "last_active_at": 1 }] })
        .to_string();
        assert_eq!(parse_device_list(&one_bad), None);
        let missing_time = serde_json::json!({ "devices": [{ "device_id": "c".repeat(32), "platform": "ios", "name": "z" }] }).to_string();
        assert_eq!(parse_device_list(&missing_time), None);
        let upper = serde_json::json!({ "devices": [device('A', "x", None, 1)] }).to_string();
        assert_eq!(parse_device_list(&upper), None, "ids are lowercase");
        assert_eq!(parse_device_list(r#"{"devices": {}}"#), None);
        assert_eq!(parse_device_list(r#"{}"#), None);
        assert_eq!(parse_device_list("not json"), None);
        assert_eq!(parse_device_list(r#"{"devices": []}"#), Some(vec![]));
    }

    #[test]
    fn labels_prefer_the_model_and_number_repeats_by_age() {
        let devices: Vec<DeviceRecord> = [
            device('c', "Phone", Some("Pixel 8"), 30),
            device('a', "Work", Some("Pixel 8"), 10),
            device('b', "Home", Some("Pixel 8"), 20),
            device('d', "  ", None, 5),
            device('e', "Studio", None, 6),
        ]
        .into_iter()
        .map(|v| parse_device(v).unwrap())
        .collect();
        let labels = device_labels(&devices);
        assert_eq!(labels[&"a".repeat(32)], "Pixel 8");
        assert_eq!(labels[&"b".repeat(32)], "Pixel 8 (2)");
        assert_eq!(labels[&"c".repeat(32)], "Pixel 8 (3)");
        assert_eq!(labels[&"d".repeat(32)], "Device");
        assert_eq!(labels[&"e".repeat(32)], "Studio");
    }

    #[test]
    fn platforms_have_names_and_icons_and_unknown_ones_are_generic() {
        assert_eq!((platform_name("ios"), device_kind("ios")), ("iPhone", "phone"));
        assert_eq!((platform_name("android"), device_kind("android")), ("Android", "phone"));
        assert_eq!((platform_name("macos"), device_kind("macos")), ("Mac", "computer"));
        assert_eq!((platform_name("windows"), device_kind("windows")), ("Windows", "computer"));
        assert_eq!((platform_name("linux"), device_kind("linux")), ("Linux", "computer"));
        assert_eq!((platform_name("tvos"), device_kind("tvos")), ("Device", "other"));
        assert!(matches!(this_platform(), "macos" | "windows" | "linux"));
    }

    #[test]
    fn refusals_read_the_flat_body() {
        let limit = DeviceRefusal::from_body(409, r#"{"error":"device_limit","message":"x"}"#);
        assert!(limit.is_device_limit());
        assert!(!DeviceRefusal::from_body(409, r#"{"error":"account_purging"}"#).is_device_limit());
        assert!(DeviceRefusal::from_body(404, "").is_unavailable());
        assert!(!DeviceRefusal::no_answer().is_unavailable());
    }
}
