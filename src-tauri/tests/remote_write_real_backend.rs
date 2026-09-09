//! Live lane: uploading into, and renaming inside, a folder this device
//! does NOT sync.
//!
//! `#[ignore]`d and skips quietly without its env, so a plain `cargo test`
//! stays hermetic — see `.claude/rules/testing.md`.
//!
//! ## Why this suite has to exist
//!
//! `remote_upload` assembles a `Manifest` from public `hcfs-client`
//! primitives and posts it to `/upload`; `remote_rename` builds a
//! `BatchRenameRequest` and posts it to `/rename_files`. Both are
//! *statements to a server about crypto*, and a subtly wrong one is
//! accepted locally by every hermetic test we can write: the unit tests
//! prove the path string is normalised, not that the server accepts the
//! signature, nor that the ciphertext decrypts back to the bytes that went
//! in. A wrong manifest uploads happily and fails months later, at
//! download, as an unreadable file.
//!
//! So the assertion that matters here is the ROUND TRIP: the file the
//! server hands back must be byte-identical to the one sent, through the
//! real encrypt → manifest → upload → list → download → decrypt chain.
//!
//! ## Running it
//!
//! ```bash
//! HCFS_DESKTOP_E2E_SERVER_URL=http://127.0.0.1:8000 \
//! HCFS_DESKTOP_E2E_BEARER=<user bearer> \
//! HCFS_DESKTOP_E2E_SS58=<that bearer's ss58> \
//!   cargo test --test remote_write_real_backend -- --ignored --nocapture
//! ```
//!
//! The bearer must be a USER bearer: the admin-bypass token maps to a
//! literal `"admin"` owner, so the upload would land under an account the
//! listing never looks at. Same requirement as
//! `folder_shares_real_backend`, and the opposite of
//! `folder_entries_real_backend`'s admin bearer — which is why the two
//! read different variables.

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

/// Published BIP-39 vector — never a real wallet. The server does not check
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
            "{REQUIRE_ENV}=1 but {SERVER_URL_ENV}/{BEARER_ENV}/{SS58_ENV} are not all set — the live lane must not skip"
        );
        tracing::warn!(
            "skipping remote_write_real_backend: set {SERVER_URL_ENV}, {BEARER_ENV} and {SS58_ENV} to run \
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
/// keychain is never touched — `folder_shares_real_backend::TEST_HOME`.
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

/// Unique per run so re-runs against a persistent server database never
/// collide with an earlier run's folder.
fn unique_label(suffix: &str) -> String {
    format!(
        "remote-write-{}-{suffix}",
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

/// Upload a file into a folder with no local root, read it back, and
/// rename it — the whole chain against a real server.
#[tokio::test]
#[ignore = "live lane: needs a real hcfs-server (see module docs)"]
async fn a_file_uploaded_to_an_unsynced_folder_round_trips_and_renames() {
    let Some(env) = live_env() else { return };
    ensure_master_seal(&env.ss58);

    let work = tempfile::TempDir::new().expect("work dir");
    let pool = live_pool(work.path()).await;
    seed_account(&pool, &env).await;

    let label = unique_label("roundtrip");
    seed_unsynced_drive(&pool, &env.ss58, &label).await;
    let state = make_state(pool.clone(), &env.ss58);

    // Content with a byte pattern that would survive a truncation but not
    // a wrong key, so a decrypt mismatch is unambiguous.
    let plaintext: Vec<u8> = (0..64_000u32).map(|i| (i % 251) as u8).collect();
    let source = work.path().join("original.bin");
    std::fs::write(&source, &plaintext).expect("write source");

    let identity = tauri_project_lib::sync::identity::resolve_drive_identity_or_own(&pool, &env.ss58, &label)
        .await
        .expect("resolve identity");

    tauri_project_lib::sync::remote_upload::upload_to_remote_folder(&state, &pool, &env.ss58, &label, "", &source, &identity)
        .await
        .expect("upload into a folder with no local root");

    // The server must now list it — proving the manifest's path identity
    // and folder hash landed where the listing looks.
    let listed = tauri_project_lib::sync::remote::list_remote_folder_files_inner(&state, &env.ss58, &label)
        .await
        .expect("list the remote folder");
    let entry = listed
        .iter()
        .find(|f| f.name == "original.bin")
        .expect("the uploaded file must appear in the folder listing");
    assert_eq!(
        entry.size_bytes as usize,
        plaintext.len(),
        "the server recorded a different size than was uploaded"
    );

    // The assertion that actually matters: what comes back decrypts to
    // what went in. A manifest that is wrong in a way the server accepts
    // still fails here.
    // The same `hcfs_client` call the app's download command makes, minus
    // the Tauri progress emit — so the oracle is production's decrypt, not
    // a reimplementation in the test.
    let downloaded = work.path().join("downloaded.bin");
    let client = tauri_project_lib::sync::remote::build_client_for_tests(&pool, &env.ss58, &identity)
        .await
        .expect("build client");
    let encryption_key = tauri_project_lib::sync::remote::encryption_key_for_tests(&pool, &env.ss58, &label, MASTER, &identity)
        .await
        .expect("derive encryption key");
    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: &identity.wire_ss58,
        folder_hash: &identity.wire_folder_hash,
        encryption_key: &encryption_key,
    };
    hcfs_client::drive::remote::download_remote_file(&access, &entry.file_id, &downloaded, None::<fn(u64, u64)>)
        .await
        .expect("download what was just uploaded");
    assert_eq!(
        std::fs::read(&downloaded).expect("read downloaded"),
        plaintext,
        "the round-tripped bytes differ from the original — the ciphertext or key is wrong"
    );

    // Rename, then confirm the listing moved rather than duplicated.
    tauri_project_lib::sync::remote_rename::rename_in_remote_folder(
        &state,
        &pool,
        tauri_project_lib::sync::remote_rename::RemoteRename {
            account_id: &env.ss58,
            label: &label,
            parent_path: "",
            old_name: "original.bin",
            new_name: "renamed.bin",
            identity: &identity,
        },
    )
    .await
    .expect("rename in a folder with no local root");

    let after = tauri_project_lib::sync::remote::list_remote_folder_files_inner(&state, &env.ss58, &label)
        .await
        .expect("list after rename");
    assert!(
        after.iter().any(|f| f.name == "renamed.bin"),
        "the renamed file is missing from the listing"
    );
    assert!(
        !after.iter().any(|f| f.name == "original.bin"),
        "the old name is still listed — the rename copied instead of moving"
    );
}
