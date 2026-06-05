//! Address book (contacts) CRUD.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::AppError;
use sqlx::sqlite::SqlitePool;
use tracing::info;

/// Address-book row sent to the frontend.
///
/// `camelCase` rename matches the TS interface in `addressBookDb.ts`; without
/// it the frontend reads `walletAddress`/`dateAdded` as `undefined`, which
/// silently rendered an empty WALLET ADDRESS cell and an "Invalid Date" in
/// DATE ADDED — same convention `BalanceObject` uses (`billing/queries.rs`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub wallet_address: String,
    pub date_added: i64,
}

/// The caller's `owner` key — the `account_key` hash of the active session
/// account, matching the convention used by `sync_paths`. Every contacts query
/// scopes by this so one account can never read or mutate another's contacts.
fn caller_owner(state: &tauri::State<'_, AppState>) -> Result<String, AppError> {
    Ok(account_key(&state.current_account_id()?))
}

/// Adopt every legacy (pre-`owner`-column) contact for `owner`.
///
/// Rows created before the `owner` migration have `owner = ''`. The decided
/// backfill policy is "assign to the first account": the first account to open
/// its address book claims all owner-empty rows; once claimed they are scoped
/// like any other row and no other account can see them. Idempotent — after the
/// first claim there are no `owner = ''` rows left, so this is a 0-row no-op.
///
/// Why first-account-claim is an accepted tradeoff (not a bug): legacy rows
/// predate the `owner` column, so the database holds no attribution for them —
/// there is no recoverable key to scope the claim by. Hippius Desktop is also
/// single-user-per-database (one logged-in account owns each SQLite file; see
/// the same assumption in `crypto::store::migrate_if_needed`), so in practice
/// the "first account" IS the only account. The claim is verified end-to-end by
/// the `first_account_claims_legacy_unowned_contacts` test below. If multi-user
/// support is ever added, this must be re-scoped per the new attribution source
/// (audit 2026-06-05, finding D7).
async fn claim_legacy_contacts(pool: &SqlitePool, owner: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE address_book SET owner = ? WHERE owner = ''")
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(())
}

async fn add_contact_inner(pool: &SqlitePool, owner: &str, name: &str, wallet_address: &str) -> Result<i64, AppError> {
    let result = sqlx::query("INSERT INTO address_book (owner, name, wallet_address) VALUES (?, ?, ?)")
        .bind(owner)
        .bind(name)
        .bind(wallet_address)
        .execute(pool)
        .await?;
    Ok(result.last_insert_rowid())
}

async fn get_contacts_inner(pool: &SqlitePool, owner: &str) -> Result<Vec<Contact>, AppError> {
    let rows = sqlx::query_as::<_, (i64, String, String, i64)>(
        "SELECT id, name, wallet_address, date_added FROM address_book WHERE owner = ? ORDER BY name ASC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, wallet_address, date_added)| Contact {
            id,
            name,
            wallet_address,
            date_added,
        })
        .collect())
}

/// Returns the number of rows updated — `0` means the `id` did not belong to
/// `owner` (no cross-account write happened).
async fn update_contact_inner(pool: &SqlitePool, owner: &str, id: i64, name: &str, wallet_address: &str) -> Result<u64, AppError> {
    let r = sqlx::query("UPDATE address_book SET name = ?, wallet_address = ? WHERE id = ? AND owner = ?")
        .bind(name)
        .bind(wallet_address)
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Returns the number of rows deleted — `0` means the `id` did not belong to
/// `owner` (no cross-account delete happened).
async fn delete_contact_inner(pool: &SqlitePool, owner: &str, id: i64) -> Result<u64, AppError> {
    let r = sqlx::query("DELETE FROM address_book WHERE id = ? AND owner = ?")
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Add a contact to the caller's address book.
#[tauri::command]
pub async fn add_contact(state: tauri::State<'_, AppState>, name: String, wallet_address: String) -> Result<i64, AppError> {
    let owner = caller_owner(&state)?;
    let pool = state.pool()?;
    info!(name = %name, "Adding contact");
    add_contact_inner(pool, &owner, &name, &wallet_address).await
}

/// Get the caller's contacts, ordered by name ascending. Opening the address
/// book is the entry point that claims any legacy owner-empty contacts.
#[tauri::command]
pub async fn get_contacts(state: tauri::State<'_, AppState>) -> Result<Vec<Contact>, AppError> {
    let owner = caller_owner(&state)?;
    let pool = state.pool()?;
    claim_legacy_contacts(pool, &owner).await?;
    get_contacts_inner(pool, &owner).await
}

/// Update one of the caller's contacts. Scoped by owner, so an `id` belonging
/// to another account is a no-op rather than a cross-account edit.
#[tauri::command]
pub async fn update_contact(state: tauri::State<'_, AppState>, id: i64, name: String, wallet_address: String) -> Result<(), AppError> {
    let owner = caller_owner(&state)?;
    let pool = state.pool()?;
    update_contact_inner(pool, &owner, id, &name, &wallet_address).await?;
    Ok(())
}

/// Delete one of the caller's contacts. Scoped by owner (see `update_contact`).
#[tauri::command]
pub async fn delete_contact(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    info!(id = id, "Deleting contact");
    let owner = caller_owner(&state)?;
    let pool = state.pool()?;
    delete_contact_inner(pool, &owner, id).await?;
    Ok(())
}

// ── Onboarding ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn fresh_pool() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, pool)
    }

    // The cross-account isolation property: A's contacts are invisible to B, and
    // B cannot delete A's contact by id (the IDOR the owner column closes).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn contacts_are_scoped_and_idor_safe() {
        let (_dir, pool) = fresh_pool().await;
        let a_id = add_contact_inner(&pool, "ownerA", "Alice", "addr1").await.unwrap();
        add_contact_inner(&pool, "ownerB", "Bob", "addr2").await.unwrap();

        let a_list = get_contacts_inner(&pool, "ownerA").await.unwrap();
        assert_eq!(a_list.len(), 1, "A sees only its own contact");
        assert_eq!(a_list[0].name, "Alice");

        // B deleting A's contact by id affects 0 rows (IDOR blocked).
        assert_eq!(delete_contact_inner(&pool, "ownerB", a_id).await.unwrap(), 0);
        assert_eq!(get_contacts_inner(&pool, "ownerA").await.unwrap().len(), 1);
    }

    // B updating A's contact by id affects 0 rows and leaves A's data intact.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_cannot_cross_accounts() {
        let (_dir, pool) = fresh_pool().await;
        let id = add_contact_inner(&pool, "ownerA", "Alice", "addr1").await.unwrap();
        assert_eq!(update_contact_inner(&pool, "ownerB", id, "Hacked", "evil").await.unwrap(), 0);
        let a = get_contacts_inner(&pool, "ownerA").await.unwrap();
        assert_eq!(a[0].name, "Alice");
        assert_eq!(a[0].wallet_address, "addr1");
    }

    // Decided backfill: the FIRST account to open the address book claims all
    // legacy owner-empty rows; a later account sees none of them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_account_claims_legacy_unowned_contacts() {
        let (_dir, pool) = fresh_pool().await;
        sqlx::query("INSERT INTO address_book (owner, name, wallet_address) VALUES ('', 'Legacy', 'addrL')")
            .execute(&pool)
            .await
            .unwrap();

        // Before any claim, the scoped query returns nothing for either account.
        assert_eq!(get_contacts_inner(&pool, "ownerA").await.unwrap().len(), 0);

        // A opens the address book first → adopts the legacy row.
        claim_legacy_contacts(&pool, "ownerA").await.unwrap();
        assert_eq!(get_contacts_inner(&pool, "ownerA").await.unwrap().len(), 1);

        // B opening later sees nothing — A already claimed it. Idempotent.
        claim_legacy_contacts(&pool, "ownerB").await.unwrap();
        assert_eq!(get_contacts_inner(&pool, "ownerB").await.unwrap().len(), 0);
    }
}
