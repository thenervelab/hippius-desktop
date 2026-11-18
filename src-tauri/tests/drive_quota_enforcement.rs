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
//! It also pins who a write is asked about: a drive shared WITH the account
//! is paid for by its OWNER, so a member with no plan of their own may write
//! to it, and its refusals name the drive, never the member's plan.
//!
//! One `#[tokio::test]`, because the three env vars below are process-wide
//! and `INDEXER_API_KEY` / `HIPPIUS_INDEXER_URL` are additionally read into
//! a `OnceLock` on first use — a second test could not re-point them.

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
use tauri_project_lib::billing::eligibility::{
    InsufficientCreditsAction, SHARED_DRIVE_FROZEN, SHARED_DRIVE_FULL, SHARED_DRIVE_VIEW_ONLY, check_action_eligibility_for_drive,
    member_drive_for_label, member_drive_for_sync_path, require_eligible, require_eligible_for_drive,
};
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
    /// Answers for one `ss58_address`, over `can_upload`, so the caller and
    /// the owner of a drive shared with them can be given different plans.
    can_upload_for: Arc<Mutex<std::collections::HashMap<String, (u16, Value)>>>,
    /// `(ss58_address, folder_hash)` of the last `/can_upload` request.
    last_can_upload_target: Arc<Mutex<Option<(String, String)>>>,
}

impl MockDrive {
    fn new() -> Self {
        Self {
            subscription: Arc::new(Mutex::new(json!({ "active": false }))),
            plans: Arc::new(Mutex::new(json!([{ "code": "free", "is_free": true, "storage_bytes": 10 * GIB }]))),
            used_bytes: Arc::new(Mutex::new(0)),
            can_upload: Arc::new(Mutex::new((200, json!({ "result": true, "error": null })))),
            last_can_upload_size: Arc::new(Mutex::new(None)),
            can_upload_for: Arc::new(Mutex::new(std::collections::HashMap::new())),
            last_can_upload_target: Arc::new(Mutex::new(None)),
        }
    }

    /// What `/can_upload` answers when it is asked about `ss58`.
    fn set_can_upload_for(&self, ss58: &str, status: u16, body: Value) {
        self.can_upload_for.lock().unwrap().insert(ss58.to_owned(), (status, body));
    }

    fn last_can_upload_target(&self) -> Option<(String, String)> {
        self.last_can_upload_target.lock().unwrap().clone()
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
    let ss58 = req.get("ss58_address").and_then(Value::as_str).unwrap_or_default().to_owned();
    let hash = req.get("folder_hash").and_then(Value::as_str).unwrap_or_default().to_owned();
    *s.last_can_upload_target.lock().unwrap() = Some((ss58.clone(), hash));
    let answer = s.can_upload_for.lock().unwrap().get(&ss58).cloned();
    let (status, body) = answer.unwrap_or_else(|| s.can_upload.lock().unwrap().clone());
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

    // The drives synced here: what turns a local upload's sync root into the
    // drive it lands in. The member columns are the ones a drive shared WITH
    // this account carries.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'private',
            label TEXT NOT NULL DEFAULT 'default',
            timestamp INTEGER NOT NULL DEFAULT 0,
            is_paused INTEGER NOT NULL DEFAULT 0,
            owner_ss58 TEXT,
            wire_folder_hash TEXT,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Record a drive synced here at `path`: an own drive when `member` is
/// `None`, else one shared WITH the account by `(owner, folder hash)`.
async fn add_synced_drive(pool: &SqlitePool, account_id: &str, label: &str, path: &str, member: Option<(&str, &str)>) {
    sqlx::query("INSERT INTO sync_paths (owner, path, label, owner_ss58, wire_folder_hash) VALUES (?, ?, ?, ?, ?)")
        .bind(account_key(account_id))
        .bind(path)
        .bind(label)
        .bind(member.map(|(owner, _)| owner))
        .bind(member.map(|(_, hash)| hash))
        .execute(pool)
        .await
        .unwrap();
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

    // SAFETY: single test fn in this binary, so nothing races these. The
    // indexer pair is read into a `OnceLock` on first use — they are set
    // before the first `require_eligible` below and never change.
    unsafe {
        std::env::set_var("HIPPIUS_API_BASE_URL", &base_url);
        std::env::set_var("HIPPIUS_INDEXER_URL", &base_url);
        std::env::set_var("INDEXER_API_KEY", "test-key");
    }

    let account_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let pool = setup_pool_with_token(account_id, &base_url).await;
    let state = AppState::new();
    state.set_pool(pool.clone());
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

    shared_drives_are_asked_about_their_owner(&state, &pool, &mock, account_id).await;
}

/// A drive shared WITH the account is paid for by its OWNER. A member with no
/// plan of their own (an access-key account, say) may upload to it as far as
/// the owner's plan allows, and only the drive's own state refuses them,
/// in words about the drive. Their own drive still answers to their own plan.
async fn shared_drives_are_asked_about_their_owner(state: &AppState, pool: &SqlitePool, mock: &MockDrive, account_id: &str) {
    const OWNER: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const HASH: &str = "0123456789abcdef";
    let browse_label = format!("shared:{OWNER}~{HASH}");
    add_synced_drive(pool, account_id, "Team", "/drives/Team", Some((OWNER, HASH))).await;
    add_synced_drive(pool, account_id, "Mine", "/drives/Mine", None).await;

    // The member has no plan; the owner has room.
    mock.set_can_upload(json!({ "result": true, "error": null }));
    mock.set_can_upload_for(account_id, 200, json!({ "result": false, "error": "drive_not_entitled" }));
    mock.set_can_upload_for(OWNER, 200, json!({ "result": true, "error": null }));

    // ── Their own drive still answers to their own plan. ─────────────────
    assert_refused(state, account_id, InsufficientCreditsAction::FileUpload, GIB, "own drive with no plan").await;
    assert!(
        member_drive_for_sync_path(state, account_id, "/drives/Mine").await.is_none(),
        "an own drive is gated as it always was"
    );
    assert!(member_drive_for_label(state, account_id, "Mine").await.is_none());
    let own = check_action_eligibility_for_drive(state, account_id, InsufficientCreditsAction::FileUpload, GIB, Some("Mine"))
        .await
        .expect("own-drive check");
    assert!(!own.eligible && !own.owner_pays, "own drive, no plan: refused on the member's plan");
    assert_eq!(own.reason.as_deref(), Some("storage_limit_reached"));
    assert_eq!(own.message, None, "an own drive's refusal is the plan dialog, not a sentence");

    // ── The shared drive, synced here or only browsed, is asked about as
    //    its owner, and the owner has room. ────────────────────────────────
    let synced = member_drive_for_sync_path(state, account_id, "/drives/Team")
        .await
        .expect("synced member drive");
    let browsed = member_drive_for_label(state, account_id, &browse_label)
        .await
        .expect("browsed member drive");
    for (case, drive) in [("synced", &synced), ("browsed", &browsed)] {
        for action in [
            InsufficientCreditsAction::FileUpload,
            InsufficientCreditsAction::FolderUpload,
            InsufficientCreditsAction::FolderSync,
        ] {
            require_eligible_for_drive(state, account_id, action, GIB, Some(drive))
                .await
                .unwrap_or_else(|e| panic!("{case} {action:?}: a member with no plan was refused a drive with room: {e:?}"));
            assert_eq!(
                mock.last_can_upload_target(),
                Some((OWNER.to_owned(), HASH.to_owned())),
                "{case}: the pre-flight must ask about the owner's drive"
            );
        }
    }
    for label in ["Team", browse_label.as_str()] {
        let verdict = check_action_eligibility_for_drive(state, account_id, InsufficientCreditsAction::FileUpload, GIB, Some(label))
            .await
            .expect("shared-drive check");
        assert!(verdict.eligible, "{label}: the click must not be refused on the member's plan");
        assert!(verdict.owner_pays, "{label}: the frontend must not judge it on the member's plan either");
    }

    // ── The owner is out of room: refused, in words about the owner. ─────
    mock.set_can_upload_for(OWNER, 200, json!({ "result": false, "error": "drive_quota_exceeded" }));
    match require_eligible_for_drive(state, account_id, InsufficientCreditsAction::FileUpload, GIB, Some(&synced)).await {
        Err(AppError::Validation(message)) => assert_eq!(message, SHARED_DRIVE_FULL),
        other => panic!("a full shared drive must name its owner, never the member's plan: {other:?}"),
    }
    let full = check_action_eligibility_for_drive(state, account_id, InsufficientCreditsAction::FolderUpload, GIB, Some("Team"))
        .await
        .expect("shared-drive check");
    assert!(!full.eligible && full.owner_pays);
    assert_eq!(full.reason.as_deref(), Some("shared_drive_full"));
    assert_eq!(full.message.as_deref(), Some(SHARED_DRIVE_FULL));

    // ── The owner's account is limited (the drive is frozen), or the member
    //    is a Viewer: the server says so with a 403, and so does the gate. ──
    for (slug, sentence) in [
        ("account_read_only", SHARED_DRIVE_FROZEN),
        ("account_suspended", SHARED_DRIVE_FROZEN),
        ("forbidden", SHARED_DRIVE_VIEW_ONLY),
    ] {
        mock.set_can_upload_for(OWNER, 403, json!({ "error": slug, "message": "refused" }));
        match require_eligible_for_drive(state, account_id, InsufficientCreditsAction::FileUpload, GIB, Some(&browsed)).await {
            Err(AppError::Validation(message)) => assert_eq!(message, sentence, "{slug}"),
            other => panic!("{slug}: expected the drive's own refusal, got {other:?}"),
        }
    }

    // ── The same 403 on an own drive keeps falling open, as it always has. ─
    mock.set_can_upload_for(account_id, 403, json!({ "error": "account_read_only", "message": "refused" }));
    require_eligible(state, account_id, InsufficientCreditsAction::FileUpload, GIB)
        .await
        .expect("an own drive's 403 is not read as a verdict");
}
