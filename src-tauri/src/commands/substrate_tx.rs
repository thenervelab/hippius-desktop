use crate::DB_POOL;
use crate::substrate_client::{
    get_current_wss_endpoint, get_substrate_client, update_wss_endpoint,
};
use crate::utils::account_key::account_key;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use sqlx::Row;

#[subxt::subxt(runtime_metadata_path = "metadata.scale")]
pub mod custom_runtime {}
use custom_runtime::marketplace::calls::types::storage_unpin_request::FileHash;
use custom_runtime::runtime_types::bounded_collections::bounded_vec::BoundedVec;
use custom_runtime::runtime_types::ipfs_pallet::types::FileInput;

#[derive(Deserialize, Debug)]
pub struct FileInputWrapper {
    pub file_hash: Vec<u8>,
    pub file_name: Vec<u8>,
}

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
    pub account_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyncPathParams {
    pub is_public: bool,
    pub account_id: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
}

#[tauri::command]
pub async fn set_sync_path(
    _app_handle: tauri::AppHandle,
    params: SetSyncPathParams,
) -> Result<String, String> {
    crate::utils::sync::set_active_account(&params.account_id);

    let path_type = if params.is_public {
        "public"
    } else {
        "private"
    };
    let timestamp = Utc::now().timestamp();

    if let Some(pool) = DB_POOL.get() {
        let owner = account_key(&params.account_id);

        // Legacy cleanup: if a pre-owner row exists (owner is empty) with the same type, replace it once.
        if let Ok(Some(legacy_id)) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1",
        )
        .bind(path_type)
        .fetch_optional(pool)
        .await
        {
            let _ = sqlx::query(
                "REPLACE INTO sync_paths (id, owner, path, type, timestamp) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(legacy_id)
            .bind(&owner)
            .bind(&params.path)
            .bind(path_type)
            .bind(timestamp)
            .execute(pool)
            .await;
        }

        let res = sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, timestamp) VALUES (?, ?, ?, ?)
             ON CONFLICT(owner, type) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
        )
        .bind(&owner)
        .bind(&params.path)
        .bind(path_type)
        .bind(timestamp)
        .execute(pool)
        .await;

        match res {
            Ok(_) => {
                println!(
                    "[set_sync_path] Sync path for '{}' set successfully in DB.",
                    path_type
                );

                // Create security-scoped bookmark for macOS
                #[cfg(target_os = "macos")]
                {
                    use crate::utils::bookmark_db::store_bookmark;
                    if let Err(e) = store_bookmark(&params.path, path_type).await {
                        eprintln!(
                            "[set_sync_path] Warning: Failed to create security-scoped bookmark: {}",
                            e
                        );
                    }
                }

                Ok(format!("Sync path for '{}' set successfully.", path_type))
            }
            Err(e) => {
                eprintln!(
                    "[set_sync_path] DB write failed for owner {} type {}: {}",
                    owner, path_type, e
                );
                Err(format!("Failed to set sync path: {}", e))
            }
        }
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn transfer_balance_tauri(
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

    let api = get_substrate_client()
        .await
        .map_err(|e| format!("Failed to connect to Substrate node: {e}"))?;

    let tx = custom_runtime::tx()
        .balances()
        .transfer_keep_alive(recipient.into(), amount);

    println!("[Substrate] Submitting balance transfer transaction...");
    let tx_hash = api
        .tx()
        .sign_and_submit_then_watch_default(&tx, &signer)
        .await
        .map_err(|e| format!("Failed to submit transaction: {}", e))?
        .wait_for_finalized_success()
        .await
        .map_err(|e| format!("Transaction failed: {}", e))?
        .extrinsic_hash();

    println!("[Substrate] Transfer submitted with hash: {:?}", tx_hash);

    Ok(format!(
        "Transfer submitted successfully! Finalized in block: {tx_hash}"
    ))
}

pub async fn get_sync_path_internal(
    is_public: bool,
    owner: &str,
) -> Result<SyncPathResult, String> {
    let path_type = if is_public { "public" } else { "private" };
    if let Some(pool) = DB_POOL.get() {
        // Try scoped entry first
        let rec_row = sqlx::query("SELECT path FROM sync_paths WHERE owner = ? AND type = ?")
            .bind(owner)
            .bind(path_type)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error: {}", e))?;

        // If not found, migrate a legacy (owner='') row only when no scoped rows exist yet.
        let path_opt: Option<String> = if let Some(row) = rec_row {
            Some(row.get::<String, _>("path"))
        } else {
            let scoped_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(1) FROM sync_paths WHERE owner != '' AND owner IS NOT NULL",
            )
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
                    let _ = sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND type = ?")
                        .bind(owner)
                        .bind(path_type)
                        .execute(&mut *tx)
                        .await;

                    let _ = sqlx::query(
                        "UPDATE sync_paths SET owner = ? WHERE id = ? AND owner = ''",
                    )
                    .bind(owner)
                    .bind(legacy_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("DB error updating legacy row: {}", e))?;

                    tx.commit()
                        .await
                        .map_err(|e| format!("DB error (commit): {}", e))?;
                    Some(legacy_path)
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

        if let Some(path) = path_opt {
            Ok(SyncPathResult { path, is_public })
        } else {
            Err(format!(
                "Sync path for {} not set yet. Please configure it first.",
                path_type
            ))
        }
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn get_sync_path(params: GetSyncPathParams) -> Result<SyncPathResult, String> {
    let account_id = match params
        .account_id
        .or_else(|| crate::utils::sync::current_account_id().ok())
    {
        Some(id) => id,
        None => {
            return Ok(SyncPathResult {
                path: "".to_string(),
                is_public: params.is_public,
            })
        }
    };
    let owner = account_key(&account_id);
    get_sync_path_internal(params.is_public, &owner).await
}

#[tauri::command]
pub async fn get_wss_endpoint() -> Result<String, String> {
    get_current_wss_endpoint().await
}

#[tauri::command]
pub async fn update_wss_endpoint_command(endpoint: String) -> Result<String, String> {
    update_wss_endpoint(endpoint.clone()).await?;
    Ok(format!("WSS endpoint updated to: {}", endpoint))
}
