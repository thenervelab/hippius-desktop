//! This computer's device registration, per account, in SQLite
//! (`device_registration`, keyed by `account_key`).
//!
//! The row outlives a sign-out on purpose: signing in again on this
//! computer reconnects the same device (`reconnect_pending`) rather than
//! adding another one to the account.

use sqlx::SqlitePool;

/// What this computer knows about its own device for one account.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SavedDevice {
    pub device_id: Option<String>,
    /// The server listed it, or this computer created or reconnected it. A
    /// confirmed device that leaves the list was unlinked from elsewhere.
    pub confirmed: bool,
    /// Set by an explicit sign-in (not by a launch restore): a saved device
    /// missing from the list is reconnected rather than read as unlinked.
    pub reconnect_pending: bool,
}

fn owner(account_id: &str) -> String {
    crate::auth::account_key::account_key(account_id)
}

pub async fn load(pool: &SqlitePool, account_id: &str) -> sqlx::Result<SavedDevice> {
    let row: Option<(Option<String>, i64, i64)> =
        sqlx::query_as("SELECT device_id, confirmed, reconnect_pending FROM device_registration WHERE owner = ?")
            .bind(owner(account_id))
            .fetch_optional(pool)
            .await?;
    Ok(row.map_or_else(SavedDevice::default, |(device_id, confirmed, pending)| SavedDevice {
        device_id: device_id.filter(|id| !id.is_empty()),
        confirmed: confirmed != 0,
        reconnect_pending: pending != 0,
    }))
}

/// This computer is `device_id` and the server lists it (or just made it).
pub async fn save_linked(pool: &SqlitePool, account_id: &str, device_id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO device_registration (owner, device_id, confirmed, reconnect_pending, updated_at)
         VALUES (?, ?, 1, 0, strftime('%s','now'))
         ON CONFLICT(owner) DO UPDATE SET device_id = excluded.device_id, confirmed = 1, reconnect_pending = 0,
             updated_at = excluded.updated_at",
    )
    .bind(owner(account_id))
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// An explicit sign-in: the next check reconnects a saved device the server
/// no longer lists.
pub async fn mark_reconnect_pending(pool: &SqlitePool, account_id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO device_registration (owner, device_id, confirmed, reconnect_pending, updated_at)
         VALUES (?, NULL, 0, 1, strftime('%s','now'))
         ON CONFLICT(owner) DO UPDATE SET reconnect_pending = 1, updated_at = excluded.updated_at",
    )
    .bind(owner(account_id))
    .execute(pool)
    .await?;
    Ok(())
}

/// The DDL, shared with `utils::schema` and the tests.
pub const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS device_registration (
    owner             TEXT    NOT NULL PRIMARY KEY,
    device_id         TEXT,
    confirmed         INTEGER NOT NULL DEFAULT 0,
    reconnect_pending INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER
)";

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query(CREATE_TABLE).execute(&pool).await.expect("create");
        pool
    }

    #[tokio::test]
    async fn a_sign_in_marks_a_reconnect_and_linking_clears_it() {
        let pool = pool().await;
        assert_eq!(load(&pool, "5A").await.unwrap(), SavedDevice::default());
        mark_reconnect_pending(&pool, "5A").await.unwrap();
        let saved = load(&pool, "5A").await.unwrap();
        assert!(saved.reconnect_pending && saved.device_id.is_none() && !saved.confirmed);
        save_linked(&pool, "5A", &"a".repeat(32)).await.unwrap();
        let saved = load(&pool, "5A").await.unwrap();
        assert_eq!(saved.device_id.as_deref(), Some("a".repeat(32).as_str()));
        assert!(saved.confirmed && !saved.reconnect_pending);
        // A later sign-in keeps the id and confirmation.
        mark_reconnect_pending(&pool, "5A").await.unwrap();
        let saved = load(&pool, "5A").await.unwrap();
        assert!(saved.confirmed && saved.reconnect_pending && saved.device_id.is_some());
        // Accounts do not share a row.
        assert_eq!(load(&pool, "5B").await.unwrap(), SavedDevice::default());
    }
}
