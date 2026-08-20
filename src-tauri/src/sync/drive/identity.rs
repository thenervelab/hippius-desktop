//! Drive wire-identity resolution — the single decoupling point between a
//! drive's LOCAL label and its WIRE identity on hcfs-server.
//!
//! An OWN drive's wire identity is derived from the session account and the
//! label (`ss58 = account_id`, `folder_hash = folder_hash(label)`), exactly as
//! every pre-shared-drives code path computed it inline. A MEMBER drive
//! (shared-drives phase 2) syncs another account's folder, so its wire
//! identity is the OWNER's ss58 plus the owner's folder hash, persisted on
//! the drive's `sync_paths` row (`owner_ss58` / `wire_folder_hash`). Every
//! drive-scoped call that today derives `folder_hash(local_label)` must go
//! through [`resolve_drive_identity`] instead — a member's local label CANNOT
//! derive the wire hash.

use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use sqlx::sqlite::SqlitePool;

/// The wire identity a drive presents to hcfs-server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveIdentity {
    /// The ss58 address the server knows this folder under — the session
    /// account for an own drive, the drive OWNER's address for a member drive.
    pub wire_ss58: String,
    /// The server-side folder hash — `folder_hash(label)` for an own drive,
    /// the OWNER's folder hash for a member drive.
    pub wire_folder_hash: String,
    /// True when this device syncs the drive as an invited member rather
    /// than as its owner.
    pub is_member: bool,
}

/// The wire identity to persist onto a NEW member drive's `sync_paths` row.
///
/// Carried by `paths::LabelMode::Allocate` (member drives are only ever
/// created through the allocate path — see the `LabelMode` docs for why
/// `Exact` never carries one) and written into the `owner_ss58` /
/// `wire_folder_hash` columns that [`resolve_drive_identity`] later reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDriveIdentity {
    /// The drive OWNER's ss58 address (never the member's own).
    pub owner_ss58: String,
    /// The OWNER's server-side folder hash (16 lowercase hex chars).
    pub wire_folder_hash: String,
}

impl MemberDriveIdentity {
    /// Fail closed BEFORE the row is written. Persisting an invalid identity
    /// would create a drive that [`resolve_drive_identity`] can only ever
    /// refuse — a bricked slot the user must remove by hand — so the write
    /// path rejects it as `Validation` (bad caller input) instead of letting
    /// the read path discover it later as a corrupt row.
    pub fn validate(&self) -> Result<()> {
        if self.owner_ss58.is_empty() {
            return Err(AppError::Validation("member drive owner_ss58 must not be empty".into()));
        }
        if !is_wire_folder_hash(&self.wire_folder_hash) {
            return Err(AppError::Validation(format!(
                "member drive wire_folder_hash must be 16 lowercase hex chars, got '{}'",
                self.wire_folder_hash
            )));
        }
        Ok(())
    }
}

/// Resolve the wire identity for `(account_id, label)` from its `sync_paths`
/// row.
///
/// Both member columns NULL is the own-drive shape and resolves to
/// `(account_id, folder_hash(label), false)` — byte-identical to the values
/// every existing call site derives today. Both set is the member shape and
/// resolves to the persisted pair. Exactly one set is a corrupt row and fails
/// closed as [`AppError::Db`] (`sqlx::Error::Decode`, the corrupt-row
/// convention from `shares::history`): syncing under a half-resolved identity
/// could upload into the wrong namespace, so no fallback is safe. A missing
/// row mirrors `shares::commands::sync_root_for_label`'s
/// "Unknown sync folder label" `Validation` error — deliberately NOT the
/// FE-silenced `Auth`/`NotReady` kinds.
///
/// Call discipline: resolve ONCE at the top of an operation's funnel and
/// thread the `Clone`-able [`DriveIdentity`] down to every consumer. Never
/// re-resolve at individual call sites — each resolve is an independent DB
/// read, so two resolves inside one operation can observe DIFFERENT rows
/// (a concurrent remove/re-add of the label) and split the operation across
/// two wire identities.
pub async fn resolve_drive_identity(pool: &SqlitePool, account_id: &str, label: &str) -> Result<DriveIdentity> {
    let owner = account_key(account_id);
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT owner_ss58, wire_folder_hash FROM sync_paths WHERE owner = ? AND label = ?")
            .bind(&owner)
            .bind(label)
            .fetch_optional(pool)
            .await?;

    let Some((owner_ss58, wire_folder_hash)) = row else {
        return Err(AppError::Validation(format!("Unknown sync folder label: {label}")));
    };

    match (owner_ss58, wire_folder_hash) {
        (None, None) => Ok(DriveIdentity {
            wire_ss58: account_id.to_string(),
            wire_folder_hash: crate::sync::mnemonic::folder_hash(label),
            is_member: false,
        }),
        (Some(ss58), Some(hash)) => {
            if ss58.is_empty() {
                return Err(corrupt_member_row(label, "owner_ss58 is empty"));
            }
            if !is_wire_folder_hash(&hash) {
                return Err(corrupt_member_row(label, "wire_folder_hash is not 16 lowercase hex chars"));
            }
            Ok(DriveIdentity {
                wire_ss58: ss58,
                wire_folder_hash: hash,
                is_member: true,
            })
        }
        (Some(_), None) => Err(corrupt_member_row(label, "owner_ss58 set without wire_folder_hash")),
        (None, Some(_)) => Err(corrupt_member_row(label, "wire_folder_hash set without owner_ss58")),
    }
}

/// A `sync_paths` row whose member-identity columns violate the "both NULL or
/// both valid" invariant. Surfaced as `AppError::Db(sqlx::Error::Decode)` —
/// the same shape `shares::history` uses for a row value that violates an
/// application invariant — so the FE gets a surfaced `kind: "Db"` rather than
/// a silenced `Auth`/`NotReady`.
fn corrupt_member_row(label: &str, detail: &str) -> AppError {
    AppError::Db(sqlx::Error::Decode(
        format!("sync_paths row for label '{label}' has a corrupt shared-drive identity: {detail}").into(),
    ))
}

/// A wire folder hash is exactly 16 lowercase hex chars — the shape
/// `hcfs_client::drive::keys::folder_hash` produces and hcfs-server keys
/// folders by. Anything else on a member row is corruption, not a value we
/// can normalize.
fn is_wire_folder_hash(hash: &str) -> bool {
    hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory pool with the production `sync_paths` shape (incl. the
    /// member-identity columns) — the same in-file sqlite pattern as the
    /// `drive::paths` tests.
    async fn make_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                timestamp INTEGER NOT NULL,
                is_paused INTEGER NOT NULL DEFAULT 0,
                owner_ss58 TEXT,
                wire_folder_hash TEXT,
                UNIQUE(owner, label)
            )",
        )
        .execute(&pool)
        .await
        .expect("schema");
        pool
    }

    async fn insert_row(pool: &SqlitePool, account_id: &str, label: &str, owner_ss58: Option<&str>, wire_folder_hash: Option<&str>) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, owner_ss58, wire_folder_hash)
             VALUES (?, '/p', 'private', ?, 0, ?, ?)",
        )
        .bind(account_key(account_id))
        .bind(label)
        .bind(owner_ss58)
        .bind(wire_folder_hash)
        .execute(pool)
        .await
        .expect("insert row");
    }

    const ACCT: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const OWNER: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const WIRE_HASH: &str = "0123456789abcdef";

    fn assert_corrupt_row(err: AppError, ctx: &str) {
        match err {
            AppError::Db(sqlx::Error::Decode(_)) => {}
            other => panic!("{ctx}: expected AppError::Db(Decode) fail-closed, got {other:?}"),
        }
    }

    // Own drive: NULL columns resolve to the session account + the label's
    // own folder hash — byte-identical to what every pre-resolver call site
    // computes inline today.
    #[tokio::test]
    async fn own_drive_resolves_to_account_and_label_hash() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "docs", None, None).await;

        let id = resolve_drive_identity(&pool, ACCT, "docs").await.expect("resolve own drive");
        assert_eq!(
            id,
            DriveIdentity {
                wire_ss58: ACCT.to_string(),
                wire_folder_hash: crate::sync::mnemonic::folder_hash("docs"),
                is_member: false,
            }
        );
    }

    // Member drive: both columns set resolve to the persisted owner identity,
    // never anything derived from the local label.
    #[tokio::test]
    async fn member_drive_resolves_to_persisted_owner_identity() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "shared-docs", Some(OWNER), Some(WIRE_HASH)).await;

        let id = resolve_drive_identity(&pool, ACCT, "shared-docs").await.expect("resolve member drive");
        assert_eq!(
            id,
            DriveIdentity {
                wire_ss58: OWNER.to_string(),
                wire_folder_hash: WIRE_HASH.to_string(),
                is_member: true
            }
        );
        assert_ne!(
            id.wire_folder_hash,
            crate::sync::mnemonic::folder_hash("shared-docs"),
            "the member wire hash must not collide with the local-label derivation this test means to bypass"
        );
    }

    // Exactly one column set is a corrupt row: syncing under a half-resolved
    // identity could target the wrong namespace, so both halves fail closed.
    #[tokio::test]
    async fn owner_without_hash_fails_closed() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "half-a", Some(OWNER), None).await;

        let err = resolve_drive_identity(&pool, ACCT, "half-a").await.expect_err("half-set row must fail");
        assert_corrupt_row(err, "owner_ss58 without wire_folder_hash");
    }

    #[tokio::test]
    async fn hash_without_owner_fails_closed() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "half-b", None, Some(WIRE_HASH)).await;

        let err = resolve_drive_identity(&pool, ACCT, "half-b").await.expect_err("half-set row must fail");
        assert_corrupt_row(err, "wire_folder_hash without owner_ss58");
    }

    // A member row whose wire hash is not 16 lowercase hex chars is corrupt —
    // wrong length, uppercase, and non-hex are each rejected, as is an empty
    // owner_ss58.
    #[tokio::test]
    async fn malformed_wire_hash_fails_closed() {
        let pool = make_pool().await;
        for (label, bad_hash) in [
            ("short", "0123456789abcde"),
            ("long", "0123456789abcdef0"),
            ("upper", "0123456789ABCDEF"),
            ("nonhex", "0123456789abcdeg"),
        ] {
            insert_row(&pool, ACCT, label, Some(OWNER), Some(bad_hash)).await;
            let err = resolve_drive_identity(&pool, ACCT, label).await.expect_err("malformed hash must fail");
            assert_corrupt_row(err, label);
        }
    }

    #[tokio::test]
    async fn empty_owner_ss58_fails_closed() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "empty-owner", Some(""), Some(WIRE_HASH)).await;

        let err = resolve_drive_identity(&pool, ACCT, "empty-owner")
            .await
            .expect_err("empty owner must fail");
        assert_corrupt_row(err, "empty owner_ss58");
    }

    // Cross-pin the validator to the producer: every own-drive wire hash the
    // desktop mints comes from `folder_hash`, so the member-row shape check
    // must accept exactly that shape. An hcfs bump that changes the hash
    // format fails HERE, not later as "every member row is corrupt".
    #[test]
    fn wire_hash_validator_accepts_the_producers_shape() {
        assert!(
            is_wire_folder_hash(&crate::sync::mnemonic::folder_hash("any-label")),
            "is_wire_folder_hash must accept what folder_hash produces"
        );
    }

    // Missing row mirrors sync_root_for_label: a surfaced Validation error,
    // never the FE-silenced Auth/NotReady kinds.
    #[tokio::test]
    async fn missing_row_is_validation_error() {
        let pool = make_pool().await;

        let err = resolve_drive_identity(&pool, ACCT, "nope").await.expect_err("missing row must fail");
        match err {
            AppError::Validation(msg) => assert!(msg.contains("nope"), "message names the label: {msg}"),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    // Rows are scoped by account_key(account_id): another account's member
    // row for the same label is invisible, not inherited.
    #[tokio::test]
    async fn member_row_is_scoped_to_its_account() {
        let pool = make_pool().await;
        insert_row(&pool, ACCT, "team", Some(OWNER), Some(WIRE_HASH)).await;

        let err = resolve_drive_identity(&pool, OWNER, "team")
            .await
            .expect_err("other account must not see the row");
        assert!(
            matches!(err, AppError::Validation(_)),
            "foreign account resolves to a missing row, got {err:?}"
        );
    }
}
