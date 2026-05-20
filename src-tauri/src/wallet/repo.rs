//! `local_wallets` table CRUD.
//!
//! Each row stores one user-created Substrate wallet: a friendly name, the
//! polkadot address derived from the mnemonic, the AEAD-encrypted mnemonic,
//! and a SHA-256 password hash for fast verification before attempting the
//! AEAD decrypt.
//!
//! Only one row at a time has `is_active = 1` — the constraint is enforced in
//! [`set_active`] (clear all → set one) rather than via a partial unique
//! index, which would conflict with the legacy `feature/wallet-updates`
//! schema we're migrating from.

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

/// Insert a wallet row. Returns the newly-created row.
///
/// The first wallet ever inserted is automatically marked active so
/// callers don't need to follow up with `set_active`.
pub async fn insert(
    pool: &SqlitePool,
    name: &str,
    address: &str,
    encrypted_mnemonic: &str,
    password_hash: &str,
) -> Result<LocalWallet, AppError> {
    // Reject duplicates before insert so the error message is friendlier
    // than the raw "UNIQUE constraint failed: ..." SQLite would give.
    if let Some(_existing) = get_by_address(pool, address).await? {
        return Err(AppError::Other("A wallet with this address already exists".into()));
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_wallets").fetch_one(pool).await?;
    let is_first = count == 0;
    let now = now_ms();

    sqlx::query(
        r#"
        INSERT INTO local_wallets
            (name, address, encrypted_mnemonic, password_hash, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(name)
    .bind(address)
    .bind(encrypted_mnemonic)
    .bind(password_hash)
    .bind(if is_first { 1 } else { 0 })
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    // Re-fetch so we return the row Sqlite actually persisted (including the
    // auto-assigned id and any default-clamp surprises).
    get_by_address(pool, address)
        .await?
        .ok_or_else(|| AppError::Other("inserted wallet missing on re-read".into()))
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets ORDER BY created_at ASC");
    let rows = sqlx::query_as::<_, WalletRow>(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(LocalWallet::from).collect())
}

pub async fn get_active(pool: &SqlitePool) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE is_active = 1 LIMIT 1");
    let row = sqlx::query_as::<_, WalletRow>(&sql).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE id = ?");
    let row = sqlx::query_as::<_, WalletRow>(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

pub async fn get_by_address(pool: &SqlitePool, address: &str) -> Result<Option<LocalWallet>, AppError> {
    let sql = format!("SELECT {SELECT_COLS} FROM local_wallets WHERE address = ?");
    let row = sqlx::query_as::<_, WalletRow>(&sql).bind(address).fetch_optional(pool).await?;
    Ok(row.map(LocalWallet::from))
}

/// Mark `id` as the single active wallet. Atomically clears `is_active` on
/// every other row first to satisfy the "only one active" invariant.
pub async fn set_active(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    let now = now_ms();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE local_wallets SET is_active = 0, updated_at = ?")
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE local_wallets SET is_active = 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<(), AppError> {
    let now = now_ms();
    sqlx::query("UPDATE local_wallets SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete a wallet. If the deleted wallet was active, promotes the first
/// remaining wallet (by creation order) to active so the UI never has
/// zero-active-and-non-empty state.
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    let target = match get_by_id(pool, id).await? {
        Some(w) => w,
        None => return Ok(()),
    };

    sqlx::query("DELETE FROM local_wallets WHERE id = ?").bind(id).execute(pool).await?;

    if target.is_active {
        let remaining = list_all(pool).await?;
        if let Some(next) = remaining.first() {
            set_active(pool, next.id).await?;
        }
    }
    Ok(())
}
