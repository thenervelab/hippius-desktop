//! `local_wallets` table CRUD.
//!
//! Each row stores one user-created Substrate wallet: a friendly name, the
//! polkadot address derived from the mnemonic, the AEAD-encrypted mnemonic,
//! and a SHA-256 password hash for fast verification before attempting the
//! AEAD decrypt.
//!
//! Rows are scoped to the logged-in account via the `owner` column
//! (`account_key(substrate_address)`), mirroring `sync_paths`. Every CRUD
//! function takes an `owner` argument and all queries filter on it — a
//! wallet created under account A is invisible to (and unmodifiable from)
//! account B, even if both know its `id`.
//!
//! Only one row at a time has `is_active = 1` PER OWNER — the constraint is
//! enforced in [`set_active`] (clear all owner rows → set one), not via a
//! partial unique index, so multiple accounts can each have their own
//! active wallet without colliding.
//!
//! `UNIQUE(owner, address)` is enforced in the DDL (see
//! `utils/schema::ensure_table_schema`); duplicate-address inserts under
//! the same owner are rejected pre-insert by [`insert`] with a friendlier
//! error than the raw SQLite UNIQUE-violation string.

use crate::error::AppError;
use serde::Serialize;
use sqlx::SqlitePool;

/// One row of the `local_wallets` table. Field naming is camelCase to match
/// the TS consumer shape (the original TS impl on `feature/wallet-updates`).
///
/// The crate's `sqlx` dependency is built without the `macros` feature so
/// `#[derive(FromRow)]` is unavailable; we map rows manually via tuples
/// returned by `query_as` and convert them into this struct.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWallet {
    pub id: i64,
    pub name: String,
    pub address: String,
    pub encrypted_mnemonic: String,
    pub password_hash: String,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

type WalletRow = (i64, String, String, String, String, i64, i64, i64);

impl From<WalletRow> for LocalWallet {
    fn from(r: WalletRow) -> Self {
        Self {
            id: r.0,
            name: r.1,
            address: r.2,
            encrypted_mnemonic: r.3,
            password_hash: r.4,
            is_active: r.5 != 0,
            created_at: r.6,
            updated_at: r.7,
        }
    }
}

const SELECT_COLS: &str =
    "id, name, address, encrypted_mnemonic, password_hash, is_active, created_at, updated_at";

/// Public projection of `LocalWallet` that excludes the encrypted mnemonic
/// and password hash. The full struct can leak into FE state via
/// react-query caches; the projection is what IPC list-style commands
/// return so secrets never traverse the IPC boundary unless explicitly
/// requested (via `get_decrypted_mnemonic`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicLocalWallet {
    pub id: i64,
    pub name: String,
    pub address: String,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<&LocalWallet> for PublicLocalWallet {
    fn from(w: &LocalWallet) -> Self {
        Self {
            id: w.id,
            name: w.name.clone(),
            address: w.address.clone(),
            is_active: w.is_active,
            created_at: w.created_at,
            updated_at: w.updated_at,
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Insert a wallet row under `owner`. Returns the newly-created row.
///
/// The first wallet ever inserted FOR THIS OWNER is automatically marked
/// active so callers don't need to follow up with `set_active`. Other
/// owners' active wallets are unaffected — the "exactly one active per
/// owner" invariant is owner-scoped.
pub async fn insert(
    pool: &SqlitePool,
    owner: &str,
    name: &str,
    address: &str,
    encrypted_mnemonic: &str,
    password_hash: &str,
) -> Result<LocalWallet, AppError> {
    if let Some(_existing) = get_by_address(pool, owner, address).await? {
        return Err(AppError::Other("A wallet with this address already exists".into()));
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_wallets WHERE owner = ?")
        .bind(owner)
        .fetch_one(pool)
        .await?;
    let is_first = count == 0;
    let now = now_ms();

    sqlx::query(
        r#"
        INSERT INTO local_wallets
            (owner, name, address, encrypted_mnemonic, password_hash, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(owner)
    .bind(name)
    .bind(address)
    .bind(encrypted_mnemonic)
    .bind(password_hash)
    .bind(if is_first { 1 } else { 0 })
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    get_by_address(pool, owner, address)
        .await?
        .ok_or_else(|| AppError::Other("inserted wallet missing on re-read".into()))
}

pub async fn list_all(pool: &SqlitePool, owner: &str) -> Result<Vec<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE owner = ? ORDER BY created_at ASC");
    let rows = sqlx::query_as::<_, WalletRow>(&sql).bind(owner).fetch_all(pool).await?;
    Ok(rows.into_iter().map(LocalWallet::from).collect())
}

pub async fn count_for_owner(pool: &SqlitePool, owner: &str) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_wallets WHERE owner = ?")
        .bind(owner)
        .fetch_one(pool)
        .await?;
    Ok(count)
}

pub async fn get_active(pool: &SqlitePool, owner: &str) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE owner = ? AND is_active = 1 LIMIT 1");
    let row = sqlx::query_as::<_, WalletRow>(&sql).bind(owner).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

/// Look up a wallet by id, but only if it belongs to `owner`. Returning
/// `None` for cross-owner ids is intentional: it makes a stale wallet id
/// from another account behave identically to a deleted wallet, so the
/// IPC layer doesn't have to distinguish "missing" from "not yours".
pub async fn get_by_id(pool: &SqlitePool, owner: &str, id: i64) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE id = ? AND owner = ?");
    let row = sqlx::query_as::<_, WalletRow>(&sql).bind(id).bind(owner).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

pub async fn get_by_address(pool: &SqlitePool, owner: &str, address: &str) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE owner = ? AND address = ?");
    let row = sqlx::query_as::<_, WalletRow>(&sql).bind(owner).bind(address).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

/// Mark `id` as the single active wallet for `owner`. Other owners' active
/// wallets are not touched — the UPDATE is scoped via `WHERE owner = ?` so
/// switching wallets under one account never affects another logged-in
/// account on the same machine.
pub async fn set_active(pool: &SqlitePool, owner: &str, id: i64) -> Result<(), AppError> {
    let now = now_ms();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE local_wallets SET is_active = 0, updated_at = ? WHERE owner = ?")
        .bind(now)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE local_wallets SET is_active = 1, updated_at = ? WHERE id = ? AND owner = ?")
        .bind(now)
        .bind(id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn rename(pool: &SqlitePool, owner: &str, id: i64, name: &str) -> Result<(), AppError> {
    let now = now_ms();
    sqlx::query("UPDATE local_wallets SET name = ?, updated_at = ? WHERE id = ? AND owner = ?")
        .bind(name)
        .bind(now)
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete a wallet. If the deleted wallet was active, promotes the first
/// remaining wallet under the same owner (by creation order) to active so
/// the UI never has zero-active-and-non-empty state for that account.
pub async fn delete(pool: &SqlitePool, owner: &str, id: i64) -> Result<(), AppError> {
    let target = match get_by_id(pool, owner, id).await? {
        Some(w) => w,
        None => return Ok(()),
    };

    sqlx::query("DELETE FROM local_wallets WHERE id = ? AND owner = ?")
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?;

    if target.is_active {
        let remaining = list_all(pool, owner).await?;
        if let Some(next) = remaining.first() {
            set_active(pool, owner, next.id).await?;
        }
    }
    Ok(())
}
