//! One-click "Copy link" for a file, used by the tray popover's upload rows.
//!
//! The Drive's Share dialog asks how long a link should live and whether it
//! needs a password; a quick action cannot ask anything, so this command
//! settles both the way the capture card's automatic link does: a public link
//! that lasts until it is revoked. Before minting it looks for a link to the
//! same file this device already made and can still rebuild, so pressing the
//! button twice copies the same link rather than leaving a trail of
//! duplicates on the Shared Links page.
//!
//! Minting goes through the same two funnels the Share dialog uses
//! (`share_synced_file` for a file on disk, `create_remote_share_inner` for a
//! cloud-only one), so the eligibility gate, the share-origin sidecar (the
//! Drive's "Shared" badge) and the owner wrap all apply unchanged.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use crate::shares::SqliteShareKeystore;
use crate::shares::client::build_account_client;
use crate::shares::commands::{ShareChoice, console_base_url};
use crate::shares::origin;
use chrono::{DateTime, Duration, Utc};
use hcfs_client::client::share::{ShareSecret, ShareTtl, build_share_url_for};
use serde::Serialize;
use tauri::AppHandle;
use tracing::{info, warn};

/// What the popover shows after a press. A failure is an `Ok` outcome with a
/// sentence written here, so the webview never words a share error itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum QuickLinkOutcome {
    /// The link is on the clipboard. `reused` is true when it was an existing
    /// link rather than a new one.
    #[serde(rename_all = "camelCase")]
    Copied { url: String, reused: bool },
    /// Nothing was copied; `message` says why, in the user's terms.
    Failed { message: String },
}

/// Copy offered when the link exists but the clipboard refused it.
pub const NOT_COPIED: &str = "The link was made, but it couldn't be copied. Open Shared Links to copy it.";

/// An existing link to the file, as far as this device can see it.
#[derive(Debug, Clone)]
pub struct ExistingLink {
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    /// The rebuilt URL, `None` when this device does not hold the key.
    pub url: Option<String>,
    pub is_private: bool,
}

/// A link that expires within this margin is not worth handing out: the
/// recipient would open it after it died.
const MIN_REMAINING: Duration = Duration::hours(1);

/// The newest link worth copying again: public (a password link copied
/// without its password is useless, and the password is never stored), not
/// about to expire, and rebuildable on this device.
#[must_use]
pub fn pick_reusable(links: &[ExistingLink], now: DateTime<Utc>) -> Option<String> {
    links
        .iter()
        .filter(|l| !l.is_private)
        .filter(|l| l.expires_at.is_none_or(|e| e > now + MIN_REMAINING))
        .filter(|l| l.url.is_some())
        .max_by_key(|l| l.created_at)
        .and_then(|l| l.url.clone())
}

/// Two drive-relative paths name the same file. The server stores some paths
/// with a leading slash and the sidecar stores whatever the minting surface
/// passed, so the comparison ignores leading and trailing slashes.
#[must_use]
pub fn same_relative_path(a: &str, b: &str) -> bool {
    a.trim_matches('/') == b.trim_matches('/')
}

/// The sentence for a mint that failed: a refusal Rust already worded (a
/// `Validation`) is shown as is, anything else gets the capture card's link
/// copy, so a transport error's own text never reaches the user.
#[must_use]
pub fn failure_copy(e: &AppError) -> String {
    match e {
        AppError::Validation(message) => message.clone(),
        other => crate::capture::deliver::link_failure_copy(other),
    }
}

/// Links this device made for `(folder_label, relative_path)` that the server
/// still lists. Best effort: a listing failure means "none found", and the
/// caller mints a new link (the mint fails with its own reason if the server
/// is unreachable).
async fn existing_links(state: &AppState, account_id: &str, folder_label: &str, relative_path: &str) -> Result<Vec<ExistingLink>> {
    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let summaries = client.list_shares().await.map_err(|e| AppError::Hcfs(format!("list_shares: {e}")))?;
    let tokens: Vec<&str> = summaries.iter().map(|s| s.share_token.as_str()).collect();
    let owner = account_key(account_id);
    let origins = origin::fetch_for_tokens(pool, &owner, &tokens).await?;
    let matching: Vec<&str> = tokens
        .iter()
        .copied()
        .filter(|t| {
            origins
                .get(*t)
                .is_some_and(|o| o.folder_label == folder_label && same_relative_path(&o.relative_path, relative_path))
        })
        .collect();
    if matching.is_empty() {
        return Ok(Vec::new());
    }
    let keystore = SqliteShareKeystore::new(pool.clone());
    let mut keys = keystore
        .get_many(&matching)
        .map_err(|e| AppError::Hcfs(format!("keystore lookup: {e}")))?;
    super::owner_wrap::sync_file_wraps(state, account_id, &keystore, &mut keys, &matching).await;
    let console_base = console_base_url();
    Ok(summaries
        .iter()
        .filter(|s| matching.contains(&s.share_token.as_str()))
        .map(|s| {
            let secret = keys.get(&s.share_token);
            ExistingLink {
                created_at: s.created_at,
                expires_at: s.expires_at,
                url: secret.map(|secret| build_share_url_for(&console_base, &s.share_token, secret)),
                is_private: secret.is_some_and(ShareSecret::is_private),
            }
        })
        .collect())
}

/// Mint a public, never-expiring link through the Share dialog's funnels.
async fn mint(state: &AppState, account_id: &str, folder_label: &str, relative_path: &str, file_id: Option<&str>) -> Result<String> {
    let link = match file_id {
        Some(id) => {
            crate::shares::commands::create_remote_share_inner(
                state,
                account_id,
                folder_label,
                relative_path,
                id,
                ShareTtl::Never,
                ShareChoice::Public,
                None,
            )
            .await?
        }
        None => {
            crate::shares::commands::share_synced_file(state, account_id, folder_label, relative_path, ShareTtl::Never, ShareChoice::Public, None)
                .await?
        }
    };
    Ok(link.share_url)
}

/// Reuse the file's link or make one, then put it on the clipboard.
///
/// `file_id` is the server file id, passed only for a file with no copy on
/// this device (the Drive's `isCloudOnlyRow`); such a file is shared the way
/// the Share dialog shares it, from a temporary decrypted copy.
///
/// # Errors
///
/// Only for an invalid request (blank drive or path) or no signed-in account;
/// a link that could not be made or copied is a `Failed` outcome.
#[tauri::command]
pub async fn copy_file_share_link(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    folder_label: String,
    relative_path: String,
    file_id: Option<String>,
) -> Result<QuickLinkOutcome> {
    let folder_label = folder_label.trim().to_owned();
    let relative_path = relative_path.trim().trim_matches('/').to_owned();
    if folder_label.is_empty() || relative_path.is_empty() {
        return Err(AppError::Validation("This file can't be shared from here.".into()));
    }
    let file_id = file_id.map(|id| id.trim().to_owned()).filter(|id| !id.is_empty());
    let account_id = state.current_account_id()?;

    let existing = match existing_links(&state, &account_id, &folder_label, &relative_path).await {
        Ok(links) => pick_reusable(&links, Utc::now()),
        Err(e) => {
            warn!(error = %e, "could not look for an existing link; making a new one");
            None
        }
    };
    let (url, reused) = match existing {
        Some(url) => (url, true),
        None => match mint(&state, &account_id, &folder_label, &relative_path, file_id.as_deref()).await {
            Ok(url) => (url, false),
            Err(e) => {
                warn!(error = %e, cloud_only = file_id.is_some(), "quick link could not be made");
                return Ok(QuickLinkOutcome::Failed { message: failure_copy(&e) });
            }
        },
    };
    info!(reused, "quick link ready");

    use tauri_plugin_clipboard_manager::ClipboardExt;
    if let Err(e) = app.clipboard().write_text(url.clone()) {
        warn!(error = %e, "quick link made but not copied");
        return Ok(QuickLinkOutcome::Failed { message: NOT_COPIED.into() });
    }
    Ok(QuickLinkOutcome::Copied { url, reused })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(age_hours: i64, expires_in_hours: Option<i64>, url: Option<&str>, is_private: bool) -> ExistingLink {
        let now = Utc::now();
        ExistingLink {
            created_at: now - Duration::hours(age_hours),
            expires_at: expires_in_hours.map(|h| now + Duration::hours(h)),
            url: url.map(str::to_owned),
            is_private,
        }
    }

    #[test]
    fn reuses_the_newest_public_link_this_device_can_rebuild() {
        let links = [
            link(48, None, Some("old"), false),
            link(1, None, Some("new"), false),
            link(5, Some(100), Some("middle"), false),
        ];
        assert_eq!(pick_reusable(&links, Utc::now()).as_deref(), Some("new"));
    }

    #[test]
    fn never_reuses_a_password_link() {
        // The password is never stored, so the copied link could not be opened.
        let links = [link(1, None, Some("private"), true)];
        assert_eq!(pick_reusable(&links, Utc::now()), None);
    }

    #[test]
    fn skips_a_link_this_device_holds_no_key_for() {
        let links = [link(1, None, None, false), link(9, None, Some("rebuildable"), false)];
        assert_eq!(pick_reusable(&links, Utc::now()).as_deref(), Some("rebuildable"));
    }

    #[test]
    fn skips_a_link_about_to_expire() {
        let now = Utc::now();
        let dying = ExistingLink {
            created_at: now,
            expires_at: Some(now + Duration::minutes(10)),
            url: Some("dying".into()),
            is_private: false,
        };
        let expired = ExistingLink {
            created_at: now,
            expires_at: Some(now - Duration::minutes(1)),
            url: Some("expired".into()),
            is_private: false,
        };
        assert_eq!(pick_reusable(&[dying, expired], now), None);
        assert_eq!(pick_reusable(&[link(1, Some(48), Some("alive"), false)], now).as_deref(), Some("alive"));
    }

    #[test]
    fn no_links_means_mint() {
        assert_eq!(pick_reusable(&[], Utc::now()), None);
    }

    #[test]
    fn paths_match_across_leading_slashes_only() {
        assert!(same_relative_path("/Captures/a.png", "Captures/a.png"));
        assert!(same_relative_path("Captures/a.png", "Captures/a.png/"));
        assert!(!same_relative_path("Captures/a.png", "Captures/b.png"));
        assert!(!same_relative_path("Captures/a.png", "a.png"));
    }

    #[test]
    fn a_worded_refusal_is_shown_as_is_and_transport_text_never_is() {
        assert_eq!(
            failure_copy(&AppError::Validation("File has no usable name".into())),
            "File has no usable name"
        );
        let transport = failure_copy(&AppError::Hcfs(
            "create_share: error sending request: Network unreachable (os error 51)".into(),
        ));
        assert!(!transport.contains("os error"), "{transport}");
        let full = failure_copy(&AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached));
        assert!(!full.is_empty());
    }

    #[test]
    fn outcome_wire_shape_is_tagged_camel_case() {
        let copied = serde_json::to_value(QuickLinkOutcome::Copied {
            url: "https://x/#k=1".into(),
            reused: true,
        })
        .expect("json");
        assert_eq!(copied, serde_json::json!({"status": "copied", "url": "https://x/#k=1", "reused": true}));
        let failed = serde_json::to_value(QuickLinkOutcome::Failed { message: "m".into() }).expect("json");
        assert_eq!(failed, serde_json::json!({"status": "failed", "message": "m"}));
    }
}
