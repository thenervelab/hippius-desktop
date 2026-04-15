//! Backwards-compatible migration of drive password ↔ recovery password.
//!
//! # Context
//!
//! Before PR #307 shipped always-on recovery, users had a `drive_password`
//! in `hcfs_config` (encrypts folder mnemonics) set during sync setup, and
//! nothing else. PR #307 added a **separate** recovery password that seals
//! a blob on hcfs-server and encrypts `master_enc_mnemonic.json`. Depending
//! on what the user typed in each prompt, the two passwords may or may not
//! be the same string.
//!
//! # Goal
//!
//! Unify them: **the drive password is the canonical password**, and on
//! first launch after this code ships we automatically bring the server
//! blob + master file into line with it. Users never re-enter anything.
//!
//! # Design
//!
//! The decision is a pure state machine (see [`decide_migration`] and the
//! truth table below). I/O — DB reads, server probes, folder-unlock
//! samples — lives separately so the decision logic can be proven correct
//! in isolation with zero mocks.
//!
//! | has_drive_pw | has_blob | drive→blob    | folder_unlock         | Decision                      |
//! |--------------|----------|---------------|-----------------------|-------------------------------|
//! | false        | false    | —             | —                     | NoMigrationNeeded             |
//! | false        | true     | —             | —                     | DeferUntilUnlock              |
//! | true         | false    | —             | NoFoldersToCheck      | AutoSealAndUpload             |
//! | true         | false    | —             | DrivePasswordWorks    | AutoSealAndUpload             |
//! | true         | false    | —             | DrivePasswordFails    | AbortStaleDrivePassword       |
//! | true         | true     | Some(true)    | any                   | AlreadyAligned                |
//! | true         | true     | Some(false)   | NoFoldersToCheck      | AbortStaleDrivePassword       |
//! | true         | true     | Some(false)   | DrivePasswordWorks    | ResealUnderDrivePassword      |
//! | true         | true     | Some(false)   | DrivePasswordFails    | AbortStaleDrivePassword       |

#![allow(dead_code, reason = "Wiring into session_restore + the reseal/upload side-effects arrives in Step 3+ per the migration plan.")]

/// Inputs gathered from disk / server, fed into [`decide_migration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MigrationInputs {
    /// `true` iff the active account has a non-empty `hcfs_config.drive_password`.
    pub has_drive_password: bool,
    /// `true` iff `GET /v1/mnemonic-blob` returned 200 for this account.
    pub has_server_blob: bool,
    /// Tri-state: `None` when there's no blob to test against; `Some(true)`
    /// when the (decrypted) drive password successfully opens the blob;
    /// `Some(false)` when it doesn't.
    pub drive_password_decrypts_blob: Option<bool>,
    /// Tri-state verification that the drive password is still real — i.e.
    /// that it unlocks at least one existing folder `enc_mnemonic.json`.
    pub folder_unlock_check: FolderUnlockCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FolderUnlockCheck {
    /// No sync folders are configured for this account yet.
    NoFoldersToCheck,
    /// At least one folder's `enc_mnemonic.json` decrypts under the drive password.
    DrivePasswordWorks,
    /// A folder's `enc_mnemonic.json` exists but does not decrypt — the
    /// drive password is stale / wrong.
    DrivePasswordFails,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationDecision {
    /// No migration action required. Set the migrated flag and move on.
    NoMigrationNeeded,
    /// Server blob and drive password already agree. Set the flag.
    AlreadyAligned,
    /// No blob yet; seal the master mnemonic under the drive password and
    /// POST it. State B (sync set up, pre-always-on-recovery).
    AutoSealAndUpload,
    /// Blob exists under a different password but the drive password is
    /// real (verified by a folder unlock). Re-seal under the drive password.
    /// State C-conflict.
    ResealUnderDrivePassword,
    /// Blob exists but we have no drive password yet. Wait for the normal
    /// unlock flow to collect one. State D.
    DeferUntilUnlock,
    /// Drive password is stale or wrong, or we can't verify it is real.
    /// Don't touch the server. The user will re-align naturally on their
    /// next manual password entry (rotation or unlock).
    AbortStaleDrivePassword { reason: &'static str },
}

/// Decide what to do given the inputs. Pure function — no I/O, no side effects.
///
/// See module docs for the full truth table. Every case is covered by a
/// unit test below.
pub(crate) fn decide_migration(inputs: MigrationInputs) -> MigrationDecision {
    match (inputs.has_drive_password, inputs.has_server_blob) {
        // --- No drive password ---
        (false, false) => MigrationDecision::NoMigrationNeeded,
        (false, true) => MigrationDecision::DeferUntilUnlock,

        // --- Drive password, no blob (state B) ---
        (true, false) => match inputs.folder_unlock_check {
            FolderUnlockCheck::NoFoldersToCheck | FolderUnlockCheck::DrivePasswordWorks => {
                MigrationDecision::AutoSealAndUpload
            }
            FolderUnlockCheck::DrivePasswordFails => MigrationDecision::AbortStaleDrivePassword {
                reason: "drive password does not unlock existing folder mnemonics — treating as stale",
            },
        },

        // --- Drive password + blob (states C/E) ---
        (true, true) => match inputs.drive_password_decrypts_blob {
            Some(true) => MigrationDecision::AlreadyAligned,
            Some(false) => match inputs.folder_unlock_check {
                FolderUnlockCheck::DrivePasswordWorks => MigrationDecision::ResealUnderDrivePassword,
                FolderUnlockCheck::NoFoldersToCheck => MigrationDecision::AbortStaleDrivePassword {
                    reason: "blob exists under a different password and no folders exist to verify the drive password against",
                },
                FolderUnlockCheck::DrivePasswordFails => MigrationDecision::AbortStaleDrivePassword {
                    reason: "both the server blob and folder mnemonics reject the drive password — user must re-align manually",
                },
            },
            // Invariant: has_server_blob=true implies drive_password_decrypts_blob=Some.
            // `None` means the caller constructed MigrationInputs incorrectly;
            // treat it as a stale-password abort rather than silently proceeding.
            None => MigrationDecision::AbortStaleDrivePassword {
                reason: "internal: has_server_blob=true but drive_password_decrypts_blob=None",
            },
        },
    }
}

// ---------------------------------------------------------------------------
// I/O: gather inputs from DB + server + disk
// ---------------------------------------------------------------------------
//
// These are thin wrappers over existing helpers. They exist in this module
// so `decide_migration`'s inputs have a single obvious source of truth.
// The pure decision logic stays above; everything below touches I/O and
// is covered by the integration tests in the `io_tests` module.

use crate::console_access::{HcfsServerCtx, HttpOutcome, get_json};
use crate::error::Result;
use sqlx::SqlitePool;

/// Gather every input [`decide_migration`] needs, from the DB, the server,
/// and a sample folder-unlock attempt.
///
/// `mnemonic` is used to decrypt the stored `hcfs_config.drive_password`
/// when `encryption_version=1`. It is never logged and never stored.
pub(crate) async fn gather_migration_inputs(
    pool: &SqlitePool,
    ctx: &HcfsServerCtx,
    account_id: &str,
    mnemonic: &str,
) -> Result<MigrationInputs> {
    // 1. Drive password — None when no row, empty, or undecryptable.
    let drive_password = crate::sync::config::get_drive_password(pool, account_id, Some(mnemonic))
        .await
        .ok()
        .filter(|p| !p.is_empty());
    let has_drive_password = drive_password.is_some();

    // 2. Server blob probe — 404 maps to no blob.
    let blob_opt = match get_json::<hcfs_client::mnemonic_blob::SealedBlob>(ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => Some(b),
        HttpOutcome::NotFound => None,
    };
    let has_server_blob = blob_opt.is_some();

    // 3. Does the drive password open the blob?
    let drive_password_decrypts_blob = match (&drive_password, &blob_opt) {
        (Some(pw), Some(blob)) => Some(hcfs_client::mnemonic_blob::open_mnemonic(blob, pw, &ctx.ss58).is_ok()),
        _ => None,
    };

    // 4. Does the drive password unlock an existing folder file?
    let folder_unlock_check = match &drive_password {
        Some(pw) => sample_folder_unlock(pool, account_id, pw).await?,
        None => FolderUnlockCheck::NoFoldersToCheck,
    };

    Ok(MigrationInputs {
        has_drive_password,
        has_server_blob,
        drive_password_decrypts_blob,
        folder_unlock_check,
    })
}

/// Try to decrypt the first available `enc_mnemonic.json` for this account.
///
/// Returns `NoFoldersToCheck` when no non-`migration` sync-paths row has a
/// folder mnemonic file on disk yet. One success (or one failure) is enough
/// to classify the password, so we stop at the first folder that has a file.
async fn sample_folder_unlock(pool: &SqlitePool, account_id: &str, drive_password: &str) -> Result<FolderUnlockCheck> {
    let owner = crate::auth::account_key::account_key(account_id);
    let labels: Vec<String> = sqlx::query_scalar("SELECT label FROM sync_paths WHERE owner = ? AND label != 'migration'")
        .bind(&owner)
        .fetch_all(pool)
        .await?;

    for label in labels {
        let folder_dir = crate::sync::mnemonic::config_dir_for_folder(account_id, &label)?;
        let folder_enc = folder_dir.join("enc_mnemonic.json");
        if !folder_enc.exists() {
            continue;
        }
        return Ok(match hcfs_client::auth::recover_mnemonic(&folder_enc, drive_password) {
            Ok(_) => FolderUnlockCheck::DrivePasswordWorks,
            Err(_) => FolderUnlockCheck::DrivePasswordFails,
        });
    }

    Ok(FolderUnlockCheck::NoFoldersToCheck)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(
        has_drive_password: bool,
        has_server_blob: bool,
        drive_password_decrypts_blob: Option<bool>,
        folder_unlock_check: FolderUnlockCheck,
    ) -> MigrationInputs {
        MigrationInputs {
            has_drive_password,
            has_server_blob,
            drive_password_decrypts_blob,
            folder_unlock_check,
        }
    }

    // State A — fresh install.
    #[test]
    fn fresh_install_no_migration_needed() {
        let d = decide_migration(inputs(false, false, None, FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::NoMigrationNeeded);
    }

    // State D — blob exists but no drive password yet; wait for normal unlock.
    #[test]
    fn blob_only_defers_until_unlock() {
        let d = decide_migration(inputs(false, true, Some(false), FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::DeferUntilUnlock);

        // The blob-only case must also defer regardless of folder check,
        // because folder_unlock_check is meaningless without a drive password.
        let d = decide_migration(inputs(false, true, Some(true), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::DeferUntilUnlock);
    }

    // State B (sub-case): user signed up, drive password set, no folders yet.
    // Trust the freshly-typed password and seal.
    #[test]
    fn state_b_no_folders_auto_seals() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::AutoSealAndUpload);
    }

    // State B (common case): drive password verified against an existing folder.
    #[test]
    fn state_b_verified_folder_auto_seals() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::AutoSealAndUpload);
    }

    // Safety: drive password exists but does not unlock folders — don't seal.
    #[test]
    fn state_b_stale_drive_password_aborts() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::DrivePasswordFails));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("stale"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // State C-aligned / State E — drive password already opens the blob.
    #[test]
    fn state_c_aligned_is_noop() {
        let d = decide_migration(inputs(true, true, Some(true), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::AlreadyAligned);

        // Aligned even when there are no folders (fresh device that recovered then set up sync).
        let d = decide_migration(inputs(true, true, Some(true), FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::AlreadyAligned);
    }

    // State C-conflict: blob under a different password, no folders to verify against → safety abort.
    #[test]
    fn state_c_conflict_no_folders_aborts() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::NoFoldersToCheck));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("no folders"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // State C-conflict: drive password opens folders but not the blob → re-seal.
    #[test]
    fn state_c_conflict_reseals_under_drive_password() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::ResealUnderDrivePassword);
    }

    // State C-conflict: both passwords wrong → abort (user must re-align manually).
    #[test]
    fn state_c_conflict_folders_fail_aborts() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::DrivePasswordFails));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("manually"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // Invariant-violation guard: has_server_blob=true but decrypt check is None.
    // Callers should never construct this, but if they do we must abort, not
    // proceed silently.
    #[test]
    fn invariant_violation_aborts() {
        let d = decide_migration(inputs(true, true, None, FolderUnlockCheck::DrivePasswordWorks));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("internal"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // Exhaustive: enumerate every input combination and assert each falls
    // into exactly one decision (no panics, no unreachables). This catches
    // any match-arm gap a future refactor might introduce.
    #[test]
    fn every_input_combination_yields_a_decision() {
        let folder_checks = [
            FolderUnlockCheck::NoFoldersToCheck,
            FolderUnlockCheck::DrivePasswordWorks,
            FolderUnlockCheck::DrivePasswordFails,
        ];
        let drive_decrypts = [None, Some(true), Some(false)];

        for &has_drive in &[false, true] {
            for &has_blob in &[false, true] {
                for &decrypts in &drive_decrypts {
                    for &folder in &folder_checks {
                        let d = decide_migration(inputs(has_drive, has_blob, decrypts, folder));
                        // Any variant is fine; the point is the call
                        // doesn't panic and always returns.
                        let _ = d;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod io_tests {
    //! Integration tests for [`gather_migration_inputs`].
    //!
    //! Each test stands up:
    //! - an in-memory SQLite pool with `hcfs_config` + `sync_paths` seeded
    //!   to match the scenario;
    //! - an axum mock server bound to `127.0.0.1:0` that answers
    //!   `GET /v1/mnemonic-blob` with either 200 + a sealed blob or 404;
    //! - a tempdir wired as `$HOME` so `config_dir_for_folder` resolves
    //!   under it, with a folder-level `enc_mnemonic.json` written when
    //!   the scenario needs one.
    //!
    //! We assert both the raw [`MigrationInputs`] the gatherer returns
    //! AND the [`MigrationDecision`] the pure function produces from them
    //! — so a regression in either layer is caught.

    use super::*;
    use crate::auth::account_key::account_key;
    use crate::console_access::HcfsServerCtx;
    use crate::sync::mnemonic::config_dir_for_folder;
    use axum::{
        Json, Router,
        extract::State,
        http::StatusCode,
        response::IntoResponse,
        routing::get,
    };
    use hcfs_client::mnemonic_blob::{SealedBlob, seal_mnemonic};
    use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    const TEST_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[derive(Clone, Default)]
    struct MockState {
        blob: Arc<Mutex<Option<SealedBlob>>>,
    }

    async fn blob_handler(State(state): State<MockState>) -> impl IntoResponse {
        let guard = state.blob.lock().expect("blob lock poisoned");
        match &*guard {
            Some(b) => Json(b.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    /// Stand up a mock server returning `blob` (or 404 if `None`) at
    /// `/v1/mnemonic-blob`. Returns the base URL.
    async fn start_mock(blob: Option<SealedBlob>) -> String {
        let state = MockState {
            blob: Arc::new(Mutex::new(blob)),
        };
        let app = Router::new()
            .route("/v1/mnemonic-blob", get(blob_handler))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .expect("mock server crashed");
        });
        format!("http://{addr}")
    }

    /// In-memory pool with just the two tables `gather_migration_inputs` touches.
    async fn make_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open sqlite");
        sqlx::query(
            r"CREATE TABLE hcfs_config (
                owner TEXT PRIMARY KEY,
                server_url TEXT NOT NULL DEFAULT '',
                drive_password TEXT NOT NULL DEFAULT '',
                encryption_version INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .expect("create hcfs_config");
        sqlx::query(
            r"CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                timestamp INTEGER NOT NULL,
                is_paused INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner, label)
            )",
        )
        .execute(&pool)
        .await
        .expect("create sync_paths");
        pool
    }

    async fn insert_drive_password(pool: &SqlitePool, account_id: &str, password: &str) {
        let owner = account_key(account_id);
        sqlx::query(
            "INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://example', ?, 0)",
        )
        .bind(&owner)
        .bind(password)
        .execute(pool)
        .await
        .expect("insert drive_password");
    }

    async fn insert_sync_path(pool: &SqlitePool, account_id: &str, label: &str) {
        let owner = account_key(account_id);
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, 'local', ?, 0)",
        )
        .bind(&owner)
        .bind(format!("/tmp/{label}"))
        .bind(label)
        .execute(pool)
        .await
        .expect("insert sync_paths");
    }

    fn ctx_for(base_url: &str) -> HcfsServerCtx {
        HcfsServerCtx {
            client: reqwest::Client::new(),
            base_url: base_url.to_string(),
            bearer: "test-bearer".to_string(),
            ss58: TEST_SS58.to_string(),
        }
    }

    /// Serialise every test that mutates `$HOME`. `cargo test` runs tests
    /// on parallel threads within a single process, so concurrent
    /// `set_var("HOME", ...)` calls would race — one test's tempdir would
    /// mask another's and `config_dir_for_folder` would resolve to the
    /// wrong directory. Taking this mutex across the lifetime of the
    /// `HomeGuard` forces the env-mutating tests to serialise.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII `$HOME` override. On Drop, restores the previous value (or
    /// removes the env var if it was unset). Holds [`HOME_LOCK`] for its
    /// lifetime so two tests can't set `$HOME` simultaneously.
    struct HomeGuard {
        previous: Option<std::ffi::OsString>,
        _tmp: tempfile::TempDir,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl HomeGuard {
        fn new() -> Self {
            let lock = HOME_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let tmp = tempfile::tempdir().expect("tempdir");
            let previous = std::env::var_os("HOME");
            // SAFETY: test-only env mutation. Serialised via `HOME_LOCK`
            // so no other test in this process reads/writes `HOME`
            // concurrently for the lifetime of this guard.
            unsafe {
                std::env::set_var("HOME", tmp.path());
            }
            Self {
                previous,
                _tmp: tmp,
                _lock: lock,
            }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            // SAFETY: see `HomeGuard::new`.
            unsafe {
                match self.previous.take() {
                    Some(v) => std::env::set_var("HOME", v),
                    None => std::env::remove_var("HOME"),
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // Scenarios
    // -----------------------------------------------------------------

    /// State A — no drive password, no server blob.
    #[tokio::test]
    async fn fresh_install() {
        let _home = HomeGuard::new();
        let pool = make_pool().await;
        let base_url = start_mock(None).await;
        let ctx = ctx_for(&base_url);

        let inputs = gather_migration_inputs(&pool, &ctx, "5FreshAccount", TEST_MNEMONIC)
            .await
            .expect("gather inputs");

        assert!(!inputs.has_drive_password);
        assert!(!inputs.has_server_blob);
        assert_eq!(inputs.drive_password_decrypts_blob, None);
        assert_eq!(inputs.folder_unlock_check, FolderUnlockCheck::NoFoldersToCheck);
        assert_eq!(decide_migration(inputs), MigrationDecision::NoMigrationNeeded);
    }

    /// State D — blob present, no drive password yet (fresh device after recovery).
    #[tokio::test]
    async fn blob_only_defers_until_unlock() {
        let _home = HomeGuard::new();
        let pool = make_pool().await;
        let blob = seal_mnemonic(TEST_MNEMONIC, "recovery-pw", TEST_SS58).expect("seal");
        let base_url = start_mock(Some(blob)).await;
        let ctx = ctx_for(&base_url);

        let inputs = gather_migration_inputs(&pool, &ctx, "5BlobOnlyAccount", TEST_MNEMONIC)
            .await
            .expect("gather inputs");

        assert!(!inputs.has_drive_password);
        assert!(inputs.has_server_blob);
        assert_eq!(inputs.drive_password_decrypts_blob, None);
        assert_eq!(inputs.folder_unlock_check, FolderUnlockCheck::NoFoldersToCheck);
        assert_eq!(decide_migration(inputs), MigrationDecision::DeferUntilUnlock);
    }

    /// State B — drive password set, no blob, no folders (fresh signup).
    #[tokio::test]
    async fn state_b_signup_no_folders_auto_seals() {
        let _home = HomeGuard::new();
        let pool = make_pool().await;
        let account = "5StateBSignup";
        insert_drive_password(&pool, account, "drive-pw").await;
        let base_url = start_mock(None).await;
        let ctx = ctx_for(&base_url);

        let inputs = gather_migration_inputs(&pool, &ctx, account, TEST_MNEMONIC)
            .await
            .expect("gather inputs");

        assert!(inputs.has_drive_password);
        assert!(!inputs.has_server_blob);
        assert_eq!(inputs.drive_password_decrypts_blob, None);
        assert_eq!(inputs.folder_unlock_check, FolderUnlockCheck::NoFoldersToCheck);
        assert_eq!(decide_migration(inputs), MigrationDecision::AutoSealAndUpload);
    }

    /// State C-aligned — drive password, blob opens with it, folder file
    /// also opens with it. Nothing to do.
    #[tokio::test]
    async fn state_c_aligned_is_noop() {
        let _home = HomeGuard::new();
        let pool = make_pool().await;
        let account = "5StateCAligned";
        let password = "drive-pw";
        insert_drive_password(&pool, account, password).await;
        insert_sync_path(&pool, account, "alpha").await;

        // Write a folder mnemonic file sealed under the drive password.
        let folder_dir = config_dir_for_folder(account, "alpha").expect("folder dir");
        tokio::fs::create_dir_all(&folder_dir).await.expect("mkdir");
        let folder_enc = folder_dir.join("enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, TEST_MNEMONIC, password).expect("save folder enc");

        // Blob sealed under the same password.
        let blob = seal_mnemonic(TEST_MNEMONIC, password, TEST_SS58).expect("seal");
        let base_url = start_mock(Some(blob)).await;
        let ctx = ctx_for(&base_url);

        let inputs = gather_migration_inputs(&pool, &ctx, account, TEST_MNEMONIC)
            .await
            .expect("gather inputs");

        assert!(inputs.has_drive_password);
        assert!(inputs.has_server_blob);
        assert_eq!(inputs.drive_password_decrypts_blob, Some(true));
        assert_eq!(inputs.folder_unlock_check, FolderUnlockCheck::DrivePasswordWorks);
        assert_eq!(decide_migration(inputs), MigrationDecision::AlreadyAligned);
    }

    /// State C-conflict — drive password unlocks folders but not the blob
    /// (blob is sealed under a different, older recovery password). Re-seal.
    #[tokio::test]
    async fn state_c_conflict_reseals_under_drive_password() {
        let _home = HomeGuard::new();
        let pool = make_pool().await;
        let account = "5StateCConflict";
        let drive_password = "drive-pw";
        insert_drive_password(&pool, account, drive_password).await;
        insert_sync_path(&pool, account, "alpha").await;

        // Folder file sealed under the drive password (password is real).
        let folder_dir = config_dir_for_folder(account, "alpha").expect("folder dir");
        tokio::fs::create_dir_all(&folder_dir).await.expect("mkdir");
        let folder_enc = folder_dir.join("enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, TEST_MNEMONIC, drive_password).expect("save folder enc");

        // Blob sealed under a DIFFERENT password (pre-unification recovery pw).
        let blob = seal_mnemonic(TEST_MNEMONIC, "other-recovery-pw", TEST_SS58).expect("seal");
        let base_url = start_mock(Some(blob)).await;
        let ctx = ctx_for(&base_url);

        let inputs = gather_migration_inputs(&pool, &ctx, account, TEST_MNEMONIC)
            .await
            .expect("gather inputs");

        assert!(inputs.has_drive_password);
        assert!(inputs.has_server_blob);
        assert_eq!(inputs.drive_password_decrypts_blob, Some(false));
        assert_eq!(inputs.folder_unlock_check, FolderUnlockCheck::DrivePasswordWorks);
        assert_eq!(decide_migration(inputs), MigrationDecision::ResealUnderDrivePassword);
    }
}
