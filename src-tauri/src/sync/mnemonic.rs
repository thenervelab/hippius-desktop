//! Mnemonic and key management for HCFS sync.
//!
//! Contains functions for deriving folder-specific mnemonics from the master
//! mnemonic, persisting the master mnemonic, and creating encrypted backups.

use tracing::{info, warn};

use crate::auth::account_key::account_key;
use crate::error::Result;
use crate::sync::config::get_drive_password;
use hcfs_client::engine::manager::DriveManager;
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};

/// Compute the account-level directory: `~/.hippius/drives/<account_key>/`
pub(crate) fn account_dir(account_id: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or(crate::error::AppError::Other("Could not determine home directory".into()))?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key))
}

/// Deterministic 16-char hex hash of a folder label.
/// Delegates to the hcfs-client library.
pub(crate) fn folder_hash(label: &str) -> String {
    hcfs_client::drive::keys::folder_hash(label)
}

/// Compute the per-folder config directory:
/// `~/.hippius/drives/<account_key>/<folder_hash>/`
pub(crate) fn config_dir_for_folder(account_id: &str, label: &str) -> Result<PathBuf> {
    Ok(account_dir(account_id)?.join(folder_hash(label)))
}

/// Path to the master encrypted mnemonic at the account level:
/// `~/.hippius/drives/<account_key>/master_enc_mnemonic.json`
pub(crate) fn master_mnemonic_path(account_id: &str) -> Result<PathBuf> {
    Ok(account_dir(account_id)?.join("master_enc_mnemonic.json"))
}

/// Derive a folder-specific mnemonic from the master mnemonic + folder label.
/// Delegates to the hcfs-client library.
pub(crate) fn derive_folder_mnemonic(master_mnemonic: &str, label: &str) -> Result<String> {
    hcfs_client::drive::keys::derive_folder_mnemonic(master_mnemonic, label).map_err(|e| crate::error::AppError::Other(e.to_string()))
}

/// Ensure the folder uses the correct derived mnemonic for the current master.
///
/// Detects two legacy states:
///   1. Folder mnemonic == master verbatim (copied during migration without derivation)
///   2. Folder mnemonic != derive(master, label) (derived from a different/old master)
///
/// In either case it re-derives from the current master, writes a `.needs_rekey`
/// marker (so `initialize_sync_inner` purges stale remote files), and wipes local
/// sync state to force re-upload with the correct key.
pub(crate) fn ensure_derived_mnemonic(folder_dir: &Path, master_path: &Path, password: &str, label: &str) -> Result<()> {
    use zeroize::Zeroize;

    let folder_enc = folder_dir.join("enc_mnemonic.json");
    if !folder_enc.exists() || !master_path.exists() {
        return Ok(());
    }

    let master = hcfs_client::auth::recover_mnemonic(master_path, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let mut master_str = master.to_string();

    let folder = hcfs_client::auth::recover_mnemonic(&folder_enc, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let mut folder_str = folder.to_string();

    let mut expected = derive_folder_mnemonic(&master_str, label)?;

    if folder_str == expected {
        // Already correct — nothing to do.
        master_str.zeroize();
        folder_str.zeroize();
        expected.zeroize();
        return Ok(());
    }

    // Folder mnemonic is wrong — either raw master or derived from an old master.
    if folder_str == master_str {
        info!("Folder '{}' uses raw master mnemonic — re-deriving", label);
    } else {
        info!("Folder '{}' uses wrong derived mnemonic (old master?) — re-deriving", label);
    }
    folder_str.zeroize();
    master_str.zeroize();

    // Create the rekey marker BEFORE saving the new mnemonic. If the
    // process crashes after the mnemonic is saved but before the marker
    // is written, the next startup would see folder == expected and
    // skip — leaving stale remote files encrypted with the old key.
    let marker = folder_dir.join(".needs_rekey");
    std::fs::File::create(&marker)?;

    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &expected, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    expected.zeroize();

    // Wipe sync state so files get re-uploaded with the new key
    let state_path = folder_dir.join("sync_state.json");
    let state_bak = folder_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    info!("Re-derived mnemonic for '{}', wiped sync state (remote files preserved)", label);

    Ok(())
}

/// Retrieves the master BIP-39 mnemonic for the given account.
///
/// Tries a 5-stage fallback chain: in-memory cache → encrypted master
/// on disk → first active drive export → database row → error.
///
/// Returns [`zeroize::Zeroizing<String>`] to ensure the mnemonic is wiped from
/// memory when the caller drops it.
///
/// Takes `&AppState` to access both the DB pool and the live drive registry
/// without relying on global state.
pub async fn get_mnemonic_for_account(app_state: &crate::app_state::AppState, account_id: &str) -> Result<zeroize::Zeroizing<String>> {
    // Stage 1: in-memory cache populated by login_with_mnemonic or
    // ensure_sync_mnemonic (OAuth). Gated on the active account so a
    // stale cache from a previous account never leaks.
    {
        let auth = app_state.auth.lock()?;
        if auth.substrate_address.as_deref() == Some(account_id)
            && let Some(ref cached) = auth.mnemonic
        {
            return Ok(zeroize::Zeroizing::new(cached.to_string()));
        }
    }

    let pool = app_state.pool()?;

    // Stage 2: master mnemonic on disk.
    let master_path = master_mnemonic_path(account_id)?;
    if master_path.exists()
        && let Ok(drive_password) = get_drive_password(pool, account_id, None).await
    {
        match hcfs_client::auth::recover_mnemonic(&master_path, &drive_password) {
            Ok(mnemonic) => return Ok(zeroize::Zeroizing::new(mnemonic.to_string())),
            Err(e) => {
                // Wrong password / corrupt file — surface as recoverable
                // precondition rather than a stringly Hcfs error so the
                // frontend prompts the user to re-login.
                warn!("Master mnemonic at {:?} failed to decrypt: {e}", master_path);
                return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::MasterMnemonicUnrecoverable));
            }
        }
    }

    // Stage 3: first active drive's folder mnemonic (pre-migration state).
    warn!("Master mnemonic not found at {:?}, falling back to per-folder mnemonic", master_path);
    let first_arc = {
        let guard = app_state.sync.drives.lock().await;
        guard.values().next().map(|slot| slot.manager.clone())
    };
    if let Some(arc) = first_arc
        && let Ok(drive_password) = get_drive_password(pool, account_id, None).await
    {
        let m = arc.lock().await;
        if m.is_initialized()
            && let Ok(mnemonic) = m.export_mnemonic(&drive_password)
        {
            return Ok(zeroize::Zeroizing::new(mnemonic));
        }
    }

    // Stage 4: any sync path row in the DB.
    let owner = account_key(account_id);
    let result: Option<(String, String)> = sqlx::query_as("SELECT path, label FROM sync_paths WHERE owner = ? LIMIT 1")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;

    if let Some((path, lbl)) = result
        && let Ok(drive_password) = get_drive_password(pool, account_id, None).await
    {
        let folder_dir = config_dir_for_folder(account_id, &lbl)?;
        let manager = DriveManager::new(PathBuf::from(&path), folder_dir);
        if manager.is_initialized()
            && let Ok(mnemonic) = manager.export_mnemonic(&drive_password)
        {
            return Ok(zeroize::Zeroizing::new(mnemonic));
        }
    }

    // Stage 5: nothing recoverable. Frontend dispatches on this kind to
    // prompt the user to log in again with their seed phrase.
    Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::MasterMnemonicUnrecoverable))
}

/// Tauri command wrapper: return the master BIP-39 mnemonic by decrypting it
/// from disk.
///
/// Unwraps the [`zeroize::Zeroizing<String>`] at the IPC boundary so that
/// Tauri can serialize it as a plain `String`. The `Zeroizing` wrapper is
/// dropped (and the in-process copy wiped) immediately after the clone.
#[tauri::command]
pub async fn get_drive_mnemonic(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<String> {
    let z = get_mnemonic_for_account(&state, &account_id).await?;
    Ok((*z).clone())
}

/// Ensure a BIP-39 mnemonic is available for HCFS sync.
///
/// Tries the drive's encrypted mnemonic first, falls back to generating
/// a new one. The resolved (or generated) mnemonic is cached in
/// `AuthInfo.mnemonic` so every downstream Rust caller that needs it can
/// pull it from memory via `get_mnemonic_for_account` without the mnemonic
/// ever having to cross the IPC boundary.
///
/// # Security
///
/// This command returns `Result<()>` rather than the raw phrase. The
/// frontend used to consume the return value and hand it back to
/// `initialize_sync` / `auto_init_sync`, which round-tripped the seed
/// phrase through JavaScript memory unnecessarily. Rust already has
/// everything it needs once this function returns, so the return value
/// is intentionally empty. The explicit reveal flow lives in
/// `get_drive_mnemonic` — the recovery-phrase settings page is the only
/// legitimate consumer of the raw string.
#[tauri::command]
pub async fn ensure_sync_mnemonic(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<()> {
    // Block on the recovery gate before touching the mnemonic store.
    //
    // For OAuth login on a fresh device, `complete_oauth_flow` flips the
    // gate to `Pending` so this await parks until the recovery dialog has
    // resolved — either by installing a server-sealed mnemonic via
    // `recover_mnemonic`, uploading a freshly-generated one via
    // `seal_and_upload_mnemonic`, or fast-path skipping via
    // `mark_recovery_skipped`. Without this gate there's a race where
    // `auto_init_sync` mints a new mnemonic seconds before the user
    // enters their recovery password, which then corrupts the drive
    // password and trips `MasterMnemonicUnrecoverable` on the next run.
    //
    // For every other login path (mnemonic login, session restore on a
    // returning device) the gate's default is `Skipped`, so this await
    // is a no-op.
    state.await_recovery_resolved().await;

    // Try the five-stage recovery chain first.
    if let Ok(m) = get_mnemonic_for_account(&state, &account_id).await
        && !m.is_empty()
    {
        // Already cached by stage 1 of `get_mnemonic_for_account` when it
        // hit `AuthInfo.mnemonic`, or freshly resolved from disk/DB. Make
        // sure the active AuthInfo slot has it so downstream Rust callers
        // pick it up without re-traversing the fallback chain.
        state.auth.lock()?.cache_session_mnemonic(&account_id, (*m).clone());
        return Ok(());
    }

    // Recovery failed. Before generating a fresh mnemonic, check whether
    // the user already has encrypted state on disk / in the DB that would
    // be rendered permanently unreadable by minting a new one. The
    // canonical markers:
    //
    // 1. `master_enc_mnemonic.json` exists — the mnemonic was already
    //    generated once and encrypted to disk with the user's drive
    //    password. Generating a new mnemonic would leave this file
    //    unopenable.
    // 2. `hcfs_config.drive_password` has `encryption_version > 0` — the
    //    drive password is encrypted with the existing mnemonic; a new
    //    mnemonic cannot decrypt it and `load_sync_config` would fail
    //    with the opaque `Crypto: decryption failed — wrong key or
    //    corrupted data` the bug report surfaced.
    //
    // The previous code regenerated in both states because
    // `get_mnemonic_for_account` stages 2-4 pass `None` to
    // `get_drive_password` and always return `Err` for
    // `encryption_version = 1` rows — a chicken-and-egg that made the
    // recovery chain look empty whenever the keychain had evicted the
    // mnemonic (common in release-signed builds with `hardenedRuntime`).
    // Regenerating then corrupted the drive password on the next
    // decrypt. Instead, surface `MasterMnemonicUnrecoverable` so the
    // frontend's reauth banner / seed-phrase re-entry flow takes over.
    if has_existing_mnemonic_state(state.pool()?, &account_id).await? {
        warn!(
            "Mnemonic recovery failed for account {} but encrypted state exists — refusing to generate a new mnemonic (reauth required)",
            &account_id[..8.min(account_id.len())]
        );
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::MasterMnemonicUnrecoverable));
    }

    // Truly fresh state (first-time OAuth sync setup) — safe to mint one.
    info!(
        "No drive mnemonic available and no prior state, generating new one for account {}",
        &account_id[..8.min(account_id.len())]
    );
    let generated = crate::auth::login::generate_mnemonic_internal()?;

    // Cache for the active session so subsequent `get_mnemonic_for_account`
    // calls (e.g. migration, auto_init_sync) hit Stage 1 immediately,
    // regardless of whether auto_init_sync has finished writing
    // `master_enc_mnemonic.json` yet. The helper is gated on the active
    // substrate_address so a stale cache from a previous account never
    // leaks across logins.
    state.auth.lock()?.cache_session_mnemonic(&account_id, (*generated).clone());

    Ok(())
}

/// Returns `true` when the account already has encrypted mnemonic/drive
/// state that would be destroyed by minting a new mnemonic.
///
/// Checked artifacts:
/// - `master_enc_mnemonic.json` under `~/.hippius/drives/<account_key>/`.
/// - A `hcfs_config` row with `encryption_version > 0`.
///
/// Takes `&SqlitePool` (not `&AppState`) so unit tests can exercise the
/// DB branch with an in-memory pool without standing up the full
/// application state.
pub(crate) async fn has_existing_mnemonic_state(pool: &sqlx::SqlitePool, account_id: &str) -> Result<bool> {
    if let Ok(path) = master_mnemonic_path(account_id)
        && path.exists()
    {
        return Ok(true);
    }

    let owner = account_key(account_id);
    let row: Option<(i32,)> = sqlx::query_as("SELECT COALESCE(encryption_version, 0) FROM hcfs_config WHERE owner = ? LIMIT 1")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;

    Ok(row.is_some_and(|(v,)| v > 0))
}

/// Create a password-protected zip file containing the plaintext mnemonic.
/// Uses AES-256 encryption on the zip entry.
///
/// Both `mnemonic` and `password` are wrapped in [`zeroize::Zeroizing`] so that
/// their memory is wiped via [`Drop`] even if the zip operation panics during
/// stack unwinding — the previous manual `zeroize()` calls would be skipped on panic.
#[tauri::command]
pub async fn create_encrypted_backup(mnemonic: String, password: String, output_path: String) -> Result<()> {
    use zeroize::Zeroizing;

    let mnemonic = Zeroizing::new(mnemonic);
    let password = Zeroizing::new(password);

    let buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .with_aes_encryption(zip::AesMode::Aes256, &password);

    zip.start_file("recovery-phrase.txt", options)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    zip.write_all(mnemonic.as_bytes())?;

    let cursor = zip.finish().map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    std::fs::write(&output_path, cursor.into_inner())?;

    // `mnemonic` and `password` are zeroized here via Drop, even on panic unwind.
    Ok(())
}

/// Re-derive and re-encrypt every sync-folder's `enc_mnemonic.json` under
/// `new_password` for the active account.
///
/// Used by the password-rotation / unlock / signup paths that unify the
/// user's recovery password with the on-disk drive password. Each folder
/// mnemonic is **re-derived from the master** via
/// [`hcfs_client::drive::keys::derive_folder_mnemonic`] rather than decrypted
/// from the existing file, so this call does not require knowledge of the
/// previous drive password and is safe to invoke from unlock flows where
/// the only secret available is the user's recovery password.
///
/// Idempotent: `save_encrypted_mnemonic` truncates on write, so re-running
/// this function with the same inputs produces the same bytes. Safe to
/// re-run after a partial failure.
///
/// Skips the internal `migration` pseudo-drive label (see
/// `sync::drive_status` filters). Folders whose `enc_mnemonic.json` does
/// not exist yet are created under the new password as part of this call
/// — rotation brings every folder that has a `sync_paths` row up to date,
/// whether or not it had been realised on disk before.
///
/// Every per-folder step is best-effort: derivation or save failures are
/// warn-logged with their `label` and skipped so a single bad folder
/// doesn't block rotating the rest. Returns `Err` only when the
/// `sync_paths` read itself fails.
pub(crate) async fn reencrypt_all_folder_mnemonics(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    master_mnemonic: &str,
    new_password: &str,
) -> crate::error::Result<()> {
    use crate::auth::account_key::account_key;

    let owner = account_key(account_id);
    let labels: Vec<String> = sqlx::query_scalar("SELECT label FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await?;

    // Build per-label re-encrypt futures and run them concurrently.
    // Each iteration is independent: it derives a folder mnemonic from the
    // master, prepares the folder dir, then spawns a blocking task to do
    // the password-key derive + AEAD encrypt + JSON write. The crypto work
    // is CPU-bound (Argon2-style); concurrency = number of cores via the
    // tokio blocking-thread pool. For users with N drives this reduces the
    // change-recovery-password latency from sum(N) to max(N).
    //
    // Secrets are wrapped in `Zeroizing<String>` and shared via `Arc` so we
    // hold ONE owned copy of the master mnemonic and the new password
    // across all per-label futures. Cloning the `Arc` per future is cheap
    // and — critically — preserves zeroization on drop. The pre-Arc
    // version cloned the secrets into bare `String`s, which sat
    // unzeroized on the heap for the lifetime of every future.
    //
    // Per-label `account_id` is not secret (a public ss58 address), so
    // bare String clone is fine there.
    let master_mnemonic = std::sync::Arc::new(zeroize::Zeroizing::new(master_mnemonic.to_string()));
    let new_password = std::sync::Arc::new(zeroize::Zeroizing::new(new_password.to_string()));

    let futures = labels
        .iter()
        .filter(|l| l.as_str() != "migration")
        .map(|label| {
            let label = label.clone();
            let account_id = account_id.to_string();
            let master_mnemonic = std::sync::Arc::clone(&master_mnemonic);
            let new_password = std::sync::Arc::clone(&new_password);
            async move {
                let folder_dir = match config_dir_for_folder(&account_id, &label) {
                    Ok(dir) => dir,
                    Err(e) => {
                        tracing::warn!(
                            label = %label,
                            error = %e,
                            "reencrypt_all_folder_mnemonics: failed to compute folder dir; continuing"
                        );
                        return;
                    }
                };
                let folder_enc = folder_dir.join("enc_mnemonic.json");

                // Re-derive deterministically from the master. Folder files
                // that don't exist yet on disk are created here under the
                // new password.
                let folder_mnemonic_owned = match hcfs_client::drive::keys::derive_folder_mnemonic(master_mnemonic.as_str(), &label) {
                    Ok(s) => zeroize::Zeroizing::new(s),
                    Err(e) => {
                        tracing::warn!(
                            label = %label,
                            error = %e,
                            "reencrypt_all_folder_mnemonics: failed to derive folder mnemonic; continuing"
                        );
                        return;
                    }
                };

                if let Some(parent) = folder_enc.parent()
                    && let Err(e) = tokio::fs::create_dir_all(parent).await
                {
                    tracing::warn!(
                        label = %label,
                        error = %e,
                        "reencrypt_all_folder_mnemonics: failed to create folder dir; continuing"
                    );
                    return;
                }

                // save_encrypted_mnemonic is sync + blocking; wrap in
                // spawn_blocking to match install_recovered_mnemonic.
                // Owned copy of the password for the 'static spawn_blocking
                // closure, kept in a Zeroizing wrapper so it scrubs on drop.
                let password_owned: zeroize::Zeroizing<String> = zeroize::Zeroizing::new(new_password.as_str().to_owned());
                let label_for_task = label.clone();
                let result = tokio::task::spawn_blocking(move || {
                    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &folder_mnemonic_owned, &password_owned).map_err(|e| e.to_string())
                })
                .await;

                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        tracing::warn!(
                            label = %label_for_task,
                            error = %e,
                            "reencrypt_all_folder_mnemonics: failed to save folder mnemonic; continuing"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            label = %label_for_task,
                            error = %e,
                            "reencrypt_all_folder_mnemonics: spawn_blocking join error; continuing"
                        );
                    }
                }
            }
        });

    futures_util::future::join_all(futures).await;

    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::await_holding_lock,
    reason = "Tests hold HOME_LOCK across awaits to serialise $HOME overrides. #[tokio::test] runs on a current-thread runtime so awaits don't contend on this lock — see test_helpers.rs."
)]
mod tests {
    use super::*;

    // ── folder_hash ─────────────────────────────────────────────────

    #[test]
    fn folder_hash_is_deterministic() {
        let h1 = folder_hash("my-folder");
        let h2 = folder_hash("my-folder");
        assert_eq!(h1, h2);
    }

    #[test]
    fn folder_hash_is_16_hex_chars() {
        let h = folder_hash("test");
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()), "expected hex, got: {h}");
    }

    #[test]
    fn folder_hash_differs_for_different_labels() {
        assert_ne!(folder_hash("alpha"), folder_hash("beta"));
    }

    // ── derive_folder_mnemonic ──────────────────────────────────────

    #[test]
    fn derive_folder_mnemonic_is_deterministic() {
        let master = "abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon \
                       abandon about";
        let m1 = derive_folder_mnemonic(master, "docs").unwrap();
        let m2 = derive_folder_mnemonic(master, "docs").unwrap();
        assert_eq!(m1, m2);
    }

    #[test]
    fn derive_folder_mnemonic_differs_per_label() {
        let master = "abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon \
                       abandon about";
        let m1 = derive_folder_mnemonic(master, "docs").unwrap();
        let m2 = derive_folder_mnemonic(master, "photos").unwrap();
        assert_ne!(m1, m2);
    }

    #[test]
    fn derive_folder_mnemonic_produces_24_words() {
        let master = "abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon \
                       abandon about";
        let derived = derive_folder_mnemonic(master, "test").unwrap();
        assert_eq!(derived.split_whitespace().count(), 24, "derived mnemonic should be 24 words");
    }

    #[test]
    fn derive_folder_mnemonic_rejects_invalid_master() {
        let result = derive_folder_mnemonic("not a valid mnemonic", "x");
        assert!(result.is_err());
    }

    // ── config_dir_for_folder / master_mnemonic_path ────────────────

    #[test]
    fn config_dir_for_folder_uses_folder_hash_subdirectory() {
        let dir = config_dir_for_folder("5GrwvaEF", "docs").unwrap();
        let expected_hash = folder_hash("docs");
        assert!(dir.ends_with(&expected_hash), "path should end with folder hash: {}", dir.display());
    }

    #[test]
    fn master_mnemonic_path_ends_with_expected_filename() {
        let path = master_mnemonic_path("5GrwvaEF").unwrap();
        assert!(
            path.file_name().unwrap() == "master_enc_mnemonic.json",
            "path should end with master_enc_mnemonic.json: {}",
            path.display()
        );
    }

    #[test]
    fn account_dir_is_under_hippius_drives() {
        let dir = account_dir("5GrwvaEF").unwrap();
        let components: Vec<_> = dir.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
        assert!(
            components.contains(&".hippius".to_string()),
            "should be under .hippius: {}",
            dir.display()
        );
        assert!(components.contains(&"drives".to_string()), "should be under drives: {}", dir.display());
    }

    // ── has_existing_mnemonic_state ─────────────────────────────────
    //
    // The DB branch — `hcfs_config.encryption_version > 0` — is what
    // guards the release-mode scenario that motivated these tests (an
    // OAuth user with a previously-set-up drive whose OS keychain
    // entry was evicted). The file-exists branch is exercised by the
    // integration tests in `src-tauri/tests/` that spin up a real
    // account directory; here we focus on the DB shape.

    use sqlx::sqlite::SqlitePool;

    async fn make_hcfs_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE hcfs_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL UNIQUE,
                server_url TEXT NOT NULL DEFAULT '',
                drive_password TEXT NOT NULL DEFAULT '',
                encryption_version INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    // A randomized-looking SS58 we never combine with HOME so the file
    // branch can't accidentally fire during the DB-branch tests on a
    // developer machine that happens to have `master_enc_mnemonic.json`
    // lying around.
    const UNUSED_ACCOUNT: &str = "5TestAccountIdForHasExistingMnemonicState0000";

    #[tokio::test]
    async fn no_row_and_no_file_returns_false() {
        let pool = make_hcfs_pool().await;
        let result = has_existing_mnemonic_state(&pool, UNUSED_ACCOUNT).await.unwrap();
        assert!(!result, "fresh account with no artifacts should not block regeneration");
    }

    #[tokio::test]
    async fn plaintext_row_returns_false() {
        // encryption_version = 0 means the row predates at-rest
        // encryption — the old `get_mnemonic_for_account` stages could
        // still read it with `None`, so regeneration isn't needed.
        let pool = make_hcfs_pool().await;
        let owner = account_key(UNUSED_ACCOUNT);
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, 0)")
            .bind(&owner)
            .bind("https://example")
            .bind("plaintext-password")
            .execute(&pool)
            .await
            .unwrap();
        let result = has_existing_mnemonic_state(&pool, UNUSED_ACCOUNT).await.unwrap();
        assert!(!result, "plaintext config row must not trigger the guard");
    }

    #[tokio::test]
    async fn encrypted_row_returns_true() {
        // The load-bearing case: encrypted drive_password exists, so
        // regenerating a mnemonic would permanently lock the user out.
        let pool = make_hcfs_pool().await;
        let owner = account_key(UNUSED_ACCOUNT);
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, 1)")
            .bind(&owner)
            .bind("https://example")
            .bind("base64-ciphertext-blob")
            .execute(&pool)
            .await
            .unwrap();
        let result = has_existing_mnemonic_state(&pool, UNUSED_ACCOUNT).await.unwrap();
        assert!(result, "encrypted row must block regeneration");
    }

    #[tokio::test]
    async fn different_owner_does_not_match() {
        // The lookup is scoped by `owner = account_key(account_id)`;
        // another user's encrypted row must not leak into this
        // account's regeneration decision.
        let pool = make_hcfs_pool().await;
        let other_owner = account_key("5OtherAccountWithEncryptedState0000000000000");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, 1)")
            .bind(&other_owner)
            .bind("https://example")
            .bind("encrypted")
            .execute(&pool)
            .await
            .unwrap();
        let result = has_existing_mnemonic_state(&pool, UNUSED_ACCOUNT).await.unwrap();
        assert!(!result, "another user's encrypted row must not trigger the guard");
    }

    // ── reencrypt_all_folder_mnemonics ──────────────────────────────

    #[tokio::test]
    async fn reencrypt_overwrites_existing_folder_mnemonics_under_new_password() {
        use sqlx::sqlite::SqlitePoolOptions;

        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        // `config_dir_for_folder` and the account_id hashing path look at $HOME.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0)")
            .execute(&pool)
            .await
            .unwrap();

        let account = "5TestReencryptAccount";
        let owner = account_key(account);
        for label in ["alpha", "beta", "migration"] {
            sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, ?)")
                .bind(&owner)
                .bind(format!("/tmp/{label}"))
                .bind(label)
                .execute(&pool)
                .await
                .unwrap();
        }

        // A stable BIP39 test mnemonic — NOT a real secret. Common test vector.
        let master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let new_password = "correct horse battery staple test vector only";

        // Seed an existing folder file under an OLD password so we can prove
        // the function overwrites rather than skips.
        let alpha_dir = config_dir_for_folder(account, "alpha").unwrap();
        tokio::fs::create_dir_all(&alpha_dir).await.unwrap();
        let alpha_enc = alpha_dir.join("enc_mnemonic.json");
        let alpha_folder_mnemonic = hcfs_client::drive::keys::derive_folder_mnemonic(master, "alpha").unwrap();
        hcfs_client::auth::save_encrypted_mnemonic(&alpha_enc, &alpha_folder_mnemonic, "old password").unwrap();

        reencrypt_all_folder_mnemonics(&pool, account, master, new_password).await.unwrap();

        // alpha: must decrypt under NEW password and equal the deterministic derivation.
        let recovered = hcfs_client::auth::recover_mnemonic(&alpha_enc, new_password).unwrap();
        assert_eq!(recovered.to_string(), alpha_folder_mnemonic);

        // beta: file didn't exist before; the function should have created it
        // under the new password.
        let beta_enc = config_dir_for_folder(account, "beta").unwrap().join("enc_mnemonic.json");
        assert!(beta_enc.exists(), "beta enc_mnemonic.json should be created");
        let beta_expected = hcfs_client::drive::keys::derive_folder_mnemonic(master, "beta").unwrap();
        let beta_recovered = hcfs_client::auth::recover_mnemonic(&beta_enc, new_password).unwrap();
        assert_eq!(beta_recovered.to_string(), beta_expected);

        // migration: must be skipped entirely — no file created.
        let migration_enc = config_dir_for_folder(account, "migration").unwrap().join("enc_mnemonic.json");
        assert!(!migration_enc.exists(), "migration pseudo-drive must be skipped");

        // Idempotence: a second call is a no-op on disk (same bytes because
        // derivation is deterministic) and returns Ok.
        reencrypt_all_folder_mnemonics(&pool, account, master, new_password).await.unwrap();
        let recovered_again = hcfs_client::auth::recover_mnemonic(&alpha_enc, new_password).unwrap();
        assert_eq!(recovered_again.to_string(), alpha_folder_mnemonic);
    }

    #[tokio::test]
    async fn reencrypt_with_zero_folders_returns_ok() {
        use sqlx::sqlite::SqlitePoolOptions;

        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0)")
            .execute(&pool)
            .await
            .unwrap();

        let master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        // No sync_paths rows for this account — the loop body must never
        // execute and the helper must be a no-op Ok.
        reencrypt_all_folder_mnemonics(&pool, "5EmptyAccount", master, "any-password")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reencrypt_with_invalid_master_warn_skips_all() {
        use sqlx::sqlite::SqlitePoolOptions;

        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0)")
            .execute(&pool)
            .await
            .unwrap();

        let account = "5InvalidMasterAccount";
        let owner = account_key(account);
        for label in ["alpha", "beta"] {
            sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, ?)")
                .bind(&owner)
                .bind(format!("/tmp/{label}"))
                .bind(label)
                .execute(&pool)
                .await
                .unwrap();
        }

        // Invalid master — every folder's derive step will fail. Under the
        // warn+continue policy the helper must still return Ok and NOT
        // write any file.
        reencrypt_all_folder_mnemonics(&pool, account, "not a bip39 mnemonic", "any-password")
            .await
            .unwrap();

        for label in ["alpha", "beta"] {
            let enc = config_dir_for_folder(account, label).unwrap().join("enc_mnemonic.json");
            assert!(!enc.exists(), "{label}: no file should be written when derivation fails");
        }
    }
}
