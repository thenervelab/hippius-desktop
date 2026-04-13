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

#[cfg(test)]
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
}
