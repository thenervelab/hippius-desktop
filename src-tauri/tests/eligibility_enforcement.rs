//! Integration tests for `crate::billing::eligibility::require_eligible`
//! against a mocked Hippius billing API.
//!
//! These tests are the IPC enforcement guarantee for the credit-gate
//! migration: every gated action command (`add_file`, `add_files`,
//! `add_folder`, `add_local_sync_folder`, `create_vm`) calls
//! `require_eligible(...)?` as its first line, so as long as that helper
//! correctly returns `Err(NotReady(InsufficientCredits))` against a
//! zero-balance backend, the gate cannot silently regress on any of the
//! call sites.
//!
//! The mock server impersonates `GET /api/billing/credits/balance/`
//! (the only endpoint touched by `check_action_eligibility_inner` for
//! actions that don't require chain balance — i.e. all of `FileUpload`,
//! `FolderUpload`, `FolderSync`). `VmCreation` additionally fetches
//! substrate chain balance, but since the credit fetch happens FIRST
//! and short-circuits on failure, we can still exercise the credit gate
//! for `VmCreation` against the mock by returning a sub-threshold credit
//! balance.
//!
//! The tests live in a single `#[tokio::test]` because they mutate the
//! `HIPPIUS_API_BASE_URL` environment variable, which is process-wide.
//! Splitting them into separate `#[test]`s would race when cargo runs
//! tests in parallel.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::auth_session_repo::{UpsertSession, upsert};
use tauri_project_lib::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use tauri_project_lib::error::{AppError, NotReadyKind};

/// Shared state for the mock balance endpoint. The credit value is
/// returned as a string because the production endpoint serializes
/// `BigDecimal` as a string and the production code parses it back via
/// `f64::from_str` — keeping the wire shape identical guarantees the
/// test exercises the real parsing path.
#[derive(Clone, Default)]
struct MockBilling {
    balance: Arc<Mutex<String>>,
}

async fn balance_handler(State(state): State<MockBilling>) -> Json<serde_json::Value> {
    let balance = state.balance.lock().unwrap().clone();
    Json(json!({ "balance": balance }))
}

/// Spin up the mock server on a random port and return its base URL
/// (e.g. `http://127.0.0.1:54321`) plus the shared state handle so the
/// test can rewrite the balance between cases.
async fn spawn_mock_server() -> (String, MockBilling) {
    let state = MockBilling::default();
    let app = Router::new()
        .route("/api/billing/credits/balance/", get(balance_handler))
        .with_state(state.clone());

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind mock server");
    let addr = listener.local_addr().expect("local addr");

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock server");
    });

    (format!("http://{addr}"), state)
}

/// Build an in-memory pool with the `auth_session` schema and a token
/// row for `account_id`. The token value doesn't matter — the mock
/// server doesn't validate it — but it must be present and non-empty
/// or `ApiClient::get` short-circuits before hitting the network.
async fn setup_pool_with_token(account_id: &str) -> SqlitePool {
    // Prevent `auth_session_repo::upsert` from touching the real OS
    // keychain when running this integration test — without the
    // disable flag the repo would store `test-token-not-validated` in
    // the developer's macOS Keychain and leave residue behind.
    // SAFETY: process-global env mutation, deterministic value, set
    // before any auth_session_repo call in this test file.
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
            logout_time_minutes INTEGER,
            last_login_at TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    upsert(
        &pool,
        UpsertSession {
            substrate_address: account_id,
            token: "test-token-not-validated",
            token_expiry_ms: chrono::Utc::now().timestamp_millis() + 3_600_000,
            user_id: Some(1),
            username: "tester",
            provider: "test",
            logout_time_minutes: None,
        },
    )
    .await
    .unwrap();

    pool
}

#[tokio::test]
async fn require_eligible_enforces_thresholds_against_mock_billing_api() {
    let (base_url, mock) = spawn_mock_server().await;
    // SAFETY: tests in this file run sequentially (single test fn) so
    // the env var mutation can't race another test in this binary. The
    // env var is read at every `ApiClient::new` call (via `api_base_url`)
    // so each subtest below picks up the current value.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base_url);
    }

    let account_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let pool = setup_pool_with_token(account_id).await;
    let state = AppState::new();
    state.set_pool(pool);

    // -----------------------------------------------------------------
    // Case 1: zero balance — every action must be rejected with
    // `NotReady(InsufficientCredits)`. This is the IPC enforcement
    // guarantee that the FE can't bypass.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "0".to_string();
    for action in [
        InsufficientCreditsAction::FileUpload,
        InsufficientCreditsAction::FolderUpload,
        InsufficientCreditsAction::FolderSync,
        InsufficientCreditsAction::VmCreation,
    ] {
        let err = require_eligible(&state, account_id, action)
            .await
            .expect_err(&format!("zero balance must reject {action:?}"));
        match err {
            AppError::NotReady(NotReadyKind::InsufficientCredits) => {}
            other => panic!("expected NotReady(InsufficientCredits) for {action:?}, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // Case 2: sub-threshold for VM creation (≥ 10) but enough for the
    // `> 0` actions. VM creation must still be rejected — and because
    // 5 credits fails at the credit gate, the chain-balance branch is
    // never reached, so the test does not depend on a wired substrate
    // client. The other three actions must pass.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "5".to_string();
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload)
        .await
        .expect("5 credits passes FileUpload `> 0` gate");
    require_eligible(&state, account_id, InsufficientCreditsAction::FolderUpload)
        .await
        .expect("5 credits passes FolderUpload `> 0` gate");
    require_eligible(&state, account_id, InsufficientCreditsAction::FolderSync)
        .await
        .expect("5 credits passes FolderSync `> 0` gate");
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::VmCreation)
        .await
        .expect_err("5 credits must NOT pass VmCreation ≥10 gate");
    assert!(
        matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)),
        "expected NotReady(InsufficientCredits), got {err:?}",
    );

    // -----------------------------------------------------------------
    // Case 3: above the highest threshold — all actions pass the credit
    // check. For VmCreation the credit gate passes and `require_eligible`
    // then enters the chain-balance branch; with no substrate client
    // wired up in the test AppState that branch is a no-op and returns
    // `Ok(())`. Asserting that here pins the current behavior so a
    // future regression that hard-fails when the substrate client is
    // missing gets caught.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "100".to_string();
    for action in [
        InsufficientCreditsAction::FileUpload,
        InsufficientCreditsAction::FolderUpload,
        InsufficientCreditsAction::FolderSync,
        InsufficientCreditsAction::VmCreation,
    ] {
        require_eligible(&state, account_id, action)
            .await
            .unwrap_or_else(|e| panic!("100 credits must pass {action:?}, got {e:?}"));
    }

    // -----------------------------------------------------------------
    // Case 4: exactly the threshold — boundary check for the legacy
    // `creditsNumber < 10` semantics that this migration preserves
    // (10 passes, 9.99 fails). The `> 0` actions also have to pass.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "10".to_string();
    require_eligible(&state, account_id, InsufficientCreditsAction::VmCreation)
        .await
        .expect("exactly 10 credits passes the VmCreation ≥10 gate");

    *mock.balance.lock().unwrap() = "9.99".to_string();
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::VmCreation)
        .await
        .expect_err("9.99 credits must NOT pass the VmCreation ≥10 gate");
    assert!(
        matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)),
        "expected NotReady(InsufficientCredits), got {err:?}",
    );

    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
