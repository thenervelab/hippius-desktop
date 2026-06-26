//! Orchestration tests for the `login_with_mnemonic` Tauri command.
//!
//! This file used to be a tautology: it reimplemented `hash_passcode`,
//! `crypto_js_derive_key_iv`, and the CryptoJS-compatible AES helpers
//! *locally* and asserted those local copies against hardcoded vectors —
//! testing nothing in the crate under test. The real production crypto is
//! covered where it lives: `auth::service::derive_keys` has frozen
//! Foundry/sr25519 vectors (`service.rs::tests`), and the at-rest AES path is
//! covered by `wallet/crypto` roundtrips and `tests/crypto_migration.rs`.
//!
//! What was actually missing was an *orchestration* test of the login command
//! itself. These tests drive the REAL `login_with_mnemonic` against an axum
//! mock of the Hippius challenge/verify API, an in-memory SQLite pool, and the
//! OS keychain disabled, then assert the full observable contract: the returned
//! `LoginResult`, the in-memory `AuthInfo` write, and the persisted DB rows —
//! plus the documented invariant that a failed login leaves the prior session
//! intact (challenge-response runs BEFORE any `AuthInfo` write).
//!
//! Tests share one `#[tokio::test]` because they mutate the process-global
//! `HIPPIUS_API_BASE_URL`; splitting them would race under cargo's parallel
//! runner. (Same rationale as `tests/eligibility_enforcement.rs`.)

use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePool;
use std::net::SocketAddr;
use tauri::Manager;
use tokio::net::TcpListener;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::auth_session_repo::get_by_account;
use tauri_project_lib::auth::login::login_with_mnemonic;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::error::AppError;
use tauri_project_lib::utils::schema::ensure_table_schema;

/// Well-known Foundry/Anvil/Hardhat test phrase. Its derived addresses are the
/// frozen vectors pinned in `auth::service::tests::derive_keys_matches_frozen_vectors`,
/// so asserting them here also proves the login path derives the SAME keys.
const MNEMONIC: &str = "test test test test test test test test test test test junk";
const EXPECTED_SUBSTRATE: &str = "5GmS1wtCfR4tK5SSgnZbVT4kYw5W8NmxmijcsxCQE6oLW6A8";
const EXPECTED_ETH: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// =========================================================================
// Mock Hippius auth API (mirrors `auth::service::challenge_response`)
// =========================================================================

async fn challenge_ok() -> Json<Value> {
    Json(json!({ "challenge": "challenge-token-abc", "message": "Sign this to log in" }))
}

async fn verify_ok() -> Json<Value> {
    Json(json!({
        "token": "test-bearer-token",
        "user_id": 42,
        "username": "tester",
        "is_new": true,
    }))
}

async fn challenge_unauthorized() -> impl IntoResponse {
    (StatusCode::UNAUTHORIZED, "auth rejected")
}

/// Router whose challenge + verify endpoints both succeed.
fn success_router() -> Router {
    Router::new()
        .route("/api/auth/mnemonic/", post(challenge_ok))
        .route("/api/auth/verify/", post(verify_ok))
}

/// Router whose challenge endpoint returns 401 — the verify route is present
/// but must never be reached (challenge fails first).
fn challenge_failure_router() -> Router {
    Router::new()
        .route("/api/auth/mnemonic/", post(challenge_unauthorized))
        .route("/api/auth/verify/", post(verify_ok))
}

/// Bind an ephemeral port, serve `router`, and return its base URL.
async fn start_server(router: Router) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("mock auth server crashed");
    });
    format!("http://{addr}")
}

// =========================================================================
// AppState harness — manages a real AppState so the `tauri::State` command
// can be invoked exactly as Tauri would invoke it.
// =========================================================================

async fn fresh_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory sqlite");
    // Build every table through the production schema funnel rather than a
    // hand-rolled CREATE, so the test exercises the real columns `upsert` /
    // `save_api_token` write (axiom 111: ingest through the public path).
    ensure_table_schema(&pool).await.expect("ensure schema");
    pool
}

fn managed_app(pool: SqlitePool) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    let state = AppState::new();
    state.set_pool(pool);
    app.manage(state);
    app
}

#[tokio::test]
async fn login_with_mnemonic_orchestration() {
    // The OS keychain is disabled for the whole test so the success path's
    // token + mnemonic writes never touch the developer's real Keychain.
    // SAFETY: process-global env mutation, set once to a constant — matches
    // the pattern in `auth_session_repo::tests::setup_db`.
    unsafe {
        std::env::set_var("HIPPIUS_DISABLE_TOKEN_KEYCHAIN", "1");
        std::env::set_var("HIPPIUS_DISABLE_MNEMONIC_KEYCHAIN", "1");
    }

    // -----------------------------------------------------------------
    // Case 1 — success: the full happy path persists a complete session.
    // -----------------------------------------------------------------
    let base = start_server(success_router()).await;
    // SAFETY: see module note — single test fn, so no parallel test in this
    // binary can observe a half-set base URL.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base);
    }

    let app = managed_app(fresh_pool().await);
    let result = login_with_mnemonic(app.state::<AppState>(), MNEMONIC.to_string(), None, None)
        .await
        .expect("login should succeed against the mock API");

    // The returned result carries the derived addresses (proving the login
    // path derives the SAME keys as the frozen service.rs vectors) and the
    // server-issued session fields.
    assert_eq!(result.substrate_address, EXPECTED_SUBSTRATE);
    assert_eq!(result.eth_address, EXPECTED_ETH);
    assert_eq!(result.token, "test-bearer-token");
    assert_eq!(result.username, "tester");
    assert_eq!(result.provider, "mnemonic");
    assert!(result.is_new);

    // AuthInfo is now fully populated — capabilities Full and the mnemonic
    // cached for in-session signing.
    {
        let st = app.state::<AppState>();
        let auth = st.auth.lock().expect("auth lock");
        assert_eq!(auth.capabilities, AuthCapabilities::Full);
        assert_eq!(auth.substrate_address.as_deref(), Some(EXPECTED_SUBSTRATE));
        assert!(auth.mnemonic.is_some(), "mnemonic must be cached after login");
    }

    // The session row was persisted; with the keychain disabled the token
    // lands in the `auth_session.auth_token` column.
    {
        let st = app.state::<AppState>();
        let row = get_by_account(st.pool().expect("pool"), EXPECTED_SUBSTRATE)
            .await
            .expect("query auth_session")
            .expect("a session row must exist after login");
        assert_eq!(row.auth_token.as_deref(), Some("test-bearer-token"));
        assert_eq!(row.username.as_deref(), Some("tester"));
        assert_eq!(row.user_id, Some(42));
        assert_eq!(row.provider.as_deref(), Some("mnemonic"));
    }

    // -----------------------------------------------------------------
    // Case 2 — invalid mnemonic: rejected before any I/O, session untouched.
    // `derive_keys` fails first, so no network call and no AuthInfo write.
    // -----------------------------------------------------------------
    let app = managed_app(fresh_pool().await);
    // `LoginResult` is intentionally not `Debug` (it carries a bearer token),
    // so unwrap the error via `let...else` rather than `expect_err`.
    let Err(err) = login_with_mnemonic(app.state::<AppState>(), "not a valid bip39 phrase".to_string(), None, None).await else {
        panic!("a garbage mnemonic must be rejected");
    };
    assert!(matches!(err, AppError::Other(_)), "invalid mnemonic surfaces as Other, got {err:?}");
    {
        let st = app.state::<AppState>();
        let auth = st.auth.lock().expect("auth lock");
        assert_eq!(auth.capabilities, AuthCapabilities::None, "failed login must leave AuthInfo at default");
        assert!(auth.substrate_address.is_none());
        assert!(auth.mnemonic.is_none());
    }

    // -----------------------------------------------------------------
    // Case 3 — challenge fails (401): the documented ordering invariant —
    // challenge-response runs BEFORE the AuthInfo write, so a server-side
    // failure leaves the prior (empty here) session intact and writes no row.
    // -----------------------------------------------------------------
    let base = start_server(challenge_failure_router()).await;
    // SAFETY: single test fn (see module note) — no parallel test in this
    // binary reads HIPPIUS_API_BASE_URL while it is being repointed.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base);
    }
    let app = managed_app(fresh_pool().await);
    let Err(err) = login_with_mnemonic(app.state::<AppState>(), MNEMONIC.to_string(), None, None).await else {
        panic!("a 401 challenge must fail the login");
    };
    assert!(matches!(err, AppError::Other(_)), "challenge failure surfaces as Other, got {err:?}");
    {
        let st = app.state::<AppState>();
        // Scope the guard so it drops before the DB await below (no lock held
        // across `.await`).
        {
            let auth = st.auth.lock().expect("auth lock");
            assert_eq!(auth.capabilities, AuthCapabilities::None, "challenge failure must not write AuthInfo");
            assert!(auth.substrate_address.is_none());
        }

        let row = get_by_account(st.pool().expect("pool"), EXPECTED_SUBSTRATE)
            .await
            .expect("query auth_session");
        assert!(row.is_none(), "no session row may be persisted when the challenge fails");
    }

    // SAFETY: restore the process-global env so it can't leak the mock URL
    // into another test binary's view of the world.
    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
