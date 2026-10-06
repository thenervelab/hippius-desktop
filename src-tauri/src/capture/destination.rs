//! Which drive and folder captures are filed in, remembered per account.
//!
//! Captures have a drive of their own (`capture::setup`): the user is asked
//! where on the first capture, and can move it in Settings. Stored in
//! `user_preferences`, which is a single namespace across every account on
//! the device, so the key carries the account: a drive label is only
//! meaningful to the account that holds it, and a second account on the same
//! machine must not inherit the first one's drive.
//!
//! The key is `v2`. Rows under `capture_destination_v1` named a folder in one
//! of the user's other drives, picked in a dialog every first capture forced
//! open; they are never read, so those accounts are asked once where their
//! captures drive goes. The captures already in those folders stay there.

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
    /// The folder inside the drive, as a path from the drive's root; empty
    /// for the root itself, which is where the captures drive keeps them.
    #[serde(default)]
    pub folder: String,
}

impl CaptureDestination {
    /// An own drive, with captures at its root (the captures drive).
    #[must_use]
    pub fn own(label: &str, display_name: &str) -> Self {
        Self {
            label: label.to_string(),
            display_name: display_name.to_string(),
            owner_ss58: None,
            folder_hash: None,
            folder: String::new(),
        }
    }

    /// # Errors
    ///
    /// [`AppError::Validation`] for an empty label, half a shared-drive
    /// identity, or a folder that is not a plain path inside the drive.
    pub fn validate(&self) -> Result<()> {
        if self.label.trim().is_empty() {
            return Err(AppError::Validation("Choose a drive for your captures.".into()));
        }
        if self.owner_ss58.is_some() != self.folder_hash.is_some() {
            return Err(AppError::Validation("A shared drive needs both its owner and its folder hash.".into()));
        }
        if normalize_folder(&self.folder)? != self.folder {
            return Err(AppError::Validation("That folder name isn't valid.".into()));
        }
        Ok(())
    }

    /// The capture's path inside the drive (`<name>` at the root,
    /// `Captures/<name>` in a folder): how the sync engine names its row, and
    /// what its share link is made from.
    #[must_use]
    pub fn rel_path(&self, file_name: &str) -> String {
        if self.folder.is_empty() {
            file_name.to_string()
        } else {
            format!("{}/{file_name}", self.folder)
        }
    }

    /// The folder a direct upload names: `None` for the drive's root, which
    /// is what the upload takes for "no folder".
    #[must_use]
    pub fn upload_folder(&self) -> Option<String> {
        (!self.folder.is_empty()).then(|| self.folder.clone())
    }
}

/// The folder as stored: slashes as `/`, none at either end, each name
/// one a drive can hold on every platform (the Windows rules included, since
/// a folder Windows cannot create cannot sync to a Windows machine). Blank is
/// the drive's root.
///
/// # Errors
///
/// [`AppError::Validation`] with a sentence a person can act on.
pub fn normalize_folder(raw: &str) -> Result<String> {
    let path = raw.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." || part == ".." {
            return Err(AppError::Validation("A folder name cannot be empty, \".\" or \"..\".".into()));
        }
        if part.starts_with('.') {
            // A dot folder is hidden, and the sync engine skips it.
            return Err(AppError::Validation(
                "A folder name cannot start with a dot: the folder would not sync.".into(),
            ));
        }
        if part.ends_with('.') || part.contains([':', '*', '?', '"', '<', '>', '|', '\0']) {
            return Err(AppError::Validation(
                "A folder name cannot contain : * ? \" < > | or end with a dot.".into(),
            ));
        }
        if part.len() > 255 {
            return Err(AppError::Validation("That folder name is too long.".into()));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

const KEY_PREFIX: &str = "capture_destination_v2:";

fn key_for(account_id: &str) -> String {
    format!("{KEY_PREFIX}{}", crate::auth::account_key::account_key(account_id))
}

/// The account's captures drive, or `None` before one is set up. A stored
/// value that no longer parses is treated as unset, so the user is asked
/// again rather than the capture failing on a stale row.
pub async fn load(pool: &SqlitePool, account_id: &str) -> Result<Option<CaptureDestination>> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, &key_for(account_id)).await?;
    Ok(raw
        .and_then(|v| serde_json::from_str::<CaptureDestination>(&v).ok())
        .filter(|d| d.validate().is_ok()))
}

pub async fn save(pool: &SqlitePool, account_id: &str, destination: &CaptureDestination) -> Result<()> {
    let destination = CaptureDestination {
        folder: normalize_folder(&destination.folder)?,
        ..destination.clone()
    };
    destination.validate()?;
    let value = serde_json::to_string(&destination).map_err(|e| AppError::Other(format!("Could not store the capture drive: {e}")))?;
    crate::utils::preferences::save_user_preference_internal(pool, &key_for(account_id), &value).await
}

/// One of this account's drives synced on this machine, as a new captures
/// folder is checked against: a captures drive is never made inside another
/// drive, nor around one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveHere {
    pub label: String,
    pub path: std::path::PathBuf,
    /// A drive shared WITH this account: never offered as the captures drive.
    pub member: bool,
}

/// Every drive of this account synced on this machine, paused ones included
/// (a paused drive still owns its folder).
pub async fn drives_here(pool: &SqlitePool, account_id: &str) -> Result<Vec<DriveHere>> {
    use sqlx::Row;
    let owner = crate::auth::account_key::account_key(account_id);
    let rows = sqlx::query(
        "SELECT label, path, owner_ss58 FROM sync_paths
         WHERE owner = ? AND label != 'migration'
         ORDER BY id",
    )
    .bind(&owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| DriveHere {
            label: row.get::<String, _>("label"),
            path: std::path::PathBuf::from(row.get::<String, _>("path")),
            member: row.get::<Option<String>, _>("owner_ss58").is_some(),
        })
        .collect())
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
        CaptureDestination::own(label, label)
    }

    #[test]
    fn a_folder_name_is_stored_in_one_form() {
        assert_eq!(normalize_folder("Captures").unwrap(), "Captures");
        assert_eq!(normalize_folder(" /Work\\Screens/ ").unwrap(), "Work/Screens");
        assert_eq!(normalize_folder("My Shots / 2026").unwrap(), "My Shots/2026");
        // Blank is the drive's root, where the captures drive keeps them.
        assert_eq!(normalize_folder("").unwrap(), "");
        assert_eq!(normalize_folder(" / ").unwrap(), "");
    }

    /// The captures drive files them at its root: the path in the drive is
    /// the file name alone, and a direct upload names no folder.
    #[test]
    fn a_capture_at_the_drives_root_has_no_folder_in_its_path() {
        let root = own("Captures");
        assert_eq!(root.rel_path("a.png"), "a.png");
        assert_eq!(root.upload_folder(), None);
        let mut inside = own("Work");
        inside.folder = "Captures".into();
        assert_eq!(inside.rel_path("a.png"), "Captures/a.png");
        assert_eq!(inside.upload_folder().as_deref(), Some("Captures"));
    }

    /// A name the engine would skip, or Windows could not create, is refused
    /// with a sentence rather than a capture that never syncs.
    #[test]
    fn a_folder_name_that_would_not_sync_is_refused() {
        for bad in ["a//b", "..", "a/../b", ".hidden", "Work/.git", "Shots.", "a:b", "x?y", "pipe|d"] {
            assert!(matches!(normalize_folder(bad), Err(AppError::Validation(_))), "{bad:?}");
        }
        assert!(normalize_folder(&"x".repeat(256)).is_err());
    }

    /// A choice made before captures had a drive of their own (a folder in
    /// another drive, under the v1 key) is not read: the account is asked
    /// where its captures drive goes.
    #[tokio::test]
    async fn a_choice_from_before_the_captures_drive_is_not_read() {
        let pool = pool().await;
        let v1 = format!("capture_destination_v1:{}", crate::auth::account_key::account_key("5Alice"));
        crate::utils::preferences::save_user_preference_internal(&pool, &v1, r#"{"label":"Work","displayName":"Work","folder":"Captures"}"#)
            .await
            .unwrap();
        assert_eq!(load(&pool, "5Alice").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_chosen_folder_is_saved_normalised() {
        let pool = pool().await;
        let mut d = own("Work");
        d.folder = "/Screens\\2026/".into();
        save(&pool, "5Alice", &d).await.unwrap();
        let loaded = load(&pool, "5Alice").await.unwrap().unwrap();
        assert_eq!(loaded.folder, "Screens/2026");
        assert_eq!(loaded.rel_path("a.png"), "Screens/2026/a.png");
        d.folder = "..".into();
        assert!(save(&pool, "5Alice", &d).await.is_err());
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
    async fn drives_here_and_where_captures_go_through_them() {
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
        let here = drives_here(&pool, "5Alice").await.unwrap();
        assert_eq!(
            here.iter().map(|d| (d.label.as_str(), d.member)).collect::<Vec<_>>(),
            vec![("Work", false), ("Paused", false), ("Team", true)],
            "added order, member drives marked, never the migration pseudo-drive"
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
        assert!(drives_here(&pool, "5Bob").await.unwrap().is_empty());
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
