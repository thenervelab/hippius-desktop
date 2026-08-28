//! No-mock, real-backend end-to-end for browsable folder shares.
//!
//! Drives the REAL desktop folder-share funnel (`shares::commands::
//! create_folder_share_inner` and the `list/revoke_folder_share_inner`
//! seams — the exact bodies the Tauri IPCs and the Finder bridge call)
//! against a REAL `hcfs-server`, with a single user bearer. The only test
//! doubles are the *inputs* (tempdir roots, seeded SQLite rows) — never
//! the network or the server.
//!
//! # What real layers this drives
//!
//! - **The mint funnel**: capability probe against the live
//!   `/v1/capabilities`, identity resolution, the canonical
//!   `encryption_key_for_label` derivation, and the metadata-only POST.
//! - **The derivation round trip the mock suite cannot prove**: the drive's
//!   ciphertext is produced by the REAL sync engine (`SyncRunner` +
//!   `DriveManager`, the desktop's own upload path), fetched back through
//!   the ANONYMOUS `/v1/folder-shares/{token}/blob` route with a plain
//!   `reqwest` client, and decrypted with nothing but the key parsed out of
//!   the minted URL's `#k=` fragment. If the mint's derivation chain and
//!   the engine's ever diverge, this decrypt fails.
//! - **Badge identity**: the live listing row's `folder_hash` must equal
//!   `hcfs_client::drive::keys::folder_hash(label)` — the pair the FE's
//!   `driveFolderHash` keys "Shared" badges on. The mock suite pins both
//!   sides against the same constant; here the server's own row is the
//!   second opinion.
//! - **The password wrap**: a `#p=` mint's fragment blob unwraps with the
//!   password (client-side Argon2id, no server involvement) to exactly the
//!   drive key, and a wrong password fails.
//! - **Revocation**: while live the anonymous meta/blob answer; after
//!   `revoke_folder_share_inner` both collapse to the server's bodiless
//!   404 and the local keystore has forgotten the token.
//!
//! # What it does NOT drive (and why that's honest)
//!
//! The member-drive refusal here is client-side: the funnel refuses after
//! the live capability probe but before any mint request, so one bearer
//! suffices. A server-side member topology (a second account actually
//! joined to the drive) adds nothing to that gate — the mint never leaves
//! the process — and is covered behaviorally by `shares_server_mock.rs`.
//!
//! # How to run
//!
//! Same local stack as `shared_drives_real_backend.rs` (see its module
//! docs for the full recipe), but the auth stub needs only ONE bearer →
//! ss58 pair (the USER slot). Condensed, from an hcfs checkout at the
//! pinned rev:
//!
//! ```text
//! # 1. Postgres with a fresh database, MinIO + bucket (as in shared_drives)
//! # 2. Auth stub: one bearer -> one ss58
//! HCFS_E2E_STUB_USER_TOKEN=<bearer> HCFS_E2E_STUB_USER_SS58=<ss58> \
//!   python3 scripts/e2e-auth-stub.py &
//! python3 scripts/e2e-entitlement-stub.py &
//! # 3. hcfs-server with the shared_drives_real_backend env (S3 backend,
//! #    HCFS_FEATURE_SHARED_DRIVES=1, stub auth/entitlement URLs)
//! # 4. These tests
//! HCFS_DESKTOP_E2E_SERVER_URL=http://127.0.0.1:19999 \
//! HCFS_DESKTOP_E2E_BEARER=<bearer> \
//! HCFS_DESKTOP_E2E_SS58=<ss58> \
//!   cargo test --test folder_shares_real_backend -- --ignored
//! ```
//!
//! Unlike `folder_entries_real_backend`, the bearer here must be a USER
//! token the auth stub resolves: the folder-share routes map the admin
//! bypass bearer to the literal `"admin"` owner, whose mint always 404s at
//! the registered-drive check. That is also why the extra
//! `HCFS_DESKTOP_E2E_SS58` var exists — the tests must register the drive
//! under the exact address the stub resolves the bearer to.
//!
//! All three vars are required; with any unset the tests print a skip note
//! and return Ok, so a default `cargo test` (and `--ignored` without the
//! env) stays hermetic and green. Set `HCFS_DESKTOP_E2E_REQUIRE=1` to turn
//! that quiet skip into a hard panic — for a CI lane that must never
//! silently skip its live tests; the value is matched EXACTLY against `1`,
//! so `=true`/`=yes` disable the guard. Every `*_real_backend` suite now
//! resolves its env this way, and `.github/workflows/e2e-live.yml` sets it.
//!
//! Every drive label is per-run unique, so the tests are re-runnable
//! against a persistent server database. Be honest about what that costs:
//! the residue a failed run leaves is bounded WITHIN a run but UNBOUNDED
//! ACROSS runs. Each red run abandons one registered drive that nothing
//! ever reaps — `unregister_folder` runs only on the happy path, and the
//! server has no sweeper for orphaned drives — so repeated failures
//! accumulate drives on the target forever. Only the share rows self-heal,
//! via the 24-hour TTL. Prune abandoned `desktop-share-e2e-*` drives by
//! hand (see [`unique_label`]) if a run against production fails repeatedly.
//!
//! Failure output discipline: share tokens, share URLs, URL fragments and
//! raw key material are capabilities, so none of them may reach failure
//! output. That rules out `assert_eq!` over any of them — it prints BOTH
//! operands on failure — so those comparisons are written as
//! `assert!(a == b, "static message")`, and where a divergence needs
//! locating, the value is split into independently compared halves rather
//! than printed. `reqwest` errors are stripped with `without_url()` before
//! they can print a token-bearing URL; `hcfs-client`'s own folder-share
//! errors already strip theirs the same way.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

use hcfs_client::client::folder_share::{ShareTtl, folder_share_token_hash};
use hcfs_client::client::share::{ShareKeystore, unwrap_share_key};
use hcfs_client::client::{HcfsClient, HcfsClientConfig};
use hcfs_client::engine::events::{NoopCallbacks, SyncEvent, SyncEventHandler};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{DriveSlot, SyncRunner, trigger_sync};

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::error::AppError;
use tauri_project_lib::shares::SqliteShareKeystore;
use tauri_project_lib::shares::commands::{ShareChoice, create_folder_share_inner, list_folder_shares_inner, revoke_folder_share_inner};
use tauri_project_lib::utils::schema::ensure_table_schema;

// ── Environment ────────────────────────────────────────────────────────────

const SERVER_URL_ENV: &str = "HCFS_DESKTOP_E2E_SERVER_URL";
const BEARER_ENV: &str = "HCFS_DESKTOP_E2E_BEARER";
const SS58_ENV: &str = "HCFS_DESKTOP_E2E_SS58";
/// `=1` turns the quiet env-skip into a panic, so a live CI lane cannot
/// go green by silently not running these tests.
const REQUIRE_ENV: &str = "HCFS_DESKTOP_E2E_REQUIRE";

/// The single account's resolved live-lane parameters.
struct LiveEnv {
    server_url: String,
    bearer: String,
    ss58: String,
}

/// `Some(env)` when all three vars are set and non-empty, else `None` after
/// a skip note — or a panic when [`REQUIRE_ENV`] is `1`. Empty counts as
/// unset (a CI step forwarding an unconfigured secret materializes it as
/// `""`, and an empty bearer would 401 instead of skipping) — the
/// `folder_entries_real_backend::live_env` convention.
fn live_env() -> Option<LiveEnv> {
    let nonempty = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let vars = (nonempty(SERVER_URL_ENV), nonempty(BEARER_ENV), nonempty(SS58_ENV));
    let (Some(server_url), Some(bearer), Some(ss58)) = vars else {
        assert!(
            nonempty(REQUIRE_ENV).as_deref() != Some("1"),
            "{REQUIRE_ENV}=1 but {SERVER_URL_ENV}/{BEARER_ENV}/{SS58_ENV} are not all set — the live lane must not skip"
        );
        // `tracing::warn!` (not println) — the workspace denies stdout
        // prints; the `#[ignore]` attribute already documents the lane.
        tracing::warn!(
            "skipping folder_shares_real_backend: set {SERVER_URL_ENV}, {BEARER_ENV} and {SS58_ENV} to run \
             against a live hcfs-server (see this file's module docs)"
        );
        return None;
    };
    Some(LiveEnv {
        server_url: server_url.trim_end_matches('/').to_string(),
        bearer,
        ss58,
    })
}

// ── Fixtures (published BIP-39 vector — never a real wallet) ───────────────

/// Key material only — the server never checks that a master derives its
/// account's ss58 (identity comes solely from the bearer).
const MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DRIVE_PW: &str = "drive-pw";

/// Owner identity of the seeded MEMBER drive row in the refusal test —
/// someone else's drive, never registered anywhere.
const FOREIGN_OWNER_SS58: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const FOREIGN_WIRE_HASH: &str = "0123456789abcdef";

/// One shared `$HOME` for the process: the master-mnemonic seal and the
/// engine config dirs live under `~/.hippius`, and pointing HOME at a
/// tempdir keeps the run off the developer's real config tree. The token
/// keychain is disabled in the same breath — `get_api_token` would
/// otherwise read the developer's real OS keychain and, on an
/// opportunistic upgrade, scrub the seeded plaintext token row mid-suite.
/// Same pattern as `shares_server_mock.rs::TEST_HOME`.
static TEST_HOME: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
    let dir = tempfile::TempDir::new().expect("home tempdir");
    let path = dir.path().to_path_buf();
    std::mem::forget(dir);
    unsafe {
        std::env::set_var("HOME", &path);
        std::env::set_var("HIPPIUS_DISABLE_TOKEN_KEYCHAIN", "1");
    }
    path
});

/// Per-run-unique drive label (`suffix` keeps the tests in this binary
/// disjoint), so re-runs against a persistent server database never
/// collide on the `(ss58, folder_hash)` namespace.
fn unique_label(suffix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the Unix epoch")
        .as_nanos();
    format!("desktop-share-e2e-{suffix}-{}-{nanos}", std::process::id())
}

// ── DB + state scaffolding (the shares_server_mock hermetic recipe) ────────

/// Production-shaped file pool (WAL, multi-connection safe — the SQLite
/// keystore uses `block_in_place`, and an in-memory pool would hand each
/// connection its own empty database) carrying the FULL production schema.
async fn live_pool(dir: &std::path::Path) -> sqlx::SqlitePool {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::str::FromStr;

    let db = dir.join("hippius-test.db");
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db.display()))
        .expect("connect opts")
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().max_connections(4).connect_with(opts).await.expect("pool");
    ensure_table_schema(&pool).await.expect("apply production schema");
    pool
}

/// Seed the account's server pointer, encrypted (v1) drive password, and
/// bearer token — the rows `build_client` / `build_account_client` and the
/// key derivation consult. Owner scoping mirrors production exactly:
/// `hcfs_config` keys on `account_key(ss58)`, the token table on the raw
/// ss58 (the shape `get_api_token` binds).
async fn seed_account(pool: &sqlx::SqlitePool, env: &LiveEnv) {
    let key = tauri_project_lib::crypto::store::drive_password_key(MASTER, &env.ss58).expect("key");
    let sealed_pw = tauri_project_lib::crypto::store::encrypt(&key, DRIVE_PW).expect("encrypt pw");
    sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, 1)")
        .bind(account_key(&env.ss58))
        .bind(&env.server_url)
        .bind(&sealed_pw)
        .execute(pool)
        .await
        .expect("seed hcfs_config");

    sqlx::query("INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .bind(&env.ss58)
        .bind(&env.bearer)
        .execute(pool)
        .await
        .expect("seed bearer token");
}

/// An OWN drive row: both wire-identity columns NULL, so
/// `resolve_drive_identity` derives `(ss58, folder_hash(label), owner)`.
async fn seed_own_drive(pool: &sqlx::SqlitePool, ss58: &str, label: &str, root: &str) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, 'private', ?, 0)")
        .bind(account_key(ss58))
        .bind(root)
        .bind(label)
        .execute(pool)
        .await
        .expect("seed own drive row");
}

/// A MEMBER drive row: the wire identity names a foreign owner's drive,
/// the same row shape `install_member_drive` persists.
async fn seed_member_drive(pool: &sqlx::SqlitePool, ss58: &str, label: &str) {
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, owner_ss58, wire_folder_hash) VALUES (?, '/unused', 'private', ?, 0, ?, ?)",
    )
    .bind(account_key(ss58))
    .bind(label)
    .bind(FOREIGN_OWNER_SS58)
    .bind(FOREIGN_WIRE_HASH)
    .execute(pool)
    .await
    .expect("seed member drive row");
}

/// Write the account's master-mnemonic seal where
/// `encryption_key_for_label` expects it. The stub maps ONE bearer to ONE
/// ss58, so every test in this binary shares the account — and the seal
/// path. Written exactly once per process: `save_encrypted_mnemonic` is
/// salted (different bytes each call) and not atomic, so two tests writing
/// the same path in parallel could tear each other's reads.
fn ensure_master_seal(ss58: &str) {
    static SEALED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    SEALED.get_or_init(|| {
        let path = TEST_HOME
            .join(".hippius")
            .join("drives")
            .join(account_key(ss58))
            .join("master_enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&path, MASTER, DRIVE_PW).expect("write master seal");
    });
}

/// Build an `AppState` with the pool, the active account, and the session
/// mnemonic seeded (the post-login state, minus the real login handshake).
fn make_state(pool: sqlx::SqlitePool, ss58: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state.set_active_account(ss58, AuthCapabilities::default()).expect("set active account");
    let mut auth = state.auth.lock().expect("auth lock");
    auth.mnemonic = Some(zeroize::Zeroizing::new(MASTER.to_string()));
    drop(auth);
    state
}

// ── Engine plumbing (the desktop's runner shape, minus the Tauri bridge) ───

/// Event capture standing in for the desktop's `TauriSyncBridge` — the
/// `shared_drives_real_backend` seam.
#[derive(Default)]
struct CaptureHandler {
    events: std::sync::Mutex<Vec<SyncEvent>>,
}

impl SyncEventHandler for CaptureHandler {
    fn on_event(&self, event: SyncEvent) {
        self.events.lock().expect("capture lock").push(event);
    }
}

impl CaptureHandler {
    fn sync_errors(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("capture lock")
            .iter()
            .filter_map(|e| match e {
                SyncEvent::SyncError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .collect()
    }
}

/// The own-drive `build_hcfs_config` shape, field-for-field (that helper
/// is `pub(crate)`; its identity threading is pinned by its unit tests).
fn own_drive_config(env: &LiveEnv, label: &str) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url: env.server_url.clone(),
        bearer_token: env.bearer.clone(),
        accept_invalid_certs: false,
        billing_bypass_token: None,
        ss58_address: env.ss58.clone(),
        folder_hash: hcfs_client::drive::keys::folder_hash(label),
        read_timeout_ms: None,
        shared_drive_member: false,
    }
}

/// A registered, engine-backed drive whose one file has been uploaded by
/// the REAL sync engine — the ciphertext the fragment key must decrypt.
/// The TempDir rides along so the root outlives the test body.
struct SeededDrive {
    _root: tempfile::TempDir,
    client: HcfsClient,
}

/// Stand up an own drive the way the desktop does (`init_new_drive`'s
/// derivation, the register call, a runner slot) and push `rel_path` =
/// `contents` to the live server through a real `trigger_sync` cycle.
async fn seed_drive_with_file(env: &LiveEnv, label: &str, rel_path: &str, contents: &[u8]) -> SeededDrive {
    let root = tempfile::TempDir::new().expect("drive root");
    let cfg = tempfile::TempDir::new().expect("drive config dir");
    let file_path = root.path().join(rel_path);
    std::fs::create_dir_all(file_path.parent().expect("rel_path has a parent")).expect("mkdir file parent");
    std::fs::write(&file_path, contents).expect("write drive file");

    let folder_phrase = hcfs_client::drive::keys::derive_folder_mnemonic(MASTER, label).expect("folder mnemonic");
    let mut manager = DriveManager::new(root.path().to_path_buf(), cfg.path().to_path_buf());
    manager.set_config(own_drive_config(env, label)).expect("set_config");
    manager.init(DRIVE_PW, Some(&folder_phrase)).await.expect("drive init");
    manager.unlock(DRIVE_PW).expect("drive unlock");

    // The engine's config dir must outlive this function; TempDir would
    // delete it on drop, so leak it (OS temp cleanup reaps it).
    std::mem::forget(cfg);

    let client = HcfsClient::new(own_drive_config(env, label)).expect("construct HcfsClient");
    client
        .register_folder(&env.ss58, &hcfs_client::drive::keys::folder_hash(label), label, Some("desktop-share-e2e"))
        .await
        .expect("register drive");

    let handler = Arc::new(CaptureHandler::default());
    let runner = Arc::new(SyncRunner::new(
        handler.clone() as Arc<dyn SyncEventHandler>,
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ));
    runner.register_label_root(label.to_string(), root.path().to_path_buf());
    runner.drives.lock().await.insert(
        label.to_string(),
        DriveSlot {
            manager: Arc::new(TokioMutex::new(manager)),
            cancel_token: CancellationToken::new(),
            sync_path: root.path().to_path_buf(),
        },
    );

    trigger_sync(&runner).await;
    assert_eq!(
        handler.sync_errors(),
        Vec::<String>::new(),
        "the engine's upload cycle must succeed before any share is minted"
    );

    SeededDrive { _root: root, client }
}

// ── URL + anonymous-request helpers ────────────────────────────────────────

/// Split a minted share URL into `(token, fragment_bytes)` at `marker`
/// (`"#k="` or `"#p="`). Panic messages deliberately do NOT echo the URL —
/// it carries the fragment secret.
fn split_share_url(share_url: &str, marker: &str) -> (String, Vec<u8>) {
    let (head, frag) = share_url
        .split_once(marker)
        .unwrap_or_else(|| panic!("share URL must carry a {marker} fragment"));
    let token = head.rsplit('/').next().expect("share URL has a token path segment").to_string();
    assert!(!token.is_empty(), "share URL token segment must be non-empty");
    // `expect` here would print base64's `DecodeError`, which quotes the
    // offending fragment byte — let-else keeps the message value-free.
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(frag) else {
        panic!("share URL fragment must decode as base64url-no-pad");
    };
    (token, bytes)
}

/// Anonymous GET against a recipient route — a PLAIN `reqwest` client, no
/// bearer, exactly what a stranger holding the link can do. The caller
/// appends any query string itself (the values used here are fixed and
/// URL-safe; the repo's `reqwest` feature set has no `.query`). Transport
/// errors are stripped of their URL before surfacing (the URL path carries
/// the token).
async fn anon_get(http: &reqwest::Client, url: &str) -> reqwest::Response {
    http.get(url)
        .send()
        .await
        .map_err(reqwest::Error::without_url)
        .expect("anonymous recipient request must reach the server")
}

// ── Scenario 1: public mint → anonymous decrypt → list → revoke ────────────

/// The pivotal no-mock round trip: the real funnel mints a public share
/// over engine-uploaded ciphertext; the `#k=` fragment key — and nothing
/// else — decrypts the bytes the anonymous blob route streams back; the
/// live listing row carries the derived `folder_hash` (badge identity);
/// revocation kills the anonymous surface and forgets the local secret.
///
/// `multi_thread`: the engine's `spawn_blocking` walk, the SQLite
/// keystore's `block_in_place`, and the reqwest driver need a worker pool.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER + HCFS_DESKTOP_E2E_SS58 and a running hcfs-server"]
async fn public_mint_round_trips_decrypt_list_and_revoke() {
    let Some(env) = live_env() else {
        return; // hermetic default stays green
    };
    let _home = &*TEST_HOME;
    let http = reqwest::Client::new();

    let label = unique_label("pub");
    let plaintext: &[u8] = b"the fragment key must open exactly these bytes";
    let drive = seed_drive_with_file(&env, &label, "docs/hello.txt", plaintext).await;

    let dir = tempfile::TempDir::new().expect("db tempdir");
    let pool = live_pool(dir.path()).await;
    seed_account(&pool, &env).await;
    seed_own_drive(&pool, &env.ss58, &label, "/unused").await;
    ensure_master_seal(&env.ss58);
    let state = make_state(pool.clone(), &env.ss58);

    // --- Act: mint a public share of the docs/ subtree through the funnel ---
    //
    // Shortest TTL the API offers, because this file only PARTIALLY follows
    // hcfs's `hcfs-e2e-tests/tests/shares.rs` convention of
    // fetch-then-revoke-then-assert (capture the live responses, revoke, then
    // assert below the revoke). Here ~15 assertions sit between the mint and
    // the revoke, so any red run leaves a live, anonymously-fetchable share on
    // the target until it expires. Hours24 caps that at a day instead of a
    // week; restructuring to the full convention is the real fix, deliberately
    // deferred. Nothing asserts on `expires_at`, so the TTL is free to move.
    let link = create_folder_share_inner(&state, &env.ss58, &label, "docs", ShareTtl::Hours24, ShareChoice::Public)
        .await
        .expect("public mint against the live server");

    let (token, key_bytes) = split_share_url(&link.share_url, "#k=");
    assert!(token == link.share_token, "the URL's token segment must be the minted token");
    // `Vec<u8> -> [u8; 32]` fails with the Vec itself as its error, so an
    // `expect` here would print the fragment key. The length is the whole
    // diagnostic and is not secret, so carry only that.
    let key_len = key_bytes.len();
    let key: [u8; 32] = key_bytes
        .try_into()
        .unwrap_or_else(|_| panic!("#k= fragment must be exactly 32 key bytes, got {key_len}"));

    // --- Assert: the anonymous surface answers while the share is live ---
    let meta_url = format!("{}/v1/folder-shares/{token}/meta", env.server_url);
    let meta = anon_get(&http, &meta_url).await;
    assert_eq!(meta.status().as_u16(), 200, "anonymous meta must answer for a live share");
    let meta: serde_json::Value = meta.json().await.expect("meta parses as JSON");
    assert_eq!(meta["display_name"], "docs", "meta carries the shared folder's display name: {meta}");

    // The scoped listing shows the file with its PLAINTEXT size (the
    // workspace size-semantics rule, live).
    let browse_url = format!("{}/v1/folder-shares/{token}/browse", env.server_url);
    let browse = anon_get(&http, &browse_url).await;
    assert_eq!(browse.status().as_u16(), 200, "anonymous browse must answer for a live share");
    let browse: serde_json::Value = browse.json().await.expect("browse parses as JSON");
    let files = browse["files"].as_array().expect("browse carries a files array");
    assert!(
        files.iter().any(|f| f["name"] == "hello.txt" && f["size_bytes"] == plaintext.len()),
        "the engine-uploaded file must appear in the share listing with its plaintext size: {browse}"
    );

    // --- THE round trip: fragment key decrypts the real ciphertext ---
    let blob_url = format!("{}/v1/folder-shares/{token}/blob?path=hello.txt", env.server_url);
    let blob = anon_get(&http, &blob_url).await;
    assert_eq!(blob.status().as_u16(), 200, "anonymous blob must stream for a live share");
    assert_eq!(
        blob.headers().get("content-type").and_then(|v| v.to_str().ok()),
        Some("application/octet-stream"),
        "the blob route serves opaque ciphertext"
    );
    let ciphertext = blob.bytes().await.map_err(reqwest::Error::without_url).expect("read blob body");
    assert!(
        ciphertext.len() > plaintext.len(),
        "the blob is ciphertext (nonce + auth tags), never the plaintext"
    );
    let decrypted = hcfs_client::crypto::decrypt_small(&ciphertext, &key).expect("the #k= fragment key must decrypt the drive's real ciphertext");
    assert_eq!(decrypted, plaintext, "the decrypted bytes are the original file");

    // --- Badge identity: the live listing row's folder_hash is the derived one ---
    let rows = list_folder_shares_inner(&state, &env.ss58).await.expect("list folder shares");
    let row = rows
        .iter()
        .find(|r| r.token_hash == folder_share_token_hash(&token))
        .expect("the minted share must appear in the live listing");
    assert_eq!(
        row.folder_hash,
        hcfs_client::drive::keys::folder_hash(&label),
        "the server row's folder_hash must equal the client derivation the FE badges key on"
    );
    assert_eq!(row.path_prefix, "docs");
    assert!(row.resolvable, "the minting device must resolve its own row");
    assert!(
        row.share_token.as_deref() == Some(token.as_str()),
        "the listing row must carry the minted plaintext token back"
    );
    // The rebuilt URL carries the live token in its path AND the key in its
    // `#k=` fragment, so neither half may be printed. Splitting at the
    // marker and comparing each side as a boolean still says WHICH half
    // diverged — a wrong console base, a wrong token, or a wrong key.
    let row_url = row.share_url.as_deref().expect("a resolvable row must rebuild its share URL");
    let (row_head, row_frag) = row_url.split_once('#').expect("the rebuilt URL must carry a fragment");
    let (mint_head, mint_frag) = link.share_url.split_once('#').expect("the minted URL must carry a fragment");
    assert!(row_head == mint_head, "the listing must rebuild the minted URL's base and token path");
    assert!(row_frag == mint_frag, "the listing must rebuild the minted URL's key fragment");
    assert_eq!(row.is_private, Some(false));
    assert_eq!(row.revoked_at, None, "the share is live before the revoke");

    // --- Revoke: the anonymous surface dies, the keystore forgets ---
    revoke_folder_share_inner(&state, &env.ss58, &token).await.expect("revoke");

    let meta_after = anon_get(&http, &meta_url).await;
    assert_eq!(meta_after.status().as_u16(), 404, "anonymous meta must 404 after the revoke");
    assert!(
        meta_after
            .bytes()
            .await
            .map_err(reqwest::Error::without_url)
            .expect("read meta body")
            .is_empty(),
        "the recipient 404 is bodiless (no-oracle posture)"
    );
    let blob_after = anon_get(&http, &blob_url).await;
    assert_eq!(blob_after.status().as_u16(), 404, "the ciphertext must be unreachable after the revoke");

    let keystore = SqliteShareKeystore::new(pool);
    // `ShareSecret` derives `Debug` — `Public` holds the raw key, `Private`
    // the fragment blob — so an `assert_eq!` against `None` would print the
    // secret on the one failure that matters: it outliving the revoke.
    assert!(
        keystore.get(&token).expect("keystore get").is_none(),
        "the revoked token's secret must be forgotten"
    );

    // --- Cleanup: drop this run's drive namespace (bounded leak on panic) ---
    let _ = drive
        .client
        .unregister_folder(&env.ss58, &hcfs_client::drive::keys::folder_hash(&label))
        .await;
}

// ── Scenario 2: password mint — the wrap is real, client-side ──────────────

/// The `#p=` mint: the fragment blob unwraps with the password — pure
/// client-side Argon2id, no server round trip — to exactly the drive key
/// the sync engine encrypts with, a wrong password fails, the raw key
/// appears nowhere in the URL, and the revoke kills the anonymous meta.
///
/// No file upload here: the wrap round trip is proven against
/// `derive_encryption_key` — the very function the funnel's own-drive tail
/// calls, so what is independent is only the MNEMONIC SOURCE (this file's
/// `MASTER` constant, versus the master the funnel recovers from the sealed
/// `master_enc_mnemonic.json`), not the derivation. Scenario 1 already
/// proves that same key against real engine ciphertext, so seeding content
/// here would only re-test scenario 1's decrypt.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER + HCFS_DESKTOP_E2E_SS58 and a running hcfs-server"]
async fn password_mint_wraps_the_drive_key_and_wrong_password_fails() {
    let Some(env) = live_env() else {
        return; // hermetic default stays green
    };
    let _home = &*TEST_HOME;
    let http = reqwest::Client::new();

    let label = unique_label("pw");
    let fh = hcfs_client::drive::keys::folder_hash(&label);

    let dir = tempfile::TempDir::new().expect("db tempdir");
    let pool = live_pool(dir.path()).await;
    seed_account(&pool, &env).await;
    seed_own_drive(&pool, &env.ss58, &label, "/unused").await;
    ensure_master_seal(&env.ss58);
    let state = make_state(pool.clone(), &env.ss58);

    // The mint requires a registered drive; content is not needed.
    let client = HcfsClient::new(own_drive_config(&env, &label)).expect("construct HcfsClient");
    client
        .register_folder(&env.ss58, &fh, &label, Some("desktop-share-e2e"))
        .await
        .expect("register drive");

    // --- Act: whole-drive password mint through the funnel ---
    //
    // Hours24 for the same reason as the public mint above: assertions sit
    // between this mint and its revoke, so a red run leaks a live share until
    // expiry. A password share is not anonymously fetchable, but it is still a
    // live server-side row, and the TTL is the only thing that reaps it.
    let password = "hunter2-hunter2";
    let link = create_folder_share_inner(
        &state,
        &env.ss58,
        &label,
        "/",
        ShareTtl::Hours24,
        ShareChoice::Private {
            password: password.to_string(),
        },
    )
    .await
    .expect("password mint against the live server");
    // Boolean, not `assert_eq!`: a funnel that echoed the WRONG string here
    // would print whatever secret it echoed instead.
    assert!(
        link.password.as_deref() == Some(password),
        "the password surfaces on the create response only"
    );

    // --- Assert: the wrap round-trips client-side to the drive key ---
    let (token, blob) = split_share_url(&link.share_url, "#p=");
    assert!(token == link.share_token, "the URL's token segment must be the minted token");

    let drive_key = hcfs_client::drive::remote::derive_encryption_key(MASTER, &label).expect("drive-key derivation from the in-test master");
    let unwrapped = unwrap_share_key(password, &blob).expect("the password must unwrap the fragment blob");
    assert!(unwrapped == drive_key, "the unwrapped key must be the drive's derived file key");
    assert!(
        unwrap_share_key("not-the-password", &blob).is_err(),
        "a wrong password must fail the unwrap"
    );
    assert!(
        !link.share_url.contains(&URL_SAFE_NO_PAD.encode(drive_key)),
        "the raw drive key must not appear anywhere in a password link"
    );

    // --- Act while live, then revoke, then assert the surface is dead ---
    let meta_url = format!("{}/v1/folder-shares/{token}/meta", env.server_url);
    let meta = anon_get(&http, &meta_url).await;
    assert_eq!(meta.status().as_u16(), 200, "anonymous meta must answer for a live share");
    let meta: serde_json::Value = meta.json().await.expect("meta parses as JSON");
    assert_eq!(
        meta["display_name"],
        label.as_str(),
        "a whole-drive share is titled by the drive label: {meta}"
    );

    revoke_folder_share_inner(&state, &env.ss58, &token).await.expect("revoke");
    let meta_after = anon_get(&http, &meta_url).await;
    assert_eq!(meta_after.status().as_u16(), 404, "anonymous meta must 404 after the revoke");

    let keystore = SqliteShareKeystore::new(pool);
    // `ShareSecret` derives `Debug` — `Public` holds the raw key, `Private`
    // the fragment blob — so an `assert_eq!` against `None` would print the
    // secret on the one failure that matters: it outliving the revoke.
    assert!(
        keystore.get(&token).expect("keystore get").is_none(),
        "the revoked token's secret must be forgotten"
    );

    // --- Cleanup: drop this run's drive namespace (bounded leak on panic) ---
    let _ = client.unregister_folder(&env.ss58, &fh).await;
}

// ── Scenario 3: member refusal against the live capability document ────────

/// A member-drive mint refuses at the owner-only gate AFTER the live
/// capability probe: the real server's `/v1/capabilities` advertises
/// `folder_shares`, so the refusal provably comes from the member gate,
/// not a capability miss — and no mint request ever leaves the process
/// (nothing lands server-side, so there is nothing to clean up). The
/// probe-ordering and request-count pins live in `shares_server_mock.rs`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + HCFS_DESKTOP_E2E_BEARER + HCFS_DESKTOP_E2E_SS58 and a running hcfs-server"]
async fn member_drive_mint_refuses_against_the_live_capability_doc() {
    let Some(env) = live_env() else {
        return; // hermetic default stays green
    };
    let _home = &*TEST_HOME;

    let label = unique_label("member");
    let dir = tempfile::TempDir::new().expect("db tempdir");
    let pool = live_pool(dir.path()).await;
    seed_account(&pool, &env).await;
    seed_member_drive(&pool, &env.ss58, &label).await;
    let state = make_state(pool.clone(), &env.ss58);

    // Hours24 like the other mints. This call is expected to refuse and so
    // creates nothing, but if the owner-only rule ever regressed it WOULD
    // mint — and this test has no revoke to clean up after it.
    let err = create_folder_share_inner(&state, &env.ss58, &label, "docs", ShareTtl::Hours24, ShareChoice::Public)
        .await
        .expect_err("a member mint must refuse");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("Only the owner"), "the owner-only rule must be named: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }

    let keystore = SqliteShareKeystore::new(pool);
    assert!(keystore.all_entries().expect("scan").is_empty(), "nothing may be persisted on refusal");
}
