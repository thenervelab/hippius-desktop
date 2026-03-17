use serde::Serialize;
use tracing::{error, info, warn};

#[derive(Serialize)]
pub struct VpnStatus {
    is_enabled: bool,
}

/// Get the current VPN status
#[tauri::command]
pub async fn get_vpn_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<VpnStatus, String> {
    let pool = state.pool()?;

    match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => Ok(VpnStatus { is_enabled }),
        Ok(None) => {
            // This should never happen due to our initialization, but handle it just in case
            sqlx::query("INSERT INTO vpn_status (id, is_enabled) VALUES (1, FALSE)")
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
pub async fn toggle_vpn_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<VpnStatus, String> {
    let pool = state.pool()?;

    // First get the current status
    let current =
        match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
            .fetch_optional(pool)
            .await
        {
            Ok(Some((is_enabled,))) => VpnStatus { is_enabled },
            Ok(None) => VpnStatus { is_enabled: false },
            Err(e) => return Err(e.to_string()),
        };

    // Toggle the status
    let new_status = !current.is_enabled;

    // If enabling, check and update certificate first
    if new_status {
        info!("Checking certificate status before enabling...");
        if let Err(e) = crate::utils::nebula::check_and_update_certificate(pool).await {
            error!("Certificate check failed: {}", e);
            return Err(format!("Failed to verify/renew certificate: {}", e));
        }
    }

    // Update in database
    sqlx::query(
        "UPDATE vpn_status SET is_enabled = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1",
    )
    .bind(new_status)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Start or stop Nebula based on new status
    if new_status {
        // VPN enabled - start Nebula
        info!("VPN enabled, starting Nebula...");
        if let Err(e) = crate::utils::nebula::start_nebula_internal(pool).await {
            warn!("Failed to start Nebula: {}", e);
            // Don't return error, just log it - the toggle still succeeded
        }
    } else {
        // VPN disabled - stop Nebula
        info!("VPN disabled, stopping Nebula...");
        if let Err(e) = crate::utils::nebula::stop_nebula().await {
            warn!("Failed to stop Nebula: {}", e);
            // Don't return error, just log it - the toggle still succeeded
        }
    }

    Ok(VpnStatus {
        is_enabled: new_status,
    })
}

#[derive(Serialize)]
pub struct AutoconnectStatus {
    is_enabled: bool,
}

/// Get the current Autoconnect VPN status
#[tauri::command]
pub async fn get_autoconnect_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<AutoconnectStatus, String> {
    let pool = state.pool()?;

    match sqlx::query_as::<_, (bool,)>(
        "SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    {
        Ok(Some((is_enabled,))) => Ok(AutoconnectStatus { is_enabled }),
        Ok(None) => {
            // This should never happen due to our initialization, but handle it just in case
            sqlx::query("INSERT INTO autoconnect_vpn_enabled (id, is_enabled) VALUES (1, FALSE)")
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(AutoconnectStatus { is_enabled: false })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Toggle the Autoconnect VPN status
#[tauri::command]
pub async fn toggle_autoconnect_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<AutoconnectStatus, String> {
    let pool = state.pool()?;

    // First get the current status
    let current = match sqlx::query_as::<_, (bool,)>(
        "SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    {
        Ok(Some((is_enabled,))) => AutoconnectStatus { is_enabled },
        Ok(None) => AutoconnectStatus { is_enabled: false },
        Err(e) => return Err(e.to_string()),
    };

    // Toggle the status
    let new_status = !current.is_enabled;

    // Update in database
    sqlx::query(
        "UPDATE autoconnect_vpn_enabled SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
    )
    .bind(new_status)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(AutoconnectStatus {
        is_enabled: new_status,
    })
}
