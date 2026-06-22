//! Locally-tracked bridge transactions, backed by the SQLite `bridge_transactions`
//! table — replaces the renderer's localStorage tracker (audit TSLOGIC-7).
//!
//! The chain explorer reads (`explorer.rs`) are the authoritative status; these
//! rows record what THIS device submitted (a `pending` row from the moment of
//! submit, keyed by the extrinsic hash so a retry dedupes). Owner-scoped by
//! `account_key`, mirroring `share_origin`/`auth_session`.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::auth::account_key::account_key;
use crate::error::Result;

/// Cap returned to the FE — newest first; older rows age out of the list (the
/// chain remains the source of truth for anything beyond this window).
const MAX_ROWS: i64 = 100;

/// A tracked bridge transaction row, as returned to the frontend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTxRow {
    pub id: String,
    pub direction: String,
    pub status: String,
    pub amount: String,
    pub sender: Option<String>,
    pub recipient: Option<String>,
    pub source_tx_hash: Option<String>,
    pub deposit_id: Option<String>,
    pub withdrawal_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub error: Option<String>,
}

/// SELECT column order for the row tuple — `#[derive(FromRow)]` is unavailable
/// in this build (sqlx without the `macros` feature), so rows are mapped by
/// position, like `wallet::repo`.
type BridgeRowTuple = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<String>,
);

const SELECT_COLS: &str =
    "id, direction, status, amount, sender, recipient, source_tx_hash, deposit_id, withdrawal_id, created_at, updated_at, error";

fn to_row(r: BridgeRowTuple) -> BridgeTxRow {
    BridgeTxRow {
        id: r.0,
        direction: r.1,
        status: r.2,
        amount: r.3,
        sender: r.4,
        recipient: r.5,
        source_tx_hash: r.6,
        deposit_id: r.7,
        withdrawal_id: r.8,
        created_at: r.9,
        updated_at: r.10,
        error: r.11,
    }
}

/// Fields a freshly-submitted bridge transaction is recorded with.
pub struct NewBridgeTx<'a> {
    /// `"alpha-to-halpha"` | `"halpha-to-alpha"`.
    pub direction: &'a str,
    /// Initial status (`"pending"` on submit).
    pub status: &'a str,
    /// Source-side amount, rao decimal string.
    pub amount: &'a str,
    pub sender: Option<&'a str>,
    pub recipient: Option<&'a str>,
    /// Extrinsic hash — the row id (stable, dedupes a retry).
    pub source_tx_hash: &'a str,
    pub deposit_id: Option<&'a str>,
    pub withdrawal_id: Option<&'a str>,
}

/// Record (or upsert by tx hash) a submitted bridge transaction for `account_id`.
///
/// Best-effort: callers log on error — a tracking-row miss must never fail the
/// already-successful on-chain submit.
///
/// # Errors
/// Propagates a hard SQLite failure.
pub async fn record_bridge_tx(pool: &SqlitePool, account_id: &str, tx: &NewBridgeTx<'_>) -> Result<()> {
    let owner = account_key(account_id);
    sqlx::query(
        "INSERT INTO bridge_transactions \
         (id, owner, direction, status, amount, sender, recipient, source_tx_hash, deposit_id, withdrawal_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           status = excluded.status, deposit_id = excluded.deposit_id, \
           withdrawal_id = excluded.withdrawal_id, updated_at = unixepoch()",
    )
    .bind(tx.source_tx_hash)
    .bind(&owner)
    .bind(tx.direction)
    .bind(tx.status)
    .bind(tx.amount)
    .bind(tx.sender)
    .bind(tx.recipient)
    .bind(tx.source_tx_hash)
    .bind(tx.deposit_id)
    .bind(tx.withdrawal_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Best-effort record from a write command: resolve the account + pool from
/// `state`, insert a `pending` row, log on failure. Keeps the deposit/withdraw
/// commands to a single call site (and short).
pub async fn record_submitted(
    state: &tauri::State<'_, crate::app_state::AppState>,
    direction: &str,
    amount: u128,
    sender: &str,
    recipient: Option<&str>,
    source_tx_hash: &str,
    // The bridge request id — a deposit id for alpha→halpha, a withdrawal id for
    // halpha→alpha (only one applies per direction).
    request_id: Option<&str>,
) {
    let (Ok(account_id), Ok(pool)) = (state.current_account_id(), state.pool()) else {
        return;
    };
    let (deposit_id, withdrawal_id) = if direction == "alpha-to-halpha" {
        (request_id, None)
    } else {
        (None, request_id)
    };
    let amount = amount.to_string();
    let rec = NewBridgeTx {
        direction,
        status: "pending",
        amount: &amount,
        sender: Some(sender),
        recipient: recipient.or(Some(sender)),
        source_tx_hash,
        deposit_id,
        withdrawal_id,
    };
    if let Err(e) = record_bridge_tx(pool, &account_id, &rec).await {
        tracing::warn!(error = %e, direction, "failed to record bridge tx in history");
    }
}

/// List the active account's tracked bridge transactions, newest first.
///
/// # Errors
/// [`crate::error::AppError`] if there is no active session or the DB read fails.
#[tauri::command]
pub async fn bridge_list_transactions(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Vec<BridgeTxRow>> {
    let account_id = state.current_account_id()?;
    let owner = account_key(&account_id);
    let pool = state.pool()?;
    let rows = sqlx::query_as::<_, BridgeRowTuple>(&format!(
        "SELECT {SELECT_COLS} FROM bridge_transactions WHERE owner = ? ORDER BY created_at DESC LIMIT ?"
    ))
    .bind(&owner)
    .bind(MAX_ROWS)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(to_row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool_with_table() -> SqlitePool {
        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.expect("pool");
        sqlx::query(
            "CREATE TABLE bridge_transactions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, direction TEXT NOT NULL, \
             status TEXT NOT NULL, amount TEXT NOT NULL, sender TEXT, recipient TEXT, source_tx_hash TEXT, \
             deposit_id TEXT, withdrawal_id TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), \
             updated_at INTEGER NOT NULL DEFAULT (unixepoch()), error TEXT)",
        )
        .execute(&pool)
        .await
        .expect("create");
        pool
    }

    fn sample<'a>(hash: &'a str) -> NewBridgeTx<'a> {
        NewBridgeTx {
            direction: "halpha-to-alpha",
            status: "pending",
            amount: "15000000000000000000",
            sender: Some("5Sender"),
            recipient: Some("5Recipient"),
            source_tx_hash: hash,
            deposit_id: None,
            withdrawal_id: Some("0xabcd"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn records_lists_and_is_owner_scoped() {
        let pool = pool_with_table().await;
        record_bridge_tx(&pool, "5AccountA", &sample("0xhash1")).await.expect("record A");
        record_bridge_tx(&pool, "5AccountB", &sample("0xhash2")).await.expect("record B");

        // Owner-scoped list: A sees only its own row.
        let owner_a = account_key("5AccountA");
        let fetch_a = || async {
            let t = sqlx::query_as::<_, BridgeRowTuple>(&format!("SELECT {SELECT_COLS} FROM bridge_transactions WHERE owner = ?"))
                .bind(&owner_a)
                .fetch_all(&pool)
                .await
                .expect("query");
            t.into_iter().map(to_row).collect::<Vec<_>>()
        };
        let rows = fetch_a().await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "0xhash1");
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[0].withdrawal_id.as_deref(), Some("0xabcd"));

        // Upsert by tx hash: a status update on the same hash mutates, not dupes.
        let mut updated = sample("0xhash1");
        updated.status = "completed";
        record_bridge_tx(&pool, "5AccountA", &updated).await.expect("upsert");
        let again = fetch_a().await;
        assert_eq!(again.len(), 1, "upsert must not duplicate");
        assert_eq!(again[0].status, "completed");
    }
}
