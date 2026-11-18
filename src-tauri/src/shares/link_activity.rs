//! What the Shared Links table shows about each link's activity: a file
//! link's views and comments and whether it counts views, and a folder
//! link's Insights switch.
//!
//! hcfs-client's listings drop these fields, so they are read here from the
//! same owner listings (`GET /v1/shares`, `GET /v1/folder-shares`), each only
//! on a server that has them:
//!
//! - `settings.insights` on a file link: `share_insights`;
//! - `counts` on a file link (views, people, comments, and what is new since
//!   the owner last looked): `share_listing_counts`. `null` while the link's
//!   Insights are off;
//! - `settings.insights` on a folder link: `folder_share_insights`.
//!
//! Nothing is fetched per row, and a server without any of them is sent no
//! request.

use serde::{Deserialize, Serialize};

use super::folder_insights::OwnerApi;
use super::insights::{REQUEST_TIMEOUT, capabilities_or_none, transport};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// A file link's numbers from the listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCounts {
    pub views: u64,
    pub unique_viewers: u64,
    pub comments: u64,
    /// Something happened since the owner last opened the link's Insights.
    pub new_since_seen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLinkActivity {
    pub share_token: String,
    /// The link's Insights switch; `None` when the server does not say.
    pub insights_on: Option<bool>,
    /// `None` when the server sends no counts for it.
    pub counts: Option<LinkCounts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLinkActivity {
    pub token_hash: String,
    pub insights_on: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkActivity {
    pub files: Vec<FileLinkActivity>,
    pub folders: Vec<FolderLinkActivity>,
}

#[derive(Debug, Deserialize)]
struct WireSettings {
    #[serde(default)]
    insights: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct WireCounts {
    #[serde(default)]
    views: u64,
    #[serde(default)]
    unique_viewers: u64,
    #[serde(default)]
    comments: u64,
    #[serde(default)]
    new_views: u64,
    #[serde(default)]
    new_comments: u64,
}

#[derive(Debug, Deserialize)]
struct WireFileRow {
    #[serde(default)]
    share_token: String,
    #[serde(default)]
    settings: Option<WireSettings>,
    #[serde(default)]
    counts: Option<WireCounts>,
}

#[derive(Debug, Deserialize)]
struct WireFolderRow {
    #[serde(default)]
    token_hash: String,
    #[serde(default)]
    settings: Option<WireSettings>,
}

/// A file listing's activity. `with_counts` is `share_listing_counts`: without
/// it whatever `counts` the rows carry is left out.
fn parse_file_rows(body: &str, with_counts: bool) -> Result<Vec<FileLinkActivity>> {
    let rows: Vec<WireFileRow> = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("share listing parse failed: {e}")))?;
    Ok(rows
        .into_iter()
        .filter(|r| !r.share_token.is_empty())
        .map(|r| FileLinkActivity {
            share_token: r.share_token,
            insights_on: r.settings.and_then(|s| s.insights),
            counts: r.counts.filter(|_| with_counts).map(|c| LinkCounts {
                views: c.views,
                unique_viewers: c.unique_viewers,
                comments: c.comments,
                new_since_seen: c.new_views.saturating_add(c.new_comments) > 0,
            }),
        })
        .collect())
}

fn parse_folder_rows(body: &str) -> Result<Vec<FolderLinkActivity>> {
    let rows: Vec<WireFolderRow> = serde_json::from_str(body).map_err(|e| AppError::Hcfs(format!("folder listing parse failed: {e}")))?;
    Ok(rows
        .into_iter()
        .filter(|r| !r.token_hash.is_empty())
        .map(|r| FolderLinkActivity {
            token_hash: r.token_hash,
            insights_on: r.settings.and_then(|s| s.insights),
        })
        .collect())
}

async fn get_listing(http: &reqwest::Client, api: &OwnerApi, rest: &str) -> Result<String> {
    let resp = http
        .get(api.url(rest))
        .bearer_auth(api.bearer())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("share listing", e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(body)
    } else {
        Err(AppError::Api {
            status: status.as_u16(),
            body,
        })
    }
}

/// Which listings to read, from the server's capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Wanted {
    files: bool,
    counts: bool,
    folders: bool,
}

impl Wanted {
    fn from_caps(caps: &super::capabilities::ServerCapabilities) -> Self {
        Self {
            files: caps.share_insights,
            counts: caps.share_insights && caps.share_listing_counts,
            folders: caps.folder_shares && caps.folder_share_insights,
        }
    }
}

async fn read_activity(http: &reqwest::Client, api: &OwnerApi, wanted: Wanted) -> Result<LinkActivity> {
    let files = async {
        if wanted.files {
            parse_file_rows(&get_listing(http, api, "shares").await?, wanted.counts)
        } else {
            Ok(Vec::new())
        }
    };
    let folders = async {
        if wanted.folders {
            parse_folder_rows(&get_listing(http, api, "folder-shares").await?)
        } else {
            Ok(Vec::new())
        }
    };
    let (files, folders) = tokio::join!(files, folders);
    Ok(LinkActivity {
        files: files?,
        folders: folders?,
    })
}

/// The activity the Shared Links table draws. A decoration of the listings
/// the page already shows, so a server that cannot be asked answers empty.
#[tauri::command]
pub async fn share_link_activity(state: tauri::State<'_, AppState>) -> Result<LinkActivity> {
    let account_id = state.current_account_id()?;
    let wanted = Wanted::from_caps(&capabilities_or_none(&state, &account_id).await);
    if !wanted.files && !wanted.folders {
        return Ok(LinkActivity::default());
    }
    let api = OwnerApi::for_account(&state, &account_id).await?;
    read_activity(&state.api_client, &api, wanted).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::insights::tests::mock;

    const FILES: &str = r#"[
      {"share_token":"a","filename":"x","settings":{"insights":true,"comments":true},"counts":{"views":12,"unique_viewers":7,"comments":3,"reactions":5,"new_views":0,"new_comments":1}},
      {"share_token":"b","settings":{"insights":false},"counts":null},
      {"share_token":"c"}
    ]"#;
    const FOLDERS: &str = r#"[{"token_hash":"h1","settings":{"insights":true}},{"token_hash":"h2"}]"#;

    #[tokio::test]
    async fn both_listings_are_read_with_the_owners_bearer_and_folded() {
        let (base, seen) = mock(|s| (200, if s.path == "/v1/shares" { FILES.into() } else { FOLDERS.into() })).await;
        let wanted = Wanted {
            files: true,
            counts: true,
            folders: true,
        };
        let got = read_activity(&reqwest::Client::new(), &OwnerApi::new(&base, "owner-bearer"), wanted)
            .await
            .unwrap();
        assert_eq!(
            got.files[0],
            FileLinkActivity {
                share_token: "a".into(),
                insights_on: Some(true),
                counts: Some(LinkCounts {
                    views: 12,
                    unique_viewers: 7,
                    comments: 3,
                    new_since_seen: true
                }),
            }
        );
        assert_eq!((got.files[1].insights_on, got.files[1].counts), (Some(false), None));
        assert_eq!((got.files[2].insights_on, got.files[2].counts), (None, None));
        assert_eq!(got.folders[0].insights_on, Some(true));
        assert_eq!(got.folders[1].insights_on, None);
        let mut paths: Vec<_> = seen.lock().unwrap().iter().map(|s| (s.path.clone(), s.auth.clone())).collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                ("/v1/folder-shares".to_string(), Some("Bearer owner-bearer".to_string())),
                ("/v1/shares".to_string(), Some("Bearer owner-bearer".to_string())),
            ]
        );
        // The IPC shape the page reads.
        assert_eq!(
            serde_json::to_value(&got.files[0]).unwrap(),
            serde_json::json!({"shareToken":"a","insightsOn":true,"counts":{"views":12,"uniqueViewers":7,"comments":3,"newSinceSeen":true}})
        );
    }

    #[tokio::test]
    async fn a_server_without_a_feature_is_sent_no_request_for_it() {
        let (base, seen) = mock(|_| (200, FILES.into())).await;
        let wanted = Wanted {
            files: true,
            counts: false,
            folders: false,
        };
        let got = read_activity(&reqwest::Client::new(), &OwnerApi::new(&base, "b"), wanted).await.unwrap();
        assert!(got.files.iter().all(|f| f.counts.is_none()), "no counts without share_listing_counts");
        assert!(got.folders.is_empty());
        assert_eq!(seen.lock().unwrap().len(), 1);

        let caps = crate::shares::capabilities::ServerCapabilities {
            share_insights: true,
            folder_shares: true,
            ..Default::default()
        };
        assert_eq!(
            Wanted::from_caps(&caps),
            Wanted {
                files: true,
                counts: false,
                folders: false
            }
        );
    }

    #[tokio::test]
    async fn a_failed_listing_is_an_error() {
        let (base, _) = mock(|_| (500, "boom".into())).await;
        let wanted = Wanted {
            files: true,
            counts: true,
            folders: false,
        };
        assert!(matches!(
            read_activity(&reqwest::Client::new(), &OwnerApi::new(&base, "b"), wanted).await,
            Err(AppError::Api { status: 500, .. })
        ));
    }
}
