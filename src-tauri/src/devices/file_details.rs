//! The file details panel's extra rows: when a photo was taken and last
//! changed, the camera, and which of the account's devices uploaded it.
//!
//! One `/search_files` `file_id` lookup with `include_source_metadata`, the
//! hit checked against the id asked for (a server older than `file_id`
//! runs an ordinary search and answers with other files), then the
//! uploading device's label from `GET /v1/devices`. Every failure shows
//! nothing extra, never an error.

use super::api::DevicesApi;
use super::wire::device_labels;
use crate::app_state::AppState;
use crate::error::Result;
use crate::sync::favorites::wire::{is_folder_hash, normalize_file_id};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 1990-01-01T00:00:00Z: no earlier date is believed.
const EARLIEST_TRUSTED: i64 = 631_152_000;
/// A day of clock skew is allowed into the future.
const FUTURE_SLACK: i64 = 86_400;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Which file, as its row knows it.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceTarget {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub owner_ss58: Option<String>,
    #[serde(default)]
    pub folder_hash: Option<String>,
    pub file_id: String,
}

/// The extra rows; each `None` is left off the panel.
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceDetails {
    pub taken_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub camera: Option<String>,
    pub uploaded_from: Option<String>,
}

/// The part of a `/search_files` hit this reads.
#[derive(Deserialize, Debug, Default)]
pub struct SourceHit {
    #[serde(default)]
    pub path_hash: Option<Vec<u8>>,
    #[serde(default)]
    pub source_taken_at: Option<serde_json::Value>,
    #[serde(default)]
    pub source_modified_at: Option<serde_json::Value>,
    #[serde(default)]
    pub source_metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub device_id: Option<String>,
}

/// A date the panel may show: Unix seconds from 1990 to a day from now.
pub fn trusted_date(value: Option<&serde_json::Value>, now: i64) -> Option<i64> {
    let seconds = value?.as_f64()?;
    if !seconds.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    let seconds = seconds.floor() as i64;
    (EARLIEST_TRUSTED..=now.saturating_add(FUTURE_SLACK))
        .contains(&seconds)
        .then_some(seconds)
}

/// "Canon EOS R5" (the model already names the make), "Apple iPhone 15 Pro
/// Max", or whichever of the two exists.
pub fn camera_label(metadata: Option<&serde_json::Value>) -> Option<String> {
    let metadata = metadata?;
    let field = |key: &str| {
        metadata
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match (field("camera_make"), field("camera_model")) {
        (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => Some(model),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => model.or(make),
    }
}

/// The hit for `file_id`, or `None` when the page holds none or another file.
pub fn matching_hit(body: &str, file_id: &str) -> Option<SourceHit> {
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        files: Vec<serde_json::Value>,
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let page: Page = serde_json::from_value(value.get("Success")?.clone()).ok()?;
    page.files
        .into_iter()
        .filter_map(|v| serde_json::from_value::<SourceHit>(v).ok())
        .find(|hit| hit.path_hash.as_ref().is_some_and(|h| h.len() == 32 && hex::encode(h) == file_id))
}

/// The details, from a checked hit and (when it names a device) the list.
pub async fn lookup(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    owner: &str,
    folder_hash: &str,
    file_id: &str,
    now: i64,
) -> FileSourceDetails {
    let Ok(mut url) = reqwest::Url::parse(&format!("{}/search_files/{owner}", base_url.trim_end_matches('/'))) else {
        return FileSourceDetails::default();
    };
    url.query_pairs_mut()
        .append_pair("folder_hash", folder_hash)
        .append_pair("file_id", file_id)
        .append_pair("include_source_metadata", "true");
    let answer = http.get(url).bearer_auth(bearer).timeout(CALL_TIMEOUT).send().await;
    let body = match answer {
        Ok(response) if response.status().is_success() => response.text().await.unwrap_or_default(),
        Ok(response) => {
            tracing::debug!(status = response.status().as_u16(), "file details: lookup refused");
            return FileSourceDetails::default();
        }
        Err(e) => {
            tracing::debug!(error = %e, "file details: no answer");
            return FileSourceDetails::default();
        }
    };
    let Some(hit) = matching_hit(&body, file_id) else {
        return FileSourceDetails::default();
    };
    let uploaded_from = match hit.device_id.as_deref().filter(|id| !id.is_empty()) {
        Some(device_id) => {
            let api = DevicesApi {
                http: http.clone(),
                base_url: base_url.to_string(),
                bearer: bearer.to_string(),
            };
            match api.list().await {
                Ok(devices) => device_labels(&devices).remove(device_id),
                Err(_) => None,
            }
        }
        None => None,
    };
    FileSourceDetails {
        taken_at: trusted_date(hit.source_taken_at.as_ref(), now),
        modified_at: trusted_date(hit.source_modified_at.as_ref(), now),
        camera: camera_label(hit.source_metadata.as_ref()),
        uploaded_from,
    }
}

/// The file details' extra rows for one file. Never fails for want of an
/// answer: what cannot be read is left off.
#[tauri::command]
pub async fn get_file_source_details(state: tauri::State<'_, AppState>, account_id: String, target: FileSourceTarget) -> Result<FileSourceDetails> {
    let account_id = state.require_session_account(&account_id)?;
    let Some(file_id) = normalize_file_id(&target.file_id) else {
        return Ok(FileSourceDetails::default());
    };
    let pool = state.pool()?;
    let explicit = (
        target.owner_ss58.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        target.folder_hash.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    );
    let (owner, folder_hash) = match explicit {
        (Some(owner), Some(hash)) => (owner.to_string(), hash.to_string()),
        (None, None) => {
            let Some(label) = target.label.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(FileSourceDetails::default());
            };
            match crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, label).await {
                Ok(identity) => (identity.wire_ss58, identity.wire_folder_hash),
                Err(_) => return Ok(FileSourceDetails::default()),
            }
        }
        _ => return Ok(FileSourceDetails::default()),
    };
    if !is_folder_hash(&folder_hash) {
        return Ok(FileSourceDetails::default());
    }
    let Ok(server_url) = crate::sync::remote::get_server_url(pool, &account_id).await else {
        return Ok(FileSourceDetails::default());
    };
    let Ok(Some(bearer)) = crate::auth::tokens::get_api_token(pool, &account_id).await else {
        return Ok(FileSourceDetails::default());
    };
    let base = crate::sync::region::resolve_base_url(&server_url).to_string();
    let now = chrono::Utc::now().timestamp();
    Ok(lookup(&state.api_client, &base, &bearer, &owner, &folder_hash, &file_id, now).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000;

    #[test]
    fn only_believable_dates_are_shown() {
        assert_eq!(trusted_date(Some(&json!(1_700_000_000)), NOW), Some(1_700_000_000));
        assert_eq!(trusted_date(Some(&json!(1_700_000_000.9)), NOW), Some(1_700_000_000));
        assert_eq!(trusted_date(Some(&json!(EARLIEST_TRUSTED)), NOW), Some(EARLIEST_TRUSTED));
        assert_eq!(trusted_date(Some(&json!(EARLIEST_TRUSTED - 1)), NOW), None, "before 1990");
        assert_eq!(trusted_date(Some(&json!(0)), NOW), None);
        assert_eq!(trusted_date(Some(&json!(NOW + FUTURE_SLACK)), NOW), Some(NOW + FUTURE_SLACK));
        assert_eq!(trusted_date(Some(&json!(NOW + FUTURE_SLACK + 1)), NOW), None, "more than a day ahead");
        assert_eq!(trusted_date(Some(&json!("2026")), NOW), None);
        assert_eq!(trusted_date(None, NOW), None);
    }

    #[test]
    fn the_camera_reads_like_people_say_it() {
        let m = |make: Option<&str>, model: Option<&str>| {
            let mut v = json!({});
            if let Some(make) = make {
                v["camera_make"] = json!(make);
            }
            if let Some(model) = model {
                v["camera_model"] = json!(model);
            }
            camera_label(Some(&v))
        };
        assert_eq!(m(Some("Canon"), Some("Canon EOS R5")).as_deref(), Some("Canon EOS R5"));
        assert_eq!(m(Some("Apple"), Some("iPhone 15 Pro Max")).as_deref(), Some("Apple iPhone 15 Pro Max"));
        assert_eq!(m(None, Some("iPhone 15")).as_deref(), Some("iPhone 15"));
        assert_eq!(m(Some("Sony"), None).as_deref(), Some("Sony"));
        assert_eq!(m(Some(" "), Some("")), None);
        assert_eq!(camera_label(None), None);
    }

    #[test]
    fn a_hit_counts_only_when_its_path_hash_is_the_file_asked_for() {
        let id = hex::encode([7u8; 32]);
        let body = |hash: u8| json!({ "Success": { "files": [{ "path_hash": vec![hash; 32], "source_taken_at": 1_700_000_000 }] } }).to_string();
        assert!(matching_hit(&body(7), &id).is_some());
        // An older server's ordinary search answers with some other file.
        assert!(matching_hit(&body(8), &id).is_none());
        assert!(matching_hit(r#"{"Success":{"files":[]}}"#, &id).is_none());
        assert!(matching_hit(r#"{"Error":{"error":"forbidden"}}"#, &id).is_none());
    }
}
