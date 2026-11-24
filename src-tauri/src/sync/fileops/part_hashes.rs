//! The Arion hash of every part of a file stored in parts.
//!
//! A file whose ciphertext does not fit one 8 MiB transport chunk is stored
//! as several parts. The server leaves its `arion_hash` empty and lists the
//! parts in `chunk_hashes`, each its own object with its own page on the
//! File Tracker. The listing the app keeps carries one hash per file (the
//! first part, `arion_cid`), so File Details asks for the full list here
//! when it opens a large file.

use hcfs_shared::network::RemoteFileEntry;
use sqlx::sqlite::SqlitePool;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

/// State rows per page while locating the file.
const STATE_PAGE: u32 = 500;

/// Pages to walk before giving up, so one panel open can never turn into an
/// unbounded scan of a very large drive. Past this the panel keeps the one
/// hash it already has.
const MAX_STATE_PAGES: u32 = 40;

/// The usable part hashes of a listing row, in order: trimmed, without
/// empty entries or the server's `"pending"` marker.
///
/// Empty for a file stored whole (it has `arion_hash` instead), and for a
/// file stored as ONE part, whose single hash the listing already carries.
pub fn usable_part_hashes(entry: &RemoteFileEntry) -> Vec<String> {
    let parts: Vec<String> = entry
        .chunk_hashes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|h| h.trim())
        .filter(|h| !h.is_empty() && *h != "pending")
        .map(str::to_string)
        .collect();
    if parts.len() > 1 { parts } else { Vec::new() }
}

/// A path id as sent by the frontend (64 hex characters) as the 32 bytes
/// the server lists.
pub fn parse_path_hash(hex_str: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(hex_str.trim()).map_err(|_| AppError::Validation("Not a file id.".into()))?;
    bytes.try_into().map_err(|_| AppError::Validation("Not a file id.".into()))
}

/// Walk the drive's state until the row for `path_hash` turns up.
async fn find_entry(client: &hcfs_client::client::HcfsClient, identity: &DriveIdentity, path_hash: &[u8; 32]) -> Result<Option<RemoteFileEntry>> {
    let mut offset = 0u32;
    for _ in 0..MAX_STATE_PAGES {
        let page = client
            .get_state(&identity.wire_ss58, &identity.wire_folder_hash, offset, STATE_PAGE, None)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not read the drive: {e}")))?;
        let returned = page.files.len();
        if let Some(found) = page.files.into_iter().find(|f| &f.path_hash == path_hash) {
            return Ok(Some(found));
        }
        if !page.has_more || returned == 0 {
            return Ok(None);
        }
        offset = offset.saturating_add(returned as u32);
    }
    Ok(None)
}

/// The body of [`get_file_part_hashes`], without the Tauri state.
pub async fn file_part_hashes_inner(pool: &SqlitePool, account_id: &str, identity: &DriveIdentity, path_hash: &[u8; 32]) -> Result<Vec<String>> {
    let client = super::remote::build_client(pool, account_id, identity).await?;
    Ok(find_entry(&client, identity, path_hash)
        .await?
        .as_ref()
        .map(usable_part_hashes)
        .unwrap_or_default())
}

/// Every part hash of the file at `path_hash` in drive `label`, in order.
///
/// Empty when the file is stored whole or as one part, when the server has
/// not listed its parts yet, or when it is not in the first
/// `MAX_STATE_PAGES` pages: in each case File Details shows the single hash
/// it already has.
#[tauri::command]
pub async fn get_file_part_hashes(state: tauri::State<'_, AppState>, account_id: String, label: String, path_hash: String) -> Result<Vec<String>> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let path_hash = parse_path_hash(&path_hash)?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    file_part_hashes_inner(pool, &account_id, &identity, &path_hash).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(chunk_hashes: Option<Vec<&str>>) -> RemoteFileEntry {
        let mut e: RemoteFileEntry = serde_json::from_value(serde_json::json!({
            "path_hash": vec![0u8; 32],
            "salted_hash": vec![0u8; 32],
            "size_bytes": 0,
            "revision_seq": 1,
            "revision_id": vec![0u8; 32],
            "encrypted_path": [],
            "file_name": null,
            "arion_hash": null,
            "chunk_hashes": null,
            "created_at": 0,
            "updated_at": 0
        }))
        .expect("a minimal listing row");
        e.chunk_hashes = chunk_hashes.map(|v| v.into_iter().map(str::to_string).collect());
        e
    }

    #[test]
    fn a_file_in_parts_lists_every_part_in_order() {
        let e = entry(Some(vec!["aaa", " bbb ", "ccc"]));
        assert_eq!(usable_part_hashes(&e), vec!["aaa", "bbb", "ccc"]);
    }

    #[test]
    fn empty_and_pending_parts_are_dropped() {
        let e = entry(Some(vec!["aaa", "", "pending", "ddd"]));
        assert_eq!(usable_part_hashes(&e), vec!["aaa", "ddd"]);
    }

    /// One part is the hash the listing already carries, so there is no
    /// list to show.
    #[test]
    fn a_file_stored_whole_or_as_one_part_has_no_list() {
        assert!(usable_part_hashes(&entry(None)).is_empty());
        assert!(usable_part_hashes(&entry(Some(vec![]))).is_empty());
        assert!(usable_part_hashes(&entry(Some(vec!["aaa"]))).is_empty());
        assert!(usable_part_hashes(&entry(Some(vec!["aaa", "pending"]))).is_empty());
    }

    #[test]
    fn a_path_id_must_be_32_bytes_of_hex() {
        let hex64 = "ab".repeat(32);
        assert_eq!(parse_path_hash(&hex64).expect("valid"), [0xab; 32]);
        assert!(parse_path_hash("zz").is_err());
        assert!(parse_path_hash(&"ab".repeat(31)).is_err());
        assert!(parse_path_hash("").is_err());
    }
}
