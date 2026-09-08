//! Integration tests for how `require_eligible` treats an upload's byte
//! count.
//!
//! This file was written for the bytes-priced CREDIT layer (Task 3.1 of
//! the 2026-05-13 sync-402 plan). Drive storage is now sold as a plan, so
//! `require_eligible` routes Drive writes to the plan-allowance gate and
//! never reaches that layer — the constant and `cost_for_bytes` still
//! exist, but no upload is priced against a balance any more.
//!
//! The file therefore now pins the inverse, which is the property worth
//! guarding: **an upload's outcome does not depend on the credit
//! balance, at any size.** Reinstating the credit gate would refuse
//! uploads for every account with an empty wallet and a paid plan.
//! Payload sizes are still derived from the old priced boundary, so each
//! case is by construction one the previous gate rejected.
//!
//! - A 1-byte upload passes.
//! - A payload whose priced cost far exceeds the balance passes, for
//!   every upload action.
//! - The same payload passes when the balance would have covered it.
//! - `VmCreation` is unaffected by the bytes argument in both
//!   directions — its threshold is the up-front extrinsic fee.
//!
//! Whether the bytes fit the plan is `billing::drive_quota`'s question
//! and is covered by its own tests. Companion:
//! `tests/eligibility_enforcement.rs` pins the threshold layer at
//! `bytes = 0`; the mock-server / pool setup mirrors it.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::auth_session_repo::{UpsertSession, upsert};
use tauri_project_lib::billing::eligibility::{InsufficientCreditsAction, cost_for_bytes, require_eligible};
use tauri_project_lib::error::{AppError, NotReadyKind};

/// Shared mock-balance state; identical shape to the helper in
/// `eligibility_enforcement.rs`. Duplicated rather than extracted
/// because integration-test binaries cannot share module code without
/// turning either into a `pub mod` library — Rust integration tests
/// build one binary per file by design.
#[derive(Clone, Default)]
struct MockBilling {
    balance: Arc<Mutex<String>>,
}

async fn balance_handler(State(state): State<MockBilling>) -> Json<serde_json::Value> {
    let balance = state.balance.lock().unwrap().clone();
    Json(json!({ "balance": balance }))
}

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

/// In-memory pool seeded with a placeholder auth-session row. The token
/// value doesn't matter to the mock server, but it must be present and
/// non-empty or `ApiClient::get` short-circuits before hitting the
/// network. Identical to the helper in `eligibility_enforcement.rs`.
async fn setup_pool_with_token(account_id: &str) -> SqlitePool {
    // SAFETY: process-global env mutation, deterministic value, set
    // before any auth_session_repo call in this test file. Mirrors the
    // pattern in `eligibility_enforcement.rs` — prevents the test from
    // writing test tokens to the developer's macOS keychain.
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

/// Smallest byte count whose priced cost exceeds a given balance. Used
/// to pick test sizes deliberately (the plan calls out "exact required
/// cost depends on the constant; pick test sizes deliberately"). Avoids
/// hardcoding magic constants by deriving the threshold from the same
/// `cost_for_bytes` the production code uses.
fn bytes_just_over(balance: f64) -> u64 {
    // Doubled to give the test a safety margin against the float
    // representation of `cost_for_bytes` rounding right at the boundary.
    // The cost function is monotone non-decreasing, so any larger byte
    // count is also "over".
    let mut bytes: u64 = 1;
    while cost_for_bytes(bytes) <= balance {
        bytes = bytes.saturating_mul(2);
        assert!(bytes != 0, "u64 overflow: no byte count produces cost > {balance}");
    }
    bytes
}

#[tokio::test]
async fn require_eligible_prices_uploads_by_byte_count() {
    let (base_url, mock) = spawn_mock_server().await;
    // SAFETY: tests in this file are a single `#[tokio::test]` so the
    // env var mutation can't race another test in this binary. Mirrors
    // the pattern in `eligibility_enforcement.rs`.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base_url);
    }

    let account_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let pool = setup_pool_with_token(account_id).await;
    let state = AppState::new();
    state.set_pool(pool);
    // Eligibility mints a SessionAccount for the token fetch, so the checked
    // account must be the active session account (always true in production).
    state
        .set_active_account(account_id, tauri_project_lib::auth::state::AuthCapabilities::Full)
        .expect("set session account");

    // -----------------------------------------------------------------
    // Case A: tiny file (1 byte) with $0.33 balance must be ELIGIBLE.
    // The per-byte cost is far below any positive balance, so the gate
    // falls through to the static `> 0` floor.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "0.33".to_string();
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, 1)
        .await
        .expect("1-byte upload must fit in $0.33 balance");

    // -----------------------------------------------------------------
    // Case B: a payload whose PRICED cost exceeds the balance is still
    // allowed, for every upload action.
    //
    // Storage is sold as a plan, so `require_eligible` routes Drive
    // writes to the plan-allowance gate and never reaches the priced
    // credit layer. This is the regression guard for that: reinstating
    // the credit gate would refuse uploads for every account with an
    // empty wallet and a paid plan. Whether the bytes FIT the plan is
    // `drive_quota`'s question, covered by its own tests; the mock
    // serves no drive endpoints, so that gate falls open here.
    //
    // The size still comes from `bytes_just_over(0.33)` so the case
    // keeps its teeth if the priced layer is ever re-armed: it is by
    // construction a payload the old gate rejected.
    // -----------------------------------------------------------------
    let too_many_bytes = bytes_just_over(0.33);
    for action in [
        InsufficientCreditsAction::FileUpload,
        InsufficientCreditsAction::FolderUpload,
        InsufficientCreditsAction::FolderSync,
    ] {
        require_eligible(&state, account_id, action, too_many_bytes)
            .await
            .unwrap_or_else(|e| panic!("{action:?} must not be priced against the balance, got {e:?}"));
    }

    // A small payload passes too — the size is not what decides here.
    require_eligible(&state, account_id, InsufficientCreditsAction::FolderUpload, 1024)
        .await
        .expect("1 KiB folder upload must pass");

    // -----------------------------------------------------------------
    // Case E: non-upload action (VmCreation) is UNAFFECTED by the
    // bytes argument — its threshold is the up-front extrinsic fee
    // (10 credits), and no payload byte count should ever raise or
    // lower that bar. Pin both directions:
    //   E1. Balance < 10, huge bytes → still rejected (threshold loss,
    //       NOT bytes loss). Confirms bytes don't push a sub-threshold
    //       balance into "ineligible" via the wrong axis.
    //   E2. Balance == 10, huge bytes → ELIGIBLE. Confirms bytes don't
    //       artificially raise the VM gate above its static threshold.
    // -----------------------------------------------------------------
    *mock.balance.lock().unwrap() = "0.33".to_string();
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::VmCreation, too_many_bytes)
        .await
        .expect_err("VmCreation under-threshold must still reject");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)));

    *mock.balance.lock().unwrap() = "10".to_string();
    require_eligible(&state, account_id, InsufficientCreditsAction::VmCreation, too_many_bytes)
        .await
        .expect("VmCreation at threshold passes regardless of bytes (chain-balance fallthrough)");

    // -----------------------------------------------------------------
    // Case F: a balance that comfortably covers the priced cost also
    // passes — the same payload, from the other side of the old
    // boundary. Together with case B this pins that the outcome no
    // longer depends on the balance at all for uploads.
    //
    // Fixed-point `{:.10}` rather than default `{}` so the f64 Display
    // cannot emit scientific notation (e.g. `6e-3`) for small
    // magnitudes — the billing balance parser expects a plain decimal.
    // -----------------------------------------------------------------
    let cost_for_big = cost_for_bytes(too_many_bytes);
    *mock.balance.lock().unwrap() = format!("{:.10}", cost_for_big * 2.0);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, too_many_bytes)
        .await
        .expect("upload passes when the balance covers the old priced cost too");

    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
