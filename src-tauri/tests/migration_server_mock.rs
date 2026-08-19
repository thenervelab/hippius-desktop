//! Integration tests for the migration client ↔ server HTTP contract.
//!
//! Spins up a mock axum server that mimics the hcfs-server migration
//! endpoints (`GET /migration/{user_id}`, `GET /migration/{user_id}/status`,
//! `POST /migration/cancel`, and legacy `POST /migration`), then
//! exercises the desktop client's HTTP functions against it.
//!
//! Summary, status, and cancel require `Authorization: Bearer …`.
//! Missing or non-Bearer Authorization is 401 — the same check a later
//! HCFS `validate_and_authorize` will enforce. Legacy `POST /migration`
//! stays unauthenticated here (prod desktop does not call it).
//!
//! No live server, no S3, no Tauri AppHandle — just the HTTP contract.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

// =========================================================================
// Shared types (mirrors the server ↔ client contract)
// =========================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct MigrationFile {
    user_id: String,
    bucket_name: String,
    key: String,
    size_bytes: u64,
    is_public: bool,
    status: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigrationStatusResponse {
    needs_migration: bool,
    file_count: u64,
    total_size: u64,
    files: Vec<MigrationFile>,
}

#[derive(Debug, Deserialize)]
struct MigrationReport {
    user_id: String,
    bucket_name: String,
    keys: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
    message: String,
}

// =========================================================================
// Mock server state
// =========================================================================

#[derive(Clone)]
struct MockState {
    /// user_id → list of migration files
    files: Arc<Mutex<HashMap<String, Vec<MigrationFile>>>>,
}

impl MockState {
    fn new() -> Self {
        Self {
            files: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn seed_user(&self, user_id: &str, files: Vec<MigrationFile>) {
        self.files.lock().expect("lock poisoned").insert(user_id.to_string(), files);
    }
}

// =========================================================================
// Mock server handlers (mirrors hcfs-server migration endpoints)
// =========================================================================

/// HCFS scheme is Bearer, not Token (Token is api.hippius.com / S3).
fn require_hcfs_bearer(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let Some(value) = headers.get(axum::http::header::AUTHORIZATION) else {
        return Err((StatusCode::UNAUTHORIZED, "missing Authorization"));
    };
    let Ok(raw) = value.to_str() else {
        return Err((StatusCode::UNAUTHORIZED, "invalid Authorization"));
    };
    let Some(token) = raw.strip_prefix("Bearer ") else {
        return Err((StatusCode::UNAUTHORIZED, "expected Bearer token"));
    };
    if token.is_empty() {
        return Err((StatusCode::UNAUTHORIZED, "empty Bearer token"));
    }
    Ok(())
}

async fn get_migration_status(State(state): State<MockState>, Path(user_id): Path<String>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(resp) = require_hcfs_bearer(&headers) {
        return resp.into_response();
    }
    let guard = state.files.lock().expect("lock poisoned");
    let files = match guard.get(&user_id) {
        Some(f) => f.clone(),
        None => {
            return Json(MigrationStatusResponse {
                needs_migration: false,
                file_count: 0,
                total_size: 0,
                files: vec![],
            })
            .into_response();
        }
    };

    let total_size: u64 = files.iter().map(|f| f.size_bytes).sum();
    let file_count = files.len() as u64;
    let needs_migration = files.iter().any(|f| f.status == "Pending");

    Json(MigrationStatusResponse {
        needs_migration,
        file_count,
        total_size,
        files,
    })
    .into_response()
}

async fn migration_report(State(state): State<MockState>, Json(report): Json<MigrationReport>) -> impl IntoResponse {
    let mut guard = state.files.lock().expect("lock poisoned");
    let Some(files) = guard.get_mut(&report.user_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "user_not_found".into(),
                message: format!("User {} not found in migration data", report.user_id),
            }),
        )
            .into_response();
    };

    // Check bucket exists
    let bucket_exists = files.iter().any(|f| f.bucket_name == report.bucket_name);
    if !bucket_exists {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "bucket_not_found".into(),
                message: format!("Bucket {} not found for user", report.bucket_name),
            }),
        )
            .into_response();
    }

    // Mark reported keys as Migrated
    for key in &report.keys {
        for file in files.iter_mut() {
            if file.bucket_name == report.bucket_name && file.key == *key {
                file.status = "Migrated".to_string();
            }
        }
    }

    StatusCode::OK.into_response()
}

async fn get_job_status(Path(_user_id): Path<String>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(resp) = require_hcfs_bearer(&headers) {
        return resp.into_response();
    }
    Json(serde_json::json!({
        "status": "in_progress",
        "total": 0,
        "completed": 0,
        "failed": 0,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct CancelBody {
    /// Present on the wire (`{ "ss58_address": ... }`); the mock only
    /// checks Authorization, so the field is unread after deserialize.
    #[expect(dead_code, reason = "documents the cancel JSON body contract")]
    ss58_address: String,
}

async fn cancel_migration(headers: HeaderMap, Json(_body): Json<CancelBody>) -> impl IntoResponse {
    if let Err(resp) = require_hcfs_bearer(&headers) {
        return resp.into_response();
    }
    StatusCode::OK.into_response()
}

async fn internal_server_error() -> impl IntoResponse {
    (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong on the server").into_response()
}

async fn html_error_page() -> impl IntoResponse {
    (
        StatusCode::BAD_GATEWAY,
        axum::response::Html("<html><body><h1>502 Bad Gateway</h1></body></html>"),
    )
        .into_response()
}

async fn malformed_json() -> impl IntoResponse {
    (StatusCode::OK, axum::response::Json(serde_json::json!({"unexpected": true}))).into_response()
}

fn mock_router(state: MockState) -> Router {
    Router::new()
        .route("/migration/{user_id}", get(get_migration_status))
        .route("/migration/{user_id}/status", get(get_job_status))
        .route("/migration/cancel", post(cancel_migration))
        .route("/migration", post(migration_report))
        .with_state(state)
}

/// Router that always returns 500 for GET /migration/{user_id}.
fn error_500_router() -> Router {
    Router::new()
        .route("/migration/{user_id}", get(internal_server_error))
        .route("/migration", post(internal_server_error))
}

/// Router that returns HTML instead of JSON.
fn html_error_router() -> Router {
    Router::new().route("/migration/{user_id}", get(html_error_page))
}

/// Router that returns 200 OK with unexpected JSON shape.
fn malformed_json_router() -> Router {
    Router::new().route("/migration/{user_id}", get(malformed_json))
}

/// Start a router (without state) and return its base URL.
async fn start_stateless_server(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind to ephemeral port");
    let addr = listener.local_addr().expect("get local addr");
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .expect("mock server crashed");
    });
    format!("http://{addr}")
}

/// Start the mock server and return its base URL.
async fn start_mock_server(state: MockState) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind to ephemeral port");
    let addr = listener.local_addr().expect("get local addr");
    let router = mock_router(state);

    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .expect("mock server crashed");
    });

    format!("http://{addr}")
}

/// Build the HTTP client matching the desktop app's configuration.
fn test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("build test HTTP client")
}

/// Mirrors the desktop `get_api_token` value sent as `Authorization: Bearer`.
const TEST_API_TOKEN: &str = "test-api-token";

fn bearer_value() -> String {
    format!("Bearer {TEST_API_TOKEN}")
}

async fn get_summary_response(base_url: &str, user_id: &str) -> MigrationStatusResponse {
    test_client()
        .get(format!("{}/migration/{}", base_url.trim_end_matches('/'), user_id))
        .header("Authorization", bearer_value())
        .send()
        .await
        .expect("summary GET")
        .json()
        .await
        .expect("summary JSON")
}

// =========================================================================
// Helper: fetch migration files (mirrors desktop client logic)
// =========================================================================

async fn fetch_migration_files(base_url: &str, user_id: &str) -> Result<Vec<MigrationFile>, String> {
    let url = format!("{}/migration/{}", base_url.trim_end_matches('/'), user_id);
    let client = test_client();
    let resp = client
        .get(&url)
        .header("Authorization", bearer_value())
        .header("X-API-Key", "Arion")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Status {status}: {text}"));
    }

    let parsed: MigrationStatusResponse = resp.json().await.map_err(|e| format!("Parse failed: {e}"))?;

    // Apply same manifest filter as the desktop client
    let manifest_prefix = ".hippius_manifest_v1";
    Ok(parsed
        .files
        .into_iter()
        .filter(|f| f.key != manifest_prefix && !f.key.starts_with(&format!("{manifest_prefix}/")))
        .collect())
}

/// Report migrated files (mirrors desktop client logic in
/// report_migrated_files)
async fn report_migrated(base_url: &str, user_id: &str, bucket_name: &str, keys: Vec<String>) -> Result<(), String> {
    let url = format!("{}/migration", base_url.trim_end_matches('/'));
    let client = test_client();

    #[derive(Serialize)]
    struct ReportBody {
        user_id: String,
        bucket_name: String,
        keys: Vec<String>,
    }

    let resp = client
        .post(&url)
        .header("X-API-Key", "Arion")
        .json(&ReportBody {
            user_id: user_id.into(),
            bucket_name: bucket_name.into(),
            keys,
        })
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Report failed: {text}"));
    }

    Ok(())
}

// =========================================================================
// Tests
// =========================================================================

#[tokio::test]
async fn check_user_with_no_migration_data() {
    let state = MockState::new();
    let url = start_mock_server(state).await;

    let files = fetch_migration_files(&url, "unknown_user").await.unwrap();
    assert!(files.is_empty());
}

#[tokio::test]
async fn check_user_with_pending_files() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "photo.jpg".into(),
                size_bytes: 5000,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "doc.pdf".into(),
                size_bytes: 3000,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f.status == "Pending"));
}

#[tokio::test]
async fn manifest_files_are_filtered_out() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "real_file.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: ".hippius_manifest_v1".into(),
                size_bytes: 50,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: ".hippius_manifest_v1/shard_0".into(),
                size_bytes: 30,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].key, "real_file.txt");
}

#[tokio::test]
async fn report_marks_files_as_migrated() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Report a.txt as migrated
    report_migrated(&url, "user1", "files", vec!["a.txt".into()]).await.unwrap();

    // Verify: a.txt should be Migrated, b.txt still Pending
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    let a = files.iter().find(|f| f.key == "a.txt").unwrap();
    let b = files.iter().find(|f| f.key == "b.txt").unwrap();
    assert_eq!(a.status, "Migrated");
    assert_eq!(b.status, "Pending");
}

#[tokio::test]
async fn report_all_files_completes_migration() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Report both files
    report_migrated(&url, "user1", "files", vec!["a.txt".into(), "b.txt".into()])
        .await
        .unwrap();

    // Fetch raw response to check needs_migration flag
    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(!resp.needs_migration);
    assert!(resp.files.iter().all(|f| f.status == "Migrated"));
}

#[tokio::test]
async fn report_for_unknown_user_returns_error() {
    let state = MockState::new();
    let url = start_mock_server(state).await;

    let result = report_migrated(&url, "nonexistent", "files", vec!["a.txt".into()]).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("user_not_found"));
}

#[tokio::test]
async fn report_for_unknown_bucket_returns_error() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    let result = report_migrated(&url, "user1", "wrong_bucket", vec!["a.txt".into()]).await;

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("bucket_not_found"));
}

#[tokio::test]
async fn report_unknown_key_is_silently_ignored() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    // Report a key that doesn't exist — should succeed (server ignores)
    let result = report_migrated(&url, "user1", "files", vec!["nonexistent.txt".into()]).await;

    assert!(result.is_ok());

    // Original file should still be Pending
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files[0].status, "Pending");
}

#[tokio::test]
async fn multiple_buckets_tracked_independently() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "photos".into(),
                key: "img.jpg".into(),
                size_bytes: 5000,
                is_public: true,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "docs".into(),
                key: "readme.md".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Report only the photos bucket
    report_migrated(&url, "user1", "photos", vec!["img.jpg".into()]).await.unwrap();

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    let photo = files.iter().find(|f| f.key == "img.jpg").unwrap();
    let doc = files.iter().find(|f| f.key == "readme.md").unwrap();

    assert_eq!(photo.status, "Migrated");
    assert_eq!(doc.status, "Pending");
}

#[tokio::test]
async fn idempotent_report_does_not_fail() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    // Report same file twice — should not fail
    report_migrated(&url, "user1", "files", vec!["a.txt".into()]).await.unwrap();
    report_migrated(&url, "user1", "files", vec!["a.txt".into()]).await.unwrap();

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files[0].status, "Migrated");
}

#[tokio::test]
async fn mixed_pending_and_migrated_returns_needs_migration() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "done.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Migrated".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "todo.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(resp.needs_migration);
    assert_eq!(resp.file_count, 2);
}

#[tokio::test]
async fn total_size_sums_all_files() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "a.bin".into(),
                size_bytes: 1024,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "b.bin".into(),
                size_bytes: 2048,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert_eq!(resp.total_size, 3072);
}

#[tokio::test]
async fn large_batch_report() {
    let state = MockState::new();
    let files: Vec<MigrationFile> = (0..100)
        .map(|i| MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: format!("file_{i}.dat"),
            size_bytes: 1000,
            is_public: false,
            status: "Pending".into(),
        })
        .collect();
    state.seed_user("user1", files);
    let url = start_mock_server(state).await;

    // Report all 100 files at once
    let keys: Vec<String> = (0..100).map(|i| format!("file_{i}.dat")).collect();
    report_migrated(&url, "user1", "files", keys).await.unwrap();

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(!resp.needs_migration);
    assert_eq!(resp.file_count, 100);
    assert!(resp.files.iter().all(|f| f.status == "Migrated"));
}

/// Simulates the full migration lifecycle:
/// check → download phase → report → verify completion.
#[tokio::test]
async fn full_migration_lifecycle() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "photo.jpg".into(),
                size_bytes: 5000,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "doc.pdf".into(),
                size_bytes: 3000,
                is_public: false,
                status: "Pending".into(),
            },
            // Manifest file should be filtered out by client
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: ".hippius_manifest_v1".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Step 1: Check migration — client filters out manifest
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files.len(), 2);
    let pending: Vec<&MigrationFile> = files.iter().filter(|f| f.status == "Pending").collect();
    assert_eq!(pending.len(), 2);

    // Step 2: Simulate download phase (just track what we'd download)
    let sync_dir = tempfile::tempdir().expect("create temp dir");
    for file in &pending {
        let dest = sync_dir.path().join(&file.bucket_name).join(&file.key);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "mock content").unwrap();
    }

    // Step 3: Report migrated files (simulates report_migrated_files)
    let mut bucket_keys: HashMap<String, Vec<String>> = HashMap::new();
    for file in &pending {
        let file_path = sync_dir.path().join(&file.bucket_name).join(&file.key);
        if file_path.exists() {
            bucket_keys.entry(file.bucket_name.clone()).or_default().push(file.key.clone());
        }
    }

    for (bucket, keys) in &bucket_keys {
        report_migrated(&url, "user1", bucket, keys.clone()).await.unwrap();
    }

    // Step 4: Verify completion
    let files_after = fetch_migration_files(&url, "user1").await.unwrap();
    let still_pending: Vec<&MigrationFile> = files_after.iter().filter(|f| f.status == "Pending").collect();
    assert!(still_pending.is_empty(), "expected no pending files, got: {still_pending:?}");

    // The raw response should show needs_migration = false
    // (manifest file is still Pending on server but client filters it out)
    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    // Server still has manifest as Pending, so needs_migration is true
    // from server's perspective — but the client filters it out
    let client_pending: Vec<&MigrationFile> = resp
        .files
        .iter()
        .filter(|f| f.status == "Pending" && f.key != ".hippius_manifest_v1" && !f.key.starts_with(".hippius_manifest_v1/"))
        .collect();
    assert!(client_pending.is_empty(), "client should see no pending files after migration");
}

/// Tests the client-side logic for determining needs_migration from
/// the server response.
#[tokio::test]
async fn client_migration_check_logic() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    // Simulate check_migration logic
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    let pending: Vec<MigrationFile> = files.into_iter().filter(|f| f.status == "Pending").collect();
    let total_size: u64 = pending.iter().map(|f| f.size_bytes).sum();

    let needs_migration = !pending.is_empty();
    let file_count = pending.len() as u64;

    assert!(needs_migration);
    assert_eq!(file_count, 1);
    assert_eq!(total_size, 100);
}

/// Tests that different users' data is isolated.
#[tokio::test]
async fn user_isolation() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "user1_file.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    state.seed_user(
        "user2",
        vec![MigrationFile {
            user_id: "user2".into(),
            bucket_name: "files".into(),
            key: "user2_file.txt".into(),
            size_bytes: 200,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    // Report user1's file
    report_migrated(&url, "user1", "files", vec!["user1_file.txt".into()]).await.unwrap();

    // user1 should be complete, user2 still pending
    let u1 = fetch_migration_files(&url, "user1").await.unwrap();
    let u2 = fetch_migration_files(&url, "user2").await.unwrap();

    assert!(u1.iter().all(|f| f.status == "Migrated"));
    assert!(u2.iter().all(|f| f.status == "Pending"));
}

// =========================================================================
// Error path tests
// =========================================================================

#[tokio::test]
async fn server_500_returns_error() {
    let url = start_stateless_server(error_500_router()).await;

    let result = fetch_migration_files(&url, "user1").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("500"), "error should mention status 500, got: {err}");
}

#[tokio::test]
async fn server_html_error_returns_error() {
    let url = start_stateless_server(html_error_router()).await;

    let result = fetch_migration_files(&url, "user1").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.contains("502") || err.contains("Bad Gateway"),
        "error should mention 502 or Bad Gateway, got: {err}"
    );
}

#[tokio::test]
async fn malformed_json_returns_parse_error() {
    let url = start_stateless_server(malformed_json_router()).await;

    let result = fetch_migration_files(&url, "user1").await;
    // Server returns 200 with wrong JSON shape — should fail to parse
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("Parse failed"), "should be a parse error, got: {err}");
}

#[tokio::test]
async fn connection_refused_returns_error() {
    // Use a URL that nothing is listening on
    let result = fetch_migration_files("http://127.0.0.1:1", "user1").await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("Request failed"), "should be a connection error, got: {err}");
}

#[tokio::test]
async fn report_to_500_server_returns_error() {
    let url = start_stateless_server(error_500_router()).await;

    let result = report_migrated(&url, "user1", "files", vec!["a.txt".into()]).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn report_with_empty_keys_succeeds() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    // Report with empty keys — should succeed but change nothing
    let result = report_migrated(&url, "user1", "files", vec![]).await;
    assert!(result.is_ok());

    // File should still be Pending
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files[0].status, "Pending");
}

#[tokio::test]
async fn fetch_empty_user_id_returns_error() {
    let state = MockState::new();
    let url = start_mock_server(state).await;

    // Empty user_id produces an invalid URL path — server returns 404
    let result = fetch_migration_files(&url, "").await;
    assert!(result.is_err(), "empty user_id should fail: {result:?}");
}

#[tokio::test]
async fn report_with_special_characters_in_key() {
    let state = MockState::new();
    let special_key = "path/with spaces/file (1).txt";
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: special_key.into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    report_migrated(&url, "user1", "files", vec![special_key.into()]).await.unwrap();

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    let file = files.iter().find(|f| f.key == special_key).unwrap();
    assert_eq!(file.status, "Migrated");
}

#[tokio::test]
async fn user_id_with_special_characters() {
    let state = MockState::new();
    let user_id = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    state.seed_user(
        user_id,
        vec![MigrationFile {
            user_id: user_id.into(),
            bucket_name: "files".into(),
            key: "a.txt".into(),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    let files = fetch_migration_files(&url, user_id).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].user_id, user_id);
}

#[tokio::test]
async fn needs_migration_false_when_all_already_migrated() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "a.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Migrated".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: "b.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Migrated".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(!resp.needs_migration);
    assert_eq!(resp.file_count, 2);
}

#[tokio::test]
async fn zero_byte_files_handled_correctly() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: "empty.txt".into(),
            size_bytes: 0,
            is_public: false,
            status: "Pending".into(),
        }],
    );
    let url = start_mock_server(state).await;

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(resp.needs_migration);
    assert_eq!(resp.total_size, 0);
    assert_eq!(resp.file_count, 1);

    // Report it as migrated — zero-byte files should work the same
    report_migrated(&url, "user1", "files", vec!["empty.txt".into()]).await.unwrap();

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert_eq!(files[0].status, "Migrated");
}

#[tokio::test]
async fn manifest_only_user_has_no_client_visible_files() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: ".hippius_manifest_v1".into(),
                size_bytes: 50,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "files".into(),
                key: ".hippius_manifest_v1/shard_0".into(),
                size_bytes: 30,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Server says needs_migration=true, but client filters everything
    let files = fetch_migration_files(&url, "user1").await.unwrap();
    assert!(files.is_empty(), "client should see zero files when only manifests exist");
}

#[tokio::test]
async fn partial_batch_report_leaves_unreported_pending() {
    let state = MockState::new();
    let file_count = 10;
    let files: Vec<MigrationFile> = (0..file_count)
        .map(|i| MigrationFile {
            user_id: "user1".into(),
            bucket_name: "files".into(),
            key: format!("file_{i}.dat"),
            size_bytes: 100,
            is_public: false,
            status: "Pending".into(),
        })
        .collect();
    state.seed_user("user1", files);
    let url = start_mock_server(state).await;

    // Report only the first 5
    let keys: Vec<String> = (0..5).map(|i| format!("file_{i}.dat")).collect();
    report_migrated(&url, "user1", "files", keys).await.unwrap();

    let resp: MigrationStatusResponse = get_summary_response(&url, "user1").await;

    assert!(resp.needs_migration);
    let migrated = resp.files.iter().filter(|f| f.status == "Migrated").count();
    let pending = resp.files.iter().filter(|f| f.status == "Pending").count();
    assert_eq!(migrated, 5);
    assert_eq!(pending, 5);
}

#[tokio::test]
async fn report_cross_bucket_key_does_not_affect_other_bucket() {
    let state = MockState::new();
    state.seed_user(
        "user1",
        vec![
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "bucket_a".into(),
                key: "same_name.txt".into(),
                size_bytes: 100,
                is_public: false,
                status: "Pending".into(),
            },
            MigrationFile {
                user_id: "user1".into(),
                bucket_name: "bucket_b".into(),
                key: "same_name.txt".into(),
                size_bytes: 200,
                is_public: false,
                status: "Pending".into(),
            },
        ],
    );
    let url = start_mock_server(state).await;

    // Report same_name.txt only for bucket_a
    report_migrated(&url, "user1", "bucket_a", vec!["same_name.txt".into()]).await.unwrap();

    let files = fetch_migration_files(&url, "user1").await.unwrap();
    let a = files.iter().find(|f| f.bucket_name == "bucket_a").unwrap();
    let b = files.iter().find(|f| f.bucket_name == "bucket_b").unwrap();
    assert_eq!(a.status, "Migrated");
    assert_eq!(b.status, "Pending");
}

// =========================================================================
// HCFS Bearer authorization (summary GET, status GET, cancel POST)
// =========================================================================

#[derive(Clone, Copy, Debug)]
enum HcfsMigrationEndpoint {
    Summary,
    Status,
    Cancel,
}

fn hcfs_migration_request(client: &reqwest::Client, base: &str, endpoint: HcfsMigrationEndpoint) -> reqwest::RequestBuilder {
    match endpoint {
        HcfsMigrationEndpoint::Summary => client.get(format!("{base}/migration/user1")),
        HcfsMigrationEndpoint::Status => client.get(format!("{base}/migration/user1/status")),
        HcfsMigrationEndpoint::Cancel => client
            .post(format!("{base}/migration/cancel"))
            .json(&serde_json::json!({ "ss58_address": "user1" })),
    }
}

/// Summary, status, and cancel must 401 when Authorization is missing,
/// uses the api.hippius.com `Token` scheme, or is an empty Bearer. A
/// `Bearer <token>` request must succeed. This is the desktop-side
/// contract a later HCFS `validate_and_authorize` will rely on.
#[tokio::test]
async fn hcfs_migration_routes_require_bearer_authorization() {
    let url = start_mock_server(MockState::new()).await;
    let client = test_client();
    let endpoints = [
        HcfsMigrationEndpoint::Summary,
        HcfsMigrationEndpoint::Status,
        HcfsMigrationEndpoint::Cancel,
    ];

    for endpoint in endpoints {
        let missing = hcfs_migration_request(&client, &url, endpoint).send().await.expect("send missing-auth");
        assert_eq!(
            missing.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{endpoint:?} must 401 without Authorization"
        );

        let token_scheme = hcfs_migration_request(&client, &url, endpoint)
            .header("Authorization", format!("Token {TEST_API_TOKEN}"))
            .send()
            .await
            .expect("send Token scheme");
        assert_eq!(
            token_scheme.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{endpoint:?} must 401 on Token scheme (HCFS is Bearer)"
        );

        let empty_bearer = hcfs_migration_request(&client, &url, endpoint)
            .header("Authorization", "Bearer ")
            .send()
            .await
            .expect("send empty Bearer");
        assert_eq!(
            empty_bearer.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{endpoint:?} must 401 on empty Bearer token"
        );

        let bearer = hcfs_migration_request(&client, &url, endpoint)
            .header("Authorization", bearer_value())
            .send()
            .await
            .expect("send Bearer");
        assert!(
            bearer.status().is_success(),
            "{endpoint:?} must accept Authorization: Bearer, got {}",
            bearer.status()
        );
    }
}
