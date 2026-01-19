// use crate::DB_POOL;

#[cfg(target_os = "macos")]
use crate::macos_bookmarks::{
    create_security_scoped_bookmark, resolve_security_scoped_bookmark,
    stop_accessing_security_scoped_resource,
};

/// Stores a security-scoped bookmark for a path in the database
#[cfg(target_os = "macos")]
pub async fn store_bookmark(path: &str, scope_type: &str) -> Result<(), String> {
    let bookmark_data = create_security_scoped_bookmark(path)?;
    
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    
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
    
    println!("[Bookmarks] Stored security-scoped bookmark for: {}", path);
    Ok(())
}

/// Retrieves and activates a security-scoped bookmark for a path
/// Returns true if bookmark was found and activated successfully
#[cfg(target_os = "macos")]
pub async fn activate_bookmark(path: &str) -> Result<bool, String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT bookmark_data FROM security_scoped_bookmarks WHERE path = ?"
    )
    .bind(path)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch bookmark: {}", e))?;
    
    if let Some((bookmark_data,)) = row {
        // Resolve and start accessing the security-scoped resource.
        // The URL handle is intentionally discarded here because resolve_security_scoped_bookmark
        // starts accessing but does NOT stop accessing - the security scope remains active
        // for the app's lifetime, allowing sync operations to work continuously.
        // macOS will automatically clean up when the app terminates.
        let _ = resolve_security_scoped_bookmark(&bookmark_data)?;
        
        // Update last_accessed timestamp
        let _ = sqlx::query(
            "UPDATE security_scoped_bookmarks SET last_accessed = CURRENT_TIMESTAMP WHERE path = ?"
        )
        .bind(path)
        .execute(pool)
        .await;
        
        println!("[Bookmarks] Activated security-scoped bookmark for: {}", path);
        Ok(true)
    } else {
        Err(format!("No bookmark found for path: {}", path))
    }
}

/// Deactivates a security-scoped resource
#[cfg(target_os = "macos")]
pub fn deactivate_bookmark(url: cocoa::base::id) {
    stop_accessing_security_scoped_resource(url);
}

/// Removes a bookmark from the database
#[cfg(target_os = "macos")]
pub async fn remove_bookmark(path: &str) -> Result<(), String> {
    let pool = DB_POOL
        .get()
        .ok_or_else(|| "Database pool not initialized".to_string())?;
    
    sqlx::query("DELETE FROM security_scoped_bookmarks WHERE path = ?")
        .bind(path)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to remove bookmark: {}", e))?;
    
    println!("[Bookmarks] Removed security-scoped bookmark for: {}", path);
    Ok(())
}

// Non-macOS stubs
#[cfg(not(target_os = "macos"))]
pub async fn store_bookmark(_path: &str, _scope_type: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub async fn activate_bookmark(_path: &str) -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
pub fn deactivate_bookmark(_url: ()) {}

#[cfg(not(target_os = "macos"))]
pub async fn remove_bookmark(_path: &str) -> Result<(), String> {
    Ok(())
}