//! Account management commands for import, export, and app reset.
//!
//! Provides data portability (sync paths, sub-accounts) so users can
//! migrate between devices, and a full reset path that restores the
//! app to a clean state while preserving the default WSS endpoint.

use crate::blockchain::client::WSS_ENDPOINT;
use crate::error::AppError;
use chrono::Utc;
use sp_core::Pair;
use sp_core::crypto::Ss58Codec;
use sp_core::sr25519;
use sqlx::Row;
use tracing::{error, info, warn};

/// A sync path entry for import/export serialization.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SyncPathExport {
    pub path: String,
    pub label: String,
}

/// Combined export bundle containing all portable app data.
#[derive(serde::Serialize)]
pub struct ExportDataResult {
    pub sync_paths: Vec<SyncPathExport>,
    pub sub_accounts: Vec<SubAccountExport>,
}

/// Payload for the import command; each section is optional so users
/// can selectively restore only sync paths or only sub-accounts.
#[derive(serde::Deserialize)]
pub struct ImportDataParams {
    pub sync_paths: Option<Vec<SyncPathExport>>,
    pub sub_accounts: Option<Vec<SubAccountExport>>,
}

/// A sub-account's seed phrase for cross-device backup/restore.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubAccountExport {
    pub account_id: String,
    pub sub_account_seed_phrase: String,
    pub created_at: Option<String>,
}

/// Import sync paths and sub-accounts from an export bundle.
///
/// Runs in a single transaction so partial failures roll back cleanly.
/// Duplicates are skipped (not overwritten) and reported in the result
/// message so the user knows what was already present.
#[tauri::command]
pub async fn import_app_data(state: tauri::State<'_, crate::app_state::AppState>, params: ImportDataParams) -> Result<String, AppError> {
    info!("[Import] Starting app data import...");

    let pool = state.pool()?;

    let mut imported_items = Vec::new();
    let mut skipped_items = Vec::new();
    let timestamp = Utc::now().timestamp();

    let mut tx = pool.begin().await?;

    // Import sync paths
    if let Some(sync_paths) = params.sync_paths {
        let mut imported_count = 0;
        for sp in sync_paths {
            if sp.path.trim().is_empty() {
                continue;
            }
            info!("Importing sync path: {}, label: {}", sp.path, sp.label);
            let existing: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = '' AND label = ?")
                .bind(&sp.label)
                .fetch_optional(&mut *tx)
                .await?;

            if existing.as_ref().map(|p| &p.0) == Some(&sp.path) {
                skipped_items.push(format!("sync path '{}' (duplicate)", sp.label));
                continue;
            }

            sqlx::query(
                "INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES ('', ?, 'private', ?, ?)
                 ON CONFLICT(owner, label) DO UPDATE SET path=excluded.path, timestamp=excluded.timestamp",
            )
            .bind(&sp.path)
            .bind(&sp.label)
            .bind(timestamp)
            .execute(&mut *tx)
            .await?;

            imported_count += 1;
        }
        if imported_count > 0 {
            imported_items.push(format!("{imported_count} sync path(s)"));
        }
    }

    // Import sub-accounts
    if let Some(sub_accounts) = params.sub_accounts {
        let mut imported_count = 0;
        for account in sub_accounts {
            // Validate sub-account seed phrase
            if account.sub_account_seed_phrase.trim().is_empty() {
                skipped_items.push(format!("sub-account {} (empty seed)", account.account_id));
                continue;
            }

            // Check if sub-account already exists
            let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM sub_accounts WHERE account_id = ?")
                .bind(&account.account_id)
                .fetch_optional(&mut *tx)
                .await?;

            if exists.is_some() {
                skipped_items.push(format!("sub-account {} (duplicate)", account.account_id));
                continue;
            }

            // Encrypt the seed phrase if the mnemonic is available.
            let (stored_phrase, enc_version) = {
                let guard = state.auth.lock()?;
                match (guard.mnemonic.as_deref(), guard.substrate_address.as_deref()) {
                    (Some(m), Some(acct)) => {
                        let key = crate::crypto::store::sub_account_key(m, acct);
                        let encrypted = crate::crypto::store::encrypt(&key, &account.sub_account_seed_phrase)?;
                        (encrypted, 1i32)
                    }
                    _ => (account.sub_account_seed_phrase.clone(), 0i32),
                }
            };

            let _result = sqlx::query(
                "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase, encryption_version, created_at)
                 VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))",
            )
            .bind(&account.account_id)
            .bind(&stored_phrase)
            .bind(enc_version)
            .bind(account.created_at)
            .execute(&mut *tx)
            .await?;

            imported_count += 1;
        }

        if imported_count > 0 {
            imported_items.push(format!("{imported_count} sub-account(s)"));
        }
    }

    tx.commit().await?;

    let mut message_parts = Vec::new();
    if !imported_items.is_empty() {
        message_parts.push(format!("Successfully imported {}", imported_items.join(", ")));
    }
    if !skipped_items.is_empty() {
        message_parts.push(format!("Skipped {}", skipped_items.join(", ")));
    }
    let success_message = if message_parts.is_empty() {
        "No new data was imported. All items already exist.".to_string()
    } else {
        message_parts.join("; ")
    };
    info!("[Import] {}", success_message);
    Ok(success_message)
}

/// Export all sync paths and sub-accounts as a portable JSON bundle.
#[tauri::command]
pub async fn export_app_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<ExportDataResult, AppError> {
    info!("[Export] Starting app data export...");

    let pool = state.pool()?;

    // Get all sync paths
    let sync_rows = sqlx::query("SELECT path, label FROM sync_paths").fetch_all(pool).await?;
    let sync_paths: Vec<SyncPathExport> = sync_rows
        .iter()
        .map(|row| SyncPathExport {
            path: row.get("path"),
            label: row.try_get("label").unwrap_or_else(|_| "default".to_string()),
        })
        .collect();

    // Get sub-accounts
    let sub_accounts_rows =
        sqlx::query("SELECT account_id, sub_account_seed_phrase, COALESCE(encryption_version, 0) as enc_ver, created_at FROM sub_accounts")
            .fetch_all(pool)
            .await?;

    let mnemonic_and_acct = {
        let guard = state.auth.lock()?;
        match (guard.mnemonic.as_deref().map(String::from), guard.substrate_address.clone()) {
            (Some(m), Some(a)) => Some((m, a)),
            _ => None,
        }
    };

    let sub_accounts = sub_accounts_rows
        .into_iter()
        .filter_map(|row| {
            let account_id: String = row.get("account_id");
            let raw_phrase: String = row.get("sub_account_seed_phrase");
            let enc_ver: i32 = row.get("enc_ver");
            let created_at: Option<String> = row.get("created_at");

            let phrase = match enc_ver {
                0 => raw_phrase,
                1 => {
                    let (m, acct) = mnemonic_and_acct.as_ref()?;
                    let key = crate::crypto::store::sub_account_key(m, acct);
                    match crate::crypto::store::decrypt(&key, &raw_phrase) {
                        Ok(p) => (*p).clone(),
                        Err(e) => {
                            warn!("Failed to decrypt sub-account {account_id}: {e}");
                            return None;
                        }
                    }
                }
                v => {
                    warn!("Unknown encryption_version {v} for sub-account {account_id}");
                    return None;
                }
            };

            Some(SubAccountExport {
                account_id,
                sub_account_seed_phrase: phrase,
                created_at,
            })
        })
        .collect::<Vec<_>>();

    info!("Exported {} sub-accounts, {} sync paths", sub_accounts.len(), sync_paths.len(),);

    Ok(ExportDataResult { sync_paths, sub_accounts })
}

/// Wipe user data (sync paths, sub-accounts) and restore the default
/// WSS endpoint. Non-fatal table-clear errors are logged but do not
/// abort the reset so the app reaches a usable state regardless.
#[tauri::command]
pub async fn reset_app(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), AppError> {
    info!("[Reset App] Starting app reset...");

    let pool = state.pool()?;

    for (table, query) in [
        ("sync_paths", "DELETE FROM sync_paths"),
        ("wss_endpoint", "DELETE FROM wss_endpoint"),
        ("sub_accounts", "DELETE FROM sub_accounts"),
    ] {
        if let Err(e) = sqlx::query(query).execute(pool).await {
            error!("[Reset App] Failed to clear table {}: {}", table, e);
        }
    }

    info!("[Reset App] Restoring default WSS endpoint...");
    if let Err(e) = sqlx::query("INSERT OR REPLACE INTO wss_endpoint (id, endpoint) VALUES (1, ?)")
        .bind(WSS_ENDPOINT)
        .execute(pool)
        .await
    {
        error!("[Reset App] Failed to restore default WSS endpoint: {}", e);
    }

    info!("[Reset App] App reset completed.");
    Ok(())
}

/// Derive SS58 addresses from all stored sub-account seed phrases.
///
/// Returns `(account_id, ss58_address)` pairs. Sub-accounts with
/// invalid mnemonics are logged and silently skipped.
#[tauri::command]
pub async fn get_all_subaccount_addresses(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Vec<(String, String)>, AppError> {
    let pool = state.pool()?;

    let mnemonic_and_acct = {
        let guard = state.auth.lock()?;
        match (guard.mnemonic.as_deref().map(String::from), guard.substrate_address.clone()) {
            (Some(m), Some(a)) => Some((m, a)),
            _ => None,
        }
    };

    let sub_accounts = sqlx::query("SELECT account_id, sub_account_seed_phrase, COALESCE(encryption_version, 0) as enc_ver FROM sub_accounts")
        .fetch_all(pool)
        .await?;

    let mut result = Vec::new();

    for row in sub_accounts {
        let account_id: String = row.get("account_id");
        let raw_phrase: String = row.get("sub_account_seed_phrase");
        let enc_ver: i32 = row.get("enc_ver");

        let phrase = match enc_ver {
            0 => raw_phrase,
            1 => {
                let Some((ref m, ref acct)) = mnemonic_and_acct else {
                    warn!("Cannot decrypt sub-account {account_id} — mnemonic unavailable");
                    continue;
                };
                let key = crate::crypto::store::sub_account_key(m, acct);
                match crate::crypto::store::decrypt(&key, &raw_phrase) {
                    Ok(p) => (*p).clone(),
                    Err(e) => {
                        warn!("Failed to decrypt sub-account {account_id}: {e}");
                        continue;
                    }
                }
            }
            v => {
                warn!("Unknown encryption_version {v} for sub-account {account_id}");
                continue;
            }
        };

        if let Ok((pair, _seed)) = sr25519::Pair::from_phrase(&phrase, None) {
            let ss58 = pair.public().to_ss58check();
            result.push((account_id, ss58));
        } else {
            warn!("Failed to create keypair from phrase for account_id: {account_id}");
        }
    }

    Ok(result)
}
