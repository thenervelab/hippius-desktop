//! Integration tests for the bytes-priced layer of
//! `crate::billing::eligibility::require_eligible` (Task 3.1 of the
//! 2026-05-13 sync-402 plan).
//!
//! Companion to `tests/eligibility_enforcement.rs` (which pins the
//! static-threshold layer at `bytes = 0`). This file pins the layer
//! that scales with the byte count of the upload payload:
//!
//! - A 1-byte file with a $0.33 marketplace balance passes — the
//!   per-byte cost is far below any positive balance, so the gate
//!   degenerates to the legacy `> 0` floor.
//! - A "huge" file whose priced cost exceeds the balance is REJECTED
//!   with the structured `NotReady(InsufficientCredits)` error.
//! - A folder whose recursive byte sum exceeds the balance is REJECTED.
//! - A folder whose recursive byte sum fits in the balance passes.
//! - `VmCreation` (non-upload action) is unaffected by the bytes
//!   argument — same threshold semantics as the existing test.
//!
//! The mock-server / pool setup mirrors `eligibility_enforcement.rs` so
//! the two files exercise the same contract surface against the same
//! billing API shape; only the byte-count input changes.

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
    // Case B: same balance, but a payload large enough that its priced
    // cost EXCEEDS the balance. Must be REJECTED with the structured
    // `NotReady(InsufficientCredits)` error.
    //
    // Size is derived from `bytes_just_over(0.33)` so the assertion
    // survives any future tuning of `CREDITS_PER_BYTE_MONTHLY` —
    // re-running the helper recomputes the boundary against the
    // current constant. The plan example ($1.38 storage cost vs $0.33
    // balance) maps to ~470 GB at the per-month rate; the helper picks
    // a similar magnitude.
    // -----------------------------------------------------------------
    let too_many_bytes = bytes_just_over(0.33);
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, too_many_bytes)
        .await
        .expect_err("priced file upload must fail when cost exceeds balance");
    assert!(
        matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)),
        "expected NotReady(InsufficientCredits) for priced file overrun, got {err:?}",
    );

    // -----------------------------------------------------------------
    // Case C: folder upload — same byte threshold logic, different
    // action. Pins that the bytes-priced layer applies to every upload
    // action variant, not just `FileUpload`.
    // -----------------------------------------------------------------
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::FolderUpload, too_many_bytes)
        .await
        .expect_err("priced folder upload must fail when cost exceeds balance");
    assert!(
        matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)),
        "expected NotReady(InsufficientCredits) for priced folder overrun, got {err:?}",
    );

    // Folder within balance: the same `FolderUpload` action passes with
    // a payload sized below the boundary. Pins that the boundary is
    // monotone (no "gate rejects everything once balance < threshold").
    require_eligible(&state, account_id, InsufficientCreditsAction::FolderUpload, 1024)
        .await
        .expect("1 KiB folder upload must fit in $0.33 balance");

    // -----------------------------------------------------------------
    // Case D: `add_local_sync_folder` action (`FolderSync`). Same
    // bytes-priced gate.
    // -----------------------------------------------------------------
    let err = require_eligible(&state, account_id, InsufficientCreditsAction::FolderSync, too_many_bytes)
        .await
        .expect_err("priced folder-sync must fail when cost exceeds balance");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::InsufficientCredits)));

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
    // Case F: enough balance to cover the priced layer. The same huge
    // byte count from case B passes when the balance is above its
    // computed cost. Confirms the gate is genuinely a comparison, not
    // a unconditional rejection above some size.
    // -----------------------------------------------------------------
    let cost_for_big = cost_for_bytes(too_many_bytes);
    // Add a safety margin so float-equality at the boundary doesn't
    // flip the result; `required_credits >=` is `>=`, not `>`.
    //
    // Use fixed-point `{:.10}` rather than default `{}` to avoid the f64
    // Display sometimes emitting scientific notation (e.g. `6e-3`) for
    // small magnitudes — the billing balance parser on the other side
    // expects a plain decimal string. 10 fractional digits is well
    // beyond the precision needed for any plausible `cost_for_big * 2.0`
    // in this test, and the value still parses back via `f64::from_str`.
    *mock.balance.lock().unwrap() = format!("{:.10}", cost_for_big * 2.0);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, too_many_bytes)
        .await
        .expect("priced upload passes when balance covers cost + margin");

    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
