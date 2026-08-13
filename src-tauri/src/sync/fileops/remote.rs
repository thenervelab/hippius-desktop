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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{error, info};
use zeroize::Zeroize;

// ─── DB Helpers (desktop-specific) ─────────────────────────────────────────

fn master_mnemonic_path(account_id: &str) -> Result<PathBuf> {
    // `home_dir()==None` is an environment fault, not user input — no typed
    // variant fits, so it stays the catch-all `Other` (the FE displays it
    // generically). Kept identical to the two other home_dir sites below.
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("Could not determine home directory".into()))?;
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
/// when its `encryption_version` is 1 or 2 (v2 adds the account-id AAD,
/// audit R-33). Without this, the raw base64
/// ciphertext from the column would be passed to `recover_mnemonic`
/// as if it were the plaintext password — which fails with
/// "Decryption failed - wrong password?" and surfaces as "Failed to load
/// remote files" in the browse-folder dialog (and the matching failure in
/// `download_remote_file`).
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
///
/// Returns a `Zeroizing<String>` so the heap copy is wiped when the caller
/// drops it (the callers hold it across async download/decrypt work); the
/// previous bare `String` left a plaintext master-mnemonic copy in freed heap
/// after every preview/download (audit R-20). Callers pass `&mnemonic` to
/// `&str` params, which deref-coerces unchanged.
fn session_mnemonic(state: &AppState) -> Result<zeroize::Zeroizing<String>> {
    // A poisoned mutex flows through `?` to `AppError::Lock` via the blanket
    // `From<PoisonError>` impl (matching every other `state.auth.lock()?` call
    // site), instead of a hand-rolled `Other`. The guard never crosses an await
    // (this fn is sync), so holding it here is fine.
    let auth = state.auth.lock()?;
    auth.mnemonic
        .as_ref()
        .map(|z| zeroize::Zeroizing::new(z.as_str().to_string()))
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
/// because the first already moved the shared part away). The process id plus a
/// monotonic counter make every attempt's
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
    // Lists another account's remote files under its token; authorize against
    // the session (sibling download/cache commands are already guarded).
    let account_id = state.require_session_account(&account_id)?;
    list_remote_folder_files_inner(state.inner(), &account_id, &label).await
}

/// Inner of [`list_remote_folder_files`], taking `&AppState` so live e2e tests
/// can drive it without a `tauri::State`. The command wrapper performs the
/// session-authority check before delegating here (mirrors the `*_inner` split
/// used by `list_sync_folder_grouped_inner` and friends).
pub async fn list_remote_folder_files_inner(state: &AppState, account_id: &str, label: &str) -> Result<Vec<RemoteFileInfo>> {
    info!(account_id = %account_id, label = %label, "Listing remote folder files");
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(state)?;
    let encryption_key = encryption_key_for_label(pool, account_id, label, &mnemonic).await?;
    let client = build_client(pool, account_id, label).await?;
    let fhash = folder_hash(label);

    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: account_id,
        folder_hash: &fhash,
        encryption_key: &encryption_key,
    };
    hcfs_client::drive::remote::list_remote_files(&access).await.map_err(|e| {
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

    // The account is the authority for the bearer token and encryption key
    // used below; trust the session, not the webview-supplied argument.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(&state)?;
    let encryption_key = encryption_key_for_label(pool, &account_id, &label, &mnemonic).await?;
    let client = build_client(pool, &account_id, &label).await?;
    let fhash = folder_hash(&label);

    let progress_file_id = file_id.clone();
    let progress_app = app.clone();

    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: &account_id,
        folder_hash: &fhash,
        encryption_key: &encryption_key,
    };
    hcfs_client::drive::remote::download_remote_file(
        &access,
        &file_id,
        &PathBuf::from(&output_path),
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

    // Decrypts another-account's file under the session's token/key path, so
    // the requested account must be the active session account.
    let account_id = state.require_session_account(&account_id)?;

    // Must live under the asset-protocol scope, which is deliberately ONLY
    // `$HOME/.hippius/preview-cache/**` (tauri.conf.json) — scoping all of
    // `~/.hippius` let a compromised renderer fetch `master_enc_mnemonic.json`
    // and the SQLite DB through `http://asset.localhost` (R-03). The OS cache
    // dir is OUTSIDE the scope, so a preview pointed there is blocked by the
    // asset protocol even though the download + decrypt succeeded — which is
    // why download worked but preview didn't.
    // home_dir None → documented Other (environment fault, no typed variant
    // fits); same rationale as master_mnemonic_path.
    let cache_root = dirs::home_dir()
        .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
        .join(".hippius")
        .join("preview-cache");
    tokio::fs::create_dir_all(&cache_root).await?;

    // Content-addressed when we have it (never stale across edits); else keyed
    // by the path hash. Both values are hex/base-N, so filename-safe. Keep the
    // original extension so the webview infers the right MIME type.
    let key = if arion_hash.is_empty() { &file_id } else { &arion_hash };
    let ext = std::path::Path::new(&file_name).extension().and_then(|e| e.to_str()).unwrap_or("");
    let cache_name = if ext.is_empty() { key.clone() } else { format!("{key}.{ext}") };
    let target = cache_root.join(&cache_name);

    // Cache hit: reuse the already-decrypted copy.
    if matches!(tokio::fs::metadata(&target).await, Ok(meta) if meta.len() > 0) {
        // A non-UTF-8 cache path we can't hand to the webview: no typed variant
        // fits a `to_str()` None, so it stays the documented catch-all `Other`.
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
    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: &account_id,
        folder_hash: &fhash,
        encryption_key: &encryption_key,
    };
    if let Err(e) = hcfs_client::drive::remote::download_remote_file(
        &access,
        &file_id,
        &part,
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

    // A rename failure is an I/O fault → `AppError::Io` (typed `#[from]`), which
    // can't carry the path pair, so log it first (the migration-slice pattern:
    // Io for the kind, a tracing line for the context the variant can't hold).
    if let Err(e) = tokio::fs::rename(&part, &target).await {
        error!(part = %part.display(), target = %target.display(), "failed to promote preview cache: {e}");
        return Err(AppError::Io(e));
    }

    info!(file_id = %file_id, "Remote file cached for preview");
    // Same non-UTF-8 path case as the cache-hit return above → documented Other.
    target
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("preview cache path is not valid UTF-8".into()))
}

// ─── Thumbnails ────────────────────────────────────────────────────────────

/// Root dir for cached thumbnails. Under `$HOME/.hippius/**` so the webview can
/// load them via `convertFileSrc` — same asset-scope reasoning as the preview
/// cache (the OS cache dir is outside the scope and would be blocked).
fn thumbnail_cache_root() -> Result<PathBuf> {
    // home_dir None → documented Other (environment fault); see master_mnemonic_path.
    Ok(dirs::home_dir()
        .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
        .join(".hippius")
        .join("thumbnail-cache"))
}

/// Deterministic, content-addressed cache filename for a thumbnail. `key` is the
/// file's content hash (`arion_hash`) when known, else its path hash
/// (`file_id`); `max_dim` is folded in so a later request for a different size
/// can't collide with (or serve a stale) entry. Always `.jpg` — the thumbnail
/// encoder's output format regardless of the source type.
fn thumbnail_cache_name(key: &str, max_dim: u32) -> String {
    format!("{key}_{max_dim}.jpg")
}

/// Resolve a usable on-disk source path, or `None` when the file isn't present
/// locally (cloud-only). A blank `source`, a missing path, or a non-file all
/// fall through to `None` so the caller takes the download path. This is the
/// same "is it really on disk" gate `useViewableFileUrl` applies on the FE.
async fn local_source_path(source: Option<&str>) -> Option<PathBuf> {
    let s = source?.trim();
    if s.is_empty() {
        return None;
    }
    let p = PathBuf::from(s.replace('\\', "/"));
    match tokio::fs::metadata(&p).await {
        Ok(meta) if meta.is_file() => Some(p),
        _ => None,
    }
}

/// Download + decrypt one cloud file to `dest`. The shared cloud-fetch core so
/// the preview cache and the thumbnailer use one key-derivation → client-build →
/// download path. `account_id` MUST already be the validated session account.
///
/// # Errors
/// [`AppError::NotReady`] (no session mnemonic), [`AppError::Crypto`] (key
/// derivation), or [`AppError::Hcfs`] (download/decrypt).
pub async fn download_cloud_file_to(state: &AppState, account_id: &str, label: &str, file_id: &str, dest: &Path) -> Result<()> {
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(state)?;
    let encryption_key = encryption_key_for_label(pool, account_id, label, &mnemonic).await?;
    let client = build_client(pool, account_id, label).await?;
    let fhash = folder_hash(label);
    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: account_id,
        folder_hash: &fhash,
        encryption_key: &encryption_key,
    };
    hcfs_client::drive::remote::download_remote_file(
        &access,
        file_id,
        dest,
        // No progress events: a thumbnail fetch is a small one-shot.
        Some(|_: u64, _: u64| {}),
    )
    .await
    // Discard the downloaded byte count — callers only need success/failure.
    .map(|_bytes| ())
    .map_err(|e| AppError::Hcfs(e.to_string()))
}

/// Decode `src`, scale it to fit within `max_dim` (aspect preserved, never
/// upscaled), and write a JPEG to `target` via a unique temp + atomic rename.
/// Format is sniffed from the bytes (`with_guessed_format`), not the path, so a
/// `.part` download temp or a mis-extensioned file still decodes.
///
/// CPU-bound and blocking — callers MUST run it on a blocking thread.
///
/// # Errors
/// [`AppError::Other`] when the source can't be decoded or the JPEG can't be
/// written; [`AppError::Io`] when the atomic rename into place fails.
fn generate_thumbnail_file(src: &Path, cache_root: &Path, cache_name: &str, target: &Path, max_dim: u32) -> Result<()> {
    // The whole decode pipeline reports the documented `Other` (see the fn doc):
    // `image`'s `ImageError` has no `AppError` variant, and the io-typed
    // open/guess steps are grouped with it so a thumbnail failure is ONE kind
    // rather than a confusing Io-vs-Other split mid-pipeline.
    let img = image::ImageReader::open(src)
        .map_err(|e| AppError::Other(format!("open image for thumbnail: {e}")))?
        .with_guessed_format()
        .map_err(|e| AppError::Other(format!("guess image format: {e}")))?
        .decode()
        .map_err(|e| AppError::Other(format!("decode image for thumbnail: {e}")))?;

    // `thumbnail` is a fast averaging downscale that preserves aspect ratio and
    // never upscales past the source. `to_rgb8` drops any alpha so the JPEG
    // encoder (which has no alpha channel) accepts the buffer.
    let thumb = img.thumbnail(max_dim, max_dim).to_rgb8();

    // Write to a per-attempt-unique sibling then rename, mirroring the preview
    // cache's atomic-promote invariant: a crash mid-encode never leaves a
    // half-written JPEG that the cache-hit check (non-zero length) would serve.
    let part = unique_part_path(cache_root, cache_name);
    if let Err(e) = thumb.save_with_format(&part, image::ImageFormat::Jpeg) {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::Other(format!("encode thumbnail: {e}")));
    }
    std::fs::rename(&part, target).map_err(AppError::Io)?;
    Ok(())
}

fn thumbnail_path_to_string(p: &Path) -> Result<String> {
    // Non-UTF-8 path → documented Other (no typed variant fits `to_str()` None);
    // same rationale as the preview-cache paths.
    p.to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("thumbnail cache path is not valid UTF-8".into()))
}

/// Return a cached thumbnail path for an image, generating it on first request.
///
/// Unlike the FE's `getFileUrl` (which only resolves files already on disk),
/// this works for files NOT present on this device — uploads from other devices
/// or folders not synced here: with no local copy it downloads + decrypts the
/// file (the same path as [`cache_remote_file`]), thumbnails it, and **discards
/// the full decrypted copy** so only the small JPEG persists. Local synced files
/// are thumbnailed straight from disk with no network.
///
/// The result lives under `$HOME/.hippius/thumbnail-cache/` and is
/// content-addressed (`arion_hash`, else `file_id`, plus `max_dim`), so
/// re-browsing the same grid is a metadata-only cache hit.
///
/// # Errors
/// - [`AppError::Validation`] when neither a content hash nor a file id is given.
/// - [`AppError::NotReady`] when no session mnemonic is loaded (re-auth needed).
/// - [`AppError::Hcfs`]/[`AppError::Crypto`] on download/decrypt failure.
/// - [`AppError::Other`] when the image can't be decoded or encoded.
#[tauri::command]
pub async fn get_thumbnail(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    file_id: String,
    arion_hash: String,
    source: Option<String>,
    max_dim: Option<u32>,
) -> Result<String> {
    // Decrypts another account's file under the session's token/key path when
    // the file is cloud-only, so the requested account must be the session one.
    let account_id = state.require_session_account(&account_id)?;
    // Clamp to a sane thumbnail range so a webview can't request a 100k-px decode.
    let max_dim = max_dim.unwrap_or(256).clamp(32, 1024);

    let key = if arion_hash.is_empty() { file_id.as_str() } else { arion_hash.as_str() };
    if key.is_empty() {
        return Err(AppError::Validation("thumbnail requires a content hash or file id".into()));
    }

    let cache_root = thumbnail_cache_root()?;
    tokio::fs::create_dir_all(&cache_root).await?;
    let cache_name = thumbnail_cache_name(key, max_dim);
    let target = cache_root.join(&cache_name);

    // Cache hit — reuse the already-generated thumbnail.
    if matches!(tokio::fs::metadata(&target).await, Ok(meta) if meta.len() > 0) {
        return thumbnail_path_to_string(&target);
    }

    // Source bytes: the local synced copy when present, else a throwaway
    // download of the cloud file (deleted after thumbnailing below).
    let (src_path, cloud_temp) = if let Some(local) = local_source_path(source.as_deref()).await {
        (local, None)
    } else {
        let tmp = unique_part_path(&cache_root, &cache_name);
        if let Err(e) = download_cloud_file_to(&state, &account_id, &label, &file_id, &tmp).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
        (tmp.clone(), Some(tmp))
    };

    // Decode + resize + encode off the async runtime (CPU-bound).
    let encode = {
        let src = src_path.clone();
        let cache_root = cache_root.clone();
        let cache_name = cache_name.clone();
        let target = target.clone();
        // A tokio `JoinError` (the blocking task panicked) has no typed variant
        // → documented Other.
        tokio::task::spawn_blocking(move || generate_thumbnail_file(&src, &cache_root, &cache_name, &target, max_dim))
            .await
            .map_err(|e| AppError::Other(format!("thumbnail task panicked: {e}")))?
    };

    // Always reclaim the throwaway cloud download, success or not — only the
    // small JPEG should persist on disk.
    if let Some(tmp) = cloud_temp {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    encode?;

    info!(label = %label, key = %key, "Generated thumbnail");
    thumbnail_path_to_string(&target)
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

        // The core of the race guard: two concurrent previews of the SAME
        // uncached file must download to DIFFERENT temp paths so they can't
        // interleave into one file or race the rename.
        assert_ne!(a, b, "two attempts on the same cache_name must produce distinct temp paths");

        for p in [&a, &b] {
            let s = p.to_str().expect("temp path is UTF-8");
            assert!(
                p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("part")),
                "temp file must end in .part: {s}"
            );
            // The deterministic cache_name stem is preserved so the file keeps
            // its extension (MIME inference) and is recognisably a sibling.
            assert!(s.contains(cache_name), "temp path must carry the cache_name stem: {s}");
            assert!(s.starts_with(root.to_str().unwrap()), "temp path must live under the cache root: {s}");
        }
    }

    #[test]
    fn thumbnail_cache_name_is_content_and_size_addressed() {
        assert_eq!(thumbnail_cache_name("abc", 256), "abc_256.jpg");
        // Different sizes must not collide so a 128px request never serves a
        // cached 256px thumbnail (or vice versa).
        assert_ne!(thumbnail_cache_name("abc", 256), thumbnail_cache_name("abc", 128));
        // Different content hashes must not collide.
        assert_ne!(thumbnail_cache_name("abc", 256), thumbnail_cache_name("xyz", 256));
    }

    /// Wire-contract pin for the FOREIGN `hcfs_client::drive::remote::RemoteFileInfo`,
    /// which `list_remote_folder_files` returns RAW (no desktop wrapper) and the FE
    /// `RemoteFolderBrowser` reads as `{file_id, path, name, size_bytes, arion_hash,
    /// created_at, updated_at}`. The struct is foreign and `#[derive(Serialize)]`
    /// with NO `rename_all`, so an hcfs bump that renames a field — or adds
    /// `rename_all = "camelCase"` — would break the browser with NO compile error
    /// here (the desktop never names these fields) and NO existing test failure.
    /// This pins the snake_case key set so such a bump fails CI instead. AUDIT gap H3.
    #[test]
    fn remote_file_info_pins_wire_shape() {
        use std::collections::BTreeSet;

        let info = RemoteFileInfo {
            file_id: "deadbeef".to_string(),
            path: "photos/beach.jpg".to_string(),
            name: "beach.jpg".to_string(),
            size_bytes: 2048,
            arion_hash: Some("Qm123".to_string()),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_005,
        };
        let json = serde_json::to_value(&info).expect("serialize RemoteFileInfo");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["arion_hash", "created_at", "file_id", "name", "path", "size_bytes", "updated_at"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            keys, expected,
            "RemoteFileInfo wire keys drifted — FE RemoteFolderBrowser reads these snake_case keys"
        );

        // `arion_hash` is `Option` with no `skip_serializing_if`, so the key must
        // stay present (serialized `null`) when None — the FE types it `string | null`.
        let none_hash = RemoteFileInfo { arion_hash: None, ..info };
        let json_none = serde_json::to_value(&none_hash).expect("serialize None arion_hash");
        assert!(
            json_none.get("arion_hash").is_some_and(serde_json::Value::is_null),
            "arion_hash must serialize as null, not be omitted"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_source_path_only_resolves_existing_regular_files() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        // None / blank / missing all fall through to the download path.
        assert!(local_source_path(None).await.is_none());
        assert!(local_source_path(Some("   ")).await.is_none());
        assert!(local_source_path(Some("/no/such/hippius/file.png")).await.is_none());
        // A directory is not a usable file source.
        assert!(local_source_path(dir.path().to_str()).await.is_none());
        // A real file resolves.
        let f = dir.path().join("pic.png");
        tokio::fs::write(&f, b"bytes").await.expect("write");
        assert_eq!(local_source_path(f.to_str()).await.expect("resolves"), f);
    }

    #[test]
    fn generate_thumbnail_file_downscales_preserving_aspect_and_writes_jpeg() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        // 400×200 source → fitting 128 keeps aspect → 128×64.
        let src = dir.path().join("src.png");
        image::RgbImage::from_pixel(400, 200, image::Rgb([10, 200, 30]))
            .save(&src)
            .expect("write src");

        let target = dir.path().join("out_128.jpg");
        generate_thumbnail_file(&src, dir.path(), "out_128.jpg", &target, 128).expect("thumbnail");

        assert!(std::fs::metadata(&target).expect("exists").len() > 0, "thumbnail must be non-empty");
        let thumb = image::open(&target).expect("decodes as a valid image");
        assert_eq!((thumb.width(), thumb.height()), (128, 64), "aspect ratio must be preserved");
    }

    #[test]
    fn generate_thumbnail_file_decodes_despite_a_non_image_extension() {
        // The cloud-download temp is named `<name>.jpg.<pid>.<n>.part`, so the
        // decoder must sniff bytes, not trust the extension.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let src = dir.path().join("payload.part");
        image::RgbImage::from_pixel(64, 64, image::Rgb([0, 0, 0]))
            .save_with_format(&src, image::ImageFormat::Png)
            .expect("write png-as-part");

        let target = dir.path().join("out_32.jpg");
        generate_thumbnail_file(&src, dir.path(), "out_32.jpg", &target, 32).expect("decodes via byte sniffing");
        assert!(std::fs::metadata(&target).expect("exists").len() > 0);
    }

    /// Build an in-memory pool with the production schema (so `hcfs_config`
    /// matches `ensure_hcfs_config`, not a hand-rolled DDL that could drift).
    async fn schema_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open sqlite::memory:");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("apply schema");
        pool
    }

    /// `download_cloud_file_to` is the shared cloud-fetch core behind the
    /// preview cache and the thumbnailer, adapted to hcfs-client's
    /// `RemoteFileAccess` API. Before any network/crypto it must fail closed
    /// with `NotReady(NoEncryptionKey)` when the session carries no mnemonic
    /// (the cold-start "Mnemonic required" guard) — never panic or proceed.
    #[tokio::test]
    async fn download_cloud_file_to_requires_session_mnemonic() {
        let state = AppState::new();
        state.set_pool(schema_pool().await);
        // No mnemonic seeded on `state.auth`.

        let dir = tempfile::TempDir::new().expect("tempdir");
        let dest = dir.path().join("out.bin");
        let err = download_cloud_file_to(&state, "5SessionlessAccount", "label", "deadbeef", &dest)
            .await
            .expect_err("must fail without a session mnemonic");

        assert!(
            matches!(err, AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey)),
            "expected NotReady(NoEncryptionKey), got {err:?}"
        );
    }

    /// With a session mnemonic and a `hcfs_config` drive-password row, but no
    /// `master_enc_mnemonic.json` on disk, key derivation must surface a clear
    /// `AppError::Hcfs` (from `recover_mnemonic`) rather than panicking — the
    /// guard the cloud-fetch path relies on before building the HCFS client.
    /// `HOME` is pointed at a tempdir so `master_mnemonic_path` resolves to a
    /// directory with no key file; serialised by `HOME_LOCK`.
    #[allow(
        clippy::await_holding_lock,
        reason = "Test holds HOME_LOCK across awaits to serialise $HOME overrides. #[tokio::test] runs on a current-thread runtime so awaits don't contend on this lock — see test_helpers.rs."
    )]
    #[tokio::test]
    async fn download_cloud_file_to_errors_when_master_mnemonic_missing() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // SAFETY: the HOME override is serialised by HOME_LOCK (see test_helpers);
        // #[tokio::test] is current-thread so no await contends on the env.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let account = "5MasterMissingAccount";
        let pool = schema_pool().await;
        // encryption_version = 0 -> get_drive_password returns the plaintext, so
        // the failure lands at recover_mnemonic (missing file), not earlier.
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, '', ?, 0)")
            .bind(account_key(account))
            .bind("pw-123")
            .execute(&pool)
            .await
            .expect("seed hcfs_config");

        let state = AppState::new();
        state.set_pool(pool);
        state.auth.lock().expect("auth lock").mnemonic = Some(zeroize::Zeroizing::new("test mnemonic phrase".to_string()));

        let dest = tmp.path().join("out.bin");
        let err = download_cloud_file_to(&state, account, "label", "deadbeef", &dest)
            .await
            .expect_err("must fail when the master mnemonic file is absent");

        assert!(
            matches!(err, AppError::Hcfs(_)),
            "expected Hcfs(recover master mnemonic) error, got {err:?}"
        );
    }
}
