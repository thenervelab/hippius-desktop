//! Sync path CRUD — manages the `sync_paths` SQLite table.
//!
//! Maps local directories to labeled drive slots. Includes overlap validation
//! to prevent conflicting folder hierarchies.

use crate::auth::account_key::account_key;
use crate::error::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::path::Path;
use tracing::{error, info, warn};

/// Parameters for registering or updating a sync folder via IPC.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
    pub account_id: String,
    pub label: Option<String>,
}

/// Parameters for querying sync paths via IPC.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyncPathParams {
    pub is_public: bool,
    pub account_id: Option<String>,
}

/// A configured sync path with its label and pause state.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
    pub label: String,
    pub is_paused: bool,
}

/// Reject a new sync path if it overlaps (is a parent or child of) any existing sync path.
fn validate_no_path_overlap(new_path: &Path, new_label: &str, existing: &[(String, String)]) -> Result<()> {
    let canonical_new = std::fs::canonicalize(new_path).unwrap_or_else(|_| new_path.to_path_buf());

    for (label, path_str) in existing {
        if label == new_label {
            continue;
        }
        let existing_path = Path::new(path_str);
        let canonical_existing = std::fs::canonicalize(existing_path).unwrap_or_else(|_| existing_path.to_path_buf());

        if canonical_new.starts_with(&canonical_existing) {
            return Err(crate::error::AppError::Validation(format!(
                "This folder is already being synced as part of '{label}'"
            )));
        }
        if canonical_existing.starts_with(&canonical_new) {
            return Err(crate::error::AppError::Validation(format!(
                "This folder contains '{label}' which is already being synced separately. \
                 Remove it first if you want to sync the parent folder instead."
            )));
        }
    }
    Ok(())
}

/// Core DB upsert + macOS bookmark logic.
pub(crate) async fn set_sync_path_internal(pool: &SqlitePool, account_id: &str, path: &str, is_public: bool, label: Option<&str>) -> Result<String> {
    let path_type = if is_public { "public" } else { "private" };
    let label = label.unwrap_or("default");
    let timestamp = Utc::now().timestamp();
    let owner = account_key(account_id);

    let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error checking path overlap: {e}")))?;

    let existing: Vec<(String, String)> = rows.iter().map(|r| (r.get("label"), r.get("path"))).collect();

    validate_no_path_overlap(Path::new(path), label, &existing)?;

    if let Ok(Some(legacy_id)) = sqlx::query_scalar::<_, i64>("SELECT id FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1")
        .bind(path_type)
        .fetch_optional(pool)
        .await
        && let Err(e) = sqlx::query("REPLACE INTO sync_paths (id, owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
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
                use crate::utils::bookmarks::store_bookmark;
                if let Err(e) = store_bookmark(pool, path, path_type).await {
                    warn!("Failed to create security-scoped bookmark: {}", e);
                }
            }

            Ok(format!("Sync path for '{path_type}' set successfully."))
        }
        Err(e) => {
            warn!("DB write failed for owner {} type {}: {}", owner, path_type, e);
            Err(crate::error::AppError::Db(e))
        }
    }
}

/// Set or update a sync path for an account, expanding the asset protocol scope.
#[tauri::command]
pub async fn set_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    app_handle: tauri::AppHandle,
    params: SetSyncPathParams,
) -> Result<String> {
    info!(
        "Setting sync path for label '{}': path='{}', is_public={}",
        params.label.as_deref().unwrap_or("default"),
        params.path,
        params.is_public
    );
    // `set_sync_path` is a Tauri command that fires after the user has
    // already authenticated; login flows are the only writers to
    // `AuthInfo`. No need to touch active account state here.
    let pool = state.pool()?;
    let result = set_sync_path_internal(pool, &params.account_id, &params.path, params.is_public, params.label.as_deref()).await?;

    crate::sync::files::allow_asset_directory(&app_handle, &params.path);

    info!("Sync path set successfully for label '{}'", params.label.as_deref().unwrap_or("default"));
    Ok(result)
}

/// Fetch a single sync path by type for the given account.
pub async fn get_sync_path_internal(pool: &SqlitePool, is_public: bool, owner: &str) -> Result<SyncPathResult> {
    let path_type = if is_public { "public" } else { "private" };
    {
        let row = sqlx::query("SELECT path, label, is_paused FROM sync_paths WHERE owner = ? AND type = ? LIMIT 1")
            .bind(owner)
            .bind(path_type)
            .fetch_optional(pool)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("DB error: {e}")))?;

        if let Some(row) = row {
            let paused_int: i32 = row.try_get("is_paused").unwrap_or(0);
            return Ok(SyncPathResult {
                path: row.get("path"),
                is_public,
                label: row.try_get("label").unwrap_or_else(|_| "default".to_string()),
                is_paused: paused_int != 0,
            });
        }
    }

    // Legacy fallback: try migrating an ownerless row
    let legacy_row = sqlx::query("SELECT id, path FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1")
        .bind(path_type)
        .fetch_optional(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error (legacy check): {e}")))?;

    if let Some(legacy) = legacy_row {
        let has_scoped = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_paths WHERE owner = ? AND owner != ''")
            .bind(owner)
            .fetch_one(pool)
            .await
            .unwrap_or(1);

        if has_scoped == 0 {
            let legacy_id: i64 = legacy.get("id");
            let legacy_path: String = legacy.get("path");
            let timestamp = Utc::now().timestamp();

            if let Err(e) = sqlx::query("UPDATE sync_paths SET owner = ?, timestamp = ? WHERE id = ?")
                .bind(owner)
                .bind(timestamp)
                .bind(legacy_id)
                .execute(pool)
                .await
            {
                warn!("Failed to migrate legacy sync path: {e}");
            } else {
                info!("Migrated legacy {path_type} sync path for owner {owner}");
                return Ok(SyncPathResult {
                    path: legacy_path,
                    is_public,
                    label: "default".to_string(),
                    is_paused: false,
                });
            }
        }
    }

    Err(crate::error::AppError::Other(format!("{path_type} sync path not set yet")))
}

/// Fetch a single sync path via IPC.
#[tauri::command]
pub async fn get_sync_path(state: tauri::State<'_, crate::app_state::AppState>, params: GetSyncPathParams) -> Result<SyncPathResult> {
    let Some(account_id) = params.account_id.or_else(|| state.current_account_id().ok()) else {
        return Ok(SyncPathResult {
            path: String::new(),
            is_public: params.is_public,
            label: "default".to_string(),
            is_paused: false,
        });
    };
    let owner = account_key(&account_id);
    get_sync_path_internal(state.pool()?, params.is_public, &owner).await
}

/// Pure helper: pick the first non-conflicting label by appending a numeric
/// suffix when `base` already exists in `existing`.
///
/// Used by `add_local_sync_folder` (`lifecycle.rs`) so the folder-uniqueness
/// loop has exactly one source of truth.
pub(crate) fn generate_unique_label_internal(existing: &std::collections::HashSet<String>, base: &str) -> String {
    let mut label = base.to_string();
    let mut suffix = 2u32;
    while existing.contains(&label) {
        label = format!("{base}-{suffix}");
        suffix += 1;
    }
    label
}

#[cfg(test)]
mod label_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn returns_base_when_no_conflict() {
        let existing = HashSet::new();
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos");
    }

    #[test]
    fn appends_numeric_suffix_on_conflict() {
        let mut existing = HashSet::new();
        existing.insert("Photos".to_string());
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos-2");
    }

    #[test]
    fn keeps_incrementing_until_free() {
        let mut existing = HashSet::new();
        existing.insert("Photos".to_string());
        existing.insert("Photos-2".to_string());
        existing.insert("Photos-3".to_string());
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos-4");
    }
}

/// Set the `is_paused` flag for a sync path in the DB.
pub(crate) async fn set_sync_path_paused(pool: &SqlitePool, account_id: &str, label: &str, paused: bool) -> Result<()> {
    let owner = account_key(account_id);
    let val: i32 = i32::from(paused);

    sqlx::query("UPDATE sync_paths SET is_paused = ? WHERE owner = ? AND label = ?")
        .bind(val)
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await?;

    Ok(())
}

/// Delete a sync path row from the DB without stopping the drive.
pub(crate) async fn remove_sync_path_internal(pool: &SqlitePool, account_id: &str, label: &str) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await?;

    Ok(())
}

/// Remove a sync path and stop the corresponding drive.
#[tauri::command]
pub async fn remove_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<()> {
    info!("Removing sync path for label '{}', account '{}'", label, account_id);
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(&label)
        .execute(pool)
        .await
        .map_err(|e| {
            error!("Failed to remove sync path for label '{}': {}", label, e);
            format!("Failed to remove sync path: {e}")
        })?;

    crate::sync::lifecycle::remove_drive(app, label.clone()).await?;

    info!("Sync path removed and drive torn down for label '{}'", label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(l, p)| (l.to_string(), p.to_string())).collect()
    }

    #[test]
    fn sibling_paths_are_allowed() {
        let existing = pairs(&[("photos", "/home/user/Photos")]);
        assert!(validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing).is_ok());
    }

    #[test]
    fn child_of_existing_path_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already being synced as part of"));
    }

    #[test]
    fn parent_of_existing_path_is_rejected() {
        let existing = pairs(&[("work", "/home/user/Documents/Work")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already being synced separately"));
    }

    #[test]
    fn same_label_skips_self() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        assert!(validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "docs", &existing).is_ok());
    }

    #[test]
    fn exact_same_path_different_label_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents"), "docs2", &existing);
        assert!(result.is_err());
    }

    #[test]
    fn multiple_existing_paths_checked() {
        let existing = pairs(&[
            ("photos", "/home/user/Photos"),
            ("music", "/home/user/Music"),
            ("docs", "/home/user/Documents"),
        ]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing);
        assert!(result.is_err());
    }

    #[test]
    fn empty_existing_always_passes() {
        assert!(validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &[]).is_ok());
    }

    #[test]
    fn error_message_includes_conflicting_label() {
        let existing = pairs(&[("my-photos", "/home/user/Photos")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Photos/Vacation"), "vacation", &existing);
        assert!(result.unwrap_err().to_string().contains("my-photos"));
    }
}
