//! Tauri IPC commands for browsing remote folder contents and downloading
//! individual files without starting a full sync.
//!
//! Delegates to `hcfs_client::drive::remote` for the core logic.
//! This module handles DB lookups and Tauri event emission.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use hcfs_client::drive::keys::folder_hash;
use hcfs_client::drive::remote::RemoteFileInfo;
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{error, info};
use zeroize::Zeroize;

// ─── DB Helpers (desktop-specific) ─────────────────────────────────────────

fn master_mnemonic_path(account_id: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or(AppError::Validation("Could not determine home directory".into()))?;
    let key = account_key(account_id);
    Ok(home.join(".hippius").join("drives").join(key).join("master_enc_mnemonic.json"))
}

/// Read `hcfs_config.server_url` for this account, normalised for
/// hcfs-client's region probe.
///
/// Returns an empty string when the DB row is missing, holds an empty
/// string, or holds the legacy single-region URL — those three cases all
/// signal hcfs-client to race the regional endpoints and pick the
/// faster one. Any explicitly chosen URL is passed through verbatim.
///
/// This is the canonical "where does this account's HCFS server live?"
/// lookup; other modules (migration, one-shot backfill) delegate here so
/// the empty-vs-explicit decision lives in exactly one place.
pub(crate) async fn get_server_url(pool: &SqlitePool, account_id: &str) -> Result<String> {
    let owner = account_key(account_id);
    let result: Option<(String,)> = sqlx::query_as("SELECT server_url FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    let raw = match result {
        Some((url,)) => url,
        None => String::new(),
    };
    Ok(crate::sync::config::normalize_for_region_probe(&raw))
}

/// Derive the per-folder encryption key from the master mnemonic.
///
/// `mnemonic` is the user's session BIP-39 mnemonic, needed by
/// `get_drive_password` to decrypt the `hcfs_config.drive_password` row
/// when its `encryption_version = 1`. Without this, the raw base64
/// ciphertext from the column would be passed to `recover_mnemonic`
/// as if it were the plaintext password — which fails with
/// "Decryption failed - wrong password?" and was the long-standing bug
/// behind the "Failed to load remote files" error in the browse-folder
/// dialog (and the matching failure in `download_remote_file`).
async fn encryption_key_for_label(pool: &SqlitePool, account_id: &str, label: &str, mnemonic: &str) -> Result<[u8; 32]> {
    let password = crate::sync::config::get_drive_password(pool, account_id, Some(mnemonic)).await?;
    let master_path = master_mnemonic_path(account_id)?;
    let mut master_mnemonic = hcfs_client::auth::recover_mnemonic(&master_path, &password)
        .map_err(|e| AppError::Hcfs(format!("Failed to recover master mnemonic: {e}")))?
        .to_string();
    let key = hcfs_client::drive::remote::derive_encryption_key(&master_mnemonic, label).map_err(|e| AppError::Crypto(e.to_string()));
    master_mnemonic.zeroize();
    key
}

/// Pull the active session mnemonic out of `AppState.auth`. Returns
/// `NoEncryptionKey` if no mnemonic is loaded (e.g. session restored
/// from disk without keychain rehydration — see the cold-start
/// "Mnemonic required" issue).
fn session_mnemonic(state: &AppState) -> Result<String> {
    let auth = state.auth.lock().map_err(|e| AppError::Other(format!("auth lock poisoned: {e}")))?;
    auth.mnemonic
        .as_ref()
        .map(|z| z.as_str().to_string())
        .ok_or(AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey))
}

async fn build_client(pool: &SqlitePool, account_id: &str, label: &str) -> Result<hcfs_client::client::HcfsClient> {
    let server_url = get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or(AppError::Auth("No authentication token found. Please log in again.".into()))?;
    let config = crate::sync::config::build_hcfs_config(&server_url, &bearer_token, account_id, &folder_hash(label));
    hcfs_client::client::HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client: {e}")))
}

/// Build a per-attempt-unique temp path for a preview download.
///
/// The final cache entry is the deterministic `cache_name`, but the in-flight
/// download MUST land on a unique sibling. Two preview surfaces opening the same
/// uncached file near-simultaneously (e.g. the search palette and the files
/// table both resolving the same cloud-only hit) would otherwise share one
/// `{cache_name}.part` and either interleave their writes into one file (a
/// corrupt cache entry served stale forever, since the cache-hit check only
/// asserts non-zero length) or race the rename (the second loser hits ENOENT
/// because the first already moved the shared part away) — audit 2026-06-05
/// finding B2. The process id plus a monotonic counter make every attempt's
/// temp path distinct within this process and across processes; the rename into
/// `cache_name` stays atomic and idempotent (a racing winner's copy has the
/// same content hash, so replacing it is harmless).
fn unique_part_path(cache_root: &std::path::Path, cache_name: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    cache_root.join(format!("{cache_name}.{}.{n}.part", std::process::id()))
}

// ─── Tauri Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_remote_folder_files(state: tauri::State<'_, AppState>, account_id: String, label: String) -> Result<Vec<RemoteFileInfo>> {
    info!(account_id = %account_id, label = %label, "Listing remote folder files");
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    hcfs_client::drive::remote::list_remote_files(&client, &account_id, &fhash, &encryption_key)
        .await
        .map_err(|e| {
            error!(label = %label, "Failed to list remote files: {e}");
            AppError::Hcfs(e.to_string())
        })
}

#[tauri::command]
pub async fn download_remote_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    file_id: String,
    output_path: String,
) -> Result<()> {
    use tauri::Emitter;
    info!(label = %label, file_id = %file_id, "Downloading remote file");

    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    let progress_file_id = file_id.clone();
    let progress_app = app.clone();

    hcfs_client::drive::remote::download_remote_file(
        &client,
        &account_id,
        &fhash,
        &file_id,
        &PathBuf::from(&output_path),
        &encryption_key,
        Some(move |bytes: u64, total: u64| {
            let _ = progress_app.emit(
                "oneoff_download_progress",
                serde_json::json!({
                    "file_id": progress_file_id,
                    "bytes_downloaded": bytes,
                    "total_bytes": total,
                }),
            );
        }),
    )
    .await
    .map_err(|e| AppError::Hcfs(e.to_string()))?;

    info!(file_id = %file_id, "File downloaded and decrypted successfully");
    Ok(())
}

/// Download + decrypt a single remote file into a local preview cache and
/// return its absolute path, so the preview dialogs (image / video / PDF) can
/// display a file that isn't synced to this device — exactly like a synced
/// file resolved through the frontend's `convertFileSrc`.
///
/// The decrypted copy is cached under the OS cache dir
/// (`{cache}/hippius/preview/`). The cache key is the file's content hash
/// (`arion_hash`) when present — so an edit (new content) produces a new entry
/// and a re-open never serves a stale copy — falling back to `file_id` (the
/// path hash) otherwise. The download lands on a per-attempt-unique `.part`
/// sibling first (see [`unique_part_path`]) and is renamed into place
/// atomically, so an interrupted transfer never leaves a half-written file the
/// webview would render as broken, a failed transfer cleans up its partial, and
/// two concurrent previews of the same file can't collide on one temp path.
///
/// Decryption uses the same `hcfs_config.drive_password` → master-mnemonic →
/// folder-key path as [`download_remote_file`]; no password prompt is needed
/// because the drive password lives in the DB and the mnemonic in the session.
///
/// # Errors
///
/// - [`AppError::NotReady`] when no session mnemonic is loaded (re-auth needed).
/// - [`AppError::Hcfs`] / [`AppError::Crypto`] on download or decrypt failure.
/// - [`AppError::Io`] when the cache directory or file cannot be created.
#[tauri::command]
pub async fn cache_remote_file(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    file_id: String,
    file_name: String,
    arion_hash: String,
) -> Result<String> {
    info!(label = %label, file_id = %file_id, "Caching remote file for preview");

    // Must live under the asset-protocol scope (`$HOME/.hippius/**` in
    // tauri.conf.json) so the webview can load the decrypted file via
    // `convertFileSrc`. The OS cache dir is OUTSIDE that scope, so a preview
    // pointed there is blocked by the asset protocol even though the download
    // + decrypt succeeded — which is why download worked but preview didn't.
    let cache_root = dirs::home_dir()
        .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
        .join(".hippius")
        .join("preview-cache");
    tokio::fs::create_dir_all(&cache_root).await?;

    // Content-addressed when we have it (never stale across edits); else keyed
    // by the path hash. Both values are hex/base-N, so filename-safe. Keep the
    // original extension so the webview infers the right MIME type.
    let key = if arion_hash.is_empty() { &file_id } else { &arion_hash };
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let cache_name = if ext.is_empty() { key.clone() } else { format!("{key}.{ext}") };
    let target = cache_root.join(&cache_name);

    // Cache hit: reuse the already-decrypted copy.
    if matches!(tokio::fs::metadata(&target).await, Ok(meta) if meta.len() > 0) {
        return target
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("preview cache path is not valid UTF-8".into()));
    }

    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    let part = unique_part_path(&cache_root, &cache_name);
    if let Err(e) = hcfs_client::drive::remote::download_remote_file(
        &client,
        &account_id,
        &fhash,
        &file_id,
        &part,
        &encryption_key,
        // No progress events: preview is a one-shot interactive fetch.
        Some(|_: u64, _: u64| {}),
    )
    .await
    {
        // Best-effort cleanup of the partially-written download so a failed or
        // interrupted transfer doesn't leak a `.part` file into the cache dir
        // (the doc comment's "never leaves a half-written file" invariant). The
        // unlink result is intentionally discarded — a missing/already-gone
        // partial must not mask the real download error.
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Hcfs(e.to_string()));
    }

    tokio::fs::rename(&part, &target).await.map_err(|e| {
        AppError::Other(format!("failed to promote preview cache {} -> {}: {e}", part.display(), target.display()))
    })?;

    info!(file_id = %file_id, "Remote file cached for preview");
    target
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("preview cache path is not valid UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_part_path_is_distinct_per_attempt_but_keeps_the_cache_name_stem() {
        let root = std::path::Path::new("/tmp/hippius-preview-cache");
        let cache_name = "abc123def.png";
        let a = unique_part_path(root, cache_name);
        let b = unique_part_path(root, cache_name);

        // The core of the B2 race fix: two concurrent previews of the SAME
        // uncached file must download to DIFFERENT temp paths so they can't
        // interleave into one file or race the rename.
        assert_ne!(a, b, "two attempts on the same cache_name must produce distinct temp paths");

        for p in [&a, &b] {
            let s = p.to_str().expect("temp path is UTF-8");
            assert!(s.ends_with(".part"), "temp file must end in .part: {s}");
            // The deterministic cache_name stem is preserved so the file keeps
            // its extension (MIME inference) and is recognisably a sibling.
            assert!(s.contains(cache_name), "temp path must carry the cache_name stem: {s}");
            assert!(s.starts_with(root.to_str().unwrap()), "temp path must live under the cache root: {s}");
        }
    }
}
