//! Which drive captures are filed in, remembered per account.
//!
//! The user picks it on their first capture and can change it in Settings.
//! Stored in `user_preferences`, which is a single namespace across every
//! account on the device, so the key carries the account: a drive label is
//! only meaningful to the account that holds it, and a second account on the
//! same machine must not inherit the first one's drive.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, Result};

/// A drive to file captures in.
///
/// `owner_ss58` + `folder_hash` are set together, for a drive shared WITH this
/// account, and absent together for one it owns — the same pairing the remote
/// upload takes, which refuses half an identity rather than guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDestination {
    pub label: String,
    /// What the user called the drive, for "Saved to <name>".
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_ss58: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_hash: Option<String>,
}

impl CaptureDestination {
    /// # Errors
    ///
    /// [`AppError::Validation`] for an empty label or half a shared-drive identity.
    pub fn validate(&self) -> Result<()> {
        if self.label.trim().is_empty() {
            return Err(AppError::Validation("Choose a drive for your captures.".into()));
        }
        if self.owner_ss58.is_some() != self.folder_hash.is_some() {
            return Err(AppError::Validation("A shared drive needs both its owner and its folder hash.".into()));
        }
        Ok(())
    }
}

const KEY_PREFIX: &str = "capture_destination_v1:";

fn key_for(account_id: &str) -> String {
    format!("{KEY_PREFIX}{}", crate::auth::account_key::account_key(account_id))
}

/// The account's capture drive, or `None` if it has not chosen one. A stored
/// value that no longer parses is treated as unset, so the picker asks again
/// rather than the capture failing on a stale row.
pub async fn load(pool: &SqlitePool, account_id: &str) -> Result<Option<CaptureDestination>> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, &key_for(account_id)).await?;
    Ok(raw
        .and_then(|v| serde_json::from_str::<CaptureDestination>(&v).ok())
        .filter(|d| d.validate().is_ok()))
}

pub async fn save(pool: &SqlitePool, account_id: &str, destination: &CaptureDestination) -> Result<()> {
    destination.validate()?;
    let value = serde_json::to_string(destination).map_err(|e| AppError::Other(format!("Could not store the capture drive: {e}")))?;
    crate::utils::preferences::save_user_preference_internal(pool, &key_for(account_id), &value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE user_preferences (preference_key TEXT PRIMARY KEY, preference_value TEXT NOT NULL, updated_at INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn own(label: &str) -> CaptureDestination {
        CaptureDestination {
            label: label.into(),
            display_name: label.into(),
            owner_ss58: None,
            folder_hash: None,
        }
    }

    #[tokio::test]
    async fn round_trips_a_destination() {
        let pool = pool().await;
        save(&pool, "5Alice", &own("Work")).await.unwrap();
        assert_eq!(load(&pool, "5Alice").await.unwrap(), Some(own("Work")));
    }

    /// Two accounts on one machine each keep their own drive.
    #[tokio::test]
    async fn is_kept_per_account() {
        let pool = pool().await;
        save(&pool, "5Alice", &own("Work")).await.unwrap();
        assert_eq!(load(&pool, "5Bob").await.unwrap(), None);
        save(&pool, "5Bob", &own("Photos")).await.unwrap();
        assert_eq!(load(&pool, "5Alice").await.unwrap(), Some(own("Work")));
    }

    #[tokio::test]
    async fn half_a_shared_drive_is_refused_before_it_is_stored() {
        let pool = pool().await;
        let half = CaptureDestination {
            owner_ss58: Some("5Owner".into()),
            ..own("team")
        };
        assert!(matches!(save(&pool, "5Alice", &half).await, Err(AppError::Validation(_))));
        assert_eq!(load(&pool, "5Alice").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_stale_unreadable_row_reads_as_unset() {
        let pool = pool().await;
        crate::utils::preferences::save_user_preference_internal(&pool, &key_for("5Alice"), "{not json")
            .await
            .unwrap();
        assert_eq!(load(&pool, "5Alice").await.unwrap(), None);
    }
}
