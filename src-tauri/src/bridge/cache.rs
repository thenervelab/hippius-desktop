//! SQLite persistence for tracked bridge transactions.
//!
//! Replaces the `localStorage` map in `hippius-web/src/lib/bridge/service.ts`.
//! Rows are scoped by `owner` (the auth account id) so a user only
//! ever sees their own transactions, even after a logout / login
//! cycle. The schema is created in `utils/schema.rs` alongside
//! `address_book` and `local_wallets`.

use crate::bridge::types::{BridgeTransactionEvent, TrackedBridgeTransaction};
use crate::error::AppError;
use sqlx::{Row, SqlitePool};

/// Insert a new tracked transaction. Returns the inserted row's id
/// (same value as `tx.id` — kept for symmetry with sqlx's
/// `last_insert_rowid`-style helpers).
pub async fn insert(pool: &SqlitePool, owner: &str, tx: &TrackedBridgeTransaction) -> Result<String, AppError> {
    let events_json = serde_json::to_string(&tx.events)
        .map_err(|e| AppError::Other(format!("serialize events: {e}")))?;
    sqlx::query(
        "INSERT INTO bridge_transactions (
            id, owner, direction, status,
            amount_planck, amount_decimals,
            sender_address, recipient_address,
            source_tx_hash, destination_tx_hash,
            deposit_id, withdrawal_id,
            created_at, updated_at,
            error, attestations, required_attestations,
            events_json, denial_reason, refunded
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&tx.id)
    .bind(owner)
    .bind(&tx.direction)
    .bind(&tx.status)
    .bind(&tx.amount)
    .bind(tx.amount_decimals as i64)
    .bind(&tx.sender_address)
    .bind(&tx.recipient_address)
    .bind(&tx.source_tx_hash)
    .bind(&tx.destination_tx_hash)
    .bind(&tx.deposit_id)
    .bind(&tx.withdrawal_id)
    .bind(tx.created_at)
    .bind(tx.updated_at)
    .bind(&tx.error)
    .bind(tx.attestations as i64)
    .bind(tx.required_attestations as i64)
    .bind(&events_json)
    .bind(&tx.denial_reason)
    .bind(tx.refunded as i64)
    .execute(pool)
    .await?;
    Ok(tx.id.clone())
}

/// Append an event to a transaction's `events_json` and bump
/// `updated_at`. Returns `Ok(false)` if no row matched the
/// (owner, id) pair so callers can decide whether to log it.
pub async fn append_event(
    pool: &SqlitePool,
    owner: &str,
    id: &str,
    event: BridgeTransactionEvent,
) -> Result<bool, AppError> {
    let existing = sqlx::query("SELECT events_json FROM bridge_transactions WHERE owner = ? AND id = ?")
        .bind(owner)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let Some(row) = existing else {
        return Ok(false);
    };
    let events_json: String = row.get("events_json");
    let mut events: Vec<BridgeTransactionEvent> = serde_json::from_str(&events_json).unwrap_or_default();
    events.push(event);
    let serialized = serde_json::to_string(&events)
        .map_err(|e| AppError::Other(format!("serialize events: {e}")))?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    sqlx::query("UPDATE bridge_transactions SET events_json = ?, updated_at = ? WHERE owner = ? AND id = ?")
        .bind(&serialized)
        .bind(now_ms)
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(true)
}

/// Mutate the high-level status of a transaction. `error_message`
/// when set is stored on the row for the failure-state UI.
pub async fn set_status(
    pool: &SqlitePool,
    owner: &str,
    id: &str,
    status: &str,
    error_message: Option<&str>,
) -> Result<(), AppError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    sqlx::query("UPDATE bridge_transactions SET status = ?, error = ?, updated_at = ? WHERE owner = ? AND id = ?")
        .bind(status)
        .bind(error_message)
        .bind(now_ms)
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Record the source-chain extrinsic hash after the user signs and
/// submits. Stored separately from the high-level status so the
/// "Submitted" state has a hash to render even if the row is still
/// pending confirmation.
pub async fn set_source_tx_hash(
    pool: &SqlitePool,
    owner: &str,
    id: &str,
    tx_hash: &str,
) -> Result<(), AppError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    sqlx::query("UPDATE bridge_transactions SET source_tx_hash = ?, updated_at = ? WHERE owner = ? AND id = ?")
        .bind(tx_hash)
        .bind(now_ms)
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Fetch every tracked transaction for `owner`, newest-first. The
/// caller decides whether to merge in indexer rows on top.
pub async fn list(pool: &SqlitePool, owner: &str) -> Result<Vec<TrackedBridgeTransaction>, AppError> {
    let rows = sqlx::query(
        "SELECT id, direction, status,
                amount_planck, amount_decimals,
                sender_address, recipient_address,
                source_tx_hash, destination_tx_hash,
                deposit_id, withdrawal_id,
                created_at, updated_at,
                error, attestations, required_attestations,
                events_json, denial_reason, refunded
         FROM bridge_transactions
         WHERE owner = ?
         ORDER BY created_at DESC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let events_json: String = row.get("events_json");
        let events = serde_json::from_str::<Vec<BridgeTransactionEvent>>(&events_json).unwrap_or_default();
        out.push(TrackedBridgeTransaction {
            id: row.get("id"),
            direction: row.get("direction"),
            status: row.get("status"),
            amount: row.get("amount_planck"),
            amount_decimals: row.get::<i64, _>("amount_decimals") as u8,
            sender_address: row.get("sender_address"),
            recipient_address: row.get("recipient_address"),
            source_tx_hash: row.get("source_tx_hash"),
            destination_tx_hash: row.get("destination_tx_hash"),
            deposit_id: row.get("deposit_id"),
            withdrawal_id: row.get("withdrawal_id"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            error: row.get("error"),
            attestations: row.get::<i64, _>("attestations") as u32,
            required_attestations: row.get::<i64, _>("required_attestations") as u32,
            events,
            denial_reason: row.get("denial_reason"),
            refunded: row.get::<i64, _>("refunded") != 0,
        });
    }
    Ok(out)
}

/// Generate a 16-byte hex transaction id. Mirrors the web client's
/// `generateTxId` so an upstream merge wouldn't need a rename.
pub fn generate_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let nonce = u64::from_be_bytes(bytes);
    let ts = chrono::Utc::now().timestamp_millis() as u64;
    format!("br_{ts:x}_{nonce:x}")
}
