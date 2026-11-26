//! HTTP calls to hcfs-server's `/v1/devices` routes.
//!
//! Direct `reqwest` calls with `Authorization: Bearer`, as Trash makes its
//! own: the pinned hcfs-client has no devices calls. Nothing here retries.
//! A create asked twice registers two devices, and the registration loop
//! asks again a minute later anyway. Every function takes the client, base
//! and bearer as values, so `tests/devices_server_mock.rs` drives the real
//! request and response code with no Tauri runtime.

use super::wire::{DeviceRecord, DeviceRefusal, parse_device, parse_device_list};
use std::time::Duration;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Where and as whom devices calls go.
#[derive(Clone)]
pub struct DevicesApi {
    pub http: reqwest::Client,
    pub base_url: String,
    pub bearer: String,
}

impl DevicesApi {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    async fn call(&self, request: reqwest::RequestBuilder) -> Result<(u16, String), DeviceRefusal> {
        let response = request.bearer_auth(&self.bearer).timeout(CALL_TIMEOUT).send().await.map_err(|e| {
            tracing::debug!(error = %e, "devices: no answer");
            DeviceRefusal::no_answer()
        })?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|_| DeviceRefusal::no_answer())?;
        if (200..300).contains(&status) {
            Ok((status, body))
        } else {
            Err(DeviceRefusal::from_body(status, &body))
        }
    }

    async fn device(&self, request: reqwest::RequestBuilder) -> Result<DeviceRecord, DeviceRefusal> {
        let (status, body) = self.call(request).await?;
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(parse_device)
            .ok_or_else(|| DeviceRefusal::unreadable(status))
    }

    /// `GET /v1/devices`: the linked devices, read strictly. Only a clean
    /// `200` with a readable list is an answer.
    pub async fn list(&self) -> Result<Vec<DeviceRecord>, DeviceRefusal> {
        let (status, body) = self.call(self.http.get(self.url("/v1/devices"))).await?;
        if status != 200 {
            return Err(DeviceRefusal::unreadable(status));
        }
        parse_device_list(&body).ok_or_else(|| DeviceRefusal::unreadable(status))
    }

    /// `POST /v1/devices`: register this computer. A computer sends no model
    /// fields.
    pub async fn create(&self, platform: &str, name: &str) -> Result<DeviceRecord, DeviceRefusal> {
        let body = serde_json::json!({ "platform": platform, "name": name });
        self.device(self.http.post(self.url("/v1/devices")).json(&body)).await
    }

    /// `POST /v1/devices/{id}/reconnect`: link a removed device again.
    pub async fn reconnect(&self, device_id: &str) -> Result<DeviceRecord, DeviceRefusal> {
        let url = self.url(&format!("/v1/devices/{device_id}/reconnect"));
        self.device(self.http.post(url)).await
    }

    /// `PATCH /v1/devices/{id}` `{name}`.
    pub async fn rename(&self, device_id: &str, name: &str) -> Result<(), DeviceRefusal> {
        let url = self.url(&format!("/v1/devices/{device_id}"));
        self.call(self.http.patch(url).json(&serde_json::json!({ "name": name })))
            .await
            .map(|_| ())
    }

    /// `DELETE /v1/devices/{id}`. A `404` is done too: the device is gone
    /// either way.
    pub async fn unlink(&self, device_id: &str) -> Result<(), DeviceRefusal> {
        let url = self.url(&format!("/v1/devices/{device_id}"));
        match self.call(self.http.delete(url)).await {
            Ok(_) => Ok(()),
            Err(r) if r.status == 404 => Ok(()),
            Err(r) => Err(r),
        }
    }
}

/// A name the server takes: 1 to 128 characters, no control characters.
pub fn server_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    let name = if trimmed.is_empty() { "Computer" } else { trimmed };
    name.chars().take(128).collect()
}

#[cfg(test)]
mod tests {
    use super::server_name;

    #[test]
    fn names_fit_what_the_server_takes() {
        assert_eq!(server_name("  Studio  "), "Studio");
        assert_eq!(server_name("a\u{7}b"), "ab");
        assert_eq!(server_name(""), "Computer");
        assert_eq!(server_name(&"x".repeat(200)).chars().count(), 128);
    }
}
