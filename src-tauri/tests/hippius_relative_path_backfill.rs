//! Regression tests for the desktop `relative_path` backfill.
//!
//! PR 7 Task 7.4 of the hcfs nested-folder-browsing plan.
//!
//! # What this suite pins
//!
//! The backfill in `src-tauri/src/sync/relative_path_backfill.rs` is the
//! one-shot legacy-row repair path: every drive created before the
//! server-side `relative_path` column existed walks its local
//! `SyncState.path_index` exactly once and posts it to
//! `POST /register_relative_paths/{ss58}/{folder_hash}`. After a
//! successful sweep the `sync_paths.relative_paths_backfilled_at`
//! timestamp is set so the sweep never runs again for that drive.
//!
//! The tests are arranged from highest- to lowest-level:
//!
//! 1. **`AlreadyDone` via `run_backfill_for_drive`.** Seeds the flag and
//!    asserts the production orchestrator short-circuits without touching
//!    the wire. Guards the `is_backfilled` gate at the TOP of
//!    `run_backfill_for_drive`.
//! 2. **`NotReady` via `run_backfill_for_drive`.** Seeds a NULL flag but
//!    registers no drive in `AppState.sync.drives`. Asserts the
//!    orchestrator returns `NotReady`, makes zero HTTP calls, and leaves
//!    the flag NULL for the next-launch retry. Guards the
//!    `snapshot_path_index` early-return.
//! 3. **Happy-path wire contract.** Calls `HcfsClient::register_relative_paths`
//!    directly against an axum mock. The `Completed` branch of
//!    `run_backfill_for_drive` requires a fully-initialized + unlocked
//!    `DriveManager` plus a populated `path_index`, which would cost
//!    ~200 ms of disk I/O and a real mnemonic encryption cycle per test
//!    — those moving parts are already exercised by hcfs-client's own
//!    tests. This test pins the server-facing JSON envelope the
//!    production `submit_batches` loop produces.
//! 4. **HTTP 500 propagation via the public `HcfsClient`.** Asserts that
//!    a server-side failure surfaces as `Err` from `register_relative_paths`.
//!    That's the error the production `submit_batches` `?` operator
//!    propagates, which `run_backfill_for_drive` then catches with
//!    `let Ok(...) = ... else { return Ok(RetryLater) }`. This test
//!    pins the wire-level contract; the unit tests in
//!    `src/sync/relative_path_backfill.rs::tests` pin the state machine
//!    around it.
//!
//! # Why not also drive a real `DriveManager` here?
//!
//! Driving `DriveManager::init()` + `unlock()` + `load_sync_state()` for
//! the `Completed` branch would add ~200 ms of disk I/O per test case
//! for no additional contract coverage beyond what hcfs-client's own
//! test suite already provides. The production code path is covered by:
//! (a) the two real-function tests for the non-Completed branches,
//! (b) the unit tests that pin chunking, `path_index_to_entries`,
//!     `is_backfilled`, and `mark_backfilled`,
//! (c) this suite's wire-contract tests for the HTTP envelope.

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
use hcfs_shared::network::{RegisterRelativePathEntry, RegisterRelativePathsRequest};
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri_project_lib::app_state::AppState;
use tauri_project_lib::sync::relative_path_backfill::{BackfillOutcome, is_backfilled, run_backfill_for_drive};
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

/// Build a fresh `AppState` with the given pool installed. `AppState::new`
/// doesn't touch the filesystem or any real service, so it's safe to
/// construct in a test — only the DB pool needs to be injected.
fn make_state_with_pool(pool: SqlitePool) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state
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

// =============================================================================
// Mock hcfs-server
// =============================================================================

/// Captures every request that lands on the mock. The `Vec<RegisterRelativePathsRequest>`
/// preserves arrival order so a test can assert "zero requests hit the wire".
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
/// transient server error. Still records the body so callers can assert
/// "the request reached the server before the failure" vs "we never sent it".
async fn fail_500_handler(
    State(recorder): State<MockRecorder>,
    Path((_ss58, _folder_hash)): Path<(String, String)>,
    Json(body): Json<RegisterRelativePathsRequest>,
) -> impl IntoResponse {
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
// HcfsClient fixture (for the wire-contract tests)
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
        read_timeout_ms: None,
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

// =============================================================================
// Tests
// =============================================================================

/// Static regression guard: `initialize_sync_inner` MUST reference
/// `spawn_backfill` somewhere in its body. Every public entry point that
/// starts or restarts a drive (`setup_and_init_sync`, `add_local_sync_folder`,
/// `resume_drive`, `initialize_sync`, `auto_init_sync`) funnels through
/// `initialize_sync_inner`, so this single check covers the whole trigger
/// surface. A refactor that silently drops the backfill kick-off — or moves
/// it to a path that isn't on the init funnel — fails this test.
#[test]
fn lifecycle_initialize_sync_inner_spawns_backfill() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs");

    // Find the function signature and its brace-matched body; simpler than
    // pulling in a full parser and more precise than a bare substring match
    // (which would pass if `spawn_backfill` were referenced in an unrelated
    // helper elsewhere in the file).
    let sig_idx = src
        .find("async fn initialize_sync_inner(")
        .expect("initialize_sync_inner declaration present");
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    let mut body_end = body_start;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &src[body_start..=body_end];
    assert!(
        body.contains("spawn_backfill"),
        "initialize_sync_inner must call spawn_backfill so every init path triggers the one-shot backfill",
    );
}

/// Invariant: once the backfill flag is set, `run_backfill_for_drive`
/// short-circuits to `AlreadyDone` without touching the wire. This is
/// the guard that prevents a hot-reload or repeated `spawn_backfill`
/// from DoS-ing the server.
///
/// Exercises the real production orchestrator — NOT a hand-rolled mirror
/// of its gate — so a future refactor that moves the `is_backfilled`
/// check lower in the function (or drops it entirely) fails here.
#[tokio::test]
async fn run_backfill_returns_already_done_when_flag_set() {
    let pool = temp_pool().await;
    let seeded_ts = 1_700_000_000i64;
    seed_sync_path(&pool, TEST_ACCOUNT, "default", Some(seeded_ts)).await;

    // The server MUST NOT receive any requests. If the gate fails open,
    // the subsequent `build_one_shot_client` step would fail (no auth
    // token, no hcfs_config row) — but it might fail for the WRONG
    // reason. A live mock lets us distinguish "short-circuited before
    // the wire" from "failed before the wire for an unrelated reason".
    let recorder = MockRecorder::new();
    let _base_url = start_ok_server(recorder.clone()).await;

    let state = make_state_with_pool(pool.clone());
    let outcome = run_backfill_for_drive(&state, TEST_ACCOUNT, "default")
        .await
        .expect("run_backfill_for_drive must not error on AlreadyDone path");

    assert_eq!(
        outcome,
        BackfillOutcome::AlreadyDone,
        "seeded flag must make the orchestrator short-circuit"
    );
    assert!(
        recorder.snapshot().is_empty(),
        "AlreadyDone MUST NOT touch the wire; saw {} requests",
        recorder.snapshot().len()
    );
    // Flag timestamp is untouched — a silent rewrite would mask bugs in
    // the gate itself by always leaving the DB in the "done" state.
    assert!(is_backfilled(&pool, &account_key(TEST_ACCOUNT), "default").await.unwrap());
    let (flag,): (Option<i64>,) = sqlx::query_as("SELECT relative_paths_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(account_key(TEST_ACCOUNT))
        .bind("default")
        .fetch_one(&pool)
        .await
        .expect("re-fetch timestamp");
    assert_eq!(flag, Some(seeded_ts), "flag timestamp must not be rewritten by AlreadyDone");
}

/// Invariant: when the drive isn't registered in `AppState.sync.drives`
/// yet, `run_backfill_for_drive` returns `NotReady` and leaves the flag
/// NULL so the next launch retries.
///
/// This is the steady-state path on every cold boot: the backfill task
/// is spawned BEFORE the drive finishes its first `init()+unlock()`
/// cycle on occasion, and the orchestrator must treat that as "try
/// again later" rather than "done" or "error". A regression that
/// accidentally called `mark_backfilled` here would permanently poison
/// the drive's backfill state.
#[tokio::test]
async fn run_backfill_returns_not_ready_when_drive_not_registered() {
    let pool = temp_pool().await;
    seed_sync_path(&pool, TEST_ACCOUNT, "default", None).await;
    assert!(
        !is_backfilled(&pool, &account_key(TEST_ACCOUNT), "default").await.unwrap(),
        "pre-condition: flag NULL"
    );

    let recorder = MockRecorder::new();
    let _base_url = start_ok_server(recorder.clone()).await;

    // No drive is ever registered in `state.sync.drives`, so
    // `snapshot_path_index` returns `None` and `run_backfill_for_drive`
    // returns `NotReady` before it even tries to build an HTTP client.
    let state = make_state_with_pool(pool.clone());
    let outcome = run_backfill_for_drive(&state, TEST_ACCOUNT, "default")
        .await
        .expect("run_backfill_for_drive must not error on NotReady path");

    assert_eq!(outcome, BackfillOutcome::NotReady, "missing drive entry must surface as NotReady");
    assert!(
        recorder.snapshot().is_empty(),
        "NotReady MUST NOT touch the wire; saw {} requests",
        recorder.snapshot().len()
    );
    assert!(
        !is_backfilled(&pool, &account_key(TEST_ACCOUNT), "default").await.unwrap(),
        "flag must stay NULL on NotReady so the next launch retries"
    );
}

/// Wire-contract regression: a call through `HcfsClient::register_relative_paths`
/// (the exact method the production `submit_batches` invokes) produces
/// the JSON envelope the server expects.
///
/// Why we don't drive the full `run_backfill_for_drive` `Completed`
/// branch here: that branch needs a registered + unlocked `DriveManager`
/// with a populated `path_index`, which would cost ~200 ms of disk I/O
/// and a real mnemonic encryption cycle per test case. That machinery is
/// already covered by hcfs-client's own integration tests. What this test
/// uniquely guards is the JSON shape — URL template, body envelope,
/// hex-encoded `path_hash`, verbatim `relative_path`, and the
/// `{"Success": {..}}` response envelope the client decodes.
#[tokio::test]
async fn hcfs_client_register_relative_paths_emits_expected_wire_shape() {
    let recorder = MockRecorder::new();
    let base_url = start_ok_server(recorder.clone()).await;
    let client = make_client(&base_url);
    let entries = fixture_entries(3);

    let response = client
        .register_relative_paths(TEST_ACCOUNT, TEST_FOLDER_HASH, entries.clone())
        .await
        .expect("register_relative_paths succeeded");

    assert_eq!(response.updated, 3, "server reports all 3 updated");
    assert_eq!(response.skipped, 0);

    let recorded = recorder.snapshot();
    assert_eq!(recorded.len(), 1, "exactly one POST");
    assert_eq!(recorded[0].entries.len(), 3);
    let received_paths: Vec<&str> = recorded[0].entries.iter().map(|e| e.relative_path.as_str()).collect();
    assert_eq!(
        received_paths,
        vec!["nested/folder_0/file_0.txt", "nested/folder_1/file_1.txt", "nested/folder_2/file_2.txt"],
        "relative_path values must round-trip verbatim"
    );
    for (i, entry) in recorded[0].entries.iter().enumerate() {
        assert_eq!(entry.path_hash, entries[i].path_hash, "path_hash byte-for-byte match for entry {i}");
    }
}

/// Wire-contract regression: an HTTP 500 from the server surfaces as
/// `Err` from `HcfsClient::register_relative_paths`.
///
/// In production, this error flows through `submit_batches`' `?` operator
/// and then through the `let Ok(...) = ... else { return Ok(RetryLater) }`
/// pattern in `run_backfill_for_drive` — which in turn means
/// `mark_backfilled` is NEVER called on a failed POST, so the flag stays
/// NULL and the next launch retries. This test pins the first link of
/// that chain (the HcfsClient → AppError boundary); the subsequent
/// `RetryLater` behaviour is covered by the unit tests in
/// `src/sync/relative_path_backfill.rs::tests`.
#[tokio::test]
async fn hcfs_client_register_relative_paths_errors_on_http_500() {
    let recorder = MockRecorder::new();
    let base_url = start_fail_server(recorder.clone()).await;
    let client = make_client(&base_url);

    let result = client.register_relative_paths(TEST_ACCOUNT, TEST_FOLDER_HASH, fixture_entries(5)).await;
    assert!(result.is_err(), "5xx from server must surface as Err from HcfsClient");
    // Sanity: the request did leave the client — a "Err before send" bug
    // would look identical to a server failure otherwise.
    assert_eq!(recorder.snapshot().len(), 1, "exactly one POST attempt before giving up");
}
