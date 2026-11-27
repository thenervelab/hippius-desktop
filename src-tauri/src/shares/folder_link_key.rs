//! The content key of one of the owner's folder links: the key its files open
//! with, from which its comment key comes. A folder link's NDA text is sealed
//! under that comment key (AAD `<token_hash>:nda-text`, hcfs #1446), exactly
//! as the console seals it (`folder-link-key.ts`), since the share page opens
//! the text with the key it opens the files with.
//!
//! - A drive link's files open with the drive's file key, whatever its URL
//!   carries (the key itself on a legacy `#k=` link, or a link secret whose
//!   envelope seals the key). So the key is derived from the drive, through
//!   the one funnel every other drive operation uses
//!   (`remote::encryption_key_for_label`), never read from the link. The
//!   drive is found by the link's own origin row when it was made here, else
//!   by its wire identity (`owner_ss58`, `folder_hash` on the listing), and a
//!   drive whose identity does not match the row's is never used: a text
//!   sealed under the wrong key would lock every viewer out.
//! - An uploaded copy's files open with a key of its own, which only the link
//!   carries: this device's keystore, or the owner wrap. A password link's key
//!   needs the password, which is never kept, and a link secret's key comes
//!   sealed from the server only to a viewer, so neither is found here.
//!
//! The key never leaves Rust: only what it seals and opens does.

use std::collections::HashMap;

use hcfs_client::client::share::ShareSecret;
use serde::Deserialize;
use tracing::debug;
use zeroize::Zeroizing;

use super::SqliteShareKeystore;
use super::comment_crypto::CommentKey;
use super::folder_insights::OwnerApi;
use super::insights::{KeyUnavailable, REQUEST_TIMEOUT, read_ok, transport};
use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

/// The listing row's fields the key is found from. Read as JSON, since
/// hcfs-client's listing drops `owner_ss58`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub(crate) struct LinkRow {
    #[serde(default)]
    pub token_hash: String,
    #[serde(default)]
    pub folder_hash: String,
    /// The drive's owner; absent on an older server, read as this account.
    #[serde(default)]
    pub owner_ss58: Option<String>,
    /// `"drive"` or `"upload"`; absent on an older server, read as a drive.
    #[serde(default)]
    pub source: Option<String>,
}

impl LinkRow {
    fn is_upload(&self) -> bool {
        self.source.as_deref() == Some("upload")
    }
}

/// Where the key comes from, decided from the row and the secret held here.
#[derive(Debug, PartialEq, Eq)]
enum Found {
    /// The 32-byte key itself.
    Key([u8; 32]),
    /// A drive link: the drive's file key, derived from the drive.
    FromDrive,
    Unavailable(KeyUnavailable),
}

/// The pure half: what the row and this device's secret for it say.
fn from_secret(row: &LinkRow, held: Option<&ShareSecret>) -> Found {
    if row.is_upload() {
        return match held {
            Some(ShareSecret::Public(key)) => Found::Key(*key),
            Some(ShareSecret::Private(_) | ShareSecret::FolderLinkPrivate(_)) => Found::Unavailable(KeyUnavailable::Password),
            _ => Found::Unavailable(KeyUnavailable::NotOnDevice),
        };
    }
    match held {
        // A legacy drive link's fragment is the drive's file key.
        Some(ShareSecret::Public(key)) => Found::Key(*key),
        _ if row.folder_hash.is_empty() => Found::Unavailable(KeyUnavailable::NotOnDevice),
        _ => Found::FromDrive,
    }
}

/// Whether `identity` is the drive the row names. The owner is checked when
/// the server reports one and the drive is somebody else's.
fn identity_matches(row: &LinkRow, account_id: &str, identity: &DriveIdentity) -> bool {
    if identity.wire_folder_hash != row.folder_hash {
        return false;
    }
    match row.owner_ss58.as_deref() {
        Some(owner) if identity.is_member => identity.wire_ss58 == owner,
        Some(owner) => owner == account_id || owner == identity.wire_ss58,
        None => !identity.is_member,
    }
}

/// The label the drive is known by here, or the browse label that names it.
async fn drive_label(state: &AppState, account_id: &str, row: &LinkRow, token: Option<&str>) -> Option<String> {
    let pool = state.pool().ok()?;
    let owner_key = account_key(account_id);
    if let Some(token) = token
        && let Ok(Some((label, _))) = super::origin::folder_origin(pool, &owner_key, token).await
    {
        return Some(label);
    }
    let theirs = row.owner_ss58.as_deref().filter(|owner| *owner != account_id);
    if let Some(owner) = theirs {
        if let Ok(Some(member)) = crate::sync::identity::member_row_for_wire_identity(pool, account_id, owner, &row.folder_hash).await {
            return Some(member.label);
        }
        // Not synced here: the browse label names the drive, and the key
        // funnel finds this account's grant for it.
        return Some(format!("shared:{owner}~{}", row.folder_hash));
    }
    let own: Vec<String> = sqlx::query_scalar("SELECT label FROM sync_paths WHERE owner = ? AND owner_ss58 IS NULL AND wire_folder_hash IS NULL")
        .bind(&owner_key)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    if let Some(label) = own.into_iter().find(|l| crate::sync::mnemonic::folder_hash(l) == row.folder_hash) {
        return Some(label);
    }
    // A drive that is not synced here: the server's own listing names it.
    crate::sync::folders::list_remote_folders_internal(pool, account_id)
        .await
        .ok()?
        .into_iter()
        .find(|f| f.folder_hash == row.folder_hash)
        .map(|f| f.label)
}

/// The drive's file key, when the drive is found here and is the one the row
/// names.
async fn drive_key(
    state: &AppState,
    account_id: &str,
    row: &LinkRow,
    token: Option<&str>,
) -> std::result::Result<Zeroizing<[u8; 32]>, KeyUnavailable> {
    let label = drive_label(state, account_id, row, token).await.ok_or(KeyUnavailable::NotOnDevice)?;
    let pool = state.pool().map_err(|_| KeyUnavailable::NotOnDevice)?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, &label)
        .await
        .map_err(|_| KeyUnavailable::NotOnDevice)?;
    if !identity_matches(row, account_id, &identity) {
        debug!("folder link key: the drive found here is not the link's");
        return Err(KeyUnavailable::NotOnDevice);
    }
    let mnemonic = crate::sync::remote::session_mnemonic(state).map_err(|_| KeyUnavailable::NotOnDevice)?;
    let key = crate::sync::remote::encryption_key_for_label(state, account_id, &label, &mnemonic, &identity)
        .await
        .map_err(|e| {
            debug!(error = %e, "folder link key: the drive's key is not here");
            KeyUnavailable::NotOnDevice
        })?;
    Ok(Zeroizing::new(*key.as_bytes()))
}

/// The owner's listing row for `token_hash`, read as JSON.
async fn listing_row(state: &AppState, account_id: &str, token_hash: &str) -> Result<Option<LinkRow>> {
    let api = OwnerApi::for_account(state, account_id).await?;
    let resp = state
        .api_client
        .get(api.url("folder-shares"))
        .bearer_auth(api.bearer())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("folder links", e))?;
    let rows: Vec<LinkRow> = serde_json::from_str(&read_ok(resp).await?).map_err(|e| AppError::Hcfs(format!("folder links parse failed: {e}")))?;
    Ok(rows.into_iter().find(|r| r.token_hash == token_hash))
}

/// The comment key of the folder link `token_hash`, or why it is not here.
pub(crate) async fn folder_comment_key_for(state: &AppState, account_id: &str, token_hash: &str) -> std::result::Result<CommentKey, KeyUnavailable> {
    let row = match listing_row(state, account_id, token_hash).await {
        Ok(Some(row)) => row,
        Ok(None) => return Err(KeyUnavailable::NotOnDevice),
        Err(e) => {
            debug!(error = %e, "folder link key: the listing could not be read");
            return Err(KeyUnavailable::Unreachable);
        }
    };
    let pool = state.pool().map_err(|_| KeyUnavailable::NotOnDevice)?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let mut secrets: HashMap<String, (String, ShareSecret)> = super::commands::folder_share_secrets_by_hash(&keystore).unwrap_or_default();
    if !secrets.contains_key(token_hash) {
        super::owner_wrap::sync_folder_wraps(state, account_id, &keystore, &mut secrets, &[token_hash.to_string()]).await;
    }
    let held = secrets.get(token_hash).filter(|(_, secret)| !secret.is_file_link());
    let key = match from_secret(&row, held.map(|(_, secret)| secret)) {
        Found::Key(key) => Zeroizing::new(key),
        Found::FromDrive => drive_key(state, account_id, &row, held.map(|(token, _)| token.as_str())).await?,
        Found::Unavailable(why) => return Err(why),
    };
    Ok(CommentKey::derive(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const THEM: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    fn row(source: Option<&str>, owner: Option<&str>) -> LinkRow {
        LinkRow {
            token_hash: "h".repeat(64),
            folder_hash: "0123456789abcdef".into(),
            owner_ss58: owner.map(str::to_string),
            source: source.map(str::to_string),
        }
    }

    #[test]
    fn an_uploaded_copy_opens_only_with_its_own_key() {
        let upload = row(Some("upload"), Some(ME));
        assert_eq!(from_secret(&upload, Some(&ShareSecret::Public([7; 32]))), Found::Key([7; 32]));
        assert_eq!(
            from_secret(&upload, Some(&ShareSecret::Private(vec![1]))),
            Found::Unavailable(KeyUnavailable::Password)
        );
        assert_eq!(
            from_secret(&upload, Some(&ShareSecret::FolderLinkPrivate(vec![1]))),
            Found::Unavailable(KeyUnavailable::Password)
        );
        assert_eq!(
            from_secret(&upload, Some(&ShareSecret::FolderLink([1; 32]))),
            Found::Unavailable(KeyUnavailable::NotOnDevice),
            "a link secret's key is sealed on the server, for viewers"
        );
        assert_eq!(from_secret(&upload, None), Found::Unavailable(KeyUnavailable::NotOnDevice));
    }

    #[test]
    fn a_drive_link_uses_the_drives_key_whatever_its_url_carries() {
        let drive = row(Some("drive"), Some(ME));
        assert_eq!(
            from_secret(&drive, Some(&ShareSecret::Public([9; 32]))),
            Found::Key([9; 32]),
            "a legacy link's fragment is the drive key"
        );
        for secret in [
            ShareSecret::FolderLink([1; 32]),
            ShareSecret::FolderLinkPrivate(vec![1]),
            ShareSecret::Private(vec![1]),
        ] {
            assert_eq!(
                from_secret(&drive, Some(&secret)),
                Found::FromDrive,
                "a password never stands between the owner and the drive key"
            );
        }
        assert_eq!(from_secret(&drive, None), Found::FromDrive, "a link made on another device");
        assert_eq!(
            from_secret(&row(None, None), None),
            Found::FromDrive,
            "an older server's row is a drive link"
        );
        let mut nameless = drive;
        nameless.folder_hash.clear();
        assert_eq!(from_secret(&nameless, None), Found::Unavailable(KeyUnavailable::NotOnDevice));
    }

    #[test]
    fn only_the_drive_the_row_names_is_used() {
        let own = DriveIdentity::own(ME, "0123456789abcdef");
        let member = DriveIdentity {
            wire_ss58: THEM.into(),
            wire_folder_hash: "0123456789abcdef".into(),
            is_member: true,
        };
        assert!(identity_matches(&row(None, Some(ME)), ME, &own));
        assert!(identity_matches(&row(None, None), ME, &own));
        assert!(identity_matches(&row(None, Some(THEM)), ME, &member));
        assert!(
            !identity_matches(&row(None, Some(THEM)), ME, &own),
            "an own drive of the same name is not somebody else's"
        );
        assert!(!identity_matches(&row(None, None), ME, &member));
        assert!(!identity_matches(&row(None, Some(ME)), ME, &DriveIdentity::own(ME, "fedcba9876543210")));
    }

    #[test]
    fn the_listing_row_reads_the_fields_hcfs_client_drops() {
        let rows: Vec<LinkRow> = serde_json::from_str(&format!(
            r#"[{{"token_hash":"{h}","folder_hash":"0123456789abcdef","owner_ss58":"{THEM}","source":"drive","display_name":"x"}},
               {{"token_hash":"b","folder_hash":""}}]"#,
            h = "h".repeat(64)
        ))
        .unwrap();
        assert_eq!(rows[0].owner_ss58.as_deref(), Some(THEM));
        assert!(!rows[0].is_upload());
        assert_eq!(
            rows[1],
            LinkRow {
                token_hash: "b".into(),
                ..LinkRow::default()
            }
        );
    }
}
