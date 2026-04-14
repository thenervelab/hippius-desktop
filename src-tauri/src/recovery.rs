//! OAuth account recovery.
//!
//! Desktop-side implementation of the always-on recovery flow: on fresh-device
//! OAuth login, the user's sealed mnemonic blob is fetched from hcfs-server,
//! decrypted with the user-supplied recovery password, and installed into the
//! local mnemonic store. See `docs/plans/2026-04-14-oauth-account-recovery.md`.
//!
//! This module owns:
//! - The default hcfs-server URL used before sync is configured.
//! - Helpers that seed the URL into `hcfs_config` so recovery can reach the
//!   server on a fresh device.
//! - The Tauri commands invoked by the recovery dialog (added in follow-up
//!   tasks — currently only the scaffold lives here).

use sqlx::sqlite::SqlitePool;

use crate::auth::account_key::account_key;
use crate::error::Result;

/// Outcome of the OAuth recovery dialog, broadcast through a `watch` channel
/// so `ensure_sync_mnemonic` can await resolution before touching the local
/// mnemonic store.
///
/// `Pending` is the startup default — any code path that would mint a new
/// mnemonic must await a non-`Pending` state first. `Resolved` means either a
/// server blob was unlocked or a fresh mnemonic was sealed-and-uploaded, and
/// the local store is now authoritative. `Skipped` means no recovery action
/// was needed (e.g. local mnemonic already present).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryGateState {
    Pending,
    Resolved,
    Skipped,
}

impl RecoveryGateState {
    pub fn is_resolved(self) -> bool {
        !matches!(self, Self::Pending)
    }
}

/// Canonical production hcfs-server URL.
///
/// Used as the default when `hcfs_config.server_url` is empty — i.e. on a fresh
/// device after OAuth login but before the user has configured sync. Recovery
/// needs a URL to fetch the sealed mnemonic blob from, and the normal config
/// save path requires a drive password the user hasn't entered yet.
pub const DEFAULT_HCFS_SERVER_URL: &str = "https://arion.hippius.com";

/// Ensure an `hcfs_config` row exists for the account with a non-empty
/// `server_url`, seeding `DEFAULT_HCFS_SERVER_URL` when missing.
///
/// Idempotent: if a row already exists with a non-empty URL, leaves it alone.
/// Drive password remains untouched — this runs before the user has chosen
/// one, so `drive_password` stays empty and `encryption_version` stays 0.
pub(crate) async fn seed_hcfs_server_url_if_missing(pool: &SqlitePool, account_id: &str) -> Result<()> {
    let owner = account_key(account_id);

    // Create a row if one doesn't exist yet. Drive password is empty; later
    // sync setup will populate it via the normal save_hcfs_config path.
    sqlx::query(
        r"
        INSERT OR IGNORE INTO hcfs_config
            (owner, server_url, drive_password, encryption_version, updated_at)
        VALUES (?, ?, '', 0, CURRENT_TIMESTAMP)
        ",
    )
    .bind(&owner)
    .bind(DEFAULT_HCFS_SERVER_URL)
    .execute(pool)
    .await?;

    // If the row existed but with an empty URL (e.g. partial earlier state),
    // fill it in. Does nothing when URL is already set.
    sqlx::query(
        r"
        UPDATE hcfs_config
        SET server_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE owner = ? AND (server_url IS NULL OR server_url = '')
        ",
    )
    .bind(DEFAULT_HCFS_SERVER_URL)
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        sqlx::query(
            r"
            CREATE TABLE hcfs_config (
                owner TEXT PRIMARY KEY,
                server_url TEXT NOT NULL DEFAULT '',
                drive_password TEXT NOT NULL DEFAULT '',
                encryption_version INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP
            )
            ",
        )
        .execute(&pool)
        .await
        .expect("create hcfs_config");
        pool
    }

    #[tokio::test]
    async fn seeds_default_url_when_no_row_exists() {
        let pool = setup_pool().await;
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let owner = account_key("5TestAccountId");
        let row: (String, String, i32) = sqlx::query_as("SELECT server_url, drive_password, encryption_version FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(row.0, DEFAULT_HCFS_SERVER_URL);
        assert_eq!(row.1, "");
        assert_eq!(row.2, 0);
    }

    #[tokio::test]
    async fn leaves_non_empty_url_alone() {
        let pool = setup_pool().await;
        let owner = account_key("5TestAccountId");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://custom.example', 'secret', 0)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();

        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let row: (String, String) = sqlx::query_as("SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "https://custom.example");
        assert_eq!(row.1, "secret");
    }

    #[tokio::test]
    async fn fills_empty_url_on_existing_row() {
        let pool = setup_pool().await;
        let owner = account_key("5TestAccountId");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, '', '', 0)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();

        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let url: String = sqlx::query_scalar("SELECT server_url FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(url, DEFAULT_HCFS_SERVER_URL);
    }

    #[test]
    fn gate_state_is_resolved_for_non_pending() {
        assert!(!RecoveryGateState::Pending.is_resolved());
        assert!(RecoveryGateState::Resolved.is_resolved());
        assert!(RecoveryGateState::Skipped.is_resolved());
    }

    #[tokio::test]
    async fn app_state_recovery_gate_defaults_pending_and_resolves() {
        let state = crate::app_state::AppState::new();
        assert_eq!(state.recovery_state(), RecoveryGateState::Pending);

        state.set_recovery_state(RecoveryGateState::Resolved);
        assert_eq!(state.recovery_state(), RecoveryGateState::Resolved);

        // await returns immediately when already resolved.
        let awaited = tokio::time::timeout(std::time::Duration::from_millis(50), state.await_recovery_resolved())
            .await
            .expect("await should return immediately when already resolved");
        assert_eq!(awaited, RecoveryGateState::Resolved);
    }

    #[tokio::test]
    async fn app_state_recovery_gate_wakes_pending_waiters() {
        use std::sync::Arc;
        let state = Arc::new(crate::app_state::AppState::new());

        let waiter_state = state.clone();
        let handle = tokio::spawn(async move { waiter_state.await_recovery_resolved().await });

        // Give the waiter a chance to park on the channel.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state.set_recovery_state(RecoveryGateState::Skipped);

        let resolved = tokio::time::timeout(std::time::Duration::from_millis(100), handle)
            .await
            .expect("waiter must wake within timeout")
            .expect("task panicked");
        assert_eq!(resolved, RecoveryGateState::Skipped);
    }

    #[tokio::test]
    async fn idempotent_on_repeated_calls() {
        let pool = setup_pool().await;
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hcfs_config")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
