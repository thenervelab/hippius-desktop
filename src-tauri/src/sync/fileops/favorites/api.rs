//! HTTP calls to hcfs-server's favorites routes.
//!
//! The pinned hcfs-client has no favorites calls, so these are direct
//! `reqwest` calls with `Authorization: Bearer`, as Trash makes its own
//! (`trash::api`). Every function takes the client, base and bearer as
//! values, so `tests/favorites_server_mock.rs` drives the real request and
//! response code with no Tauri runtime.

use super::wire::{FavoriteRefusal, FavoritesPage, LIST_PAGE, MAX_PAGES, SetFavoriteBody, SetFavoriteResult, StarItem};
use hcfs_shared::network::NetworkResponse;
use serde::de::DeserializeOwned;
use std::time::Duration;

/// Bound on one call.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A call is asked again this many times in all when no answer (or a 5xx
/// or 429) arrives. Both routes are safe to repeat: marking twice answers
/// `true`, unmarking twice `false`.
const ATTEMPTS: u32 = 3;

/// Where and as whom favorites calls go.
#[derive(Clone)]
pub struct FavoritesApi {
    pub http: reqwest::Client,
    pub base_url: String,
    pub bearer: String,
}

/// What `GET /favorites` gave.
#[derive(Debug)]
pub enum Listing {
    /// Every page that was read, in order.
    Pages(Vec<FavoritesPage>),
    /// The route is not there (an older server): Starred isn't available.
    Unavailable,
}

impl FavoritesApi {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    async fn send<T: DeserializeOwned>(&self, request: impl Fn() -> reqwest::RequestBuilder, what: &'static str) -> Result<T, FavoriteRefusal> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = match request().bearer_auth(&self.bearer).timeout(CALL_TIMEOUT).send().await {
                Ok(response) => read_envelope(response).await,
                Err(e) => {
                    tracing::debug!(what, error = %e, "favorites: no answer");
                    Err(FavoriteRefusal::no_answer())
                }
            };
            match outcome {
                Err(refusal) if refusal.is_retryable() && attempt < ATTEMPTS => {
                    tokio::time::sleep(Duration::from_millis(300 * u64::from(attempt))).await;
                }
                other => return other,
            }
        }
    }

    /// `PUT /favorites/{owner}/{folder_hash}`: the item's star afterwards.
    pub async fn set(&self, owner: &str, folder_hash: &str, item: &StarItem, favorite: bool) -> Result<bool, FavoriteRefusal> {
        let url = self.url(&format!("/favorites/{}/{}", encode(owner), encode(folder_hash)));
        let body = SetFavoriteBody::new(item, favorite);
        let result: SetFavoriteResult = self.send(|| self.http.put(&url).json(&body), "set favorite").await?;
        Ok(result.favorite)
    }

    /// One page of `GET /favorites/{ss58}`, in the server's own order
    /// (drives, folders and files by name). The Starred page sorts and
    /// searches the whole list until the server can search it (hcfs#1452).
    pub async fn page(&self, ss58: &str, offset: u64) -> Result<FavoritesPage, FavoriteRefusal> {
        let url = format!("{}?offset={offset}&limit={LIST_PAGE}", self.url(&format!("/favorites/{}", encode(ss58))));
        self.send(|| self.http.get(&url), "list favorites").await
    }

    /// Every page of the account's stars, at most [`MAX_PAGES`]: the next
    /// offset moves past every row of the page, and reading stops when the
    /// server says there is no more or a page comes back empty. A `404`
    /// means the server has no Starred.
    pub async fn list_all(&self, ss58: &str) -> Result<Listing, FavoriteRefusal> {
        let mut pages = Vec::new();
        let mut offset = 0u64;
        for _ in 0..MAX_PAGES {
            let page = match self.page(ss58, offset).await {
                Ok(page) => page,
                Err(r) if r.status == 404 => return Ok(Listing::Unavailable),
                Err(r) => return Err(r),
            };
            let read = page.len() as u64;
            let more = page.has_more && read > 0;
            pages.push(page);
            if !more {
                break;
            }
            offset += read;
        }
        Ok(Listing::Pages(pages))
    }
}

/// Percent-encode one path segment.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Read a `NetworkResponse` envelope, or the refusal the body names.
async fn read_envelope<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, FavoriteRefusal> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| FavoriteRefusal::no_answer())?;
    if !(200..300).contains(&status) {
        return Err(FavoriteRefusal::from_body(status, &body));
    }
    match serde_json::from_str::<NetworkResponse<T>>(&body) {
        Ok(NetworkResponse::Success(value)) => Ok(value),
        Ok(_) => Err(FavoriteRefusal::from_body(status, &body)),
        Err(e) => {
            tracing::debug!(error = %e, "favorites: unreadable answer");
            Err(FavoriteRefusal { status, code: None })
        }
    }
}
