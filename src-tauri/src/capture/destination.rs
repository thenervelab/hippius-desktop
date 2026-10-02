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

/// A drive the capture bar offers under "Save to", with whether it is synced
/// on this machine. `remote` is what decides how "Show in folder" opens it:
/// a synced drive and a server-only one open through different paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationChoice {
    pub label: String,
    pub remote: bool,
}

/// Own drives synced here first, then own drives only on the server, each
/// once. A drive synced here is also on the server; listing it twice would
/// offer one drive by two routes.
#[must_use]
pub fn merge_choices(local: Vec<String>, remote: Vec<String>) -> Vec<DestinationChoice> {
    let mut out: Vec<DestinationChoice> = Vec::with_capacity(local.len() + remote.len());
    for label in local {
        if !label.trim().is_empty() && !out.iter().any(|c| c.label == label) {
            out.push(DestinationChoice { label, remote: false });
        }
    }
    for label in remote {
        if !label.trim().is_empty() && !out.iter().any(|c| c.label == label) {
            out.push(DestinationChoice { label, remote: true });
        }
    }
    out
}

/// This account's own drives synced on this machine, paused ones included:
/// the picker offers every own drive. A paused one is delivered like a remote
/// drive (see [`own_local_path`]), so pausing sync never strands a capture.
/// Drives shared with this account and the migration pseudo-drive are not
/// offered: captures go to a drive the user owns.
pub async fn own_local_labels(pool: &SqlitePool, account_id: &str) -> Result<Vec<String>> {
    use sqlx::Row;
    let owner = crate::auth::account_key::account_key(account_id);
    let rows = sqlx::query(
        "SELECT label FROM sync_paths
         WHERE owner = ?
           AND label != 'migration'
           AND owner_ss58 IS NULL
           AND wire_folder_hash IS NULL
         ORDER BY label",
    )
    .bind(&owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(|row| row.get::<String, _>("label")).collect())
}

/// Every drive the capture bar can save to. The server half degrades to
/// nothing when it cannot be read, so the synced drives are still offered.
pub async fn choices(pool: &SqlitePool, account_id: &str) -> Result<Vec<DestinationChoice>> {
    let local = own_local_labels(pool, account_id).await?;
    let remote = match crate::sync::folders::list_remote_folders_internal(pool, account_id).await {
        Ok(folders) => folders.into_iter().map(|f| f.label).collect(),
        Err(e) => {
            tracing::warn!(error = %e, "capture drive list: remote drives unavailable, offering synced drives only");
            Vec::new()
        }
    };
    Ok(merge_choices(local, remote))
}

/// Where `label` is synced on this machine, when it is one of this account's
/// own drives AND its sync is running. A capture for such a drive goes into
/// this folder and the sync engine uploads it, rather than being uploaded
/// directly and then synced back down as a second copy.
///
/// A paused drive answers `None`: its engine would not upload the file, and
/// the card would wait on "waiting for sync" until the user resumed it for
/// some other reason. Such a capture takes the direct upload instead.
pub async fn own_local_path(pool: &SqlitePool, account_id: &str, label: &str) -> Result<Option<std::path::PathBuf>> {
    use sqlx::Row;
    let owner = crate::auth::account_key::account_key(account_id);
    let row = sqlx::query(
        "SELECT path FROM sync_paths
         WHERE owner = ? AND label = ?
           AND label != 'migration'
           AND owner_ss58 IS NULL
           AND wire_folder_hash IS NULL
           AND is_paused = 0",
    )
    .bind(&owner)
    .bind(label)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| std::path::PathBuf::from(r.get::<String, _>("path"))))
}

/// Whether a capture for `label` is delivered through this machine's synced
/// folder: the same answer delivery acts on ([`own_local_path`]), so the card
/// never names a drive "synced here" that the capture did not go through.
pub async fn is_local(pool: &SqlitePool, account_id: &str, label: &str) -> bool {
    own_local_path(pool, account_id, label).await.is_ok_and(|p| p.is_some())
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

    #[test]
    fn choices_list_synced_drives_first_and_each_drive_once() {
        let merged = merge_choices(
            vec!["Work".into(), "Photos".into()],
            vec!["Photos".into(), "Archive".into(), String::new(), "Work".into()],
        );
        assert_eq!(
            merged,
            vec![
                DestinationChoice {
                    label: "Work".into(),
                    remote: false
                },
                DestinationChoice {
                    label: "Photos".into(),
                    remote: false
                },
                DestinationChoice {
                    label: "Archive".into(),
                    remote: true
                },
            ]
        );
    }

    #[tokio::test]
    async fn only_own_drives_are_offered_and_paused_ones_count() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let owner = crate::auth::account_key::account_key("5Alice");
        for (label, member, paused) in [("Work", false, 0), ("Paused", false, 1), ("Team", true, 0), ("migration", false, 0)] {
            sqlx::query(
                "INSERT INTO sync_paths (owner, path, type, label, is_paused, owner_ss58, wire_folder_hash, timestamp)
                 VALUES (?, ?, 'private', ?, ?, ?, ?, 0)",
            )
            .bind(&owner)
            .bind(format!("/tmp/{label}"))
            .bind(label)
            .bind(paused)
            .bind(member.then_some("5Owner"))
            .bind(member.then_some("abcd"))
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(
            own_local_labels(&pool, "5Alice").await.unwrap(),
            vec!["Paused".to_string(), "Work".to_string()]
        );
        assert!(is_local(&pool, "5Alice", "Work").await);
        assert_eq!(
            own_local_path(&pool, "5Alice", "Work").await.unwrap(),
            Some(std::path::PathBuf::from("/tmp/Work"))
        );
        assert_eq!(own_local_path(&pool, "5Alice", "Team").await.unwrap(), None);
        assert!(!is_local(&pool, "5Alice", "Team").await);
        // Offered, but a paused drive's engine would never upload the file,
        // so its captures take the direct upload.
        assert_eq!(own_local_path(&pool, "5Alice", "Paused").await.unwrap(), None);
        assert!(!is_local(&pool, "5Alice", "Paused").await);
        assert!(own_local_labels(&pool, "5Bob").await.unwrap().is_empty());
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
