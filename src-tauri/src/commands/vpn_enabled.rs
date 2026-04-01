//! VPN (Nebula) toggle and autoconnect commands.
//!
//! Persists the user's VPN on/off preference in SQLite and orchestrates
//! the actual Nebula process lifecycle. Permission escalation for the
//! TUN/TAP device only happens here (on explicit user toggle), never
//! at app startup.

use serde::Serialize;
use tracing::{error, info, warn};

/// Current VPN connection state returned to the frontend.
#[derive(Serialize)]
pub struct VpnStatus {
    is_enabled: bool,
}

/// Read the persisted VPN enabled flag from the database.
#[tauri::command]
pub async fn get_vpn_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<VpnStatus, String> {
    let pool = state.pool()?;

    match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => Ok(VpnStatus { is_enabled }),
        Ok(None) => {
            // Should not happen — setup.rs initializes this row, but handle defensively
            sqlx::query("INSERT INTO vpn_status (id, is_enabled) VALUES (1, FALSE)")
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(VpnStatus { is_enabled: false })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Toggle VPN on or off: checks permissions and certificate when
/// enabling, then starts or stops the Nebula process accordingly.
/// The DB flag is updated before the process action so the UI reflects
/// the intended state even if Nebula fails to start.
#[tauri::command]
pub async fn toggle_vpn_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<VpnStatus, String> {
    let pool = state.pool()?;

    let current = match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => VpnStatus { is_enabled },
        Ok(None) => VpnStatus { is_enabled: false },
        Err(e) => return Err(e.to_string()),
    };

    let new_status = !current.is_enabled;

    if new_status {
        info!("Checking VPN binary permissions before enabling...");
        let binary_path = crate::utils::nebula::get_nebula_binary_path().map_err(|e| e.to_string())?;

        let has_perms = crate::utils::nebula::check_permissions(&binary_path)
            .await
            .map_err(|e| format!("Failed to check permissions: {e}"))?;

        if !has_perms {
            info!("Requesting elevated permissions for VPN...");
            crate::utils::nebula::grant_permissions(&binary_path).await.map_err(|e| format!("{e}"))?;
        }

        info!("Checking certificate status before enabling...");
        if let Err(e) = crate::utils::nebula::check_and_update_certificate(pool).await {
            error!("Certificate check failed: {}", e);
            return Err(format!("Failed to verify/renew certificate: {e}"));
        }
    }

    sqlx::query("UPDATE vpn_status SET is_enabled = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1")
        .bind(new_status)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    if new_status {
        info!("VPN enabled, starting Nebula...");
        if let Err(e) = crate::utils::nebula::start_nebula_internal(&state.nebula, pool).await {
            // Don't return error — the DB toggle already succeeded, so the
            // UI should reflect the user's intent even if the process fails.
            warn!("Failed to start Nebula: {}", e);
        }
    } else {
        info!("VPN disabled, stopping Nebula...");
        if let Err(e) = crate::utils::nebula::stop_nebula(&state.nebula).await {
            // Don't return error — same rationale as above.
            warn!("Failed to stop Nebula: {}", e);
        }
    }

    Ok(VpnStatus { is_enabled: new_status })
}

/// Whether the VPN should automatically connect on app launch.
#[derive(Serialize)]
pub struct AutoconnectStatus {
    is_enabled: bool,
}

/// Read the persisted autoconnect preference from the database.
#[tauri::command]
pub async fn get_autoconnect_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<AutoconnectStatus, String> {
    let pool = state.pool()?;

    match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => Ok(AutoconnectStatus { is_enabled }),
        Ok(None) => {
            // Should not happen — setup.rs initializes this row, but handle defensively
            sqlx::query("INSERT INTO autoconnect_vpn_enabled (id, is_enabled) VALUES (1, FALSE)")
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(AutoconnectStatus { is_enabled: false })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Toggle the autoconnect preference and persist the new value.
#[tauri::command]
pub async fn toggle_autoconnect_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<AutoconnectStatus, String> {
    let pool = state.pool()?;

    let current = match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => AutoconnectStatus { is_enabled },
        Ok(None) => AutoconnectStatus { is_enabled: false },
        Err(e) => return Err(e.to_string()),
    };

    let new_status = !current.is_enabled;

    sqlx::query("UPDATE autoconnect_vpn_enabled SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        .bind(new_status)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AutoconnectStatus { is_enabled: new_status })
}
