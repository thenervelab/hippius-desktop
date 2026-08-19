//! Sole writer for the `auth_session` table.
//!
//! All other modules MUST go through these helpers — never raw SQL —
//! so that schema knowledge and ON CONFLICT semantics live in one
//! place. The `upsert` helper preserves `logout_time_minutes` via
//! `COALESCE` when the caller passes `None`, so a token refresh from
//! the sync engine doesn't reset the user's logout-timeout preference.
//!
//! # Token storage
//!
//! The bearer token is stored in the OS keychain whenever the platform
//! supports it (macOS Keychain, Windows Credential Manager, Linux
//! Secret Service). `auth_session.auth_token` stays as a fallback
//! column for Linux installs without Secret Service and for pre-update
//! rows that haven't been migrated yet. Reads transparently prefer the
//! keychain and upgrade any plaintext rows they encounter.

use crate::auth::account_key::account_key;
use crate::auth::token_keychain::{self, TokenKeychainResult};
use crate::error::{AppError, Result};
use sqlx::sqlite::SqlitePool;
use tracing::{debug, warn};

/// Parameters for an `auth_session` upsert.
///
/// `logout_time_minutes` is `Option<i64>`: pass `Some(_)` to set/overwrite,
/// pass `None` to preserve the existing value via SQL `COALESCE`.
#[derive(Debug)]
pub struct UpsertSession<'a> {
    pub substrate_address: &'a str,
    pub token: &'a str,
    pub token_expiry_ms: i64,
    pub user_id: Option<i64>,
    pub username: &'a str,
    pub provider: &'a str,
    pub logout_time_minutes: Option<i64>,
}

/// Full row payload returned by [`get_by_account`] / [`get_latest`].
#[derive(Debug, Clone)]
pub struct AuthSessionRow {
    pub auth_token: Option<String>,
    /// True when `auth_token` is `None` because the OS keychain could
    /// not be read (not because no token is stored). Restore paths must
    /// fail SOFT on this — the token likely still exists (audit M-1).
    pub token_keychain_unavailable: bool,
    pub token_expiry: Option<i64>,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub provider: Option<String>,
    pub substrate_address: Option<String>,
    pub logout_time_minutes: Option<i64>,
    pub last_login_at: Option<String>,
}

/// Upsert a session row, preserving `logout_time_minutes` when not provided.
///
/// The bearer token is routed through the OS keychain when available;
/// the `auth_token` column is written with NULL in that case so the
/// plaintext secret never lands on disk. When the keychain is
/// unavailable (Linux without Secret Service), the token is stored in
/// the column as a fallback — same on-disk exposure the app had before
/// this migration, but now clearly scoped to one code path.
pub async fn upsert(pool: &SqlitePool, params: UpsertSession<'_>) -> Result<()> {
    let owner = account_key(params.substrate_address);

    // Try the keychain first. On success we bind NULL to `auth_token`
    // so the DB holds only metadata (expiry, user_id, etc.) and any
    // previously-stored plaintext token gets scrubbed as part of the
    // same upsert.
    let keychain_ok = match token_keychain::store_token(params.substrate_address, params.token) {
        Ok(()) => true,
        Err(e) => {
            warn!(
                error = %e,
                "OS keychain unavailable for auth_session upsert — falling back to plaintext auth_token column"
            );
            false
        }
    };

    let token_for_db: Option<&str> = if keychain_ok { None } else { Some(params.token) };

    sqlx::query(
        r"
        INSERT INTO auth_session (
            owner, auth_token, token_expiry, user_id, username,
            provider, substrate_address, logout_time_minutes,
            last_login_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            auth_token = excluded.auth_token,
            token_expiry = excluded.token_expiry,
            user_id = excluded.user_id,
            username = excluded.username,
            provider = excluded.provider,
            substrate_address = excluded.substrate_address,
            logout_time_minutes = COALESCE(excluded.logout_time_minutes, auth_session.logout_time_minutes),
            last_login_at = excluded.last_login_at,
            updated_at = datetime('now')
        ",
    )
    .bind(&owner)
    .bind(token_for_db)
    .bind(params.token_expiry_ms)
    .bind(params.user_id)
    .bind(params.username)
    .bind(params.provider)
    .bind(params.substrate_address)
    .bind(params.logout_time_minutes)
    .execute(pool)
    .await
    .map_err(|e| AppError::Other(format!("Failed to upsert auth_session: {e}")))?;

    Ok(())
}

/// How the bearer token for a row resolved (see [`resolve_token`]).
///
/// `KeychainUnavailable` is the load-bearing distinction: after the
/// keychain migration the DB column is NULL, so a plain `Option` made
/// "keychain temporarily unreadable" (locked keychain, D-Bus hiccup)
/// indistinguishable from "no token stored" — and `restore_session`
/// treated the former as a dead session, destructively clearing the
/// FE's localStorage over a transient OS condition (audit M-1).
enum TokenResolution {
    Found(String),
    /// The stores are readable and genuinely hold no token.
    Absent,
    /// The OS keychain — the only store that can hold the token after
    /// migration — could not be read, AND the DB column has no
    /// plaintext fallback. The token may still exist.
    KeychainUnavailable,
}

/// Resolve the bearer token for an account: keychain first, then a
/// plaintext `auth_token` value coming back from the row. On a keychain
/// miss with a plaintext hit, opportunistically migrate the plaintext
/// into the keychain and scrub the column.
async fn resolve_token(pool: &SqlitePool, substrate_address: &str, row_token: Option<String>) -> TokenResolution {
    // Keychain is authoritative.
    let keychain_unavailable = match token_keychain::load_token(substrate_address) {
        TokenKeychainResult::Found(t) if !t.is_empty() => return TokenResolution::Found(t),
        TokenKeychainResult::Found(_) | TokenKeychainResult::NotFound => false,
        TokenKeychainResult::Unavailable(reason) => {
            debug!(reason = %reason, "OS keychain unavailable on auth_session read; using DB column");
            true
        }
    };

    // Fall back to the DB column for pre-upgrade rows or
    // keychain-unavailable platforms.
    let Some(plaintext) = row_token.filter(|s| !s.is_empty()) else {
        return if keychain_unavailable {
            TokenResolution::KeychainUnavailable
        } else {
            TokenResolution::Absent
        };
    };

    // Opportunistic upgrade: if the keychain is now available, move
    // the token over and null the column. Failures here are non-fatal
    // so the caller still gets a usable token.
    if token_keychain::store_token(substrate_address, &plaintext).is_ok() {
        let owner = account_key(substrate_address);
        if let Err(e) = sqlx::query("UPDATE auth_session SET auth_token = NULL, updated_at = datetime('now') WHERE owner = ?")
            .bind(&owner)
            .execute(pool)
            .await
        {
            warn!(error = %e, "Failed to scrub plaintext auth_token after keychain upgrade");
        } else {
            debug!("Migrated auth_session token from plaintext column to OS keychain");
        }
    }
    TokenResolution::Found(plaintext)
}

/// Null out the credential fields for an account, preserving the row
/// (and `logout_time_minutes`) so the user's logout preference survives.
///
/// Also deletes the bearer token from the OS keychain so the stored
/// credential does not outlive the user's session on any platform.
pub async fn clear(pool: &SqlitePool, account_id: &str) -> Result<()> {
    // Delete from the keychain first. Failures are logged but non-fatal
    // so a DB row is always cleared even if the keychain is flaky.
    if let Err(e) = token_keychain::delete_token(account_id) {
        warn!(error = %e, "Failed to delete token from OS keychain during clear");
    }

    let owner = account_key(account_id);

    sqlx::query(
        r"
        UPDATE auth_session SET
            auth_token = NULL,
            token_expiry = NULL,
            user_id = NULL,
            username = NULL,
            provider = NULL,
            substrate_address = NULL,
            last_login_at = NULL,
            updated_at = datetime('now')
        WHERE owner = ?
        ",
    )
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

/// Update only the `logout_time_minutes` preference column.
///
/// Deliberately does NOT bump `updated_at`: that column decides which
/// account [`get_latest`] restores at boot, and editing a settings
/// toggle for account X must not silently make X the account the next
/// launch logs into (audit M-6). Only session events (login, token
/// refresh, clear) may reorder restore priority.
pub async fn update_logout_time(pool: &SqlitePool, account_id: &str, minutes: i64) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query(
        r"
        UPDATE auth_session SET
            logout_time_minutes = ?
        WHERE owner = ?
        ",
    )
    .bind(minutes)
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

/// Correct a session row's `provider` label in place.
///
/// Exists for one job: repairing rows a pre-#102 build mislabelled.
/// `ensure_billing_auth` used to upsert `provider = "mnemonic"` keyed by
/// an OAuth account's real login SS58 (audit H-4), and since restore now
/// reads `provider` from the row alone, believing that label would send an
/// OAuth account down the mnemonic restore path. See
/// `session_restore::check_provider` for how the mislabel is detected.
///
/// Like [`update_logout_time`], this deliberately does NOT bump
/// `updated_at`: repairing stored data is not a session event, and
/// `get_latest` orders by that column to decide which account the next
/// boot restores (audit M-6).
pub async fn repair_provider(pool: &SqlitePool, account_id: &str, provider: &str) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query(
        r"
        UPDATE auth_session SET
            provider = ?
        WHERE owner = ?
        ",
    )
    .bind(provider)
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

/// Fetch just the `provider` label for a specific account, if any.
///
/// Deliberately NOT [`get_by_account`]: that resolves the auth token
/// through the OS keychain, which can block on a system password prompt.
/// The provider-repair path (`session_restore::
/// repair_provider_from_recovered_master`) needs only the label.
///
/// Skips cleared husk rows (`substrate_address IS NULL` — `clear` keeps
/// one for the logout preference, matching [`get_latest`]'s filter) so a
/// caller can never act on a logged-out row's stale label.
pub async fn get_provider(pool: &SqlitePool, account_id: &str) -> Result<Option<String>> {
    let owner = account_key(account_id);

    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT provider FROM auth_session WHERE owner = ? AND substrate_address IS NOT NULL")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;

    Ok(row.and_then(|(provider,)| provider))
}

/// Fetch the full row for a specific account, if any.
pub async fn get_by_account(pool: &SqlitePool, account_id: &str) -> Result<Option<AuthSessionRow>> {
    let owner = account_key(account_id);

    let row = sqlx::query_as::<
        _,
        (
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ),
    >(
        r"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await?;

    let Some((db_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)) = row else {
        return Ok(None);
    };

    // `substrate_address` is the canonical account identifier inside
    // the row; fall back to the caller's `account_id` only if the
    // row's column is NULL (happens for cleared rows that still hold
    // a `logout_time_minutes` preference).
    let lookup_addr = substrate_address.as_deref().unwrap_or(account_id);
    let (auth_token, token_keychain_unavailable) = split_resolution(resolve_token(pool, lookup_addr, db_token).await);

    Ok(Some(AuthSessionRow {
        auth_token,
        token_keychain_unavailable,
        token_expiry,
        user_id,
        username,
        provider,
        substrate_address,
        logout_time_minutes,
        last_login_at,
    }))
}

/// Flatten a [`TokenResolution`] into the `(token, keychain_unavailable)`
/// pair the row/status structs carry.
fn split_resolution(resolution: TokenResolution) -> (Option<String>, bool) {
    match resolution {
        TokenResolution::Found(t) => (Some(t), false),
        TokenResolution::Absent => (None, false),
        TokenResolution::KeychainUnavailable => (None, true),
    }
}

/// Fetch the most recently updated session row across all accounts.
/// Used by the boot path to find the last logged-in user.
///
/// Cleared rows are skipped (`substrate_address IS NOT NULL`): `clear`
/// keeps a logged-out account's row alive to preserve its
/// `logout_time_minutes` preference AND bumps `updated_at`, so without
/// the filter a logout of account A shadowed account B's live session
/// at the next boot — the "latest" row was A's empty husk (audit M-6).
pub async fn get_latest(pool: &SqlitePool) -> Result<Option<AuthSessionRow>> {
    let row = sqlx::query_as::<
        _,
        (
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ),
    >(
        r"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        WHERE substrate_address IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
        ",
    )
    .fetch_optional(pool)
    .await?;

    let Some((db_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)) = row else {
        return Ok(None);
    };

    // The DB column is NULL whenever the keychain holds the token, so
    // resolve it against the row's substrate_address before returning.
    // If `substrate_address` itself is NULL (a cleared-but-preserved
    // row), we skip the keychain lookup — no token is the correct
    // answer for a cleared row.
    let (auth_token, token_keychain_unavailable) = match substrate_address.as_deref() {
        Some(addr) => split_resolution(resolve_token(pool, addr, db_token).await),
        None => (db_token, false),
    };

    Ok(Some(AuthSessionRow {
        auth_token,
        token_keychain_unavailable,
        token_expiry,
        user_id,
        username,
        provider,
        substrate_address,
        logout_time_minutes,
        last_login_at,
    }))
}

/// Token validity payload returned by [`get_token_and_expiry`].
///
/// The outer `Option` (the function return type) signals "row exists".
/// The fields here signal which columns have non-NULL values.
#[derive(Debug, Clone)]
pub struct TokenStatus {
    pub token: Option<String>,
    pub expiry_ms: Option<i64>,
    /// True when `token` is `None` because the OS keychain could not be
    /// read — the token likely still exists. See [`AuthSessionRow::token_keychain_unavailable`].
    pub keychain_unavailable: bool,
}

/// Read just the token + expiry for fast validity checks.
///
/// The token is resolved through the keychain-first chain (see
/// [`resolve_token`]) so callers get the same answer regardless of
/// where the token is physically stored.
pub async fn get_token_and_expiry(pool: &SqlitePool, account_id: &str) -> Result<Option<TokenStatus>> {
    let owner = account_key(account_id);
    let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    let Some((db_token, expiry_ms)) = row else {
        return Ok(None);
    };
    let (token, keychain_unavailable) = split_resolution(resolve_token(pool, account_id, db_token).await);
    Ok(Some(TokenStatus {
        token,
        expiry_ms,
        keychain_unavailable,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an in-memory pool with the auth_session schema. Mirrors the
    /// production CREATE in `utils/schema.rs::ensure_table_schema` so the
    /// repo functions see the columns they expect.
    ///
    /// Sets `HIPPIUS_DISABLE_TOKEN_KEYCHAIN=1` so tests never touch the
    /// real OS keychain — otherwise every `upsert` would write to the
    /// developer's real macOS Keychain and leave residue behind.
    async fn setup_db() -> SqlitePool {
        // SAFETY: This is a test-only setup helper. The env var is a
        // process-global flag, but setting it from every test is
        // deterministic because it's unconditionally set to the same
        // value. The `unsafe` block is required by Rust 2024 edition
        // for `std::env::set_var`.
        unsafe {
            std::env::set_var("HIPPIUS_DISABLE_TOKEN_KEYCHAIN", "1");
        }
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS auth_session (
                owner TEXT PRIMARY KEY,
                auth_token TEXT,
                token_expiry INTEGER,
                user_id INTEGER,
                username TEXT,
                provider TEXT,
                substrate_address TEXT,
                logout_time_minutes INTEGER DEFAULT 1440,
                last_login_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    const ALICE: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const BOB: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    #[tokio::test]
    async fn upsert_writes_all_fields() {
        let pool = setup_db().await;
        let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "test-token-123",
                token_expiry_ms: future_expiry,
                user_id: Some(42),
                username: "testuser",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.auth_token.as_deref(), Some("test-token-123"));
        assert_eq!(row.token_expiry, Some(future_expiry));
        assert_eq!(row.user_id, Some(42));
        assert_eq!(row.username.as_deref(), Some("testuser"));
        assert_eq!(row.provider.as_deref(), Some("mnemonic"));
        assert_eq!(row.substrate_address.as_deref(), Some(ALICE));
        assert_eq!(row.logout_time_minutes, Some(1440));
    }

    #[tokio::test]
    async fn upsert_preserves_logout_minutes_when_none_passed() {
        // Critical invariant: a token-refresh upsert from the sync engine
        // (which doesn't know the user's preference) must NOT clobber the
        // logout_time_minutes the user previously set.
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "first-token",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "refreshed-token",
                token_expiry_ms: 2,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: None, // refresh path: don't touch the preference
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(60), "COALESCE must preserve preference");
        assert_eq!(row.auth_token.as_deref(), Some("refreshed-token"), "token should be updated");
    }

    #[tokio::test]
    async fn upsert_overwrites_logout_minutes_when_some_passed() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "t",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "t",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(1440));
    }

    #[tokio::test]
    async fn clear_nulls_credentials_but_preserves_logout_minutes() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "token",
                token_expiry_ms: 9_999_999_999,
                user_id: Some(1),
                username: "bob",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        clear(&pool, ALICE).await.unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert!(row.auth_token.is_none(), "auth_token must be cleared");
        assert!(row.token_expiry.is_none());
        assert!(row.username.is_none());
        assert!(row.provider.is_none());
        assert!(row.substrate_address.is_none());
        assert_eq!(row.logout_time_minutes, Some(60), "logout preference must survive clear");
    }

    #[tokio::test]
    async fn get_token_and_expiry_returns_token_when_present() {
        let pool = setup_db().await;
        let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "valid-token",
                token_expiry_ms: future_expiry,
                user_id: Some(99),
                username: "alice",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_token_and_expiry(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.token.as_deref(), Some("valid-token"));
        assert_eq!(row.expiry_ms, Some(future_expiry));
    }

    #[tokio::test]
    async fn update_logout_time_only_touches_one_column() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "token",
                token_expiry_ms: 1,
                user_id: Some(1),
                username: "bob",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        update_logout_time(&pool, ALICE, -1).await.unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(-1));
        assert_eq!(row.auth_token.as_deref(), Some("token"), "credentials must not be touched");
        assert_eq!(row.username.as_deref(), Some("bob"));
    }

    /// Pin a row's `updated_at` to a fixed timestamp so ordering tests are
    /// deterministic (SQLite's `datetime('now')` has 1-second resolution,
    /// so two upserts in one test land in the same tick).
    async fn set_updated_at(pool: &SqlitePool, account: &str, ts: &str) {
        sqlx::query("UPDATE auth_session SET updated_at = ? WHERE owner = ?")
            .bind(ts)
            .bind(account_key(account))
            .execute(pool)
            .await
            .unwrap();
    }

    async fn upsert_simple(pool: &SqlitePool, account: &str, token: &str) {
        upsert(
            pool,
            UpsertSession {
                substrate_address: account,
                token,
                token_expiry_ms: chrono::Utc::now().timestamp_millis() + 86_400_000,
                user_id: Some(1),
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();
    }

    /// Audit H-4 residue: a pre-#102 build could label an OAuth account
    /// `provider = "mnemonic"`. The repair corrects the label without
    /// touching credentials.
    #[tokio::test]
    async fn repair_provider_corrects_the_label_only() {
        let pool = setup_db().await;
        upsert_simple(&pool, ALICE, "alice-token").await;

        repair_provider(&pool, ALICE, "oauth").await.unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().expect("row survives the repair");
        assert_eq!(row.provider.as_deref(), Some("oauth"));
        assert_eq!(row.auth_token.as_deref(), Some("alice-token"), "credentials must not be touched");
        assert_eq!(row.username.as_deref(), Some("u"));
        assert_eq!(row.substrate_address.as_deref(), Some(ALICE));
    }

    /// The repair is a data fix, not a session event, so — like
    /// `update_logout_time` — it must not bump `updated_at` and reorder
    /// which account the next boot restores (audit M-6).
    #[tokio::test]
    async fn provider_repair_does_not_reorder_boot_restore() {
        let pool = setup_db().await;
        upsert_simple(&pool, ALICE, "alice-token").await;
        upsert_simple(&pool, BOB, "bob-token").await;
        set_updated_at(&pool, ALICE, "2020-01-02 00:00:00").await;
        set_updated_at(&pool, BOB, "2020-01-01 00:00:00").await;

        // Repairing the older account's label must not promote it.
        repair_provider(&pool, BOB, "oauth").await.unwrap();

        let row = get_latest(&pool).await.unwrap().expect("a live session must be found");
        assert_eq!(
            row.substrate_address.as_deref(),
            Some(ALICE),
            "a provider repair must not change which account boots"
        );
    }

    /// M-6: logging out of one account must not shadow another account's
    /// live session at boot. `clear` keeps the row (for the logout
    /// preference) and bumps `updated_at`, so the cleared husk IS the
    /// most recently updated row — `get_latest` must skip it.
    #[tokio::test]
    async fn get_latest_skips_cleared_rows() {
        let pool = setup_db().await;
        upsert_simple(&pool, ALICE, "alice-token").await;
        upsert_simple(&pool, BOB, "bob-token").await;
        set_updated_at(&pool, ALICE, "2020-01-01 00:00:00").await;
        set_updated_at(&pool, BOB, "2020-01-02 00:00:00").await;

        // Logout Bob — his row survives (preference) with the newest
        // updated_at, but its identity fields are nulled.
        clear(&pool, BOB).await.unwrap();

        let row = get_latest(&pool).await.unwrap().expect("Alice's live session must be found");
        assert_eq!(
            row.substrate_address.as_deref(),
            Some(ALICE),
            "a cleared row must not shadow another account's live session"
        );
    }

    /// M-6 companion: when every account is logged out there is no
    /// session to restore, even though the husk rows still exist.
    #[tokio::test]
    async fn get_latest_returns_none_when_all_rows_cleared() {
        let pool = setup_db().await;
        upsert_simple(&pool, ALICE, "t").await;
        clear(&pool, ALICE).await.unwrap();
        assert!(get_latest(&pool).await.unwrap().is_none());
    }

    /// M-6: editing the logout-timeout preference for a background
    /// account must not promote it to boot-restore priority.
    #[tokio::test]
    async fn preference_edit_does_not_reorder_boot_restore() {
        let pool = setup_db().await;
        upsert_simple(&pool, ALICE, "alice-token").await;
        upsert_simple(&pool, BOB, "bob-token").await;
        set_updated_at(&pool, ALICE, "2020-01-01 00:00:00").await;
        set_updated_at(&pool, BOB, "2020-01-02 00:00:00").await;

        update_logout_time(&pool, ALICE, -1).await.unwrap();

        let row = get_latest(&pool).await.unwrap().unwrap();
        assert_eq!(
            row.substrate_address.as_deref(),
            Some(BOB),
            "a preference edit must not change which account restores at boot"
        );
    }

    /// M-1: a row whose token lives ONLY in the keychain (DB column NULL
    /// — the post-migration shape) must report `keychain_unavailable`
    /// when the keychain cannot be read, so restore can fail soft
    /// instead of treating the session as dead. The disabled-keychain
    /// test env (`HIPPIUS_DISABLE_TOKEN_KEYCHAIN=1`) surfaces exactly
    /// the `Unavailable` result this simulates.
    #[tokio::test]
    async fn null_column_with_unreadable_keychain_reports_unavailable() {
        let pool = setup_db().await;
        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "kc-token",
                token_expiry_ms: chrono::Utc::now().timestamp_millis() + 86_400_000,
                user_id: Some(1),
                username: "alice",
                provider: "oauth",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();
        // Simulate the post-migration shape: token scrubbed from the DB
        // (it lives in the keychain, which this test env can't read).
        sqlx::query("UPDATE auth_session SET auth_token = NULL WHERE owner = ?")
            .bind(account_key(ALICE))
            .execute(&pool)
            .await
            .unwrap();

        let status = get_token_and_expiry(&pool, ALICE).await.unwrap().unwrap();
        assert!(status.token.is_none());
        assert!(
            status.keychain_unavailable,
            "NULL column + unreadable keychain must be flagged, not read as logged-out"
        );

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert!(row.auth_token.is_none());
        assert!(row.token_keychain_unavailable);
    }

    /// The flag stays false when a token actually resolves (plaintext
    /// fallback), so the soft path can never mask a working session.
    #[tokio::test]
    async fn resolved_plaintext_token_is_not_flagged_unavailable() {
        let pool = setup_db().await;
        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "plain-token",
                token_expiry_ms: 1,
                user_id: Some(1),
                username: "alice",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();
        let status = get_token_and_expiry(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(status.token.as_deref(), Some("plain-token"));
        assert!(!status.keychain_unavailable);
    }

    #[tokio::test]
    async fn multi_account_isolation() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "alice-token",
                token_expiry_ms: 1,
                user_id: Some(1),
                username: "alice",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: BOB,
                token: "bob-token",
                token_expiry_ms: 2,
                user_id: Some(2),
                username: "bob",
                provider: "oauth",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            get_by_account(&pool, ALICE).await.unwrap().unwrap().auth_token.as_deref(),
            Some("alice-token")
        );
        assert_eq!(
            get_by_account(&pool, BOB).await.unwrap().unwrap().auth_token.as_deref(),
            Some("bob-token")
        );

        // Clearing Alice doesn't affect Bob
        clear(&pool, ALICE).await.unwrap();
        assert_eq!(
            get_by_account(&pool, BOB).await.unwrap().unwrap().auth_token.as_deref(),
            Some("bob-token")
        );
    }
}
