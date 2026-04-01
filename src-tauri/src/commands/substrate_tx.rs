//! Substrate transaction helpers, runtime type bindings, and sync path management.
//!
//! Houses the `subxt`-generated [`custom_runtime`] module (from `metadata.scale`)
//! which provides type-safe access to all Hippius chain pallets. This module is
//! re-exported and used by [`super::blockchain`] for staking and balance queries.
//!
//! Also contains sync path CRUD commands (set, get, remove, pause) that manage
//! the `sync_paths` SQLite table. Sync paths map a local directory to a labeled
//! drive slot, with overlap validation to prevent conflicting folder hierarchies.

use crate::substrate_client::{
    get_current_wss_endpoint, get_substrate_client, update_wss_endpoint,
};
use crate::utils::account_key::account_key;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::path::Path;
use tracing::{debug, error, info, warn};

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;

/// Frontend-friendly wrapper for file pin requests, converted to the
/// Substrate runtime's [`FileInput`] type before submission.
#[derive(Deserialize, Debug)]
pub struct FileInputWrapper {
    pub file_hash: Vec<u8>,
    pub file_name: Vec<u8>,
}

/// Frontend-friendly wrapper for file unpin requests.
#[derive(Deserialize, Debug)]
pub struct FileHashWrapper {
    pub file_hash: Vec<u8>,
}

impl TryFrom<FileHashWrapper> for FileHash {
    type Error = String;

    fn try_from(wrapper: FileHashWrapper) -> Result<Self, Self::Error> {
        if wrapper.file_hash.len() > 350u32 as usize {
            return Err(format!(
                "File hash length {} exceeds maximum allowed length {}",
                wrapper.file_hash.len(),
                350u32
            ));
        }
        Ok(BoundedVec(wrapper.file_hash))
    }
}

impl From<FileInputWrapper> for FileInput {
    fn from(wrapper: FileInputWrapper) -> Self {
        FileInput {
            file_hash: wrapper.file_hash,
            file_name: wrapper.file_name,
        }
    }
}

/// Parameters for registering or updating a sync folder via IPC.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
    pub account_id: String,
    pub label: Option<String>,
}

/// Parameters for querying sync paths via IPC.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyncPathParams {
    pub is_public: bool,
    pub account_id: Option<String>,
}

/// A configured sync path with its label and pause state.
#[derive(Serialize, Debug)]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
    pub label: String,
    pub is_paused: bool,
}

/// Reject a new sync path if it overlaps (is a parent or child of) any existing sync path.
///
/// Prevents data duplication and conflict: syncing `/Documents` and
/// `/Documents/Work` simultaneously would cause the same files to be
/// tracked by two drives.
fn validate_no_path_overlap(
    new_path: &Path,
    new_label: &str,
    existing: &[(String, String)],
) -> Result<(), String> {
    let canonical_new = std::fs::canonicalize(new_path).unwrap_or_else(|_| new_path.to_path_buf());

    for (label, path_str) in existing {
        if label == new_label {
            continue;
        }
        let existing_path = Path::new(path_str);
        let canonical_existing =
            std::fs::canonicalize(existing_path).unwrap_or_else(|_| existing_path.to_path_buf());

        if canonical_new.starts_with(&canonical_existing) {
            return Err(format!(
                "This folder is already being synced as part of '{}'",
                label
            ));
        }
        if canonical_existing.starts_with(&canonical_new) {
            return Err(format!(
                "This folder contains '{}' which is already being synced separately. \
                 Remove it first if you want to sync the parent folder instead.",
                label
            ));
        }
    }
    Ok(())
}

/// Core DB upsert + macOS bookmark logic, shared by `set_sync_path` and `restore_remote_folders`.
///
/// On macOS, also creates a security-scoped bookmark so the app retains
/// access to the directory across restarts without re-prompting the user.
pub(crate) async fn set_sync_path_internal(
    pool: &SqlitePool,
    account_id: &str,
    path: &str,
    is_public: bool,
    label: Option<&str>,
) -> Result<String, String> {
    let path_type = if is_public { "public" } else { "private" };
    let label = label.unwrap_or("default");
    let timestamp = Utc::now().timestamp();
    let owner = account_key(account_id);

    let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("DB error checking path overlap: {e}"))?;

    let existing: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.get("label"), r.get("path")))
        .collect();

    validate_no_path_overlap(Path::new(path), label, &existing)?;

    // Legacy cleanup: if a pre-owner row exists (owner is empty) with the same type, replace it once.
    if let Ok(Some(legacy_id)) = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1",
    )
    .bind(path_type)
    .fetch_optional(pool)
    .await
    {
        if let Err(e) = sqlx::query(
            "REPLACE INTO sync_paths (id, owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(legacy_id)
        .bind(&owner)
        .bind(path)
        .bind(path_type)
        .bind(label)
        .bind(timestamp)
        .execute(pool)
        .await
        {
            warn!("Failed to replace legacy sync_paths row: {e}");
        }
    }

    let res = sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner, label) DO UPDATE SET path=excluded.path, type=excluded.type, timestamp=excluded.timestamp",
    )
    .bind(&owner)
    .bind(path)
    .bind(path_type)
    .bind(label)
    .bind(timestamp)
    .execute(pool)
    .await;

    match res {
        Ok(_) => {
            info!("Sync path for '{}' set successfully in DB", path_type);

            #[cfg(target_os = "macos")]
            {
                use crate::utils::bookmark_db::store_bookmark;
                if let Err(e) = store_bookmark(pool, path, path_type).await {
                    warn!("Failed to create security-scoped bookmark: {}", e);
                }
            }

            Ok(format!("Sync path for '{}' set successfully.", path_type))
        }
        Err(e) => {
            warn!(
                "DB write failed for owner {} type {}: {}",
                owner, path_type, e
            );
            Err(format!("Failed to set sync path: {}", e))
        }
    }
}

/// Set or update a sync path for an account, expanding the asset protocol scope.
#[tauri::command]
pub async fn set_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    app_handle: tauri::AppHandle,
    params: SetSyncPathParams,
) -> Result<String, String> {
    info!(
        "Setting sync path for label '{}': path='{}', is_public={}",
        params.label.as_deref().unwrap_or("default"),
        params.path,
        params.is_public
    );
    crate::utils::sync::set_active_account(&*state, &params.account_id);
    let pool = state.pool()?;
    let result = set_sync_path_internal(
        pool,
        &params.account_id,
        &params.path,
        params.is_public,
        params.label.as_deref(),
    )
    .await?;

    crate::commands::file_commands::allow_asset_directory(&app_handle, &params.path);

    info!(
        "Sync path set successfully for label '{}'",
        params.label.as_deref().unwrap_or("default")
    );
    Ok(result)
}

/// Legacy transfer command that accepts a raw seed phrase.
///
/// Prefer [`super::blockchain::transfer_balance`] which uses the in-memory
/// keypair instead of requiring the seed to be passed over IPC.
#[tauri::command]
pub async fn transfer_balance_tauri(
    state: tauri::State<'_, crate::app_state::AppState>,
    sender_seed: String,
    recipient_address: String,
    amount: String,
) -> Result<String, String> {
    use sp_core::{Pair, crypto::Ss58Codec, sr25519};
    use subxt::tx::PairSigner;

    let amount: u128 = amount
        .parse()
        .map_err(|e| format!("Invalid amount: {}", e))?;

    let pair = sr25519::Pair::from_string(&sender_seed, None)
        .map_err(|e| format!("Failed to create signer pair: {e:?}"))?;
    let signer = PairSigner::new(pair);

    let recipient = sp_core::crypto::AccountId32::from_ss58check(&recipient_address)
        .map_err(|e| format!("Invalid recipient address: {e:?}"))?;

    let api = get_substrate_client(&state)
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    let tx = custom_runtime::tx()
        .balances()
        .transfer_keep_alive(recipient.into(), amount);

    info!("Submitting balance transfer transaction...");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();

    info!("Transfer submitted with hash: {:?}", tx_hash);

    Ok(format!(
        "Transfer submitted successfully! Finalized in block: {tx_hash}"
    ))
}

/// Fetch a single sync path by type for the given account.
///
/// Falls back to migrating a legacy (ownerless) row if no scoped row exists
/// and no other scoped rows are present for this account.
pub async fn get_sync_path_internal(
    pool: &SqlitePool,
    is_public: bool,
    owner: &str,
) -> Result<SyncPathResult, String> {
    let path_type = if is_public { "public" } else { "private" };
    {
        let rec_row =
            sqlx::query("SELECT path, label FROM sync_paths WHERE owner = ? AND type = ?")
                .bind(owner)
                .bind(path_type)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("DB error: {}", e))?;

        let path_label_opt: Option<(String, String)> = if let Some(row) = rec_row {
            let label: String = row
                .try_get("label")
                .unwrap_or_else(|_| "default".to_string());
            Some((row.get::<String, _>("path"), label))
        } else {
            let scoped_count: i64 =
                sqlx::query_scalar("SELECT COUNT(1) FROM sync_paths WHERE owner = ?")
                    .bind(owner)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(0);

            if scoped_count == 0 {
                let mut tx = pool
                    .begin()
                    .await
                    .map_err(|e| format!("DB error (tx begin): {}", e))?;

                let legacy = sqlx::query_as::<_, (i64, String)>(
                    "SELECT id, path FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1",
                )
                .bind(path_type)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| format!("DB error: {}", e))?;

                if let Some((legacy_id, legacy_path)) = legacy {
                    if let Err(e) =
                        sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND type = ?")
                            .bind(owner)
                            .bind(path_type)
                            .execute(&mut *tx)
                            .await
                    {
                        warn!("Failed to delete scoped sync_paths during migration: {e}");
                    }

                    let _ =
                        sqlx::query("UPDATE sync_paths SET owner = ? WHERE id = ? AND owner = ''")
                            .bind(owner)
                            .bind(legacy_id)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| format!("DB error updating legacy row: {}", e))?;

                    tx.commit()
                        .await
                        .map_err(|e| format!("DB error (commit): {}", e))?;
                    Some((legacy_path, "default".to_string()))
                } else {
                    tx.commit()
                        .await
                        .map_err(|e| format!("DB error (commit): {}", e))?;
                    None
                }
            } else {
                None
            }
        };

        if let Some((path, label)) = path_label_opt {
            Ok(SyncPathResult {
                path,
                is_public,
                label,
                is_paused: false,
            })
        } else {
            Err(format!(
                "Sync path for {} not set yet. Please configure it first.",
                path_type
            ))
        }
    }
}

/// Fetch a single sync path by public/private type for the current account.
#[tauri::command]
pub async fn get_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    params: GetSyncPathParams,
) -> Result<SyncPathResult, String> {
    let account_id = match params
        .account_id
        .or_else(|| crate::utils::sync::current_account_id(&*state).ok())
    {
        Some(id) => id,
        None => {
            return Ok(SyncPathResult {
                path: "".to_string(),
                is_public: params.is_public,
                label: "default".to_string(),
                is_paused: false,
            });
        }
    };
    let owner = account_key(&account_id);
    get_sync_path_internal(state.pool()?, params.is_public, &owner).await
}

/// Fetch all sync paths for the current account.
#[tauri::command]
pub async fn get_all_sync_paths(
    state: tauri::State<'_, crate::app_state::AppState>,
    params: GetSyncPathParams,
) -> Result<Vec<SyncPathResult>, String> {
    let account_id = match params
        .account_id
        .or_else(|| crate::utils::sync::current_account_id(&*state).ok())
    {
        Some(id) => id,
        None => return Ok(Vec::new()),
    };
    let owner = account_key(&account_id);

    let pool = state.pool()?;
    let rows = sqlx::query("SELECT path, type, label, is_paused FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("DB error: {}", e))?;

    let results: Vec<SyncPathResult> = rows
        .iter()
        .map(|row| {
            let path_type: String = row.get("type");
            let paused_int: i32 = row.try_get("is_paused").unwrap_or(0);
            SyncPathResult {
                path: row.get("path"),
                is_public: path_type == "public",
                label: row
                    .try_get("label")
                    .unwrap_or_else(|_| "default".to_string()),
                is_paused: paused_int != 0,
            }
        })
        .collect();

    info!(
        "Retrieved {} sync path(s) for account '{}'",
        results.len(),
        account_id
    );
    for sp in &results {
        debug!(
            "  Sync path: label='{}', path='{}', is_public={}",
            sp.label, sp.path, sp.is_public
        );
    }

    Ok(results)
}

/// Set the `is_paused` flag for a sync path in the DB.
pub(crate) async fn set_sync_path_paused(
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    paused: bool,
) -> Result<(), String> {
    let owner = account_key(account_id);
    let val: i32 = if paused { 1 } else { 0 };

    sqlx::query("UPDATE sync_paths SET is_paused = ? WHERE owner = ? AND label = ?")
        .bind(val)
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update is_paused: {e}"))?;

    Ok(())
}

/// Delete a sync path row from the DB without stopping the drive.
///
/// Used for rollback when `initialize_sync` fails after the path was inserted.
pub(crate) async fn remove_sync_path_internal(
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
) -> Result<(), String> {
    let owner = account_key(account_id);

    sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to remove sync path: {}", e))?;

    Ok(())
}

/// Remove a sync path and stop the corresponding drive.
#[tauri::command]
pub async fn remove_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<(), String> {
    info!(
        "Removing sync path for label '{}', account '{}'",
        label, account_id
    );
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(&label)
        .execute(pool)
        .await
        .map_err(|e| {
            error!("Failed to remove sync path for label '{}': {}", label, e);
            format!("Failed to remove sync path: {}", e)
        })?;

    crate::commands::syncing::stop_drive(app, label.clone()).await?;

    info!("Sync path removed and drive stopped for label '{}'", label);
    Ok(())
}

/// Fetch the current WSS endpoint (from user preferences or default).
#[tauri::command]
pub async fn get_wss_endpoint(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<String, String> {
    get_current_wss_endpoint(state.pool()?).await
}

/// Update the WSS endpoint used for Substrate RPC connections.
#[tauri::command]
pub async fn update_wss_endpoint_command(
    state: tauri::State<'_, crate::app_state::AppState>,
    endpoint: String,
) -> Result<String, String> {
    update_wss_endpoint(&state, endpoint.clone()).await?;
    Ok(format!("WSS endpoint updated to: {}", endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(l, p)| (l.to_string(), p.to_string()))
            .collect()
    }

    #[test]
    fn sibling_paths_are_allowed() {
        let existing = pairs(&[("photos", "/home/user/Photos")]);
        assert!(
            validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing).is_ok()
        );
    }

    #[test]
    fn child_of_existing_path_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result =
            validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("already being synced as part of")
        );
    }

    #[test]
    fn parent_of_existing_path_is_rejected() {
        let existing = pairs(&[("work", "/home/user/Documents/Work")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("already being synced separately")
        );
    }

    #[test]
    fn same_label_skips_self() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        // Re-setting the same label to a child path should be allowed (it's an update)
        assert!(
            validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "docs", &existing)
                .is_ok()
        );
    }

    #[test]
    fn exact_same_path_different_label_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result =
            validate_no_path_overlap(Path::new("/home/user/Documents"), "docs2", &existing);
        // starts_with returns true for equal paths, so this is caught as child-of-existing
        assert!(result.is_err());
    }

    #[test]
    fn multiple_existing_paths_checked() {
        let existing = pairs(&[
            ("photos", "/home/user/Photos"),
            ("music", "/home/user/Music"),
            ("docs", "/home/user/Documents"),
        ]);
        // Child of third entry
        let result =
            validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing);
        assert!(result.is_err());
    }

    #[test]
    fn empty_existing_always_passes() {
        assert!(validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &[]).is_ok());
    }

    #[test]
    fn error_message_includes_conflicting_label() {
        let existing = pairs(&[("my-photos", "/home/user/Photos")]);
        let result = validate_no_path_overlap(
            Path::new("/home/user/Photos/Vacation"),
            "vacation",
            &existing,
        );
        assert!(result.unwrap_err().contains("my-photos"));
    }
}
