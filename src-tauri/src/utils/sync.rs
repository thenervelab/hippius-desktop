use crate::commands::substrate_tx::get_sync_path_internal;
use crate::commands::substrate_tx::SyncPathResult;
use crate::DB_POOL;
use sqlx::Row;

pub async fn get_public_sync_path() -> Result<String, String> {
    match get_sync_path_internal(true).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}

pub async fn get_private_sync_path() -> Result<String, String> {
    match get_sync_path_internal(false).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}

pub async fn is_first_run(scope: &str) -> Result<bool, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;

    // Check if table exists
    let table_exists: Result<Option<(i64,)>, _> = sqlx::query_as(
        "SELECT COUNT(*) as count 
         FROM sqlite_master 
         WHERE type='table' AND name='is_first_run'"
    )
    .fetch_optional(pool)
    .await;

    match table_exists {
        Ok(Some((count,))) if count > 0 => {
            // Table exists → check rows with matching scope
            let row_count: Result<Option<(i64,)>, _> =
                sqlx::query_as("SELECT COUNT(*) FROM is_first_run WHERE scope = ?")
                    .bind(scope)
                    .fetch_optional(pool)
                    .await;

            match row_count {
                Ok(Some((count,))) => {
                    if count > 0 {
                        Ok(false) // already has rows with this scope
                    } else {
                        // Insert first record for this scope
                        sqlx::query(
                            "INSERT INTO is_first_run (id, is_started, is_completed, scope) VALUES (1, TRUE, FALSE, ?)"
                        )
                        .bind(scope)
                        .execute(pool)
                        .await
                        .map_err(|e| format!("Failed to insert default row: {}", e))?;

                        Ok(true)
                    }
                }
                Ok(None) => Err("Failed to count rows in is_first_run".to_string()),
                Err(e) => Err(format!("Failed to query row count: {}", e)),
            }
        }
        Ok(Some((0,))) => Err("Table is_first_run does not exist".to_string()),
        Ok(None) => Err("Failed to check if table exists".to_string()),
        Err(e) => Err(format!("Failed to query sqlite_master: {}", e)),
        _ => Err("Unexpected result when checking table existence".to_string()), // catch-all
    }
}

/// Marks the first run as completed in the database
pub async fn mark_first_run_complete(scope: &str) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or_else(|| "Database pool not initialized".to_string())?;

    // Try to update the existing row with matching scope
    let result = sqlx::query(
        "UPDATE is_first_run 
         SET is_completed = TRUE, last_updated = CURRENT_TIMESTAMP 
         WHERE id = 1 AND scope = ?"
    )
    .bind(scope)
    .execute(pool)
    .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => Ok(()), // Successfully updated
        Ok(_) => Err(format!("No rows found in is_first_run with scope '{}' to mark as complete", scope)),
        Err(e) => Err(format!("Failed to update first run status: {}", e)),
    }
}

pub async fn is_first_run_completed(scope: &str) -> Result<bool, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;

    // Count rows with matching scope
    let row_count: Result<Option<(i64,)>, _> =
        sqlx::query_as("SELECT COUNT(*) FROM is_first_run WHERE scope = ?")
            .bind(scope)
            .fetch_optional(pool)
            .await;

    match row_count {
        Ok(Some((0,))) => Err(format!("No rows found in is_first_run with scope '{}'", scope)),
        Ok(Some((1,))) => {
            // Exactly one row with matching scope → fetch is_completed flag
            let result: Result<Option<(bool,)>, _> =
                sqlx::query_as("SELECT is_completed FROM is_first_run WHERE id = 1 AND scope = ?")
                    .bind(scope)
                    .fetch_optional(pool)
                    .await;

            match result {
                Ok(Some((is_completed,))) => Ok(is_completed),
                Ok(None) => Err("Unexpected error: Row not found after count".to_string()),
                Err(e) => Err(format!("Failed to fetch is_completed flag: {}", e)),
            }
        }
        Ok(Some((count,))) if count > 1 => {
            Err("Multiple rows found in is_first_run for the same scope".to_string())
        }
        Ok(Some((count,))) => {
            // Covers any other unexpected counts (like negatives, which shouldn't happen)
            Err(format!("Unexpected row count in is_first_run: {}", count))
        }
        Ok(None) => Err("Failed to check row count in is_first_run".to_string()),
        Err(e) => Err(format!("Failed to query row count: {}", e)),
    }
}

pub async fn is_sync_completed(scope: &str) -> Result<bool, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;

    let result: Result<Option<(bool,)>, _> = sqlx::query_as(
        "SELECT is_completed FROM is_first_run WHERE id = 1 AND scope = ?"
    )
    .bind(scope)
    .fetch_optional(pool)
    .await;

    match result {
        Ok(Some((is_completed,))) => Ok(is_completed),
        Ok(None) => Err(format!("No row found in is_first_run with id=1 and scope '{}'", scope)),
        Err(e) => Err(format!("Failed to fetch is_completed flag: {}", e)),
    }
}

pub async fn reset_sync_event_state(scope: &str) -> Result<(), String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;

    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    sqlx::query(
        "INSERT INTO is_first_run (scope, is_started, is_completed)
         VALUES (?, TRUE, FALSE)
         ON CONFLICT(scope)
         DO UPDATE SET is_started = TRUE, is_completed = FALSE"
    )
    .bind(scope)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("Failed to update sync state: {}", e))?;

    tx.commit().await.map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}