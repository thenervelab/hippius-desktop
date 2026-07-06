//! No-mock, real-backend end-to-end for first-class empty folders.
//!
//! Phase 1 Task 1.15 of the first-class-empty-folders plan. This is the
//! pivotal test the unit suites deliberately defer to: it drives the REAL
//! desktop folder-entity registration code against a REAL `hcfs-server` and
//! asserts an empty folder round-trips to the server's `/browse` view. There
//! are no mocks anywhere in this file — the only test doubles are the *inputs*
//! (a tempdir tree, a seeded DB row), never the network or the server.
//!
//! # What real layers this drives
//!
//! - **The desktop AppState + backfill path.** `run_folder_entries_backfill_for_drive`
//!   is the production function (not a hand-rolled client call): it resolves the
//!   sync root from a seeded `sync_paths` row, walks the on-disk tree, builds the
//!   one-shot `HcfsClient` from the seeded `hcfs_config.server_url` +
//!   `objectstore_auth_scoped` bearer, registers every directory over HTTP,
//!   mirrors them into `folder_entries_local`, and sets the backfill flag. This
//!   is the network round-trip Task 1.12 deferred to here.
//! - **The real client↔server browse.** A real `HcfsClient::browse` against the
//!   SAME server confirms the server now knows about the empty folders with
//!   `file_count == 0`.
//! - **The unregister network round-trip.** A real
//!   `HcfsClient::unregister_folder_entries` for a removed directory, then a
//!   re-browse asserting the server no longer lists it. This covers the network
//!   half Task 1.13's reconcile deferred.
//!
//! # What it does NOT drive (and why that's honest)
//!
//! The reconcile core (`reconcile_with_on_disk`) and its pure delta/cache
//! helpers are `pub(crate)`, so an external integration-test crate cannot call
//! them directly. Their delta computation and cache insert/delete are covered
//! hermetically by the in-module unit tests + proptests in
//! `sync::migrate::folder_entries_reconcile`. The reconcile's network edge
//! (register/unregister) is driven here transitively: the combined
//! `run_folder_entity_sync_for_drive` (which the C1 test calls) reconciles
//! FIRST, so the `unregister_folder_entries` HTTP round-trip runs for real and
//! the post-reconcile server state is then asserted via `list_folder_entries`.
//! So the reconcile's logic is unit-pinned and its network edge is
//! real-server-pinned through the combined runner; nothing about it is mocked.
//!
//! # How to run
//!
//! Stand up a local server (only Postgres + the server are needed for the
//! empty-folder path — an empty folder uploads zero bytes, so no S3/MinIO):
//!
//! ```text
//! HCFS_DESKTOP_E2E_SERVER_URL=http://127.0.0.1:19999 \
//! HCFS_DESKTOP_E2E_BEARER=5LrjePXpHpdFDzZXNAy3Yqy7kdfRyAq9 \
//!   cargo test --test folder_entries_real_backend -- --ignored
//! ```
//!
//! Both vars are required; with either unset the test prints a skip note and
//! returns Ok, so a default `cargo test` (and `--ignored` without the env)
//! stays hermetic and green. The bearer is hcfs's committed admin-bypass token
//! (public infra config, not a secret) — it short-circuits per-user ss58
//! ownership server-side, so a fresh random test ss58 is accepted.

use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePool;

use hcfs_client::client::{HcfsClient, HcfsClientConfig};
use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::tokens::clear_api_token;
use tauri_project_lib::sync::folder_entries_backfill::{
    run_folder_entries_backfill_for_drive, FolderEntriesBackfillOutcome,
};
use tauri_project_lib::sync::folder_entries_materialize::{
    materialize_folder_entries_for_drive, run_folder_entity_sync_for_drive, FolderEntitySyncOutcome, MaterializeOutcome,
};
use tauri_project_lib::utils::schema::ensure_table_schema;

/// Server URL env var. Unset → the test skips cleanly (default hermetic run).
const SERVER_URL_ENV: &str = "HCFS_DESKTOP_E2E_SERVER_URL";
/// Bearer-token env var (hcfs admin-bypass token, public infra config).
const BEARER_ENV: &str = "HCFS_DESKTOP_E2E_BEARER";

/// The drive label under test. The server namespaces folder entities by
/// `(ss58_address, folder_hash)` and `folder_hash` is derived from this label;
/// a per-run-unique ss58 (see [`unique_ss58`]) isolates the namespace, so a
/// fixed label never collides across runs.
const LABEL: &str = "DesktopE2EFolders";

/// `Some((server_url, bearer))` when both env vars are set and non-empty, else
/// `None` after printing a skip note.
///
/// Treats an empty value as unset (mirrors hcfs-e2e-tests' `user_scoped_env`):
/// a CI step that forwards an unconfigured secret materializes it as `""`, and
/// running with an empty bearer would 401 instead of skipping.
fn live_env() -> Option<(String, String)> {
    let nonempty = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    if let (Some(url), Some(bearer)) = (nonempty(SERVER_URL_ENV), nonempty(BEARER_ENV)) {
        return Some((url, bearer));
    }
    // `tracing::warn!` (not `println!`/`eprintln!`) because the workspace clippy
    // config denies stdout/stderr prints even in tests; the note still surfaces
    // under `RUST_LOG=warn`. The `#[ignore]` attribute already documents the
    // live-lane requirement for a default `cargo test` run.
    tracing::warn!(
        "skipping folder_entries_real_backend: set {SERVER_URL_ENV} and {BEARER_ENV} to run \
         against a live hcfs-server (see this file's module docs)"
    );
    None
}

/// A fresh 64-hex pseudo-ss58, unique per run, so each invocation owns an empty
/// server namespace and never sees another run's residue. Format mirrors the
/// hcfs-e2e harness's `hex(ed25519 pubkey)`; with the admin bearer the server
/// treats it as an opaque owner key, so any 64-hex value is accepted.
fn unique_ss58() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the Unix epoch")
        .as_nanos();
    let seed = format!("hippius-desktop-folder-entries-e2e-{nanos}-{}", std::process::id());
    hex::encode(Sha256::digest(seed.as_bytes()))
}

/// In-memory SQLite pool carrying the FULL production schema, so the columns
/// the backfill reads/writes (`sync_paths.folder_entries_backfilled_at`,
/// `folder_entries_local`, `hcfs_config`, `objectstore_auth_scoped`) stay in
/// lockstep with production rather than a hand-rolled subset.
async fn live_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
    ensure_table_schema(&pool).await.expect("apply production schema");
    pool
}

/// Seed the three rows the backfill's real path consults: the drive's sync
/// path (backfill flag NULL so the pass runs), the server URL, and the bearer
/// token. Owner scoping mirrors production exactly — `sync_paths`/`hcfs_config`
/// key on `account_key(ss58)`, while the token table keys on the raw ss58 (the
/// shape `save_api_token`/`get_api_token` bind).
async fn seed_drive(pool: &SqlitePool, ss58: &str, root: &str, server_url: &str, bearer: &str) {
    let owner = account_key(ss58);
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, folder_entries_backfilled_at)
         VALUES (?, ?, 'private', ?, 0, NULL)",
    )
    .bind(&owner)
    .bind(root)
    .bind(LABEL)
    .execute(pool)
    .await
    .expect("seed sync_paths");

    sqlx::query("INSERT INTO hcfs_config (owner, server_url) VALUES (?, ?)")
        .bind(&owner)
        .bind(server_url)
        .execute(pool)
        .await
        .expect("seed hcfs_config server_url");

    // `get_api_token` binds the RAW ss58 for the scoped plaintext read; on a
    // never-before-seen ss58 the OS keychain misses and it falls through here.
    sqlx::query("INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .bind(ss58)
        .bind(bearer)
        .execute(pool)
        .await
        .expect("seed bearer token");
}

/// Build a real `HcfsClient` pinned to the local server, mirroring the
/// desktop's `build_hcfs_config` field-for-field (notably `billing_bypass_token:
/// None` — folder-entity register/browse/unregister are bearer-only endpoints).
/// `folder_hash` is the SAME derivation the backfill used (`hcfs_client`'s own
/// `keys::folder_hash`), so this client addresses the exact namespace the
/// backfill wrote to.
fn live_client(server_url: &str, bearer: &str, ss58: &str) -> HcfsClient {
    let folder_hash = hcfs_client::drive::keys::folder_hash(LABEL);
    let config = HcfsClientConfig {
        base_url: server_url.to_string(),
        bearer_token: bearer.to_string(),
        accept_invalid_certs: false,
        billing_bypass_token: None,
        ss58_address: ss58.to_string(),
        folder_hash,
        read_timeout_ms: None,
    };
    HcfsClient::new(config).expect("construct HcfsClient for the live server")
}

/// Read the drive's `folder_entries_local` cache rows, sorted, for asserting
/// the backfill mirrored the registered directories locally.
async fn cached_dirs(pool: &SqlitePool, ss58: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT relative_path FROM folder_entries_local WHERE owner = ? AND label = ? ORDER BY relative_path",
    )
    .bind(account_key(ss58))
    .bind(LABEL)
    .fetch_all(pool)
    .await
    .expect("read folder_entries_local")
}

/// Find a folder entry by name in a browse result, panicking with the full
/// folder list when absent so a failure shows what the server actually returned.
fn folder_named<'a>(
    folders: &'a [hcfs_shared::network::BrowseFolderEntry],
    name: &str,
) -> &'a hcfs_shared::network::BrowseFolderEntry {
    folders
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("expected folder {name:?} in browse result, got {folders:?}"))
}

/// The pivotal no-mock e2e. Drives the real desktop backfill against a live
/// server, then browses the live server to prove the empty folders round-trip,
/// then exercises the unregister network round-trip.
///
/// `multi_thread`: the backfill blocks a worker thread (the `spawn_blocking`
/// walk plus the reqwest driver need a real worker pool), which a
/// current-thread runtime can't provide.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER and a running hcfs-server"]
async fn empty_folder_round_trips_to_real_server() {
    let Some((server_url, bearer)) = live_env() else {
        return; // hermetic default stays green
    };

    // --- Arrange: a tempdir tree whose only contents are EMPTY directories ---
    // `Empty/` is a bare empty dir; `a/` holds only the empty `a/b`. No file is
    // ever written, so this whole test needs no storage backend (zero bytes).
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::fs::create_dir(root.join("Empty")).expect("mkdir Empty");
    std::fs::create_dir_all(root.join("a/b")).expect("mkdir a/b");
    let root_str = root.to_str().expect("utf-8 tempdir path");

    let ss58 = unique_ss58();
    let pool = live_pool().await;
    seed_drive(&pool, &ss58, root_str, &server_url, &bearer).await;

    let state = AppState::new();
    state.set_pool(pool.clone());

    // --- Act 1: drive the REAL desktop backfill (walk → register → cache → flag) ---
    let outcome = run_folder_entries_backfill_for_drive(&state, &ss58, LABEL)
        .await
        .expect("backfill must not hard-error against a healthy server");

    // The walk finds exactly {Empty, a, a/b}; every one registered over HTTP.
    assert_eq!(
        outcome,
        FolderEntriesBackfillOutcome::Completed { total_dirs: 3 },
        "backfill should register all three directories and complete"
    );
    assert_eq!(
        cached_dirs(&pool, &ss58).await,
        vec!["Empty".to_string(), "a".to_string(), "a/b".to_string()],
        "backfill must mirror every registered directory into folder_entries_local"
    );

    // --- Assert: browse the REAL server; the empty folders are now visible ---
    let client = live_client(&server_url, &bearer, &ss58);
    let root_browse = client
        .browse(&ss58, &hcfs_client::drive::keys::folder_hash(LABEL), "", 0, 100)
        .await
        .expect("browse root against the live server");

    assert_eq!(
        folder_named(&root_browse.folders, "Empty").file_count,
        0,
        "a bare empty folder entity surfaces with zero files: {root_browse:?}"
    );
    assert_eq!(
        folder_named(&root_browse.folders, "a").file_count,
        0,
        "the parent of the nested empty dir also has zero files: {root_browse:?}"
    );

    // The nested empty dir surfaces when browsing into its parent.
    let nested_browse = client
        .browse(&ss58, &hcfs_client::drive::keys::folder_hash(LABEL), "a", 0, 100)
        .await
        .expect("browse subfolder a/");
    assert_eq!(
        folder_named(&nested_browse.folders, "b").file_count,
        0,
        "the deep empty dir a/b surfaces under a/ with zero files: {nested_browse:?}"
    );

    // --- Act 2: unregister round-trip (the network half Task 1.13 deferred) ---
    // Remove `Empty` from disk (the reconcile's "removed locally" trigger), then
    // make the real unregister call and re-browse to prove the server dropped it.
    std::fs::remove_dir(root.join("Empty")).expect("rm Empty");
    let unregister = client
        .unregister_folder_entries(&ss58, &hcfs_client::drive::keys::folder_hash(LABEL), &["Empty".to_string()])
        .await
        .expect("unregister Empty against the live server");
    assert_eq!(
        unregister.files_deleted, 0,
        "a folder-entity unregister deletes zero file bytes by server construction"
    );

    let after = client
        .browse(&ss58, &hcfs_client::drive::keys::folder_hash(LABEL), "", 0, 100)
        .await
        .expect("re-browse root after unregister");
    assert!(
        !after.folders.iter().any(|f| f.name == "Empty"),
        "Empty must be gone from the server after unregister, got {:?}",
        after.folders
    );
    assert!(
        after.folders.iter().any(|f| f.name == "a"),
        "the sibling folder a must survive Empty's unregister, got {:?}",
        after.folders
    );

    // --- Cleanup: drop this run's server entities and scrub the seeded token ---
    // Leaves the server namespace empty and removes the bearer from the OS
    // keychain (the backfill's get_api_token may have upgraded the plaintext
    // column into it), so the test leaves no residue on the dev's machine.
    let _ = client
        .unregister_folder_entries(&ss58, &hcfs_client::drive::keys::folder_hash(LABEL), &["a/b".to_string(), "a".to_string()])
        .await;
    let _ = clear_api_token(&pool, &ss58).await;
}

/// Flip a drive's backfill flag to "done" so the materialize gate opens. In the
/// two-device test below, device B's tree starts empty; running its real backfill
/// (`Completed { total_dirs: 0 }`) sets this flag — we use that production path
/// rather than a raw UPDATE so the gate opens exactly as it does in the field.
///
/// Insert one `folder_entries_local` cache row for `(ss58, LABEL, rel)`, standing
/// in for the per-cycle RECONCILE that production interleaves between materialize
/// cycles. Materialize deliberately never writes the cache — the reconcile is the
/// sole cache writer (it registers a just-materialized on-disk dir and records
/// this exact row). The reconcile entry point is `pub(crate)`, so this external
/// test seeds the post-reconcile cache state directly; the reconcile's own
/// register+cache is unit-pinned in its module. The cache row is what marks a
/// dir as "server-sourced" so a later server-side deletion makes it an
/// empty-only-removal orphan (a brand-new LOCAL dir, absent from the cache, is
/// never removed — the load-bearing safety property).
async fn seed_reconcile_cache_row(pool: &SqlitePool, ss58: &str, rel: &str) {
    sqlx::query("INSERT OR IGNORE INTO folder_entries_local (owner, label, relative_path) VALUES (?, ?, ?)")
        .bind(account_key(ss58))
        .bind(LABEL)
        .bind(rel)
        .execute(pool)
        .await
        .expect("seed folder_entries_local cache row");
}

/// The two-instance no-mock e2e for Phase 2 Task 2.2. Device A registers an empty
/// directory against the live server; device B (a second AppState + tempdir on the
/// SAME account/folder) materializes it onto B's disk over a real network
/// round-trip. Then A deletes it server-side and B materializes again, removing
/// B's now-orphaned empty dir. Finally a guard case proves a NON-empty dir
/// survives a server-side deletion — materialize never touches user data.
///
/// `multi_thread`: the materialize's `spawn_blocking` walk + apply plus the
/// reqwest driver need a real worker pool.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER and a running hcfs-server"]
async fn empty_folder_materializes_across_two_devices() {
    let Some((server_url, bearer)) = live_env() else {
        return; // hermetic default stays green
    };

    // Shared identity: one account + folder, two devices with separate DBs/disks.
    let ss58 = unique_ss58();
    let fhash = hcfs_client::drive::keys::folder_hash(LABEL);

    // --- Device A: register an empty `Shared/` folder against the live server ---
    let tmp_a = tempfile::tempdir().expect("tempdir A");
    std::fs::create_dir(tmp_a.path().join("Shared")).expect("mkdir A/Shared");
    let root_a = tmp_a.path().to_str().expect("utf-8 A path");
    let pool_a = live_pool().await;
    seed_drive(&pool_a, &ss58, root_a, &server_url, &bearer).await;
    let state_a = AppState::new();
    state_a.set_pool(pool_a.clone());
    let a_backfill = run_folder_entries_backfill_for_drive(&state_a, &ss58, LABEL)
        .await
        .expect("device A backfill must not hard-error");
    assert_eq!(a_backfill, FolderEntriesBackfillOutcome::Completed { total_dirs: 1 }, "A registers its one empty dir");

    // --- Device B: empty tree, same account; backfill sets the materialize gate ---
    let tmp_b = tempfile::tempdir().expect("tempdir B");
    let root_b_path = tmp_b.path().to_path_buf();
    let root_b = root_b_path.to_str().expect("utf-8 B path");
    let pool_b = live_pool().await;
    seed_drive(&pool_b, &ss58, root_b, &server_url, &bearer).await;
    let state_b = AppState::new();
    state_b.set_pool(pool_b.clone());
    let b_backfill = run_folder_entries_backfill_for_drive(&state_b, &ss58, LABEL)
        .await
        .expect("device B backfill must not hard-error");
    assert_eq!(b_backfill, FolderEntriesBackfillOutcome::Completed { total_dirs: 0 }, "B's empty tree completes and opens the gate");
    assert!(!root_b_path.join("Shared").exists(), "precondition: B does not have Shared yet");

    // --- Act 1: B materializes A's empty folder onto B's disk (real fetch) ---
    let created = materialize_folder_entries_for_drive(&state_b, &ss58, LABEL)
        .await
        .expect("device B materialize must not hard-error");
    assert_eq!(created, MaterializeOutcome::Materialized { created: 1, removed: 0 }, "B pulls down exactly Shared");
    assert!(root_b_path.join("Shared").is_dir(), "the empty folder now EXISTS on device B's disk");

    // Production interleaves a reconcile here, which registers B's just-materialized
    // dir and writes its cache row. Seed that row so Shared is a server-sourced
    // orphan candidate once A deletes it server-side.
    seed_reconcile_cache_row(&pool_b, &ss58, "Shared").await;

    // --- Act 2: A deletes Shared server-side; B materializes it away (empty) ---
    let client_a = live_client(&server_url, &bearer, &ss58);
    client_a
        .unregister_folder_entries(&ss58, &fhash, &["Shared".to_string()])
        .await
        .expect("device A unregisters Shared");
    let removed = materialize_folder_entries_for_drive(&state_b, &ss58, LABEL)
        .await
        .expect("device B second materialize must not hard-error");
    assert_eq!(removed, MaterializeOutcome::Materialized { created: 0, removed: 1 }, "B removes its now-orphaned empty dir");
    assert!(!root_b_path.join("Shared").exists(), "the orphaned EMPTY dir is gone from device B's disk");

    // --- Guard: a NON-empty dir survives a server-side deletion ---
    // Recreate Shared on B with a file inside, and re-seed its (server-sourced)
    // cache row. The server still does not list Shared, so it is an orphan
    // candidate — but the empty-only guard must refuse to delete it.
    std::fs::create_dir(root_b_path.join("Shared")).expect("recreate B/Shared");
    std::fs::write(root_b_path.join("Shared/keep.txt"), b"user data").expect("write user file");
    seed_reconcile_cache_row(&pool_b, &ss58, "Shared").await;
    let guarded = materialize_folder_entries_for_drive(&state_b, &ss58, LABEL)
        .await
        .expect("device B guard materialize must not hard-error");
    assert_eq!(guarded, MaterializeOutcome::Materialized { created: 0, removed: 0 }, "the non-empty orphan is left alone");
    assert!(root_b_path.join("Shared").is_dir(), "the non-empty dir SURVIVES the server-side deletion");
    assert!(root_b_path.join("Shared/keep.txt").exists(), "the user's file is untouched");

    // --- Cleanup: both devices' tokens (server namespace already empty) ---
    let _ = clear_api_token(&pool_a, &ss58).await;
    let _ = clear_api_token(&pool_b, &ss58).await;
}

/// C1 regression (the convergence race): a folder the user deletes LOCALLY while
/// the server still lists it must NOT be resurrected by the combined sync.
///
/// This is the exact hazard that concurrent reconcile + materialize created: for
/// `disk=no, cache=yes, server=yes` the reconcile wants to unregister it and the
/// materialize (on a stale server snapshot) wants to recreate it. The combined
/// runner sequences reconcile→materialize over one server snapshot taken AFTER
/// the unregister, so the folder stays deleted on disk AND is removed from the
/// server. No mock: the unregister + the post-reconcile `list_folder_entries`
/// are real network round-trips against the live server.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER and a running hcfs-server"]
async fn locally_deleted_empty_folder_not_resurrected() {
    let Some((server_url, bearer)) = live_env() else {
        return; // hermetic default stays green
    };

    let ss58 = unique_ss58();
    let fhash = hcfs_client::drive::keys::folder_hash(LABEL);

    // Arrange: an empty `Doomed/` dir that the backfill registers on the server
    // and records in the local cache (so cache=yes, server=yes).
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().to_path_buf();
    std::fs::create_dir(root.join("Doomed")).expect("mkdir Doomed");
    let root_str = root.to_str().expect("utf-8 path");

    let pool = live_pool().await;
    seed_drive(&pool, &ss58, root_str, &server_url, &bearer).await;
    let state = AppState::new();
    state.set_pool(pool.clone());

    let backfill = run_folder_entries_backfill_for_drive(&state, &ss58, LABEL)
        .await
        .expect("backfill must not hard-error");
    assert_eq!(backfill, FolderEntriesBackfillOutcome::Completed { total_dirs: 1 }, "backfill registers + caches Doomed");

    // Confirm the server lists Doomed (the `server=yes` precondition).
    let client = live_client(&server_url, &bearer, &ss58);
    let before = client.list_folder_entries(&ss58, &fhash).await.expect("list before delete");
    assert!(before.contains(&"Doomed".to_string()), "server must list Doomed before the local delete, got {before:?}");

    // The user deletes the empty folder LOCALLY: now disk=no, cache=yes, server=yes
    // — the precise race state. On disk it is gone before any sync runs.
    std::fs::remove_dir(root.join("Doomed")).expect("local delete of Doomed");

    // Run the COMBINED per-cycle step (reconcile THEN materialize, one walk).
    let outcome = run_folder_entity_sync_for_drive(&state, &ss58, LABEL)
        .await
        .expect("combined sync must not hard-error");
    assert!(matches!(outcome, FolderEntitySyncOutcome::Ran { .. }), "both halves must run, got {outcome:?}");

    // The deletion is NOT undone on disk...
    assert!(!root.join("Doomed").exists(), "locally-deleted folder must NOT be resurrected on disk");
    // ...and it is gone from the server (reconcile pushed the delete; materialize
    // saw the post-reconcile set and had nothing to create).
    let after = client.list_folder_entries(&ss58, &fhash).await.expect("list after sync");
    assert!(!after.contains(&"Doomed".to_string()), "server must no longer list the locally-deleted folder, got {after:?}");

    // A second combined cycle is a stable no-op (nothing resurfaces).
    let again = run_folder_entity_sync_for_drive(&state, &ss58, LABEL)
        .await
        .expect("second combined sync must not hard-error");
    assert!(matches!(again, FolderEntitySyncOutcome::Ran { .. }), "second cycle still ran, got {again:?}");
    assert!(!root.join("Doomed").exists(), "Doomed stays deleted across a second cycle");

    let _ = clear_api_token(&pool, &ss58).await;
}
