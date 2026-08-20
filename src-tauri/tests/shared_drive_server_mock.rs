//! Integration tests for the shared-drive HTTP layer and the member-drive
//! install path (`shared_drives::commands`), against a mock axum server —
//! the `migration_server_mock` seam: no live server, no Tauri AppHandle.
//!
//! Covers:
//! - Bearer auth + request/response shapes on the invite/membership endpoints.
//! - The feature-off discriminator: a bare 404 (unmounted route) maps to
//!   `NotReady(SharedDrivesUnavailable)`; a JSON-enveloped 404 stays a domain
//!   `NotFound`.
//! - The self-leave `?owner=` pass-through the server relies on to delete
//!   exactly one membership.
//! - The full member-add flow minus Tauri: memberships fetch → grant open →
//!   `install_member_drive` row + seal effects against a temp `$HOME` and a
//!   production-shaped SQLite pool (encrypted drive-password row, so the
//!   master-decrypt path is the one exercised).

use axum::{
    Json, Router,
    extract::{Path, RawQuery},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
};
use base64::Engine;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::error::{AppError, NotReadyKind};
use tauri_project_lib::shared_drives::commands::{http_create_invite, http_list_memberships, http_remove_member, install_member_drive};
use tauri_project_lib::shared_drives::grant;
use tauri_project_lib::sync::identity::{MemberDriveIdentity, resolve_drive_identity};

// ── Fixtures (published BIP-39 vectors — never real wallets) ───────────────

const MEMBER_MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OWNER_MASTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const MEMBER_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OWNER_SS58: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

const WIRE_HASH: &str = "0123456789abcdef";
const BEARER: &str = "test-bearer-token";

// ── Mock server ────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct Recorded {
    /// The raw query string of every DELETE members call, in arrival order
    /// (`None` when a call carried no query at all).
    remove_queries: Arc<Mutex<Vec<Option<String>>>>,
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
        Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "unauthorized", "message": "bad bearer"})),
            )
                .into_response(),
        )
    }
}

/// Feature-ON router: the shared-drive routes, mimicking hcfs-server's
/// response shapes (JSON error envelopes on domain errors).
fn feature_on_router(grant_blob_b64: String, recorded: Recorded) -> Router {
    let memberships_body = serde_json::json!({
        "memberships": [{
            "owner_ss58": OWNER_SS58,
            "folder_hash": WIRE_HASH,
            "role": "writer",
            "grant_blob": grant_blob_b64,
            "display_label": "team-docs",
            "created_at": "2026-08-20T00:00:00Z"
        }]
    });

    Router::new()
        .route(
            "/v1/drive-invites",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if let Some(resp) = bearer_rejection(&headers) {
                    return resp;
                }
                // The mint requires a registered drive; mirror the check on
                // the folder hash so a wrong-hash client bug fails the test.
                if body.get("folder_hash").and_then(|v| v.as_str()) != Some(WIRE_HASH) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(
                            serde_json::json!({"error": "folder_not_found", "message": "No registered drive with this folder_hash for your account"}),
                        ),
                    )
                        .into_response();
                }
                Json(serde_json::json!({"invite_token": "tok_mock_1"})).into_response()
            }),
        )
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
            "/v1/drives/{folder_hash}/members/{member_ss58}",
            delete(
                move |headers: HeaderMap, Path((_fh, member)): Path<(String, String)>, RawQuery(query): RawQuery| async move {
                    if let Some(resp) = bearer_rejection(&headers) {
                        return resp;
                    }
                    recorded.remove_queries.lock().unwrap().push(query);
                    if member == "5GoneMember" {
                        return (
                            StatusCode::NOT_FOUND,
                            Json(serde_json::json!({"error": "not_found", "message": "No such member on this drive"})),
                        )
                            .into_response();
                    }
                    Json(serde_json::json!({"status": "ok"})).into_response()
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

fn owner_folder_entropy() -> [u8; 32] {
    // The realistic payload: the OWNER's derived folder mnemonic's entropy.
    let phrase = hcfs_client::drive::keys::derive_folder_mnemonic(OWNER_MASTER, "team-docs").expect("owner folder mnemonic");
    let entropy = phrase.parse::<bip39::Mnemonic>().expect("parses").to_entropy();
    entropy.try_into().expect("32 bytes")
}

// ── HTTP-layer tests ───────────────────────────────────────────────────────

#[tokio::test]
async fn create_invite_sends_bearer_and_returns_the_token() {
    let blob = grant::seal_grant(MEMBER_MASTER, MEMBER_SS58, &owner_folder_entropy()).expect("seal");
    let base = serve(feature_on_router(
        base64::engine::general_purpose::STANDARD.encode(&blob),
        Recorded::default(),
    ))
    .await;
    let http = reqwest::Client::new();

    let token = http_create_invite(&http, &base, BEARER, WIRE_HASH, Some(3600), Some(5))
        .await
        .expect("mint");
    assert_eq!(token, "tok_mock_1");

    // A missing bearer is refused by the server and surfaces as Auth.
    let err = http_create_invite(&http, &base, "wrong-bearer", WIRE_HASH, None, None)
        .await
        .expect_err("bad bearer must fail");
    assert!(matches!(err, AppError::Auth(_)), "got {err:?}");
}

#[tokio::test]
async fn feature_off_server_maps_to_shared_drives_unavailable() {
    // No routes mounted — axum answers the bare 404 an HCFS_FEATURE_SHARED_
    // DRIVES=0 server produces for these paths.
    let base = serve(Router::new()).await;
    let http = reqwest::Client::new();

    let err = http_list_memberships(&http, &base, BEARER).await.expect_err("must fail");
    assert!(
        matches!(err, AppError::NotReady(NotReadyKind::SharedDrivesUnavailable)),
        "feature-off must be the typed refusal, got {err:?}"
    );
}

#[tokio::test]
async fn domain_404_stays_a_not_found() {
    let blob = grant::seal_grant(MEMBER_MASTER, MEMBER_SS58, &owner_folder_entropy()).expect("seal");
    let base = serve(feature_on_router(
        base64::engine::general_purpose::STANDARD.encode(&blob),
        Recorded::default(),
    ))
    .await;
    let http = reqwest::Client::new();

    let err = http_remove_member(&http, &base, BEARER, WIRE_HASH, "5GoneMember", None)
        .await
        .expect_err("gone member must 404");
    match err {
        AppError::NotFound(msg) => assert!(msg.contains("No such member"), "domain message survives: {msg}"),
        other => panic!("JSON-enveloped 404 must map to NotFound, got {other:?}"),
    }
}

#[tokio::test]
async fn self_leave_owner_param_reaches_the_server() {
    let blob = grant::seal_grant(MEMBER_MASTER, MEMBER_SS58, &owner_folder_entropy()).expect("seal");
    let recorded = Recorded::default();
    let base = serve(feature_on_router(
        base64::engine::general_purpose::STANDARD.encode(&blob),
        recorded.clone(),
    ))
    .await;
    let http = reqwest::Client::new();

    http_remove_member(&http, &base, BEARER, WIRE_HASH, MEMBER_SS58, Some(OWNER_SS58))
        .await
        .expect("self-leave");
    let query = recorded.remove_queries.lock().unwrap().last().cloned().expect("a delete landed");
    assert_eq!(
        query.as_deref(),
        Some(format!("owner={OWNER_SS58}").as_str()),
        "the self-leave must name exactly one owner — the bare fallback deletes every same-hash membership"
    );

    // Owner-removes-member path: no query at all.
    http_remove_member(&http, &base, BEARER, WIRE_HASH, "5SomeMember", None)
        .await
        .expect("owner remove");
    let query = recorded.remove_queries.lock().unwrap().last().cloned().expect("a delete landed");
    assert_eq!(query, None, "the owner path must not send an owner param");
}

// ── Member-drive install (row + seal effects) ──────────────────────────────

/// Production-shaped file pool (WAL, like `main.rs::build_pool`) with the
/// `sync_paths` + `hcfs_config` DDL mirrors.
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
            drive_password TEXT NOT NULL DEFAULT '',
            encryption_version INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .expect("hcfs_config schema");

    pool
}

/// The end-to-end member add minus Tauri: fetch memberships off the mock
/// server, open the grant, install the drive, and assert every persisted
/// effect — the row resolves to the OWNER identity and the config-dir seal
/// decrypts back to the owner's folder mnemonic under the member's drive
/// password. The drive-password row is stored ENCRYPTED (v1), so this
/// exercises the master-decrypt path a production account is on.
#[tokio::test]
async fn add_flow_installs_member_row_and_owner_seal() {
    // Isolated $HOME so config_dir writes land in the tempdir. This is the
    // only test in this binary that touches HOME, and none of the others
    // read it, so no cross-test lock is needed.
    let home = tempfile::TempDir::new().expect("home tempdir");
    unsafe {
        std::env::set_var("HOME", home.path());
    }

    let pool = make_pool(home.path()).await;

    // Encrypted drive-password row (encryption_version = 1), decryptable
    // only through the member's master — the production steady state after
    // crypto::store::migrate_if_needed.
    let key = tauri_project_lib::crypto::store::derive_key(MEMBER_MASTER, MEMBER_SS58, "hippius-drive-password-encryption").expect("key");
    let sealed_pw = tauri_project_lib::crypto::store::encrypt(&key, "drive-pw").expect("encrypt pw");
    sqlx::query("INSERT INTO hcfs_config (owner, drive_password, encryption_version) VALUES (?, ?, 1)")
        .bind(tauri_project_lib::auth::account_key::account_key(MEMBER_SS58))
        .bind(&sealed_pw)
        .execute(&pool)
        .await
        .expect("seed hcfs_config");

    // The grant, exactly as the server would return it.
    let entropy = owner_folder_entropy();
    let blob = grant::seal_grant(MEMBER_MASTER, MEMBER_SS58, &entropy).expect("seal grant");
    let base = serve(feature_on_router(
        base64::engine::general_purpose::STANDARD.encode(&blob),
        Recorded::default(),
    ))
    .await;
    let http = reqwest::Client::new();

    // 1. Fetch + locate the membership (the add_shared_drive lookup).
    let memberships = http_list_memberships(&http, &base, BEARER).await.expect("list memberships");
    let entry = memberships
        .memberships
        .into_iter()
        .find(|m| m.owner_ss58 == OWNER_SS58 && m.folder_hash == WIRE_HASH)
        .expect("membership present");
    let grant_bytes = base64::engine::general_purpose::STANDARD.decode(&entry.grant_blob).expect("blob decodes");

    // 2. Open the grant and rebuild the folder phrase.
    let opened = grant::open_grant(MEMBER_MASTER, MEMBER_SS58, &grant_bytes).expect("open grant");
    assert_eq!(*opened, entropy, "grant must round-trip the owner's folder entropy");
    let phrase = zeroize::Zeroizing::new(bip39::Mnemonic::from_entropy(opened.as_ref()).expect("entropy is a mnemonic").to_string());

    // 3. Install the drive (row + seal).
    let sync_root = home.path().join("Team Docs");
    std::fs::create_dir_all(&sync_root).expect("sync root");
    let member = MemberDriveIdentity {
        owner_ss58: OWNER_SS58.to_string(),
        wire_folder_hash: WIRE_HASH.to_string(),
    };
    let label = install_member_drive(
        &pool,
        MEMBER_SS58,
        &member,
        sync_root.to_str().expect("utf8 path"),
        &entry.display_label,
        &phrase,
        MEMBER_MASTER,
    )
    .await
    .expect("install member drive");
    assert_eq!(label, "team-docs", "label allocates from the display label");

    // 4. The row resolves to the OWNER's wire identity, never the local
    //    label derivation.
    let identity = resolve_drive_identity(&pool, MEMBER_SS58, &label).await.expect("resolve");
    assert!(identity.is_member);
    assert_eq!(identity.wire_ss58, OWNER_SS58);
    assert_eq!(identity.wire_folder_hash, WIRE_HASH);

    // 5. The seal exists in the drive's config dir and decrypts back to the
    //    OWNER's folder mnemonic under the member's drive password — the file
    //    initialize_sync_inner unlocks with.
    let enc_path = home
        .path()
        .join(".hippius")
        .join("drives")
        .join(tauri_project_lib::auth::account_key::account_key(MEMBER_SS58))
        .join(hcfs_client::drive::keys::folder_hash(&label))
        .join("enc_mnemonic.json");
    assert!(enc_path.is_file(), "enc_mnemonic.json must exist at {}", enc_path.display());

    let recovered = hcfs_client::auth::recover_mnemonic(&enc_path, "drive-pw").expect("seal decrypts under the drive password");
    assert_eq!(recovered.to_string(), *phrase, "the seal must hold the OWNER's folder mnemonic");
}

// ── Owner-gate refusal ─────────────────────────────────────────────────────

/// Every owner-side command (invite mint, member list/remove) resolves its
/// label through `resolve_own_drive`, which must refuse a member label as a
/// surfaced Validation — never let a member mint invites for someone else's
/// drive.
#[tokio::test]
async fn resolve_own_drive_refuses_member_labels() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let pool = make_pool(dir.path()).await;

    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, owner_ss58, wire_folder_hash) VALUES (?, '/p', 'private', 'team', 0, ?, ?)",
    )
    .bind(tauri_project_lib::auth::account_key::account_key(MEMBER_SS58))
    .bind(OWNER_SS58)
    .bind(WIRE_HASH)
    .execute(&pool)
    .await
    .expect("seed member row");
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/own', 'private', 'mine', 0)")
        .bind(tauri_project_lib::auth::account_key::account_key(MEMBER_SS58))
        .execute(&pool)
        .await
        .expect("seed own row");

    let err = tauri_project_lib::shared_drives::commands::resolve_own_drive(&pool, MEMBER_SS58, "team")
        .await
        .expect_err("member label must refuse");
    match err {
        AppError::Validation(msg) => assert!(msg.contains("only its owner"), "names the rule: {msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }

    let own = tauri_project_lib::shared_drives::commands::resolve_own_drive(&pool, MEMBER_SS58, "mine")
        .await
        .expect("own label passes");
    assert!(!own.is_member);
}
