//! VPN (Nebula) toggle and autoconnect commands.
//!
//! Persists the user's VPN on/off preference in SQLite and orchestrates
//! the actual Nebula process lifecycle. Permission escalation for the
//! TUN/TAP device only happens here (on explicit user toggle), never
//! at app startup.

use crate::error::AppError;
use serde::Serialize;
use tracing::{error, info, warn};

/// Current VPN connection state returned to the frontend.
#[derive(Serialize)]
pub struct VpnStatus {
    is_enabled: bool,
}

/// Read the persisted VPN enabled flag from the database.
#[tauri::command]
pub async fn get_vpn_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<VpnStatus, AppError> {
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
                .await?;
            Ok(VpnStatus { is_enabled: false })
        }
        Err(e) => Err(AppError::Db(e)),
    }
}

/// Toggle VPN on or off: checks permissions and certificate when
/// enabling, then starts or stops the Nebula process accordingly.
/// The DB flag is updated before the process action so the UI reflects
/// the intended state even if Nebula fails to start.
#[tauri::command]
pub async fn toggle_vpn_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<VpnStatus, AppError> {
    let pool = state.pool()?;

    let current = match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => VpnStatus { is_enabled },
        Ok(None) => VpnStatus { is_enabled: false },
        Err(e) => return Err(AppError::Db(e)),
    };

    let new_status = !current.is_enabled;

    if new_status {
        // Check credit balance before enabling VPN (fail-closed: reject if we can't verify)
        let acct = state
            .current_account_id()
            .map_err(|_| AppError::Validation("Unable to verify credits. Please log in first.".into()))?;
        let client = crate::api::client::ApiClient::new(state.api_client.clone(), pool.clone());
        let resp = client
            .get::<serde_json::Value>("/api/billing/credits/balance/", &acct)
            .await
            .map_err(|_| AppError::Validation("Unable to verify credits. Please check your network connection.".into()))?;
        let balance: f64 = resp.get("balance").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if balance < 10.0 {
            return Err(AppError::Validation(
                "Insufficient credits. You need at least 10 credits to use the VPN feature.".into(),
            ));
        }

        info!("Checking VPN binary permissions before enabling...");
        let binary_path = crate::nebula::manager::get_nebula_binary_path().map_err(|e| AppError::Nebula(e.to_string()))?;

        let has_perms = crate::nebula::manager::check_permissions(&binary_path)
            .await
            .map_err(|e| AppError::Nebula(format!("Failed to check permissions: {e}")))?;

        if !has_perms {
            info!("Requesting elevated permissions for VPN...");
            crate::nebula::manager::grant_permissions(&binary_path)
                .await
                .map_err(|e| AppError::Nebula(e.to_string()))?;
        }

        info!("Checking certificate status before enabling...");
        if let Err(e) = crate::nebula::manager::check_and_update_certificate(&state.api_client, pool, &acct).await {
            error!("Certificate check failed: {}", e);
            return Err(AppError::Nebula(format!("Failed to verify/renew certificate: {e}")));
        }
    }

    sqlx::query("UPDATE vpn_status SET is_enabled = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1")
        .bind(new_status)
        .execute(pool)
        .await?;

    if new_status {
        info!("VPN enabled, starting Nebula...");
        // Resolve the active account; if it's missing, the user logged out
        // mid-toggle and we shouldn't start nebula at all.
        let acct = state
            .current_account_id()
            .map_err(|_| AppError::Validation("Cannot start VPN: no active account.".into()))?;
        if let Err(e) = crate::nebula::manager::start_nebula_internal(&state.nebula, pool, &acct).await {
            // Don't return error — the DB toggle already succeeded, so the
            // UI should reflect the user's intent even if the process fails.
            warn!("Failed to start Nebula: {}", e);
        }
    } else {
        info!("VPN disabled, stopping Nebula...");
        if let Err(e) = crate::nebula::manager::stop_nebula(&state.nebula).await {
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
pub async fn get_autoconnect_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<AutoconnectStatus, AppError> {
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
                .await?;
            Ok(AutoconnectStatus { is_enabled: false })
        }
        Err(e) => Err(AppError::Db(e)),
    }
}

/// Toggle the autoconnect preference and persist the new value.
#[tauri::command]
pub async fn toggle_autoconnect_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<AutoconnectStatus, AppError> {
    let pool = state.pool()?;

    let current = match sqlx::query_as::<_, (bool,)>("SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((is_enabled,))) => AutoconnectStatus { is_enabled },
        Ok(None) => AutoconnectStatus { is_enabled: false },
        Err(e) => return Err(AppError::Db(e)),
    };

    let new_status = !current.is_enabled;

    sqlx::query("UPDATE autoconnect_vpn_enabled SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        .bind(new_status)
        .execute(pool)
        .await?;

    Ok(AutoconnectStatus { is_enabled: new_status })
}
