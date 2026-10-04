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
//! - The uploaded-copy (outside-folder) share: open → files → chunks → seal,
//!   ciphertext under the fragment key, an owner wrap sealed exactly like a
//!   drive folder link's, a Finder Cancel mid-upload aborting the
//!   half-built link through the real Finder mint path, the quota gate
//!   before any upload, and the capability refusal before any work.

use axum::{
    Json, Router,
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use hcfs_client::client::folder_share::{ShareTtl, folder_share_token_hash};
use hcfs_client::client::share::{ShareKeystore, SharePhase, ShareProgress, ShareSecret};
use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::error::{AppError, NotReadyKind};
use tauri_project_lib::finder_bridge::dispatch::{FinderMint, mint_confirmed};
use tauri_project_lib::shares::SqliteShareKeystore;
use tauri_project_lib::shares::commands::{
    ShareChoice, create_folder_share_inner, list_folder_shares_inner, revoke_folder_share_inner, update_folder_share_expiry_inner,
};
use tauri_project_lib::shares::outside_folder::{OutsideFolderShare, SHARE_CANCELLED, UPLOAD_FOLDER_SHARES_UNAVAILABLE, share_outside_folder};

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
    /// Body of `GET /v1/drive-memberships`: the member-mint role gate.
    memberships: serde_json::Value,
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
            memberships: json!({ "memberships": [] }),
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
    let memberships_body = opts.memberships.clone();

    Router::new()
        .route(
            "/v1/drive-memberships",
            get(move |headers: HeaderMap| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                Json(memberships_body).into_response()
            }),
        )
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
        .expect_err("a member mint must refuse on a server without member_folder_shares");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("newer server"), "the missing capability must be named: {msg}"),
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

// ── Mint inside somebody else's drive (hcfs #458) ─────────────────────────

/// The owner's folder phrase for the seeded member drive: a published BIP-39
/// vector standing in for the owner-derived folder mnemonic.
const MEMBER_FOLDER_PHRASE: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

fn member_caps() -> serde_json::Value {
    json!({ "shares": true, "folder_shares": true, "member_folder_shares": true })
}

fn membership(role: &str, frozen: bool) -> serde_json::Value {
    json!({ "memberships": [{
        "owner_ss58": OWNER_SS58, "folder_hash": WIRE_HASH, "role": role,
        "grant_blob": "", "display_label": "joined-drive",
        "created_at": "2026-08-20T00:00:00Z", "frozen": frozen
    }]})
}

/// Write the owner-sealed folder key where a synced member drive keeps it.
fn write_member_seal(account: &str, label: &str) {
    let path = TEST_HOME
        .join(".hippius")
        .join("drives")
        .join(account_key(account))
        // Keyed by the LOCAL label's hash, like every config dir.
        .join(hcfs_client::drive::keys::folder_hash(label))
        .join("enc_mnemonic.json");
    std::fs::create_dir_all(path.parent().unwrap()).expect("config dir");
    hcfs_client::auth::save_encrypted_mnemonic(&path, MEMBER_FOLDER_PHRASE, DRIVE_PW).expect("write member seal");
}

/// A Viewer is refused locally with words, and no mint reaches the server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_viewer_cannot_share_a_folder_in_someone_elses_drive() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5ViewerMintAcct";
    let label = "joined-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            capabilities: member_caps(),
            memberships: membership("reader", false),
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;
    seed_account(&pool, account, &base).await;
    seed_member_drive(&pool, account, label).await;
    let state = make_state(pool.clone(), account);

    let err = create_folder_share_inner(&state, account, label, "docs", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect_err("a Viewer must be refused");
    assert!(
        matches!(err, AppError::Validation(ref m) if m.contains("Editors and Managers")),
        "{err:?}"
    );
    assert!(recorded.create_bodies.lock().unwrap().is_empty());
}

/// A frozen drive is refused even for an Editor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frozen_drive_cannot_be_shared_from() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5FrozenMintAcct";
    let label = "joined-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            capabilities: member_caps(),
            memberships: membership("writer", true),
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;
    seed_account(&pool, account, &base).await;
    seed_member_drive(&pool, account, label).await;
    let state = make_state(pool.clone(), account);

    let err = create_folder_share_inner(&state, account, label, "docs", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect_err("frozen");
    assert!(matches!(err, AppError::Validation(ref m) if m.contains("frozen")), "{err:?}");
    assert!(recorded.create_bodies.lock().unwrap().is_empty());
}

/// An Editor's mint names the owner, carries the DRIVE's derived file key
/// (from the owner's seal, never this account's master) and is kept in the
/// keystore like any other folder share.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_editor_shares_a_folder_naming_the_owner() {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let account = "5EditorMintAcct";
    let label = "joined-drive";

    let recorded = Recorded::default();
    let base = serve(share_router(
        MockOptions {
            capabilities: member_caps(),
            memberships: membership("writer", false),
            create: CreateReply::Created {
                share_token: "tok_member",
                expires_at: None,
            },
            ..MockOptions::default()
        },
        recorded.clone(),
    ))
    .await;
    seed_account(&pool, account, &base).await;
    seed_member_drive(&pool, account, label).await;
    write_member_seal(account, label);
    let state = make_state(pool.clone(), account);

    let link = create_folder_share_inner(&state, account, label, "docs/2026", ShareTtl::Days30, ShareChoice::Public)
        .await
        .expect("an Editor may share");

    let body = recorded.create_bodies.lock().unwrap().last().cloned().expect("a mint landed");
    assert_eq!(
        body,
        json!({
            "folder_hash": WIRE_HASH,
            "path_prefix": "docs/2026",
            "display_name": "2026",
            "ttl": "30d",
            "owner_ss58": OWNER_SS58,
        }),
    );

    let phrase: bip39::Mnemonic = MEMBER_FOLDER_PHRASE.parse().expect("phrase");
    let seed = phrase.to_seed("");
    let expected = URL_SAFE_NO_PAD.encode(&seed[..32]);
    assert!(
        link.share_url.ends_with(&format!("/share/folder/tok_member#k={expected}")),
        "{}",
        link.share_url
    );
    assert_ne!(
        URL_SAFE_NO_PAD.encode(expected_file_key(label)),
        expected,
        "never a key derived from this account's own master"
    );

    let keystore = SqliteShareKeystore::new(pool);
    assert!(matches!(keystore.get("tok_member").expect("get"), Some(ShareSecret::Public(_))));
}

// ── Uploaded-copy (outside-folder) shares ──────────────────────────────────

const CAPS_UPLOADS_ON: &str = r#"{"shares":true,"folder_shares":true,"upload_folder_shares":true}"#;

/// The token the mock server mints on open. The server, not the client,
/// mints an uploaded copy's token, so the mock has to hand one out.
const UPLOAD_TOKEN: &str = "UploadCopyToken_0123456789abcdefghijklmnopq";

/// What the upload routes saw, in arrival order.
#[derive(Clone, Default)]
struct UploadRecorded {
    opens: Arc<Mutex<Vec<serde_json::Value>>>,
    files: Arc<Mutex<Vec<serde_json::Value>>>,
    chunks: Arc<Mutex<Vec<ChunkPut>>>,
    file_completes: Arc<Mutex<Vec<i64>>>,
    seals: Arc<Mutex<u32>>,
    aborts: Arc<Mutex<Vec<String>>>,
    /// `size_bytes` of every `/can_upload` pre-flight.
    can_upload_sizes: Arc<Mutex<Vec<u64>>>,
    /// Every `{token_hash, wrap}` entry PUT to the folder owner-wrap route.
    folder_wraps: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// One chunk PUT as the server received it.
#[derive(Clone)]
struct ChunkPut {
    file_id: i64,
    index: u32,
    body: Vec<u8>,
}

/// Something the user does while the first chunk is in flight.
#[derive(Clone)]
enum OnFirstChunk {
    Nothing,
    /// The modal's Cancel.
    Cancel(CancellationToken),
}

#[derive(Clone)]
struct UploadMock {
    /// Body of `POST /can_upload` (hcfs-server's quota pre-flight).
    can_upload: serde_json::Value,
    seal_expires_at: Option<&'static str>,
    on_first_chunk: OnFirstChunk,
}

impl Default for UploadMock {
    fn default() -> Self {
        Self {
            can_upload: json!({ "result": true, "error": null }),
            seal_expires_at: Some("2026-10-09T00:00:00+00:00"),
            on_first_chunk: OnFirstChunk::Nothing,
        }
    }
}

/// Open, seal, abort, keepalive and the quota pre-flight.
fn upload_lifecycle_routes(mock: &UploadMock, rec: &UploadRecorded) -> Router {
    let (opens, seals, aborts, sizes) = (rec.opens.clone(), rec.seals.clone(), rec.aborts.clone(), rec.can_upload_sizes.clone());
    let (verdict, expires) = (mock.can_upload.clone(), mock.seal_expires_at);
    Router::new()
        .route(
            "/can_upload",
            post(move |Json(body): Json<serde_json::Value>| async move {
                sizes.lock().unwrap().push(body["size_bytes"].as_u64().expect("size_bytes"));
                Json(verdict).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                opens.lock().unwrap().push(body);
                let minted = json!({ "share_token": UPLOAD_TOKEN, "token_hash": folder_share_token_hash(UPLOAD_TOKEN) });
                (StatusCode::CREATED, Json(minted)).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/complete",
            post(move |Path(_): Path<String>| async move {
                *seals.lock().unwrap() += 1;
                Json(json!({ "expires_at": expires })).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/keepalive",
            post(|Path(_): Path<String>| async { StatusCode::NO_CONTENT.into_response() }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}",
            delete(move |Path(token_hash): Path<String>| async move {
                aborts.lock().unwrap().push(token_hash);
                StatusCode::NO_CONTENT.into_response()
            }),
        )
}

/// Per-file init, chunk and complete, plus the folder owner-wrap PUT.
fn upload_file_routes(mock: &UploadMock, rec: &UploadRecorded) -> Router {
    let (files, chunks, completes, wraps) = (
        rec.files.clone(),
        rec.chunks.clone(),
        rec.file_completes.clone(),
        rec.folder_wraps.clone(),
    );
    let next_id = Arc::new(AtomicI64::new(1));
    let fired = Arc::new(AtomicBool::new(false));
    let hook = mock.on_first_chunk.clone();
    Router::new()
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files",
            post(move |Path(_): Path<String>, Json(body): Json<serde_json::Value>| async move {
                files.lock().unwrap().push(body);
                Json(json!({ "file_id": next_id.fetch_add(1, Ordering::SeqCst) })).into_response()
            }),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/chunks/{n}",
            put(
                move |Path((_, file_id, n)): Path<(String, i64, u32)>, body: axum::body::Bytes| async move {
                    chunks.lock().unwrap().push(ChunkPut {
                        file_id,
                        index: n,
                        body: body.to_vec(),
                    });
                    if !fired.swap(true, Ordering::SeqCst) {
                        match &hook {
                            OnFirstChunk::Nothing => {}
                            OnFirstChunk::Cancel(token) => token.cancel(),
                        }
                    }
                    StatusCode::NO_CONTENT.into_response()
                },
            )
            // A transport chunk is bigger than axum's 2 MiB default limit.
            .layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route(
            "/v1/folder-shares/uploads/{token_hash}/files/{file_id}/complete",
            post(move |Path((_, file_id)): Path<(String, i64)>| async move {
                completes.lock().unwrap().push(file_id);
                StatusCode::NO_CONTENT.into_response()
            }),
        )
        .route(
            "/v1/folder-shares/owner-wraps",
            put(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                let entries = body["wraps"].as_array().cloned().expect("wraps array");
                wraps.lock().unwrap().extend(entries);
                StatusCode::NO_CONTENT.into_response()
            }),
        )
}

/// A served mock plus a state for `account`, with no drive rows: an outside
/// folder needs none. The legacy `share_router` routes ride along, so the
/// same server also mints drive folder links.
async fn upload_harness(account: &str, caps: &str, mock: UploadMock) -> (AppState, UploadRecorded, Recorded, tempfile::TempDir) {
    let _home = &*TEST_HOME;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;
    let (recorded, uploads) = (Recorded::default(), UploadRecorded::default());
    let options = MockOptions {
        capabilities: serde_json::from_str(caps).expect("caps json"),
        ..MockOptions::default()
    };
    let router = share_router(options, recorded.clone())
        .merge(upload_lifecycle_routes(&mock, &uploads))
        .merge(upload_file_routes(&mock, &uploads));
    let base = serve(router).await;
    seed_account(&pool, account, &base).await;
    (make_state(pool, account), uploads, recorded, dir)
}

/// `T2-KD/` as Finder would hand it over: two real files (one large enough
/// to span several transport chunks), an empty subfolder, and the things
/// the walk must skip.
fn outside_folder() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let root = dir.path().join("T2-KD");
    std::fs::create_dir_all(root.join("sub")).expect("sub");
    std::fs::create_dir_all(root.join("empty")).expect("empty");
    std::fs::write(root.join("a.txt"), b"hello").expect("a");
    std::fs::write(root.join("sub/b.bin"), big_file()).expect("b");
    std::fs::write(root.join(".DS_Store"), b"skip").expect("hidden");
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("a.txt"), root.join("alias.txt")).expect("link");
    (dir, root)
}

fn big_file() -> Vec<u8> {
    (0..9 * 1024 * 1024).map(|i: u32| (i % 251) as u8).collect()
}

fn share_request(folder: &std::path::Path, cancel: CancellationToken) -> OutsideFolderShare<'_> {
    OutsideFolderShare {
        folder,
        ttl: ShareTtl::Days7,
        choice: ShareChoice::Public,
        progress: None,
        cancel,
    }
}

/// One uploaded file's ciphertext, reassembled from its chunk PUTs in index
/// order.
fn uploaded_ciphertext(rec: &UploadRecorded, file_id: i64) -> Vec<u8> {
    let mut parts: Vec<(u32, Vec<u8>)> = rec
        .chunks
        .lock()
        .unwrap()
        .iter()
        .filter(|chunk| chunk.file_id == file_id)
        .map(|chunk| (chunk.index, chunk.body.clone()))
        .collect();
    parts.sort_by_key(|(n, _)| *n);
    parts.into_iter().flat_map(|(_, body)| body).collect()
}

/// The whole upload through the real funnel: one open declaring exactly the
/// visible tree (empty folder kept, hidden file and symlink not), every file
/// initialised, chunked and completed, one seal, and a `#k=` link whose key
/// opens the uploaded ciphertext. The keystore holds that key, so the
/// shares page can rebuild the link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_folder_share_uploads_every_file_then_seals() {
    let account = "5UploadOkAcct";
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, UploadMock::default()).await;
    let (_tree, root) = outside_folder();
    let seen: Arc<Mutex<Vec<ShareProgress>>> = Arc::default();
    let sink = seen.clone();
    let mut request = share_request(&root, CancellationToken::new());
    request.progress = Some(Arc::new(move |p: ShareProgress| sink.lock().unwrap().push(p)));

    let link = share_outside_folder(&state, account, request).await.expect("share");

    assert_eq!(link.share_token, UPLOAD_TOKEN);
    let open = rec.opens.lock().unwrap().first().cloned().expect("one open");
    assert_eq!(open["display_name"], "T2-KD");
    assert_eq!(open["file_count"], 2);
    assert_eq!(open["total_bytes"], 5 + 9 * 1024 * 1024);
    assert_eq!(open["dirs"], json!(["empty"]));
    assert_eq!(open["ttl"], "7d");
    assert_eq!(
        *rec.can_upload_sizes.lock().unwrap(),
        vec![5 + 9 * 1024 * 1024],
        "gated on the copy's bytes"
    );

    let files = rec.files.lock().unwrap().clone();
    let mut declared: Vec<&str> = files.iter().map(|f| f["relative_path"].as_str().unwrap()).collect();
    declared.sort_unstable();
    assert_eq!(declared, vec!["a.txt", "sub/b.bin"], "hidden file and symlink are not uploaded");
    assert_eq!(rec.file_completes.lock().unwrap().len(), 2);
    assert_eq!(*rec.seals.lock().unwrap(), 1);
    assert!(rec.aborts.lock().unwrap().is_empty());

    // The fragment key opens the ciphertext the server was handed, chunk
    // by chunk, and each file declared exactly the chunks it sent.
    let (_, key) = link.share_url.split_once("#k=").expect("#k= link");
    let key: [u8; 32] = URL_SAFE_NO_PAD.decode(key).expect("b64").try_into().expect("32 bytes");
    let ids: Vec<i64> = rec.file_completes.lock().unwrap().clone();
    for (file, id) in files.iter().zip(ids.iter().copied().collect::<std::collections::BTreeSet<_>>()) {
        let sent = rec.chunks.lock().unwrap().iter().filter(|chunk| chunk.file_id == id).count() as u64;
        assert_eq!(sent, file["total_chunks"].as_u64().unwrap(), "{file}");
        let ciphertext = uploaded_ciphertext(&rec, id);
        let mut plaintext = Vec::new();
        hcfs_client::crypto::decrypt_stream(&mut std::io::Cursor::new(&ciphertext), &mut plaintext, &key, None, None::<fn(u64, u64)>)
            .expect("drive framing under the link key");
        let expected = if file["relative_path"] == "a.txt" {
            b"hello".to_vec()
        } else {
            big_file()
        };
        assert_eq!(plaintext, expected, "{file}");
    }

    assert_eq!(
        link.expires_at.as_deref(),
        Some("2026-10-09T00:00:00+00:00"),
        "expiry comes from the seal"
    );
    let keystore = SqliteShareKeystore::new(state.pool().unwrap().clone());
    assert_eq!(keystore.get(&link.share_token).unwrap(), Some(ShareSecret::Public(key)));

    let seen = seen.lock().unwrap();
    assert!(matches!(seen.last().map(|p| p.phase), Some(SharePhase::Finalizing)), "ends finalizing");
    assert!(
        seen.iter()
            .any(|p| p.phase == SharePhase::Uploading && p.bytes_done == p.bytes_total && p.bytes_total > 0),
        "uploading reaches its total, summed across files"
    );
}

/// Open a folder owner wrap the way the console does: with the account
/// mnemonic and the session (login) address, bound to the row's
/// `token_hash`. Uses hcfs-client's own opener, not the desktop sealer, so a
/// drift between the two fails here.
fn open_folder_wrap(entry: &serde_json::Value, owner_ss58: &str) -> Option<(String, ShareSecret)> {
    use base64::engine::general_purpose::STANDARD;
    use hcfs_client::client::share_wrap::{OwnerWrapContext, open_folder_owner_secret};

    let token_hash = entry["token_hash"].as_str().expect("token_hash");
    let wrap = STANDARD.decode(entry["wrap"].as_str().expect("wrap")).expect("b64 wrap");
    let ctx = OwnerWrapContext {
        master_mnemonic: MASTER,
        owner_ss58,
        row_key: token_hash,
    };
    open_folder_owner_secret(ctx, &wrap).ok()
}

/// An uploaded copy's owner wrap is sealed with exactly the inputs a drive
/// folder link's wrap is: the same mnemonic, the same owner address, the
/// row's `token_hash`. Both are minted on one account against one server;
/// both wraps open under one context, each carries its own link's token
/// (which hashes to the row it was PUT under) and the keystore's secret.
/// Without this wrap the console's Copy works on this device only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uploaded_copy_is_wrapped_exactly_like_a_drive_folder_link() {
    let account = "5UploadWrapAcct";
    let label = "photo-drive";
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, UploadMock::default()).await;
    seed_own_drive(state.pool().unwrap(), account, label).await;
    write_master_seal(account);
    let (_tree, root) = outside_folder();

    let drive_link = create_folder_share_inner(&state, account, label, "photos", ShareTtl::Days7, ShareChoice::Public)
        .await
        .expect("drive folder link");
    let copy_link = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect("uploaded copy");

    let wraps = rec.folder_wraps.lock().unwrap().clone();
    assert_eq!(wraps.len(), 2, "one wrap per link: {wraps:?}");
    let keystore = SqliteShareKeystore::new(state.pool().unwrap().clone());
    for link in [&drive_link, &copy_link] {
        let row_hash = folder_share_token_hash(&link.share_token);
        let entry = wraps
            .iter()
            .find(|w| w["token_hash"] == row_hash.as_str())
            .expect("a wrap under the row's token_hash");
        let (token, secret) = open_folder_wrap(entry, account).expect("opens with the account's mnemonic and address");
        assert_eq!(token, link.share_token);
        assert_eq!(folder_share_token_hash(&token), row_hash, "the wrapped token names its own row");
        assert_eq!(Some(secret), keystore.get(&link.share_token).unwrap());
        assert!(open_folder_wrap(entry, OWNER_SS58).is_none(), "bound to the owner address");
    }
}

/// The modal's Cancel during a Finder share of an outside folder, through
/// the real Finder mint path: the token reaches the upload, so the client
/// sends the abort for the half-built link before reporting the cancel. A
/// mint raced against the token instead would be dropped mid-request and
/// send no abort, leaving the link to the server's idle reaper.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finder_cancel_mid_upload_aborts_the_half_built_link() {
    let account = "5UploadCancelAcct";
    let cancel = CancellationToken::new();
    let mock = UploadMock {
        on_first_chunk: OnFirstChunk::Cancel(cancel.clone()),
        ..UploadMock::default()
    };
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, mock).await;
    let (_tree, root) = outside_folder();
    let mint = FinderMint {
        ttl: ShareTtl::Days7,
        choice: ShareChoice::Public,
        progress: None,
        cancel,
    };

    let err = mint_confirmed(&state, &root, mint).await.expect_err("cancelled");

    assert!(matches!(&err, AppError::Validation(m) if m == SHARE_CANCELLED), "{err:?}");
    assert_eq!(rec.opens.lock().unwrap().len(), 1, "the link was opened before the cancel");
    assert_eq!(
        *rec.aborts.lock().unwrap(),
        vec![folder_share_token_hash(UPLOAD_TOKEN)],
        "the open link is aborted on the server"
    );
    assert_eq!(*rec.seals.lock().unwrap(), 0, "a cancelled link is never sealed");
}

/// Over the plan: refused at the pre-flight with the copy's REAL size, and
/// nothing is opened, so no half-built link and no billing hold. The modal
/// opens the plans dialog on this kind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quota_refusal_stops_the_share_before_any_upload() {
    let account = "5UploadQuotaAcct";
    let mock = UploadMock {
        can_upload: json!({ "result": false, "error": "drive_quota_exceeded" }),
        ..UploadMock::default()
    };
    let (state, rec, _, _db) = upload_harness(account, CAPS_UPLOADS_ON, mock).await;
    let (_tree, root) = outside_folder();

    let err = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect_err("over quota");

    assert!(matches!(err, AppError::NotReady(NotReadyKind::StorageLimitReached)), "{err:?}");
    assert_eq!(
        *rec.can_upload_sizes.lock().unwrap(),
        vec![5 + 9 * 1024 * 1024],
        "gated on the copy's bytes"
    );
    assert!(rec.opens.lock().unwrap().is_empty(), "nothing opened");
    assert!(rec.files.lock().unwrap().is_empty(), "no file declared");
    assert!(rec.chunks.lock().unwrap().is_empty(), "no chunk sent");
}

/// A server that predates uploaded copies: refused with the "isn't
/// available yet" wording before the quota is asked or anything opened.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_without_uploaded_copies_refuses_before_any_work() {
    let account = "5UploadCapsAcct";
    let caps = r#"{"shares":true,"folder_shares":true}"#;
    let (state, rec, recorded, _db) = upload_harness(account, caps, UploadMock::default()).await;
    let (_tree, root) = outside_folder();

    let err = share_outside_folder(&state, account, share_request(&root, CancellationToken::new()))
        .await
        .expect_err("capability missing");

    assert!(
        matches!(&err, AppError::Validation(m) if m == UPLOAD_FOLDER_SHARES_UNAVAILABLE),
        "{err:?}"
    );
    assert_eq!(*recorded.capability_hits.lock().unwrap(), 1);
    assert!(rec.can_upload_sizes.lock().unwrap().is_empty(), "no quota pre-flight");
    assert!(rec.opens.lock().unwrap().is_empty(), "no open");
}
