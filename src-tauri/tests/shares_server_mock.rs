//! Behavioral integration tests for the folder-share transport layer
//! (`shares::commands`), against a mock axum server — the
//! `shared_drive_server_mock` seam: no live server, no Tauri AppHandle.
//!
//! These replace the guarantees the string-match wiring pins in
//! `folder_share_wiring.rs` could only approximate: instead of asserting
//! that `identity.is_member` appears in the source, the tests here seed a
//! member drive and watch the funnel refuse WITHOUT a request reaching the
//! mint route.
//!
//! Covers:
//! - The happy public mint through the real funnel: the POST body is
//!   exactly the four metadata fields carrying the drive's real
//!   `folder_hash`, the returned URL is the `#k=` recipient link built
//!   from the drive's derived file key, and the SQLite keystore holds it.
//! - The password mint: `#p=` URL, keystore holds the wrapped blob, the
//!   raw key appears nowhere.
//! - The member-drive refusal and the capability gate, behaviorally: the
//!   distinct Validation messages, with the mint route provably uncalled.
//! - Owner ops: the listing joins server `token_hash` rows to locally
//!   stored tokens (hash computed with `folder_share_token_hash`, never
//!   hardcoded), revoke sends the plaintext token and forgets the secret,
//!   the 404-revoke forgets ONLY when the capability probe confirms a
//!   folder-shares-capable server, and the expiry PATCH pins its `{ttl}`
//!   body and consumes the token-less `{expires_at}` response.
//! - Path-prefix validation refusing `..` and friends before any request.

use axum::{
    Json, Router,
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

use hcfs_client::client::folder_share::{ShareTtl, folder_share_token_hash};
use hcfs_client::client::share::{ShareKeystore, ShareSecret};
use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::error::AppError;
use tauri_project_lib::shares::SqliteShareKeystore;
use tauri_project_lib::shares::commands::{
    ShareChoice, create_folder_share_inner, list_folder_shares_inner, revoke_folder_share_inner, update_folder_share_expiry_inner,
};

/// One shared `$HOME` for every test in this binary that touches config dirs
/// (the master-mnemonic seal lives under `~/.hippius`). Same discipline as
/// `shared_drive_server_mock`: `HOME` is process-global and tests run in
/// parallel, so the first accessor pins ONE tempdir for the process lifetime
/// and every test keeps its writes disjoint via its own account. The token
/// keychain is disabled in the same breath — `get_api_token` would otherwise
/// read the developer's real OS keychain and, on an opportunistic upgrade,
/// scrub the seeded plaintext token row mid-suite.
static TEST_HOME: std::sync::LazyLock<std::path::PathBuf> = std::sync::LazyLock::new(|| {
    let dir = tempfile::TempDir::new().expect("home tempdir");
    let path = dir.path().to_path_buf();
    std::mem::forget(dir);
    unsafe {
        std::env::set_var("HOME", &path);
        std::env::set_var("HIPPIUS_DISABLE_TOKEN_KEYCHAIN", "1");
    }
    path
});

// ── Fixtures (published BIP-39 vector — never a real wallet) ───────────────

const MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DRIVE_PW: &str = "drive-pw";
const BEARER: &str = "test-bearer-token";

/// Owner identity of the seeded MEMBER drive (someone else's drive).
const OWNER_SS58: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const WIRE_HASH: &str = "0123456789abcdef";

// ── Mock server ────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct Recorded {
    /// How many times `GET /v1/capabilities` was hit — the pre-network
    /// refusal tests assert this stays 0.
    capability_hits: Arc<Mutex<u32>>,
    /// The raw JSON body of every `POST /v1/folder-shares`, in arrival
    /// order — the seam that pins the exact metadata-only wire body.
    create_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    /// The `{token}` path segment of every DELETE, in arrival order.
    revoked_tokens: Arc<Mutex<Vec<String>>>,
    /// The raw JSON body of every PATCH, in arrival order.
    patch_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// What the mint route answers.
#[derive(Clone)]
enum CreateReply {
    Created {
        share_token: &'static str,
        expires_at: Option<&'static str>,
    },
    /// The owner-facing 404 envelope for an unregistered drive.
    FolderNotFound,
}

/// Per-test server behavior. `Default` is a fully folder-shares-capable
/// server with an empty listing.
#[derive(Clone)]
struct MockOptions {
    /// Body of `GET /v1/capabilities` (the route is anonymous, mirroring
    /// hcfs-server).
    capabilities: serde_json::Value,
    create: CreateReply,
    /// Rows of `GET /v1/folder-shares`.
    list: serde_json::Value,
    /// Tokens whose DELETE/PATCH answers the server's bodiless 404.
    missing_tokens: Vec<String>,
    /// `expires_at` echoed by a successful PATCH — the response carries
    /// nothing else (no token echo).
    patch_expires_at: serde_json::Value,
}

impl Default for MockOptions {
    fn default() -> Self {
        Self {
            capabilities: json!({ "shares": true, "folder_shares": true }),
            create: CreateReply::Created {
                share_token: "tok_mock",
                expires_at: None,
            },
            list: json!([]),
            missing_tokens: Vec::new(),
            patch_expires_at: json!(null),
        }
    }
}

/// `Some(401)` when the bearer is missing/wrong, `None` when it checks out.
fn bearer_rejection(headers: &HeaderMap) -> Option<axum::response::Response> {
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {BEARER}"));
    if ok {
        None
    } else {
        Some((StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized", "message": "bad bearer"}))).into_response())
    }
}

/// The folder-share routes, mimicking hcfs-server's response shapes.
fn share_router(opts: MockOptions, recorded: Recorded) -> Router {
    let caps_hits = recorded.capability_hits.clone();
    let caps_body = opts.capabilities.clone();
    let create_recorder = recorded.create_bodies.clone();
    let create_reply = opts.create.clone();
    let list_body = opts.list.clone();
    let revoke_recorder = recorded.revoked_tokens.clone();
    let patch_recorder = recorded.patch_bodies.clone();
    let delete_missing = opts.missing_tokens.clone();
    let patch_missing = opts.missing_tokens.clone();
    let patch_expires = opts.patch_expires_at.clone();

    Router::new()
        .route(
            "/v1/capabilities",
            get(move || async move {
                *caps_hits.lock().unwrap() += 1;
                Json(caps_body).into_response()
            }),
        )
        .route(
            "/v1/folder-shares",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                create_recorder.lock().unwrap().push(body);
                match create_reply {
                    CreateReply::Created { share_token, expires_at } => {
                        (StatusCode::CREATED, Json(json!({ "share_token": share_token, "expires_at": expires_at }))).into_response()
                    }
                    CreateReply::FolderNotFound => (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": "folder_not_found",
                            "message": "No registered drive with this folder_hash for your account"
                        })),
                    )
                        .into_response(),
                }
            })
            .get(move |headers: HeaderMap| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                Json(list_body).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/{token}",
            delete(move |headers: HeaderMap, Path(token): Path<String>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                revoke_recorder.lock().unwrap().push(token.clone());
                if delete_missing.contains(&token) {
                    // Bodiless, like the server's collapsed 404.
                    return StatusCode::NOT_FOUND.into_response();
                }
                StatusCode::NO_CONTENT.into_response()
            })
            .patch(
                move |headers: HeaderMap, Path(token): Path<String>, Json(body): Json<serde_json::Value>| async move {
                    if let Some(resp) = bearer_rejection(&headers) {
                        return resp;
                    }
                    patch_recorder.lock().unwrap().push(body);
                    if patch_missing.contains(&token) {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    Json(json!({ "expires_at": patch_expires })).into_response()
                },
            ),
        )
}

/// Bind a router on an ephemeral port; returns its base URL.
async fn serve(router: Router) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    format!("http://{addr}")
}

// ── DB + state scaffolding ─────────────────────────────────────────────────

/// Production-shaped file pool (WAL, like `main.rs::build_pool`) with the
/// tables the share path touches: `sync_paths` (drive rows + member wire
/// identity), `hcfs_config` (server URL + encrypted drive password),
/// `objectstore_auth_scoped` (the bearer-token fallback `get_api_token`
/// reads with the keychain disabled), and the production `share_keystore`
/// DDL with its secret-kind/length CHECKs.
async fn make_pool(dir: &std::path::Path) -> sqlx::SqlitePool {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::str::FromStr;

    let db = dir.join("hippius-test.db");
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db.display()))
        .expect("connect opts")
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().max_connections(4).connect_with(opts).await.expect("pool");

    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'default',
            timestamp INTEGER NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            owner_ss58 TEXT,
            wire_folder_hash TEXT,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .expect("sync_paths schema");

    sqlx::query(
        "CREATE TABLE hcfs_config (
            owner TEXT NOT NULL UNIQUE,
            server_url TEXT NOT NULL DEFAULT '',
            drive_password TEXT NOT NULL DEFAULT '',
            encryption_version INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .expect("hcfs_config schema");

    sqlx::query(
        "CREATE TABLE objectstore_auth_scoped (
            owner TEXT PRIMARY KEY,
            temp_auth_key TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .expect("objectstore_auth_scoped schema");

    sqlx::query(
        "CREATE TABLE share_keystore (
            share_token TEXT PRIMARY KEY,
            secret_kind TEXT NOT NULL DEFAULT 'public'
                        CHECK (secret_kind IN ('public', 'private')),
            share_key BLOB NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            CHECK (
                (secret_kind = 'public'  AND length(share_key) = 32)
             OR (secret_kind = 'private' AND length(share_key) > 32)
            )
        )",
    )
    .execute(&pool)
    .await
    .expect("share_keystore schema");

    pool
}

/// Seed the account's server pointer, encrypted (v1) drive password, and
/// bearer token. The password row is stored ENCRYPTED under the session
/// mnemonic — the production steady state after
/// `crypto::store::migrate_if_needed` — so the mint exercises the same
/// master-decrypt path a real account is on.
async fn seed_account(pool: &sqlx::SqlitePool, account: &str, server_url: &str) {
    let key = tauri_project_lib::crypto::store::drive_password_key(MASTER, account).expect("key");
    let sealed_pw = tauri_project_lib::crypto::store::encrypt(&key, DRIVE_PW).expect("encrypt pw");
    sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, 1)")
        .bind(account_key(account))
        .bind(server_url)
        .bind(&sealed_pw)
        .execute(pool)
        .await
        .expect("seed hcfs_config");

    // `get_api_token` binds the RAW account id here (not `account_key`).
    sqlx::query("INSERT INTO objectstore_auth_scoped (owner, temp_auth_key) VALUES (?, ?)")
        .bind(account)
        .bind(BEARER)
        .execute(pool)
        .await
        .expect("seed bearer token");
}

/// An OWN drive row: both wire-identity columns NULL, so
/// `resolve_drive_identity` derives `(account, folder_hash(label), owner)`.
async fn seed_own_drive(pool: &sqlx::SqlitePool, account: &str, label: &str) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/unused', 'private', ?, 0)")
        .bind(account_key(account))
        .bind(label)
        .execute(pool)
        .await
        .expect("seed own drive row");
}

/// A MEMBER drive row: the wire identity names the OWNER's drive, the same
/// row shape `install_member_drive` persists.
async fn seed_member_drive(pool: &sqlx::SqlitePool, account: &str, label: &str) {
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, owner_ss58, wire_folder_hash) VALUES (?, '/unused', 'private', ?, 0, ?, ?)",
    )
    .bind(account_key(account))
    .bind(label)
    .bind(OWNER_SS58)
    .bind(WIRE_HASH)
    .execute(pool)
    .await
    .expect("seed member drive row");
}

/// Write the account's master-mnemonic seal where
/// `encryption_key_for_label` expects it — the file the own-drive key
/// derivation decrypts with the drive password.
fn write_master_seal(account: &str) {
    let path = TEST_HOME
        .join(".hippius")
        .join("drives")
        .join(account_key(account))
        .join("master_enc_mnemonic.json");
    hcfs_client::auth::save_encrypted_mnemonic(&path, MASTER, DRIVE_PW).expect("write master seal");
}

/// Build an `AppState` with the pool, an active account, and the session
/// mnemonic seeded (the post-login state, minus the real login handshake) —
/// the same scaffolding `tests/sync_mnemonic_resolution.rs` uses.
fn make_state(pool: sqlx::SqlitePool, account: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account, AuthCapabilities::default())
        .expect("set active account");
    let mut auth = state.auth.lock().expect("auth lock");
    auth.mnemonic = Some(Zeroizing::new(MASTER.to_string()));
    drop(auth);
    state
}

/// The drive file key the mint must embed in the URL fragment: the SAME
/// derivation `encryption_key_for_label` performs for an own drive
/// (master → derive_encryption_key(label)), computed independently here.
fn expected_file_key(label: &str) -> [u8; 32] {
    hcfs_client::drive::remote::derive_encryption_key(MASTER, label).expect("derive file key")
}

// ── Mint (happy paths) ─────────────────────────────────────────────────────

/// The full public mint through the real funnel: the POST body is exactly
/// `{folder_hash, path_prefix, display_name, ttl}` with the drive's real
/// `folder_hash` and NOTHING else (no key material has a field to ride
/// in), the returned URL is `…/share/folder/{token}#k={key}` with the
/// drive's independently derived file key, and the SQLite keystore holds
/// that key as a `Public` secret. The bearer is enforced by the mock —
/// a wrong or missing Authorization would fail the mint outright.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_mint_posts_exact_metadata_and_persists_the_key() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5PubMintAcct";
    let label = "photo-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::Created {
                share_token: "tok_pub",
                expires_at: Some("2026-08-30T00:00:00+00:00"),
            },
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool.clone(), account);

    let link = create_folder_share_inner(&state, account, label, "photos/2026", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect("mint");

    let body = recorded.create_bodies.lock().unwrap().last().cloned().expect("a mint landed");
    assert_eq!(
        body,
        json!({
            "folder_hash": hcfs_client::drive::keys::folder_hash(label),
            "path_prefix": "photos/2026",
            "display_name": "2026",
            "ttl": "7d",
        }),
        "the POST body must be exactly the four metadata fields"
    );

    assert_eq!(link.share_token, "tok_pub");
    assert_eq!(link.expires_at.as_deref(), Some("2026-08-30T00:00:00+00:00"));
    assert_eq!(link.password, None, "a public mint returns no password");

    let key = expected_file_key(label);
    let expected_suffix = format!("/share/folder/tok_pub#k={}", URL_SAFE_NO_PAD.encode(key));
    assert!(
        link.share_url.starts_with("http") && link.share_url.ends_with(&expected_suffix),
        "the URL must be the #k= recipient link carrying the drive's derived file key: {}",
        link.share_url
    );

    let keystore = SqliteShareKeystore::new(pool);
    assert_eq!(
        keystore.get("tok_pub").expect("keystore get"),
        Some(ShareSecret::Public(key)),
        "the keystore must hold the minted token's raw key as Public"
    );
}

/// A whole-drive share (`relative_path` of bare separators) lands on the
/// wire with the empty `path_prefix` and the DRIVE LABEL as its display
/// name — the root half of the display-name rule (console parity).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whole_drive_mint_uses_the_drive_label_and_empty_prefix() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5RootMintAcct";
    let label = "team-docs";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::Created {
                share_token: "tok_root",
                expires_at: None,
            },
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool.clone(), account);

    let link = create_folder_share_inner(&state, account, label, "/", ShareTtl::Never, ShareChoice::Public)
        .await
        .expect("mint");
    assert_eq!(link.expires_at, None, "a never-expiring share reports no expiry");

    let body = recorded.create_bodies.lock().unwrap().last().cloned().expect("a mint landed");
    assert_eq!(
        body,
        json!({
            "folder_hash": hcfs_client::drive::keys::folder_hash(label),
            "path_prefix": "",
            "display_name": label,
            "ttl": "never",
        }),
        "a whole-drive share is the empty prefix titled by the drive label"
    );
}

/// The password mint: the URL is a `#p=` link carrying the wrapped blob
/// the keystore persisted, the raw derived key appears NOWHERE in it, and
/// the caller gets the password back exactly once (on this response).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn password_mint_yields_a_p_url_and_a_private_secret() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5PrivMintAcct";
    let label = "secret-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::Created {
                share_token: "tok_priv",
                expires_at: None,
            },
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool.clone(), account);

    let link = create_folder_share_inner(
        &state,
        account,
        label,
        "secret-docs",
        ShareTtl::Days7,
        ShareChoice::Private {
            password: "hunter2-hunter2".to_string(),
        },
    )
    .await
    .expect("mint");

    assert_eq!(
        link.password.as_deref(),
        Some("hunter2-hunter2"),
        "the password surfaces on the create response only"
    );

    let raw_key_b64 = URL_SAFE_NO_PAD.encode(expected_file_key(label));
    assert!(
        !link.share_url.contains("#k="),
        "a password share must never yield a #k= link: {}",
        link.share_url
    );
    assert!(
        !link.share_url.contains(&raw_key_b64),
        "the raw file key must not appear anywhere in a password link: {}",
        link.share_url
    );

    let keystore = SqliteShareKeystore::new(pool);
    let Some(ShareSecret::Private(blob)) = keystore.get("tok_priv").expect("keystore get") else {
        panic!("the keystore must hold the password-wrapped blob, never the raw key");
    };
    let expected_suffix = format!("/share/folder/tok_priv#p={}", URL_SAFE_NO_PAD.encode(&blob));
    assert!(
        link.share_url.ends_with(&expected_suffix),
        "the #p= fragment must carry exactly the stored blob: {}",
        link.share_url
    );

    // The POST body stays the same four metadata fields — the password
    // changes only the fragment and the stored secret, never the wire.
    let body = recorded.create_bodies.lock().unwrap().last().cloned().expect("a mint landed");
    assert_eq!(
        body,
        json!({
            "folder_hash": hcfs_client::drive::keys::folder_hash(label),
            "path_prefix": "secret-docs",
            "display_name": "secret-docs",
            "ttl": "7d",
        }),
    );
}

// ── Mint (refusals) ────────────────────────────────────────────────────────

/// The security gate the wiring pin could only string-match: minting on a
/// MEMBER drive refuses with the distinct owner-only Validation and the
/// mint route stays uncalled. (The capability probe runs before identity
/// resolution, so `/v1/capabilities` may be hit — the pinned behavior is
/// that no POST fires and nothing lands in the keystore.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn member_drive_mint_refuses_before_any_mint_request() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5MemberMintAcct";
    let label = "joined-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(MockOptions::default(), recorded.clone())).await;

    seed_account(&pool, account, &base).await;
    seed_member_drive(&pool, account, label).await;
    let state = make_state(pool.clone(), account);

    let err = create_folder_share_inner(&state, account, label, "docs", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect_err("a member mint must refuse");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("Only the owner"), "the owner-only rule must be named: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }

    assert!(recorded.create_bodies.lock().unwrap().is_empty(), "no mint request may reach the server");
    let keystore = SqliteShareKeystore::new(pool);
    assert!(keystore.all_entries().expect("scan").is_empty(), "nothing may be persisted on refusal");
}

/// The capability gate, behaviorally: a server advertising `{shares:true}`
/// without `folder_shares` (an old deployment) refuses the mint with the
/// distinct message and no POST fires. The `folder_shares: true` half —
/// the mint proceeding — is every happy-mint test above.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_folder_shares_capability_refuses_the_mint() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5NoCapAcct";
    let label = "old-server-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            capabilities: json!({ "shares": true }),
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    let state = make_state(pool, account);

    let err = create_folder_share_inner(&state, account, label, "docs", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect_err("an old server must refuse the mint");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("not enabled"), "the capability refusal must be named: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }
    assert_eq!(*recorded.capability_hits.lock().unwrap(), 1, "the gate consults the capability route");
    assert!(recorded.create_bodies.lock().unwrap().is_empty(), "no mint request may reach the server");
}

/// Path-prefix validation is the FIRST gate: an illegal component refuses
/// before ANY request — not even the capability probe fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn illegal_path_prefix_refuses_before_any_network() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5BadPathAcct";

    let recorded = Recorded::default();
    let base = serve(share_router(MockOptions::default(), recorded.clone())).await;
    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, "any-drive").await;
    let state = make_state(pool, account);

    for bad in ["..", "photos/../secret", "/../", "."] {
        let err = create_folder_share_inner(&state, account, "any-drive", bad, ShareTtl::Days7, ShareChoice::Public)
            .await
            .expect_err("an illegal component must refuse");
        match err {
            AppError::Validation(msg) => assert!(msg.contains("illegal component"), "{bad:?}: {msg}"),
            other => panic!("{bad:?}: expected Validation, got {other:?}"),
        }
    }

    assert_eq!(
        *recorded.capability_hits.lock().unwrap(),
        0,
        "path validation must precede the capability probe"
    );
    assert!(recorded.create_bodies.lock().unwrap().is_empty(), "no request of any kind may fire");
}

/// The server's `folder_not_found` envelope (an unregistered drive) maps
/// to the actionable Validation the share modal shows verbatim — not a
/// generic transport error — and nothing lands in the keystore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unregistered_drive_envelope_maps_to_a_shown_validation() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5UnregAcct";
    let label = "unregistered-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::FolderNotFound,
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool.clone(), account);

    let err = create_folder_share_inner(&state, account, label, "", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect_err("an unregistered drive must refuse");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("isn't registered on the server"), "actionable message: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }
    let keystore = SqliteShareKeystore::new(pool);
    assert!(
        keystore.all_entries().expect("scan").is_empty(),
        "no secret may be stored on a failed mint"
    );
}

// ── Owner ops ──────────────────────────────────────────────────────────────

/// The listing joins the server's `token_hash` rows to the local keystore:
/// a row whose hash matches a stored token (hash computed with
/// `folder_share_token_hash`, never hardcoded) resolves with the plaintext
/// token and the rebuilt URL — byte-identical to the one the mint handed
/// out — while a foreign hash row comes back view-only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_resolves_local_rows_and_leaves_foreign_rows_view_only() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5ListAcct";
    let label = "listed-drive";
    let fh = hcfs_client::drive::keys::folder_hash(label);

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::Created {
                share_token: "tok_list",
                expires_at: None,
            },
            list: json!([
                {
                    "token_hash": folder_share_token_hash("tok_list"),
                    "folder_hash": fh,
                    "path_prefix": "reports",
                    "display_name": "reports",
                    "created_at": "2026-08-23T00:00:00+00:00",
                    "expires_at": null,
                    "revoked_at": null,
                },
                {
                    "token_hash": "ff".repeat(32),
                    "folder_hash": fh,
                    "path_prefix": "",
                    "display_name": label,
                    "created_at": "2026-08-22T00:00:00+00:00",
                    "expires_at": "2026-08-24T00:00:00+00:00",
                    "revoked_at": "2026-08-23T12:00:00+00:00",
                },
            ]),
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool, account);

    // Mint first so the keystore holds tok_list — the local half of the join.
    let link = create_folder_share_inner(&state, account, label, "reports", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect("mint");

    let rows = list_folder_shares_inner(&state, account).await.expect("list");
    assert_eq!(rows.len(), 2);

    let local = &rows[0];
    assert!(local.resolvable);
    assert_eq!(local.share_token.as_deref(), Some("tok_list"));
    assert_eq!(
        local.share_url.as_deref(),
        Some(link.share_url.as_str()),
        "the rebuilt URL must be byte-identical to the minted one"
    );
    assert_eq!(local.is_private, Some(false));
    assert_eq!(local.token_hash, folder_share_token_hash("tok_list"));
    assert_eq!(local.created_at, "2026-08-23T00:00:00+00:00");
    assert_eq!(local.expires_at, None);
    assert_eq!(local.revoked_at, None);

    let foreign = &rows[1];
    assert!(!foreign.resolvable, "a hash minted elsewhere must not resolve");
    assert_eq!(foreign.share_token, None);
    assert_eq!(foreign.share_url, None);
    assert_eq!(foreign.is_private, None, "protection is UNKNOWN for a foreign row, never false");
    assert_eq!(foreign.revoked_at.as_deref(), Some("2026-08-23T12:00:00+00:00"));
}

/// Revoke sends the PLAINTEXT token as the DELETE path segment (the token
/// is the capability) and forgets the keystore secret on the wire success.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoke_sends_the_plaintext_token_and_forgets_the_secret() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5RevokeAcct";
    let label = "revoked-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            create: CreateReply::Created {
                share_token: "tok_rev",
                expires_at: None,
            },
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    seed_own_drive(&pool, account, label).await;
    write_master_seal(account);
    let state = make_state(pool.clone(), account);

    create_folder_share_inner(&state, account, label, "", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect("mint");
    let keystore = SqliteShareKeystore::new(pool);
    assert!(keystore.get("tok_rev").expect("get").is_some(), "the mint persisted the secret");

    revoke_folder_share_inner(&state, account, "tok_rev").await.expect("revoke");

    let tokens = recorded.revoked_tokens.lock().unwrap().clone();
    assert_eq!(tokens, vec!["tok_rev".to_string()], "the DELETE must carry the plaintext token");
    assert_eq!(keystore.get("tok_rev").expect("get"), None, "the secret must be forgotten on success");
}

/// The 404-revoke idempotency, on a server that still speaks folder
/// shares: the capability probe confirms the 404 is authoritative, the
/// call succeeds, and the local secret is forgotten (a token revoked from
/// another device stops resolving here).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoke_404_with_capability_confirmed_forgets_the_local_secret() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5Revoke404Acct";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            missing_tokens: vec!["tok_gone".to_string()],
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    let state = make_state(pool.clone(), account);
    let keystore = SqliteShareKeystore::new(pool);
    keystore.put("tok_gone", &ShareSecret::Public([7u8; 32])).expect("seed secret");

    revoke_folder_share_inner(&state, account, "tok_gone")
        .await
        .expect("404 revoke is idempotent");

    assert_eq!(
        *recorded.capability_hits.lock().unwrap(),
        1,
        "the 404 must be confirmed by the capability probe"
    );
    assert_eq!(
        keystore.get("tok_gone").expect("get"),
        None,
        "the confirmed-dead token's secret must be forgotten"
    );
}

/// The rollback guard: when the 404 comes from a server that does NOT
/// advertise folder shares (a rollback answers every route with the same
/// bare 404), the probe fails the call and the keystore KEEPS the secret —
/// it may be the only plaintext copy of a token that still guards a live
/// share once the server rolls forward.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoke_404_without_the_capability_keeps_the_local_secret() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5RollbackAcct";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            capabilities: json!({ "shares": true }),
            missing_tokens: vec!["tok_keep".to_string()],
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;

    seed_account(&pool, account, &base).await;
    let state = make_state(pool.clone(), account);
    let keystore = SqliteShareKeystore::new(pool);
    let secret = ShareSecret::Public([9u8; 32]);
    keystore.put("tok_keep", &secret).expect("seed secret");

    let err = revoke_folder_share_inner(&state, account, "tok_keep")
        .await
        .expect_err("an unconfirmed 404 must fail the call");
    assert!(matches!(err, AppError::Validation(_)), "the probe's refusal surfaces, got {err:?}");
    assert_eq!(
        keystore.get("tok_keep").expect("get"),
        Some(secret),
        "the secret must survive an unconfirmed 404"
    );
}

/// The expiry PATCH pins its `{ttl}` body exactly and consumes the
/// deliberately token-less `{expires_at}` response — both the dated and
/// the `null` (never-expiring) shapes; the server's bodiless 404 becomes
/// the actionable "no longer active" Validation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expiry_update_pins_the_patch_body_and_consumes_the_bare_response() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5ExpiryAcct";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            missing_tokens: vec!["tok_dead".to_string()],
            patch_expires_at: json!("2026-09-22T00:00:00+00:00"),
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;
    seed_account(&pool, account, &base).await;
    let state = make_state(pool.clone(), account);

    let expires = update_folder_share_expiry_inner(&state, account, "tok_ttl", ShareTtl::Days7)
        .await
        .expect("expiry update");
    assert_eq!(expires.as_deref(), Some("2026-09-22T00:00:00+00:00"));
    let body = recorded.patch_bodies.lock().unwrap().last().cloned().expect("a patch landed");
    assert_eq!(body, json!({ "ttl": "7d" }), "the PATCH body must be exactly the ttl");

    let err = update_folder_share_expiry_inner(&state, account, "tok_dead", ShareTtl::Never)
        .await
        .expect_err("a dead token must refuse");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("no longer active"), "actionable message: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }

    // The null shape: a share switched to Never reports no expiry.
    let never_base = serve(share_router(MockOptions::default(), Recorded::default())).await;
    let never_account = "5ExpiryNeverAcct";
    seed_account(state.pool().expect("pool"), never_account, &never_base).await;
    let never_state = make_state(pool, never_account);
    let expires = update_folder_share_expiry_inner(&never_state, never_account, "tok_never", ShareTtl::Never)
        .await
        .expect("never update");
    assert_eq!(expires, None, "a never-expiring share reports None");
}
