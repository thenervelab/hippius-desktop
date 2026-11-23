//! HTTP calls to hcfs-server's Drive Trash routes.
//!
//! hcfs-client has no Trash methods yet, so these are direct `reqwest`
//! calls with `Authorization: Bearer`, as moves between drives make theirs
//! (`drive_move::api`). Every route path is built here, in one place, so
//! the drafted contract can be followed when the server lands.
//!
//! Each function takes the client, base and bearer as values, so the
//! mock-server tests (`tests/trash_server_mock.rs`) drive the real request
//! and response code with no Tauri runtime.

use super::wire::{
    DeleteItemsRequest, DeleteItemsResult, LIST_PAGE, ListCursor, RestoreRequest, RestoreResult, TrashFilesRequest, TrashFilesResult,
    TrashItemFilesPage, TrashListPage, TrashRefusal,
};
use hcfs_shared::network::NetworkResponse;
use serde::de::DeserializeOwned;
use std::time::Duration;

/// Bound on one call. A batch of 1,000 files or a restore of 5,000 is one
/// transaction on the server.
const CALL_TIMEOUT: Duration = Duration::from_mins(2);
/// A call is asked again this many times in all when no answer (or a 5xx
/// or 429) arrives. Every Trash call is safe to repeat: a file already in
/// Trash answers `already_deleted`, an item already restored `not_found`.
const ATTEMPTS: u32 = 3;

/// Where and as whom Trash calls go.
#[derive(Clone)]
pub struct TrashApi {
    pub http: reqwest::Client,
    pub base_url: String,
    pub bearer: String,
}

/// The routes of one drive's Trash.
fn drive_path(ss58: &str, folder_hash: &str) -> String {
    format!("/v1/trash/{ss58}/{folder_hash}")
}

impl TrashApi {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    async fn send<T: DeserializeOwned>(&self, request: impl Fn() -> reqwest::RequestBuilder, what: &'static str) -> Result<T, TrashRefusal> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = match request().bearer_auth(&self.bearer).timeout(CALL_TIMEOUT).send().await {
                Ok(response) => read_envelope(response).await,
                Err(e) => {
                    tracing::debug!(what, error = %e, "trash: no answer");
                    Err(TrashRefusal::no_answer())
                }
            };
            match outcome {
                Err(refusal) if refusal.is_retryable() && attempt < ATTEMPTS => {
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                }
                other => return other,
            }
        }
    }

    /// `POST .../files`: one batch of at most [`super::wire::MAX_TRASH_FILES`].
    pub async fn trash_files(&self, ss58: &str, folder_hash: &str, body: &TrashFilesRequest) -> Result<TrashFilesResult, TrashRefusal> {
        let url = self.url(&format!("{}/files", drive_path(ss58, folder_hash)));
        self.send(|| self.http.post(&url).json(body), "trash files").await
    }

    /// `GET .../`: one page of items, newest first.
    pub async fn list(&self, ss58: &str, folder_hash: &str, after: Option<&ListCursor>) -> Result<TrashListPage, TrashRefusal> {
        let mut query: Vec<(&str, String)> = vec![("limit", LIST_PAGE.to_string())];
        if let Some(cursor) = after {
            query.push(("after_trashed_at", cursor.after_trashed_at.to_string()));
            query.push(("after_item_id", cursor.after_item_id.clone()));
        }
        let url = with_query(self.url(&drive_path(ss58, folder_hash)), &query);
        self.send(|| self.http.get(&url), "list trash").await
    }

    /// `GET .../items/{item_id}/files`: one page of an item's files.
    pub async fn item_files(&self, ss58: &str, folder_hash: &str, item_id: &str, offset: u64) -> Result<TrashItemFilesPage, TrashRefusal> {
        let query = [("offset", offset.to_string()), ("limit", LIST_PAGE.to_string())];
        let url = with_query(
            self.url(&format!("{}/items/{}/files", drive_path(ss58, folder_hash), encode(item_id))),
            &query,
        );
        self.send(|| self.http.get(&url), "list trash item files").await
    }

    /// `POST .../restore`: one step; `more` asks for the next.
    pub async fn restore(&self, ss58: &str, folder_hash: &str, body: &RestoreRequest) -> Result<RestoreResult, TrashRefusal> {
        let url = self.url(&format!("{}/restore", drive_path(ss58, folder_hash)));
        self.send(|| self.http.post(&url).json(body), "restore").await
    }

    /// `POST .../delete`: delete items forever.
    pub async fn delete_forever(&self, ss58: &str, folder_hash: &str, item_ids: &[String]) -> Result<DeleteItemsResult, TrashRefusal> {
        let url = self.url(&format!("{}/delete", drive_path(ss58, folder_hash)));
        let body = DeleteItemsRequest { item_ids: item_ids.to_vec() };
        self.send(|| self.http.post(&url).json(&body), "delete forever").await
    }

    /// `POST .../empty`: one step of emptying the drive's Trash.
    pub async fn empty(&self, ss58: &str, folder_hash: &str) -> Result<DeleteItemsResult, TrashRefusal> {
        let url = self.url(&format!("{}/empty", drive_path(ss58, folder_hash)));
        self.send(|| self.http.post(&url).json(&serde_json::json!({})), "empty trash").await
    }
}

/// Percent-encode one query value or path segment.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn with_query(url: String, pairs: &[(&str, String)]) -> String {
    let query: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
    format!("{url}?{}", query.join("&"))
}

/// Read a `NetworkResponse` envelope, or the refusal the body names. A 2xx
/// with an empty body (a bare `204`) reads as the type's default.
async fn read_envelope<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, TrashRefusal> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| TrashRefusal::no_answer())?;
    if !(200..300).contains(&status) {
        return Err(TrashRefusal::from_body(status, &body));
    }
    let body = if body.trim().is_empty() { r#"{"Success":{}}"# } else { body.as_str() };
    match serde_json::from_str::<NetworkResponse<T>>(body) {
        Ok(NetworkResponse::Success(value)) => Ok(value),
        Ok(_) => Err(TrashRefusal::from_body(status, body)),
        Err(e) => {
            tracing::debug!(error = %e, "trash: unreadable answer");
            Err(TrashRefusal {
                status,
                ..TrashRefusal::no_answer()
            })
        }
    }
}
