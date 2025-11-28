use crate::DB_POOL;
use serde::Serialize;
use tauri::State;
use sqlx::SqlitePool;

#[derive(Serialize)]
pub struct VpnStatus {
    is_enabled: bool,
}

/// Get the current VPN status
#[tauri::command]
pub async fn get_vpn_status() -> Result<VpnStatus, String> {
    let pool = DB_POOL.get().ok_or("Database pool not available")?;
    
    match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => Ok(VpnStatus { is_enabled }),
        Ok(None) => {
            // This should never happen due to our initialization, but handle it just in case
            let _ = sqlx::query("INSERT INTO vpn_status (id, is_enabled) VALUES (1, FALSE)")
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(VpnStatus { is_enabled: false })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Toggle the VPN status
#[tauri::command]
pub async fn toggle_vpn_status() -> Result<VpnStatus, String> {
    let pool = DB_POOL.get().ok_or("Database pool not available")?;
    
    // First get the current status
    let current = get_vpn_status().await?;
    
    // Toggle the status
    let new_status = !current.is_enabled;
    
    // Update in database
    sqlx::query(
        "UPDATE vpn_status SET is_enabled = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1",
    )
    .bind(new_status)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    
    Ok(VpnStatus {
        is_enabled: new_status,
    })
}
