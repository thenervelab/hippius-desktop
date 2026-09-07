//! The Drive storage gate, end to end, against a mocked Drive API + indexer.
//!
//! `drive_quota`'s unit tests cover the decision in isolation and
//! `eligibility_enforcement.rs` pins that Drive actions never consult the
//! credit balance. Neither exercises a REFUSAL: that suite's mock serves no
//! drive endpoints, so every Drive action there falls open by design. This
//! file is the missing half — it asserts that an account past its allowance
//! is actually stopped, with `StorageLimitReached` and not
//! `InsufficientCredits`, since the two send the user to different places.
//!
//! One `#[tokio::test]`, because the three env vars below are process-wide
//! and `INDEXER_API_KEY` / `HIPPIUS_INDEXER_URL` are additionally read into
//! a `OnceLock` on first use — a second test could not re-point them.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePool;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::auth_session_repo::{UpsertSession, upsert};
use tauri_project_lib::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use tauri_project_lib::error::{AppError, NotReadyKind};

const GIB: u64 = 1024 * 1024 * 1024;

/// The three payloads the gate reads, rewritable between cases.
#[derive(Clone)]
struct MockDrive {
    subscription: Arc<Mutex<Value>>,
    plans: Arc<Mutex<Value>>,
    used_bytes: Arc<Mutex<u64>>,
}

impl MockDrive {
    fn new() -> Self {
        Self {
            subscription: Arc::new(Mutex::new(json!({ "active": false }))),
            plans: Arc::new(Mutex::new(json!([{ "code": "free", "is_free": true, "storage_bytes": 10 * GIB }]))),
            used_bytes: Arc::new(Mutex::new(0)),
        }
    }

    fn set_used(&self, bytes: u64) {
        *self.used_bytes.lock().unwrap() = bytes;
    }
}

async fn subscription_handler(State(s): State<MockDrive>) -> Json<Value> {
    Json(s.subscription.lock().unwrap().clone())
}

async fn plans_handler(State(s): State<MockDrive>) -> Json<Value> {
    Json(s.plans.lock().unwrap().clone())
}

/// The indexer row `fetch_drive_storage_stats` reads. The byte count is a
/// STRING on the wire, as the real indexer sends it, so the test exercises
/// the same parse the production path does.
async fn metrics_handler(State(s): State<MockDrive>) -> Json<Value> {
    let used = *s.used_bytes.lock().unwrap();
    Json(json!({ "data": [{ "drive_files_size": used.to_string(), "drive_files_count": "1" }] }))
}

async fn spawn_mock() -> (String, MockDrive) {
    let state = MockDrive::new();
    let app = Router::new()
        .route("/api/drive/subscription/", get(subscription_handler))
        .route("/api/drive/plans/", get(plans_handler))
        .route("/user-extended-storage-metrics", get(metrics_handler))
        .with_state(state.clone());

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind mock server");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock server");
    });

    (format!("http://{addr}"), state)
}

async fn setup_pool_with_token(account_id: &str) -> SqlitePool {
    // Keep the test off the developer's real OS keychain.
    // SAFETY: process-global env mutation, deterministic value, set before
    // any auth_session_repo call in this file.
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

/// Assert the action is refused for storage — and specifically NOT for
/// credits. A regression that reinstated the credit gate would still error
/// here, so matching the exact kind is the whole point of the assertion.
async fn assert_refused(state: &AppState, account_id: &str, action: InsufficientCreditsAction, bytes: u64, case: &str) {
    match require_eligible(state, account_id, action, bytes).await {
        Err(AppError::NotReady(NotReadyKind::StorageLimitReached)) => {}
        Ok(()) => panic!("{case}: expected a refusal, the write was allowed"),
        Err(other) => panic!("{case}: expected NotReady(StorageLimitReached), got {other:?}"),
    }
}

#[tokio::test]
async fn the_plan_allowance_actually_refuses_a_write_past_it() {
    let (base_url, mock) = spawn_mock().await;

    // SAFETY: single test fn in this binary, so nothing races these. The
    // indexer pair is read into a `OnceLock` on first use — they are set
    // before the first `require_eligible` below and never change.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base_url);
        std::env::set_var("HIPPIUS_INDEXER_URL", &base_url);
        std::env::set_var("INDEXER_API_KEY", "test-key");
    }

    let account_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let pool = setup_pool_with_token(account_id).await;
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account_id, tauri_project_lib::auth::state::AuthCapabilities::Full)
        .expect("set session account");

    // ── A free account inside the free tier uploads normally. ──────────
    mock.set_used(GIB);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("1 GiB more on a 10 GiB free tier with 1 GiB used must be allowed");

    // ── The regression this feature exists for: a free account already
    //    past the free allowance kept uploading from the desktop while the
    //    console's server-side gate refused the same bytes. ─────────────
    mock.set_used(40 * GIB);
    assert_refused(
        &state,
        account_id,
        InsufficientCreditsAction::FileUpload,
        1,
        "free account far past the free tier",
    )
    .await;

    // ── The incoming bytes count, not just what is already stored. ─────
    mock.set_used(9 * GIB);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("9 GiB + 1 GiB exactly fills a 10 GiB tier and must be allowed");
    assert_refused(
        &state,
        account_id,
        InsufficientCreditsAction::FileUpload,
        GIB + 1,
        "incoming bytes push the account past the tier",
    )
    .await;

    // ── Every Drive action answers to the same gate, not just uploads. ──
    for action in [InsufficientCreditsAction::FolderUpload, InsufficientCreditsAction::FolderSync] {
        assert_refused(&state, account_id, action, GIB + 1, &format!("{action:?} past the tier")).await;
    }

    // ── Sharing is a Drive action too, and mints zero new bytes — so it
    //    passes while there is room and is refused only once the account
    //    is ALREADY past its allowance. `thresholds::SHARING` decides
    //    nothing here any more, which the comment at its gate now says.
    require_eligible(&state, account_id, InsufficientCreditsAction::Sharing, 0)
        .await
        .expect("sharing must pass while the account is inside its allowance");
    mock.set_used(40 * GIB);
    assert_refused(
        &state,
        account_id,
        InsufficientCreditsAction::Sharing,
        0,
        "sharing from an account past its allowance",
    )
    .await;
    mock.set_used(9 * GIB);

    // ── A paid plan raises the ceiling: the SAME bytes now fit. ────────
    *mock.subscription.lock().unwrap() = json!({ "active": true, "storage_bytes": 2000 * GIB });
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB + 1)
        .await
        .expect("an active 2 TiB plan must accept what the free tier refused");

    // ── An active plan that states no allowance falls open rather than
    //    refusing a paying account over a field the API omitted. ────────
    *mock.subscription.lock().unwrap() = json!({ "active": true });
    mock.set_used(40 * GIB);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("a plan with no stated allowance must fall open");

    // ── A catalogue with no free SKU is nothing to judge against, so the
    //    write proceeds and hcfs-server's own gate is the backstop. ─────
    *mock.subscription.lock().unwrap() = json!({ "active": false });
    *mock.plans.lock().unwrap() = json!([{ "code": "plus", "is_free": false, "storage_bytes": 999u64 }]);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("an unreadable free allowance must fall open, never refuse");

    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
