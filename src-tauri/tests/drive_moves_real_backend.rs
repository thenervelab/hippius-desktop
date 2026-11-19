//! Live lane: a move between two drives, against a real hcfs-server with
//! `HCFS_FEATURE_DRIVE_MOVES=1`.
//!
//! `#[ignore]`d and skips quietly without its env, so a plain `cargo test`
//! stays hermetic; see `.claude/rules/testing.md`.
//!
//! The hermetic suites (`drive_move_server_mock.rs`, the module's unit
//! tests) prove the request shapes against the documented contract and
//! that a copy's ciphertext decrypts with the destination key. Only a real
//! server proves the manifest of a copy session is accepted, the commit
//! moves a folder whole, and the moved file reads back byte for byte from
//! its new drive under that drive's key.
//!
//! A server that does not advertise `drive_moves` is skipped with a warning,
//! since that is the server's state rather than a failure of this code.
//!
//! ## Running it
//!
//! ```bash
//! HCFS_DESKTOP_E2E_SERVER_URL=http://127.0.0.1:8000 \
//! HCFS_DESKTOP_E2E_BEARER=<user bearer> \
//! HCFS_DESKTOP_E2E_SS58=<that bearer's ss58> \
//!   cargo test --test drive_moves_real_backend -- --ignored --nocapture
//! ```
//!
//! USER bearer, for the reason `remote_write_real_backend` gives.

use std::path::PathBuf;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::utils::schema::ensure_table_schema;

const SERVER_URL_ENV: &str = "HCFS_DESKTOP_E2E_SERVER_URL";
const BEARER_ENV: &str = "HCFS_DESKTOP_E2E_BEARER";
const SS58_ENV: &str = "HCFS_DESKTOP_E2E_SS58";
/// `=1` turns the quiet env-skip into a panic, so a live CI lane cannot go
/// green by silently not running these tests.
const REQUIRE_ENV: &str = "HCFS_DESKTOP_E2E_REQUIRE";

/// Published BIP-39 vector, never a real wallet. The server does not check
/// that a master derives its account's ss58 (identity is the bearer's).
const MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DRIVE_PW: &str = "drive-pw";

struct LiveEnv {
    server_url: String,
    bearer: String,
    ss58: String,
}

fn live_env() -> Option<LiveEnv> {
    let nonempty = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let vars = (nonempty(SERVER_URL_ENV), nonempty(BEARER_ENV), nonempty(SS58_ENV));
    let (Some(server_url), Some(bearer), Some(ss58)) = vars else {
        assert!(
            nonempty(REQUIRE_ENV).as_deref() != Some("1"),
            "{REQUIRE_ENV}=1 but {SERVER_URL_ENV}/{BEARER_ENV}/{SS58_ENV} are not all set: the live lane must not skip"
        );
        tracing::warn!(
            "skipping drive_moves_real_backend: set {SERVER_URL_ENV}, {BEARER_ENV} and {SS58_ENV} to run \
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

/// Redirect `$HOME` so the master seal lands in a temp tree and the
/// keychain is never touched, as in `folder_shares_real_backend::TEST_HOME`.
static TEST_HOME: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
    let dir = tempfile::TempDir::new().expect("home tempdir");
    let path = dir.path().to_path_buf();
    std::mem::forget(dir);
    // SAFETY: not fully discharged, and accepted because this is test-only.
    // `set_var` requires that no other thread reads or writes the
    // environment during the call. What holds: LazyLock runs this once, every
    // test that reads what is set here forces TEST_HOME first, and std
    // serializes its own env access, so no Rust code sees a torn value. What
    // is not ruled out: a parallel test's C code (SQLite, the system
    // resolver) calling `getenv` during this write.
    unsafe {
        std::env::set_var("HOME", &path);
        std::env::set_var("HIPPIUS_DISABLE_TOKEN_KEYCHAIN", "1");
    }
    path
});

/// Unique per run so re-runs against a persistent server database never
/// collide with an earlier run's folder.
fn unique_label(suffix: &str) -> String {
    format!(
        "drive-moves-{}-{suffix}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis()
    )
}

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

/// A drive row with a path that does not exist on disk.
///
/// This is the whole point: the row gives `resolve_drive_identity` a label
/// to work from, but there is NO local directory, so nothing here can
/// accidentally go through the sync engine's local path. If the upload
/// works, it worked without one.
async fn seed_unsynced_drive(pool: &sqlx::SqlitePool, ss58: &str, label: &str) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/nonexistent-remote-only', 'private', ?, 0)")
        .bind(account_key(ss58))
        .bind(label)
        .execute(pool)
        .await
        .expect("seed unsynced drive row");
}

fn make_state(pool: sqlx::SqlitePool, ss58: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state.set_active_account(ss58, AuthCapabilities::default()).expect("set active account");
    let mut auth = state.auth.lock().expect("auth lock");
    auth.mnemonic = Some(zeroize::Zeroizing::new(MASTER.to_string()));
    drop(auth);
    state
}

async fn server_moves_between_drives(server_url: &str) -> bool {
    let caps: serde_json::Value = match reqwest::get(format!("{server_url}/v1/capabilities")).await {
        Ok(resp) => resp.json().await.unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };
    caps.get("drive_moves").and_then(serde_json::Value::as_bool) == Some(true)
}

/// Two own drives, neither synced here: a folder and a file move from one
/// to the other, and what arrives decrypts under the destination's key to
/// the bytes that left.
#[tokio::test]
#[ignore = "live lane: needs a real hcfs-server with drive moves on (see module docs)"]
async fn a_folder_and_a_file_move_to_another_drive_and_read_back() {
    let Some(env) = live_env() else { return };
    if !server_moves_between_drives(&env.server_url).await {
        tracing::warn!("skipping drive_moves_real_backend: the server does not advertise drive_moves");
        return;
    }
    ensure_master_seal(&env.ss58);

    let work = tempfile::TempDir::new().expect("work dir");
    let pool = live_pool(work.path()).await;
    seed_account(&pool, &env).await;
    let (from, to) = (unique_label("from"), unique_label("to"));
    seed_unsynced_drive(&pool, &env.ss58, &from).await;
    seed_unsynced_drive(&pool, &env.ss58, &to).await;
    let state = make_state(pool.clone(), &env.ss58);

    let resolve = |label: String| {
        let pool = pool.clone();
        let ss58 = env.ss58.clone();
        async move {
            tauri_project_lib::sync::identity::resolve_drive_identity_or_own(&pool, &ss58, &label)
                .await
                .expect("resolve identity")
        }
    };
    let (from_id, to_id) = (resolve(from.clone()).await, resolve(to.clone()).await);
    for (label, identity) in [(&from, &from_id), (&to, &to_id)] {
        let client = tauri_project_lib::sync::remote::build_client_for_tests(&pool, &env.ss58, identity)
            .await
            .expect("client");
        client
            .register_folder(&env.ss58, &identity.wire_folder_hash, label, None)
            .await
            .expect("register the drive");
    }

    let photo: Vec<u8> = (0..70_000u32).map(|i| (i % 241) as u8).collect();
    let note = b"moved between drives".to_vec();
    let photo_path = work.path().join("a.bin");
    let note_path = work.path().join("note.txt");
    std::fs::write(&photo_path, &photo).unwrap();
    std::fs::write(&note_path, &note).unwrap();
    for (parent, source) in [("Trip", &photo_path), ("", &note_path)] {
        tauri_project_lib::sync::remote_upload::upload_to_remote_folder(&state, &pool, &env.ss58, &from, parent, source, &from_id)
            .await
            .expect("upload into the source drive");
    }

    let request: tauri_project_lib::sync::drive_move::DriveMoveRequest = serde_json::from_value(serde_json::json!({
        "jobId": "live",
        "sourceLabel": from,
        "destLabel": to,
        "destination": "",
        "items": [
            { "path": "Trip", "isFolder": true },
            { "path": "note.txt", "isFolder": false }
        ],
        "confirmSharing": true
    }))
    .expect("request");
    let outcome = tauri_project_lib::sync::drive_move::move_between_drives_for_tests(&state, &env.ss58, &request)
        .await
        .expect("the move commits");
    let moved = serde_json::to_value(&outcome.results).unwrap();
    assert!(
        moved.as_array().unwrap().iter().all(|r| r["status"] == "moved"),
        "every item moved: {moved}"
    );

    let listed_to = tauri_project_lib::sync::remote::list_remote_folder_files_inner(&state, &env.ss58, &to)
        .await
        .expect("list destination");
    let listed_from = tauri_project_lib::sync::remote::list_remote_folder_files_inner(&state, &env.ss58, &from)
        .await
        .expect("list source");
    let paths = |list: &[hcfs_client::drive::remote::RemoteFileInfo]| list.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
    assert!(listed_from.is_empty(), "the source drive no longer holds them: {:?}", paths(&listed_from));
    let entry = listed_to
        .iter()
        .find(|f| f.path == "Trip/a.bin")
        .unwrap_or_else(|| panic!("moved whole: {:?}", paths(&listed_to)));
    assert!(listed_to.iter().any(|f| f.path == "note.txt"));

    let client = tauri_project_lib::sync::remote::build_client_for_tests(&pool, &env.ss58, &to_id)
        .await
        .expect("client");
    let key = tauri_project_lib::sync::remote::encryption_key_for_tests(&pool, &env.ss58, &to, MASTER, &to_id)
        .await
        .expect("destination key");
    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: &to_id.wire_ss58,
        folder_hash: &to_id.wire_folder_hash,
        encryption_key: &key,
    };
    let downloaded = work.path().join("back.bin");
    hcfs_client::drive::remote::download_remote_file(&access, &entry.file_id, &downloaded, None::<fn(u64, u64)>)
        .await
        .expect("download the moved file from its new drive");
    assert_eq!(std::fs::read(&downloaded).unwrap(), photo, "the moved file reads back byte for byte");
}
