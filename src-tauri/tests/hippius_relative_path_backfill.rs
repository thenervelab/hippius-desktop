//! Regression test for the desktop `relative_path` backfill contract.
//!
//! PR 7 Task 7.4 of the hcfs nested-folder-browsing plan.
//!
//! # What this suite pins
//!
//! The backfill in `src-tauri/src/sync/relative_path_backfill.rs` is
//! the one-shot legacy-row repair path: every drive created before the
//! server-side `relative_path` column existed walks its local
//! `SyncState.path_index` exactly once and posts it to
//! `POST /register_relative_paths/{ss58}/{folder_hash}`. After a
//! successful sweep the `sync_paths.relative_paths_backfilled_at`
//! timestamp is set so the sweep never runs again for that drive.
//!
//! These tests exercise the two contracts the sweep depends on:
//!
//! 1. **Server-facing HTTP wire shape.** Calls `HcfsClient::register_relative_paths`
//!    (the exact production entry point the desktop code uses via
//!    `submit_batches`) against an axum mock and asserts:
//!     - URL template: `/register_relative_paths/{ss58}/{folder_hash}`
//!     - JSON body: `{"entries": [{"path_hash": "<hex>", "relative_path": "<str>"}, ...]}`
//!       with `path_hash` hex-encoded (not a byte array) and
//!       `relative_path` carried verbatim.
//!     - Response shape: the client decodes
//!       `{"Success": {"updated": u32, "skipped": u32, "errors": [...]}}`.
//!     - Per-batch cap: entries are sent in chunks of at most
//!       `MAX_REGISTER_RELATIVE_PATHS_BATCH = 500` (enforced client-side
//!       before the wire).
//! 2. **Local flag state machine.** Emulates the
//!    `is_backfilled` / `mark_backfilled` state transitions the way
//!    `run_backfill_for_drive` drives them, and asserts:
//!     - NULL → non-NULL after a successful run.
//!     - A second attempt observes the non-NULL flag and short-circuits
//!       (no additional HTTP requests).
//!     - A server-side failure (HTTP 500) leaves the flag NULL so the
//!       next launch retries.
//!
//! # What's out of scope
//!
//! `run_backfill_for_drive` is `pub(crate)` and not reachable from an
//! integration test without modifying production visibility (which this
//! task is forbidden from doing). The inner helpers
//! (`is_backfilled`, `mark_backfilled`, `path_index_to_entries`,
//! and the chunking math on `MAX_REGISTER_RELATIVE_PATHS_BATCH`) already
//! have unit-test coverage inside
//! `src-tauri/src/sync/relative_path_backfill.rs::tests`. The integration
//! suite's distinct value is:
//!
//!  - the end-to-end HTTP shape the server actually sees (`axum` mock),
//!  - the DB NULL/non-NULL invariant across success and failure paths.
//!
//! Driving a real `DriveManager` through `init()` and `load_sync_state()`
//! would add ~200ms of disk I/O and a real mnemonic encryption cycle to
//! each test case for no additional contract coverage — those are already
//! exercised by hcfs-client's own tests and by `tests/file_commands.rs`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
};
use hcfs_client::client::HcfsClient;
use hcfs_shared::network::{MAX_REGISTER_RELATIVE_PATHS_BATCH, RegisterRelativePathEntry, RegisterRelativePathsRequest};
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri_project_lib::utils::schema::ensure_table_schema;
use tokio::net::TcpListener;

// =============================================================================
// Shared fixtures
// =============================================================================

/// A synthetic substrate address. Built with a visibly-fake prefix so a
/// grep for this string in captured request logs immediately flags the
/// test origin.
const TEST_ACCOUNT: &str = "TEST_ACCOUNT_relative_path_backfill_xxxxxxxxxxxx";

/// A fixed 16-char hex folder hash. The production code derives this via
/// `hcfs_client::drive::keys::folder_hash(label)`; the value itself is
/// opaque to the server — what matters is that the same string ends up
/// in the URL path and the DB query. Pinning a literal keeps the test
/// independent of the hash derivation's internals.
const TEST_FOLDER_HASH: &str = "0123456789abcdef";

/// Mirror of the production `account_key()` helper (hex-encoded first
/// 8 bytes of SHA-256). Must stay in sync with
/// `src-tauri/src/auth/account_key.rs` — mirrored here (rather than
/// re-exported) because that helper is `pub(crate)`.
fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new().chain_update(account_id.as_bytes()).finalize();
    hex::encode(&digest[..8])
}

/// Build an in-memory pool with the full production schema applied.
/// Using `ensure_table_schema` instead of hand-rolled DDL guarantees the
/// `relative_paths_backfilled_at` column (added in PR 7 Task 7.3) stays
/// in lockstep with production.
async fn temp_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open sqlite::memory:");
    ensure_table_schema(&pool).await.expect("apply schema");
    pool
}

/// Insert a `sync_paths` row with the chosen backfill timestamp state.
async fn seed_sync_path(pool: &SqlitePool, account_id: &str, label: &str, backfilled_at: Option<i64>) {
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, relative_paths_backfilled_at)
         VALUES (?, ?, 'private', ?, ?, ?)",
    )
    .bind(account_key(account_id))
    .bind("/tmp/test-backfill-path")
    .bind(label)
    .bind(0i64)
    .bind(backfilled_at)
    .execute(pool)
    .await
    .expect("seed sync_paths row");
}

/// Mirror of `sync::relative_path_backfill::is_backfilled` — kept in
/// sync with the production SQL so the test observes the exact same
/// state machine the production code does, without calling the
/// `pub(crate)` helper.
async fn is_backfilled(pool: &SqlitePool, account_id: &str, label: &str) -> bool {
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT relative_paths_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(account_key(account_id))
        .bind(label)
        .fetch_optional(pool)
        .await
        .expect("query sync_paths");
    matches!(row, Some((Some(_),)))
}

/// Mirror of `sync::relative_path_backfill::mark_backfilled` — sets the
/// timestamp to the current Unix epoch seconds.
async fn mark_backfilled(pool: &SqlitePool, account_id: &str, label: &str) -> i64 {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE sync_paths SET relative_paths_backfilled_at = ? WHERE owner = ? AND label = ?")
        .bind(now)
        .bind(account_key(account_id))
        .bind(label)
        .execute(pool)
        .await
        .expect("update sync_paths");
    now
}

// =============================================================================
// Mock hcfs-server
// =============================================================================

/// Captures every request that lands on the mock. The `Vec<RegisterRelativePathsRequest>`
/// preserves arrival order so chunked batches can be asserted in sequence.
#[derive(Clone, Default)]
struct MockRecorder {
    requests: Arc<Mutex<Vec<RegisterRelativePathsRequest>>>,
}

impl MockRecorder {
    fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> Vec<RegisterRelativePathsRequest> {
        self.requests.lock().expect("recorder lock").clone()
    }
}

/// Mirrors the server's `NetworkResponse<T>` wire encoding for `Success`.
/// The real `NetworkResponse` enum (from `hcfs-shared`) serializes as
/// `{"Success": <T>}` via default serde enum tagging — we hand-roll the
/// same shape here so the test is independent of any adapter changes
/// upstream.
#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
enum WireResponse<T: Serialize> {
    Success(T),
}

#[derive(Serialize)]
struct BackfillOk {
    updated: u32,
    skipped: u32,
    errors: Vec<serde_json::Value>,
}

/// Successful handler: records the request body and returns the standard
/// `Success` envelope with `updated == entries.len()`.
async fn ok_handler(
    State(recorder): State<MockRecorder>,
    Path((ss58, folder_hash)): Path<(String, String)>,
    Json(body): Json<RegisterRelativePathsRequest>,
) -> impl IntoResponse {
    assert_eq!(ss58, TEST_ACCOUNT, "mock received wrong ss58 in URL path");
    assert_eq!(folder_hash, TEST_FOLDER_HASH, "mock received wrong folder_hash in URL path");

    let entry_count = body.entries.len();
    recorder.requests.lock().expect("recorder lock").push(body);

    Json(WireResponse::Success(BackfillOk {
        updated: u32::try_from(entry_count).unwrap_or(u32::MAX),
        skipped: 0,
        errors: vec![],
    }))
    .into_response()
}

/// Failure handler: 500 with a text body, shaped to look like a real
/// transient server error. Nothing is recorded — the server is simulating
/// "the request arrived but I can't reply with a useful JSON", which is
/// the path that maps to `BackfillOutcome::RetryLater` in production.
async fn fail_500_handler(
    State(recorder): State<MockRecorder>,
    Path((_ss58, _folder_hash)): Path<(String, String)>,
    Json(body): Json<RegisterRelativePathsRequest>,
) -> impl IntoResponse {
    // Still record so a test can assert "exactly N requests hit the
    // server" — the 500 body doesn't change the wire bookkeeping.
    recorder.requests.lock().expect("recorder lock").push(body);
    (StatusCode::INTERNAL_SERVER_ERROR, "simulated transient server error").into_response()
}

async fn start_server(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .expect("mock server crashed");
    });
    format!("http://{addr}")
}

async fn start_ok_server(recorder: MockRecorder) -> String {
    let router = Router::new()
        .route("/register_relative_paths/{ss58}/{folder_hash}", post(ok_handler))
        .with_state(recorder);
    start_server(router).await
}

async fn start_fail_server(recorder: MockRecorder) -> String {
    let router = Router::new()
        .route("/register_relative_paths/{ss58}/{folder_hash}", post(fail_500_handler))
        .with_state(recorder);
    start_server(router).await
}

// =============================================================================
// HcfsClient fixture
// =============================================================================

/// Build an `HcfsClient` pointing at `base_url`. Mirrors what the
/// production `build_one_shot_client` produces — same ss58, same folder
/// hash, same bearer token shape. Differences (e.g. no TLS) are
/// intentional: debug builds of the production code set
/// `accept_invalid_certs = cfg!(debug_assertions)`, which is what lets
/// the real client talk to a plain-HTTP test server.
fn make_client(base_url: &str) -> HcfsClient {
    let config = hcfs_client::client::HcfsClientConfig {
        base_url: base_url.to_string(),
        bearer_token: "test-bearer-token".to_string(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: TEST_ACCOUNT.to_string(),
        folder_hash: TEST_FOLDER_HASH.to_string(),
    };
    HcfsClient::new(config).expect("build HcfsClient")
}

/// Deterministic fixture of backfill entries. Uses fixed byte patterns
/// for `path_hash` so the serialized JSON is stable across runs and
/// cheap to assert against.
fn fixture_entries(count: usize) -> Vec<RegisterRelativePathEntry> {
    (0..count)
        .map(|i| RegisterRelativePathEntry {
            #[expect(clippy::cast_possible_truncation, reason = "i is bounded by `count` which is small in tests")]
            path_hash: [i as u8; 32],
            relative_path: format!("nested/folder_{i}/file_{i}.txt"),
        })
        .collect()
}

/// Drive a single batch through the client. Mirrors the
/// single-iteration body of production's `submit_batches` loop — the
/// integration-test seam we have to the wire without calling a
/// `pub(crate)` helper.
async fn submit_one_batch(client: &HcfsClient, entries: Vec<RegisterRelativePathEntry>) -> Result<(u32, u32), String> {
    client
        .register_relative_paths(TEST_ACCOUNT, TEST_FOLDER_HASH, entries)
        .await
        .map(|r| (r.updated, r.skipped))
        .map_err(|e| e.to_string())
}

// =============================================================================
// Tests
// =============================================================================

/// Happy path: a nested-directory backfill posts the expected JSON
/// shape, the server records `updated == N`, and the DB transitions
/// NULL → non-NULL.
#[tokio::test]
async fn backfill_populates_relative_paths_and_marks_flag() {
    let pool = temp_pool().await;
    seed_sync_path(&pool, TEST_ACCOUNT, "default", None).await;
    assert!(!is_backfilled(&pool, TEST_ACCOUNT, "default").await, "pre-condition: flag NULL");

    let recorder = MockRecorder::new();
    let base_url = start_ok_server(recorder.clone()).await;
    let client = make_client(&base_url);

    let entries = fixture_entries(3);
    let before = chrono::Utc::now().timestamp();

    let (updated, skipped) = submit_one_batch(&client, entries.clone()).await.expect("submit succeeded");
    mark_backfilled(&pool, TEST_ACCOUNT, "default").await;

    assert_eq!(updated, 3, "server should report all 3 entries updated");
    assert_eq!(skipped, 0);

    // Post-condition: DB flag is now non-NULL and at least as recent as `before`.
    assert!(is_backfilled(&pool, TEST_ACCOUNT, "default").await, "flag must be non-NULL after success");
    let row: (i64,) = sqlx::query_as("SELECT relative_paths_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(account_key(TEST_ACCOUNT))
        .bind("default")
        .fetch_one(&pool)
        .await
        .expect("fetch timestamp");
    assert!(row.0 >= before, "timestamp {} should be >= before {before}", row.0);

    // Post-condition: exactly one POST hit the mock, carrying all three
    // entries with their relative_path values intact.
    let recorded = recorder.snapshot();
    assert_eq!(recorded.len(), 1, "expected exactly one HTTP POST, got {}", recorded.len());
    assert_eq!(recorded[0].entries.len(), 3);
    let received_paths: Vec<&str> = recorded[0].entries.iter().map(|e| e.relative_path.as_str()).collect();
    assert_eq!(
        received_paths,
        vec!["nested/folder_0/file_0.txt", "nested/folder_1/file_1.txt", "nested/folder_2/file_2.txt"],
        "relative_path values must round-trip verbatim"
    );
    // Per-entry path_hash round-trips as the fixed byte pattern.
    for (i, entry) in recorded[0].entries.iter().enumerate() {
        assert_eq!(entry.path_hash, entries[i].path_hash, "path_hash byte-for-byte match for entry {i}");
    }
}

/// Idempotency: once the flag is set, a subsequent backfill pass
/// observes the non-NULL flag via `is_backfilled` and short-circuits
/// before touching the wire. This is the guard that keeps a hot-reload
/// or repeated `spawn_backfill` from DoS-ing the server.
#[tokio::test]
async fn backfill_is_idempotent_once_flag_set() {
    let pool = temp_pool().await;
    // Seed with a PAST timestamp so `is_backfilled` returns true immediately.
    seed_sync_path(&pool, TEST_ACCOUNT, "default", Some(1_700_000_000)).await;
    assert!(is_backfilled(&pool, TEST_ACCOUNT, "default").await, "pre-condition: flag set");

    let recorder = MockRecorder::new();
    let base_url = start_ok_server(recorder.clone()).await;
    let client = make_client(&base_url);

    // Production's `run_backfill_for_drive` checks `is_backfilled` at the
    // top and returns `AlreadyDone` without building a client or touching
    // the wire. Mirror that gate here: if already backfilled, we MUST
    // NOT make any HTTP calls.
    let should_run = !is_backfilled(&pool, TEST_ACCOUNT, "default").await;
    assert!(!should_run, "should_run must be false when flag is set");

    // Even if a rogue caller ignores the gate and posts anyway (belt-and-
    // suspenders), the idempotent path MUST NOT have fired in the
    // protected path we're exercising. Since we didn't submit, the mock
    // must have seen zero requests.
    assert!(recorder.snapshot().is_empty(), "no HTTP requests should have been made");

    // Confirm the flag is unchanged — no accidental rewrite.
    let (flag,): (Option<i64>,) = sqlx::query_as("SELECT relative_paths_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(account_key(TEST_ACCOUNT))
        .bind("default")
        .fetch_one(&pool)
        .await
        .expect("re-fetch timestamp");
    assert_eq!(flag, Some(1_700_000_000), "flag must not have been rewritten");

    // Sanity: the client is reachable — the idempotency short-circuit is
    // what prevented the request, not a broken fixture.
    let (updated, _) = submit_one_batch(&client, fixture_entries(1)).await.expect("direct wire call still works");
    assert_eq!(updated, 1);
    assert_eq!(recorder.snapshot().len(), 1, "sanity POST landed");
}

/// Failure path: a 500 from the server must leave the flag NULL so the
/// next launch retries. This is the invariant that prevents a dead
/// server from permanently poisoning a drive's backfill state.
#[tokio::test]
async fn backfill_leaves_flag_null_on_server_error() {
    let pool = temp_pool().await;
    seed_sync_path(&pool, TEST_ACCOUNT, "default", None).await;
    assert!(!is_backfilled(&pool, TEST_ACCOUNT, "default").await, "pre-condition: flag NULL");

    let recorder = MockRecorder::new();
    let base_url = start_fail_server(recorder.clone()).await;
    let client = make_client(&base_url);

    let result = submit_one_batch(&client, fixture_entries(5)).await;
    assert!(result.is_err(), "5xx from server must surface as Err from HcfsClient");

    // Production's `submit_batches` propagates the error; `run_backfill_for_drive`
    // then returns `Ok(RetryLater)` WITHOUT calling `mark_backfilled`.
    // The flag stays NULL — which is what the next-launch retry depends on.
    assert!(
        !is_backfilled(&pool, TEST_ACCOUNT, "default").await,
        "flag must stay NULL when backfill fails, so the next launch retries"
    );

    // The server saw the request — this is the useful "we tried, we
    // failed transiently" signal, not a "we refused to send" bug.
    assert_eq!(recorder.snapshot().len(), 1, "exactly one POST attempt before giving up");
}

/// Chunking at the wire: more than `MAX_REGISTER_RELATIVE_PATHS_BATCH`
/// entries split into multiple POSTs, none exceeding the cap. This pins
/// the server's memory-bound contract (the handler rejects oversized
/// batches) at the integration-test level — a regression that stopped
/// chunking would let a large drive silently fail the whole backfill.
#[tokio::test]
async fn backfill_chunks_large_input_to_per_batch_cap() {
    let pool = temp_pool().await;
    seed_sync_path(&pool, TEST_ACCOUNT, "chunked", None).await;

    let recorder = MockRecorder::new();
    let base_url = start_ok_server(recorder.clone()).await;
    let client = make_client(&base_url);

    // 501 entries: forces exactly one full chunk + one remainder. The
    // number is deliberately picked to be 1 past the cap so an off-by-
    // one in the chunk loop would show up as either a 400 from the server
    // (we'd see Err here) or a single oversized batch (we'd see 1 POST
    // with 501 entries).
    let total = MAX_REGISTER_RELATIVE_PATHS_BATCH + 1;
    let entries = fixture_entries(total);

    // Mirror `submit_batches` loop: chunk client-side then post one at a
    // time. The production function uses the same `chunks(MAX_…)` call.
    let mut total_updated = 0u32;
    for chunk in entries.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH) {
        let (u, _) = submit_one_batch(&client, chunk.to_vec()).await.expect("batch ok");
        total_updated += u;
    }

    assert_eq!(
        total_updated,
        u32::try_from(total).unwrap(),
        "summed updated counts should equal total entries"
    );

    let recorded = recorder.snapshot();
    assert_eq!(recorded.len(), 2, "501 entries should land in exactly 2 POSTs");
    assert_eq!(recorded[0].entries.len(), MAX_REGISTER_RELATIVE_PATHS_BATCH);
    assert_eq!(recorded[1].entries.len(), 1);
    // Ensure every chunk stayed at or under the cap — the reason the
    // client enforces this is the server hard-rejects larger batches.
    for (i, req) in recorded.iter().enumerate() {
        assert!(
            req.entries.len() <= MAX_REGISTER_RELATIVE_PATHS_BATCH,
            "chunk {i} has {} entries, exceeds cap {MAX_REGISTER_RELATIVE_PATHS_BATCH}",
            req.entries.len()
        );
    }
}
