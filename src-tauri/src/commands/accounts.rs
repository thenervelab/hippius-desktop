use crate::constants::substrate::WSS_ENDPOINT;
use chrono::Utc;
use sp_core::Pair;
use sp_core::crypto::Ss58Codec;
use sp_core::sr25519;
use sqlx::Row;
use tracing::{error, info, warn};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SyncPathExport {
    pub path: String,
    pub label: String,
}

#[derive(serde::Serialize)]
pub struct ExportDataResult {
    pub sync_paths: Vec<SyncPathExport>,
    pub sub_accounts: Vec<SubAccountExport>,
}

#[derive(serde::Deserialize)]
pub struct ImportDataParams {
    pub sync_paths: Option<Vec<SyncPathExport>>,
    pub sub_accounts: Option<Vec<SubAccountExport>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubAccountExport {
    pub account_id: String,
    pub sub_account_seed_phrase: String,
    pub created_at: Option<String>,
}

#[tauri::command]
pub async fn import_app_data(
    state: tauri::State<'_, crate::app_state::AppState>,
    params: ImportDataParams,
) -> Result<String, String> {
    info!("[Import] Starting app data import...");

    let pool = state.pool()?;

    let mut imported_items = Vec::new();
    let mut skipped_items = Vec::new();
    let timestamp = Utc::now().timestamp();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    // Import sync paths
    if let Some(sync_paths) = params.sync_paths {
        let mut imported_count = 0;
        for sp in sync_paths {
            if sp.path.trim().is_empty() {
                continue;
            }
            info!("Importing sync path: {}, label: {}", sp.path, sp.label);
            let existing: Option<(String,)> =
                sqlx::query_as("SELECT path FROM sync_paths WHERE owner = '' AND label = ?")
                    .bind(&sp.label)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| format!("Failed to check existing sync path: {}", e))?;

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
            .await
            .map_err(|e| format!("Failed to import sync path: {}", e))?;

            imported_count += 1;
        }
        if imported_count > 0 {
            imported_items.push(format!("{} sync path(s)", imported_count));
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
            let exists: Option<(i64,)> =
                sqlx::query_as("SELECT 1 FROM sub_accounts WHERE account_id = ?")
                    .bind(&account.account_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| format!("Failed to check for existing sub-account: {}", e))?;

            if exists.is_some() {
                skipped_items.push(format!("sub-account {} (duplicate)", account.account_id));
                continue;
            }

            let _result = sqlx::query(
                "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase, created_at)
                 VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))",
            )
            .bind(&account.account_id)
            .bind(&account.sub_account_seed_phrase)
            .bind(account.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                format!(
                    "Failed to import sub-account for account ID {}: {}",
                    account.account_id, e
                )
            })?;

            imported_count += 1;
        }

        if imported_count > 0 {
            imported_items.push(format!("{} sub-account(s)", imported_count));
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    let mut message_parts = Vec::new();
    if !imported_items.is_empty() {
        message_parts.push(format!(
            "Successfully imported {}",
            imported_items.join(", ")
        ));
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

#[tauri::command]
pub async fn export_app_data(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<ExportDataResult, String> {
    info!("[Export] Starting app data export...");

    let pool = state.pool()?;

    // Get all sync paths
    let sync_rows = sqlx::query("SELECT path, label FROM sync_paths")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch sync paths: {}", e))?;
    let sync_paths: Vec<SyncPathExport> = sync_rows
        .iter()
        .map(|row| SyncPathExport {
            path: row.get("path"),
            label: row
                .try_get("label")
                .unwrap_or_else(|_| "default".to_string()),
        })
        .collect();

    // Get sub-accounts
    let sub_accounts_rows =
        sqlx::query("SELECT account_id, sub_account_seed_phrase, created_at FROM sub_accounts")
            .fetch_all(pool)
            .await
            .map_err(|e| format!("Failed to fetch sub-accounts: {}", e))?;

    let sub_accounts = sub_accounts_rows
        .into_iter()
        .map(|row| {
            let account_id: String = row.get("account_id");
            let sub_account_seed_phrase: String = row.get("sub_account_seed_phrase");
            let created_at: Option<String> = row.get("created_at");

            SubAccountExport {
                account_id,
                sub_account_seed_phrase,
                created_at,
            }
        })
        .collect::<Vec<_>>();

    info!(
        "Exported {} sub-accounts, {} sync paths",
        sub_accounts.len(),
        sync_paths.len(),
    );

    Ok(ExportDataResult {
        sync_paths,
        sub_accounts,
    })
}

#[tauri::command]
pub async fn reset_app(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), String> {
    info!("[Reset App] Starting app reset...");

    let pool = state.pool()?;

    // Use explicit SQL per table to avoid dynamic table name injection
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

#[tauri::command]
pub async fn get_all_subaccount_addresses(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<Vec<(String, String)>, String> {
    let pool = state.pool()?;

    let sub_accounts = sqlx::query_as::<_, (String, String)>(
        "SELECT account_id, sub_account_seed_phrase FROM sub_accounts",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch sub-accounts: {}", e))?;

    let mut result = Vec::new();

    for (account_id, phrase) in sub_accounts {
        // Convert mnemonic to keypair and get SS58 address
        if let Ok((pair, _seed)) = sr25519::Pair::from_phrase(&phrase, None) {
            let ss58 = pair.public().to_ss58check();
            result.push((account_id, ss58));
        } else {
            warn!(
                "Failed to create keypair from phrase for account_id: {}",
                account_id
            );
        }
    }

    Ok(result)
}
