//! Integration tests for `sync::mnemonic::get_mnemonic_for_account`.
//!
//! This helper is the single source of truth for "how does the sync
//! engine obtain the BIP-39 master mnemonic for a given account". It
//! backs the mnemonic-race fix in `auto_init_sync_inner` and
//! `initialize_sync_inner`, which now both route through this helper
//! instead of reading `AppState.auth.mnemonic` directly.
//!
//! The fallback chain (defined in `sync/mnemonic.rs`):
//!
//!   Stage 1: `AppState.auth.mnemonic` — in-memory cache, gated on
//!            `substrate_address` matching the requested account_id so
//!            stale state from a previous login can never leak through.
//!   Stage 2: `master_enc_mnemonic.json` on disk, decrypted with the
//!            account's drive_password from `hcfs_config`.
//!   Stage 3: first live drive's exported mnemonic.
//!   Stage 4: fresh `DriveManager` from any `sync_paths` row.
//!   Stage 5: `Err(NotReady(MasterMnemonicUnrecoverable))`.
//!
//! What these tests cover:
//!
//! 1. **Stage 1 hit** — `AuthInfo.mnemonic` is returned verbatim when
//!    the cached substrate_address matches the requested account_id.
//!    Pins the fast path used by the fresh-login and keychain-restore
//!    flows.
//! 2. **Stage 1 skip on mismatched account** — a cached mnemonic
//!    under account A must NOT leak when account B is requested. This
//!    is the cross-account isolation contract.
//! 3. **All sources empty → `NotReady`** — the exact error returned
//!    is `NotReady(MasterMnemonicUnrecoverable)`, which is the signal
//!    the frontend's `tryAutoInitSync` retry ladder matches on to
//!    trigger its 750ms-backoff + `hippius_auth_ready` wait.
//!
//! What these tests DO NOT cover (out of scope, would require
//! filesystem fixtures or network mocks):
//!
//! - Stage 2 disk fallback (needs a valid encrypted master file and
//!   matching hcfs_config row).
//! - Stage 3 live-drive export (needs a real `DriveManager`).
//! - Stage 4 DB-backed `DriveManager` (needs both a sync_paths row
//!   and a valid drive on disk).
//!
//! Those paths are exercised by `sync/mnemonic.rs` unit tests and by
//! the end-to-end smoke tests in `tests/file_commands.rs`.

use sqlx::sqlite::SqlitePool;
use zeroize::Zeroizing;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::error::{AppError, NotReadyKind};
use tauri_project_lib::sync::mnemonic::get_mnemonic_for_account;

/// Standard BIP-39 test vector (not a real account). Using a fixed
/// value makes the assertions exact and keeps the test deterministic.
const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// A synthetic substrate address that no production user will ever
/// have. Built with a visibly-fake prefix so a grep for this string
/// in log captures immediately flags the test origin. This is the
/// account_id threaded through `get_mnemonic_for_account`.
const TEST_ACCOUNT: &str = "TEST_ACCOUNT_mnemonic_resolution_0000000000000000";

/// A second synthetic address used to test cross-account isolation.
const OTHER_ACCOUNT: &str = "TEST_ACCOUNT_mnemonic_resolution_other_xxxxxxxxxx";

/// Build an in-memory pool with the minimum schema `get_mnemonic_for_account`
/// might touch. Stage 2 tries `get_drive_password(pool, account_id, None)`
/// which reads `hcfs_config` — if the table is missing entirely the query
/// returns an error that the helper catches with `if let Ok(..)`, so
/// Stage 2 is cleanly skipped. Stage 4 reads `sync_paths` — we ship it
/// empty so that stage is also skipped.
async fn make_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Build an `AppState` with the given pool and active account. Mirrors
/// the helper in `tests/drive_status.rs` — kept separate so changes to
/// the test scaffolding don't couple the two suites.
fn make_state_with_account(pool: SqlitePool, account_id: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account_id, AuthCapabilities::default())
        .expect("set active account");
    state
}

/// Directly seed `AuthInfo.mnemonic` to the given phrase, leaving the
/// substrate_address set by `set_active_account` intact. This simulates
/// the post-login state without running the real `login_with_mnemonic`
/// flow (which needs a valid API server to complete the challenge-
/// response handshake).
fn seed_auth_mnemonic(state: &AppState, mnemonic: &str) {
    let mut auth = state.auth.lock().expect("auth lock");
    auth.mnemonic = Some(Zeroizing::new(mnemonic.to_string()));
}

#[tokio::test]
async fn stage1_returns_cached_mnemonic_when_account_matches() {
    // Pin the fast path: `AuthInfo.mnemonic` is cached and the
    // substrate_address matches the requested account_id. The helper
    // must return the cached value verbatim without touching disk or
    // the drives map.
    let pool = make_pool().await;
    let state = make_state_with_account(pool, TEST_ACCOUNT);
    seed_auth_mnemonic(&state, TEST_MNEMONIC);

    let resolved = get_mnemonic_for_account(&state, TEST_ACCOUNT).await.expect("stage 1 should succeed");

    assert_eq!(resolved.as_str(), TEST_MNEMONIC, "expected cached mnemonic to be returned verbatim");
}

#[tokio::test]
async fn stage1_skipped_when_cached_account_does_not_match() {
    // Cross-account isolation: a cached mnemonic under account A must
    // NEVER be returned when account B is requested. If Stage 1 leaked,
    // the cached value would short-circuit and the helper would return
    // Ok with the wrong mnemonic instead of falling through to the
    // other stages. With no disk file / drives / sync_paths, the
    // correct fall-through is `NotReady(MasterMnemonicUnrecoverable)`.
    let pool = make_pool().await;
    let state = make_state_with_account(pool, TEST_ACCOUNT);
    seed_auth_mnemonic(&state, TEST_MNEMONIC);

    // Request a DIFFERENT account — the cached AuthInfo is for TEST_ACCOUNT
    // but we ask for OTHER_ACCOUNT. Stage 1 must reject and fall through.
    let result = get_mnemonic_for_account(&state, OTHER_ACCOUNT).await;

    match result {
        Err(AppError::NotReady(NotReadyKind::MasterMnemonicUnrecoverable)) => {}
        Ok(mnemonic) => panic!("Stage 1 leaked across accounts: expected Err, got Ok({:?})", mnemonic.as_str()),
        Err(other) => panic!("expected NotReady(MasterMnemonicUnrecoverable) on cross-account miss, got {other:?}"),
    }
}

#[tokio::test]
async fn returns_not_ready_when_all_sources_empty() {
    // This is the slow-system cold-start scenario that the
    // `auto_init_sync` mnemonic-race fix depends on: the FE has fired
    // auto-init before `rehydrate_full_session` has written
    // `AuthInfo.mnemonic`, and no other source is populated yet. The
    // helper must return `NotReady(MasterMnemonicUnrecoverable)` —
    // any other error type breaks the FE retry ladder in
    // `useHcfsSync.ts::tryAutoInitSync`, which matches specifically
    // on that variant via `isNotReady(err, "mnemonic")`.
    let pool = make_pool().await;
    let state = make_state_with_account(pool, TEST_ACCOUNT);
    // Deliberately do NOT call seed_auth_mnemonic — AuthInfo.mnemonic
    // stays None. The in-memory pool has no `hcfs_config` table (Stage 2
    // skips on Err), no live drives (Stage 3 skips on empty map), and
    // no `sync_paths` rows (Stage 4 skips on None). Stage 5 returns Err.

    let result = get_mnemonic_for_account(&state, TEST_ACCOUNT).await;

    match result {
        Err(AppError::NotReady(NotReadyKind::MasterMnemonicUnrecoverable)) => {}
        Ok(mnemonic) => panic!("expected Err, got Ok({:?}) — an unexpected stage succeeded", mnemonic.as_str()),
        Err(other) => panic!(
            "expected NotReady(MasterMnemonicUnrecoverable), got {other:?}. \
             The FE retry ladder matches on this specific variant; any other \
             error will break the slow-system retry flow."
        ),
    }
}
