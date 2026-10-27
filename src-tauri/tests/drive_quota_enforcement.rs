//! The Drive storage gate, end to end, against a mocked hcfs-server,
//! Drive API and indexer.
//!
//! `drive_quota`'s unit tests cover the verdict mapping in isolation and
//! `eligibility_enforcement.rs` pins that Drive actions never consult the
//! credit balance. Neither exercises a REFUSAL: that suite's mock serves no
//! `/can_upload`, so every Drive action there falls open by design. This
//! file is the missing half — it asserts that the server's verdict is what
//! stops a write, that a server yes is never overruled by what the Drive
//! API or the indexer say, and that a refusal is `StorageLimitReached` and
//! not `InsufficientCredits`, since the two send the user to different
//! places.
//!
//! One `#[tokio::test]`, because the two env vars below are process-wide and
//! `HIPPIUS_INDEXER_URL` is additionally read into a `OnceLock` on first use —
//! a second test could not re-point it.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router, extract::State, routing::get, routing::post};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePool;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::auth_session_repo::{UpsertSession, upsert};
use tauri_project_lib::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use tauri_project_lib::error::{AppError, NotReadyKind};

const GIB: u64 = 1024 * 1024 * 1024;

/// The payloads the gate reads, rewritable between cases.
///
/// The Drive API (subscription + plans) and the indexer are what the home
/// card reads; hcfs-server's `/can_upload` is what the GATE reads. The two
/// are served by one mock so a case can make them disagree — which is the
/// whole bug: the card can see a plan the gate cannot.
#[derive(Clone)]
struct MockDrive {
    subscription: Arc<Mutex<Value>>,
    plans: Arc<Mutex<Value>>,
    used_bytes: Arc<Mutex<u64>>,
    /// HTTP status + body `/can_upload` answers with.
    can_upload: Arc<Mutex<(u16, Value)>>,
    /// `size_bytes` of the last `/can_upload` request, so a case can assert
    /// the gate forwarded the real payload size.
    last_can_upload_size: Arc<Mutex<Option<u64>>>,
}

impl MockDrive {
    fn new() -> Self {
        Self {
            subscription: Arc::new(Mutex::new(json!({ "active": false }))),
            plans: Arc::new(Mutex::new(json!([{ "code": "free", "is_free": true, "storage_bytes": 10 * GIB }]))),
            used_bytes: Arc::new(Mutex::new(0)),
            can_upload: Arc::new(Mutex::new((200, json!({ "result": true, "error": null })))),
            last_can_upload_size: Arc::new(Mutex::new(None)),
        }
    }

    fn set_used(&self, bytes: u64) {
        *self.used_bytes.lock().unwrap() = bytes;
    }

    /// hcfs-server's answer to the pre-flight, as `CanUploadResponse` JSON.
    fn set_can_upload(&self, body: Value) {
        *self.can_upload.lock().unwrap() = (200, body);
    }

    /// Make the pre-flight fail at the transport/5xx level.
    fn set_can_upload_status(&self, status: u16) {
        self.can_upload.lock().unwrap().0 = status;
    }

    fn last_can_upload_size(&self) -> Option<u64> {
        *self.last_can_upload_size.lock().unwrap()
    }
}

/// hcfs-server's `POST /can_upload`. Records the requested size, then answers
/// whatever the case configured.
async fn can_upload_handler(State(s): State<MockDrive>, Json(req): Json<Value>) -> axum::response::Response {
    *s.last_can_upload_size.lock().unwrap() = req.get("size_bytes").and_then(Value::as_u64);
    let (status, body) = s.can_upload.lock().unwrap().clone();
    (StatusCode::from_u16(status).expect("valid status"), Json(body)).into_response()
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
        .route("/can_upload", post(can_upload_handler))
        .with_state(state.clone());

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind mock server");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock server");
    });

    (format!("http://{addr}"), state)
}

/// An in-memory DB with a session token and an `hcfs_config` row pointing
/// the account's sync server at `hcfs_url`, which is where the gate sends
/// its `/can_upload` pre-flight.
async fn setup_pool_with_token(account_id: &str, hcfs_url: &str) -> SqlitePool {
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
            email TEXT,
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
            email: None,
            logout_time_minutes: None,
        },
    )
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS hcfs_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL UNIQUE,
            server_url TEXT NOT NULL DEFAULT '',
            drive_password TEXT NOT NULL DEFAULT '',
            encryption_version INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO hcfs_config (owner, server_url) VALUES (?, ?)")
        .bind(account_key(account_id))
        .bind(hcfs_url)
        .execute(&pool)
        .await
        .unwrap();

    // The bearer the pre-flight sends is the hcfs API token (`get_api_token`),
    // not the Hippius session token above; with the keychain disabled it is
    // read from this plaintext fallback, keyed by the RAW account id.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS objectstore_auth_scoped (
            owner TEXT PRIMARY KEY,
            temp_auth_key TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO objectstore_auth_scoped (owner, temp_auth_key) VALUES (?, ?)")
        .bind(account_id)
        .bind("hcfs-test-bearer")
        .execute(&pool)
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
async fn the_gate_follows_the_servers_preflight_verdict() {
    let (base_url, mock) = spawn_mock().await;

    // SAFETY: single test fn in this binary, so nothing races these. The indexer
    // URL is read into a `OnceLock` on first use — it is set before the first
    // `require_eligible` below and never changes.
    //
    // No indexer credential is set: the client authenticates as the session account,
    // whose token `setup_pool_with_token` puts in the pool below.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base_url);
        std::env::set_var("HIPPIUS_INDEXER_URL", &base_url);
    }

    let account_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let pool = setup_pool_with_token(account_id, &base_url).await;
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account_id, tauri_project_lib::auth::state::AuthCapabilities::Full)
        .expect("set session account");

    // ── The report of 2026-09-08: the drive rail says "no plan", the indexer
    //    says 60 GiB, and hcfs-server says the write is fine (a legacy plan or
    //    credits cover it — its rule is grant-only, credits are the overflow).
    //    The desktop must not refuse what the server accepts. ─────────────
    *mock.subscription.lock().unwrap() = json!({ "active": false });
    mock.set_used(60 * GIB);
    mock.set_can_upload(json!({ "result": true, "error": null }));
    require_eligible(&state, account_id, InsufficientCreditsAction::Sharing, 4 * 1024 * 1024)
        .await
        .expect("the server said yes; the desktop must not refuse the share");
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("the server said yes; the desktop must not refuse the upload");
    assert_eq!(mock.last_can_upload_size(), Some(GIB), "the pre-flight must carry the real payload size");

    // ── The server's own refusal lands as StorageLimitReached, never as a
    //    credits refusal — whichever slug the server chose. ───────────────
    for slug in [
        "drive_quota_exceeded",
        "drive_not_entitled",
        "zero_balance",
        "insufficient_balance: need 3 cents, have 1 cents",
    ] {
        mock.set_can_upload(json!({ "result": false, "error": slug }));
        assert_refused(
            &state,
            account_id,
            InsufficientCreditsAction::FileUpload,
            GIB,
            &format!("server denial {slug}"),
        )
        .await;
    }

    // ── A pre-flight that cannot be reached falls open: hcfs-server is the
    //    backstop on the write itself. ───────────────────────────────────
    mock.set_can_upload_status(503);
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("an unreachable pre-flight must not refuse");

    // ── The server's own "I could not answer" is not a verdict either. ──
    mock.set_can_upload(json!({ "result": false, "error": "Failed to fetch billing balance" }));
    require_eligible(&state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("a billing outage at the server must not refuse");
    mock.set_can_upload(json!({ "result": true, "error": null }));

    // ── Every Drive action answers to the same pre-flight, not just uploads;
    //    a share carries the bytes of the copy it uploads. ──────────────
    mock.set_can_upload(json!({ "result": false, "error": "drive_quota_exceeded" }));
    for action in [
        InsufficientCreditsAction::FileUpload,
        InsufficientCreditsAction::FolderUpload,
        InsufficientCreditsAction::FolderSync,
        InsufficientCreditsAction::Sharing,
    ] {
        assert_refused(&state, account_id, action, GIB, &format!("{action:?} refused by the server")).await;
        assert_eq!(mock.last_can_upload_size(), Some(GIB), "{action:?} must forward its byte count");
    }
    mock.set_can_upload(json!({ "result": true, "error": null }));
    for action in [
        InsufficientCreditsAction::FileUpload,
        InsufficientCreditsAction::FolderUpload,
        InsufficientCreditsAction::FolderSync,
        InsufficientCreditsAction::Sharing,
    ] {
        require_eligible(&state, account_id, action, GIB)
            .await
            .unwrap_or_else(|e| panic!("{action:?} must pass when the server says yes: {e:?}"));
    }

    // ── What the Drive API and the indexer say is irrelevant to the gate:
    //    the card may draw from them, the refusal comes from the server. ─
    *mock.subscription.lock().unwrap() = json!({ "active": true, "storage_bytes": 2000 * GIB });
    mock.set_used(GIB);
    mock.set_can_upload(json!({ "result": false, "error": "drive_quota_exceeded" }));
    assert_refused(
        &state,
        account_id,
        InsufficientCreditsAction::FileUpload,
        1,
        "a server refusal wins over a roomy-looking plan",
    )
    .await;

    unsafe {
        std::env::remove_var("HIPPIUS_API_BASE_URL");
    }
}
