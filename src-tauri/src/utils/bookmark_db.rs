use sqlx::sqlite::SqlitePool;
use tracing::debug;

#[cfg(target_os = "macos")]
use crate::macos_bookmarks::create_security_scoped_bookmark;

/// Stores a security-scoped bookmark for a path in the database
#[cfg(target_os = "macos")]
pub async fn store_bookmark(pool: &SqlitePool, path: &str, scope_type: &str) -> Result<(), String> {
    let bookmark_data = create_security_scoped_bookmark(path)?;

    sqlx::query(
        "INSERT OR REPLACE INTO security_scoped_bookmarks (path, bookmark_data, scope_type, last_accessed)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(path)
    .bind(&bookmark_data)
    .bind(scope_type)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to store bookmark: {}", e))?;

    debug!("Stored security-scoped bookmark for: {}", path);
    Ok(())
}

// Non-macOS stubs
#[cfg(not(target_os = "macos"))]
pub async fn store_bookmark(
    _pool: &SqlitePool,
    _path: &str,
    _scope_type: &str,
) -> Result<(), String> {
    Ok(())
}
