//! Upload a file into a Drive folder that is NOT synced on this computer.
//!
//! The sync engine's upload path is built around a local sync root: it
//! walks a directory, diffs it against server state, and pushes what
//! changed. A folder the user is only browsing has no such root, which is
//! why the Drive header hid the upload buttons there.
//!
//! Nothing new is invented here. Every step below is a public
//! `hcfs-client` primitive, assembled in the same order the engine
//! assembles them, and posted to the same `/upload` route the web console
//! posts to. The console builds its manifest from the mirrored
//! `hcfs-client-wasm` primitives, whose byte-for-byte equivalence with
//! these is pinned upstream — so a file uploaded from here and one
//! uploaded from the console are the same bytes on the server.
//!
//! What is deliberately NOT done here: re-deriving any of the crypto. A
//! hand-rolled ciphertext or manifest signature would upload happily and
//! fail to decrypt later, which is silent data loss discovered by a user.

use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use hcfs_shared::network::Manifest;
use sqlx::sqlite::SqlitePool;
use zeroize::Zeroize;

use tauri::Emitter;

use crate::sync::projection::events::REMOTE_UPLOAD_PROGRESS;

/// Smallest gap between two transfer-progress frames for one file.
///
/// Matches the sync engine's own snapshot throttle: the widget cannot
/// render faster than that, so anything more is webview traffic nobody
/// sees.
const PROGRESS_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

/// One file's position in a remote upload, as the widget renders it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUploadProgress {
    /// Stable per-file key for the whole upload — the wire path, which is
    /// unique within the folder, so two files of the same name in
    /// different subfolders do not collapse into one row.
    pub path: String,
    pub file_name: String,
    /// The drive label, shown as the row's folder.
    pub label: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    /// `encrypting` | `inProgress` | `completed` | `error` — the same
    /// vocabulary `FileProgress.status` already uses, so the merge does
    /// not have to translate.
    pub status: String,
    pub error: Option<String>,
}

/// The Ed25519 key the manifest is signed with.
///
/// Mirrors `hcfs-client`'s `Drive::unlock`: the folder mnemonic's seed,
/// first 32 bytes. Derived here rather than reusing the encryption key —
/// the two happen to be the same bytes today, and writing that assumption
/// into a second place is how it survives a change upstream that breaks it.
pub(crate) fn signing_key_for_folder(master_mnemonic: &str, label: &str) -> Result<SigningKey> {
    use bip39::Mnemonic;
    use std::str::FromStr;

    let folder_phrase = hcfs_client::drive::keys::derive_folder_mnemonic(master_mnemonic, label)
        .map_err(|e| AppError::Crypto(format!("Failed to derive folder mnemonic: {e}")))?;
    let folder = Mnemonic::from_str(&folder_phrase).map_err(|e| AppError::Crypto(format!("Invalid derived folder mnemonic: {e}")))?;
    let mut seed = folder.to_seed("");
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&seed[..32]);
    seed.zeroize();
    let key = SigningKey::from_bytes(&secret);
    secret.zeroize();
    Ok(key)
}

/// The file's path inside the folder, as the server stores it.
///
/// Empty `parent_path` means the folder root. Separators are normalised to
/// `/` because this string is hashed into `path_hash` and encrypted into
/// `encrypted_path`: a Windows client sending `Photos\2024\a.jpg` would
/// produce a different hash for the same logical file than a Mac client,
/// and the two would stop recognising each other's uploads.
pub(crate) fn wire_relative_path(parent_path: &str, file_name: &str) -> String {
    let parent = parent_path.replace('\\', "/");
    let parent = parent.trim_matches('/');
    if parent.is_empty() {
        file_name.to_string()
    } else {
        format!("{parent}/{file_name}")
    }
}

/// Encrypt `source` into `dest` and return `(ciphertext_hash, size_bytes)`.
fn encrypt_to_temp(source: &Path, dest: &Path, key: &[u8; 32]) -> Result<String> {
    let mut reader = std::io::BufReader::new(std::fs::File::open(source)?);
    let file_size = std::fs::metadata(source)?.len();
    let mut writer = std::io::BufWriter::new(std::fs::File::create(dest)?);
    let mut hasher = blake3::Hasher::new();

    hcfs_client::crypto::encrypt_stream_with_hash(&mut reader, &mut writer, key, file_size, &mut hasher, None::<fn(u64, u64)>)
        .map_err(|e| AppError::Crypto(format!("Encryption failed: {e}")))?;

    use std::io::Write;
    writer.flush()?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// The per-chunk transfer callback, throttled.
///
/// hcfs calls this per chunk, so a large file would emit hundreds of
/// events into the webview — the same per-item flood `sync-engine.md`
/// warns about, and the reason the engine's own scan/fetch progress rides
/// a throttled snapshot rather than its own channel. One frame per
/// [`PROGRESS_EMIT_INTERVAL`] is all a bar can show; the terminal states
/// are emitted separately and unthrottled, so a row always settles even
/// if its last transfer frame was dropped.
fn transfer_progress(
    app: tauri::AppHandle,
    relative_path: &str,
    file_name: &str,
    label: &str,
    size_bytes: u64,
) -> impl Fn(u64, u64) + Send + Sync + 'static {
    let path = relative_path.to_string();
    let file_name = file_name.to_string();
    let label = label.to_string();
    let last_emit = std::sync::Mutex::new(None::<std::time::Instant>);

    move |sent: u64, total: u64| {
        {
            // A poisoned lock must not stop the upload — skipping a frame
            // is the correct degradation for a progress bar.
            let Ok(mut last) = last_emit.lock() else { return };
            if last.is_some_and(|at| at.elapsed() < PROGRESS_EMIT_INTERVAL) {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        let _ = app.emit(
            REMOTE_UPLOAD_PROGRESS,
            RemoteUploadProgress {
                path: path.clone(),
                file_name: file_name.clone(),
                label: label.clone(),
                bytes_transferred: sent,
                // hcfs reports the CIPHERTEXT length; the row is measured
                // in plaintext bytes so it matches the size shown
                // everywhere else, and a ciphertext slightly larger than
                // the plaintext cannot push the bar past 100%.
                total_bytes: total.max(size_bytes),
                status: "inProgress".into(),
                error: None,
            },
        );
    }
}

/// Everything the manifest for one file is built from.
struct SealRequest<'a> {
    source: &'a Path,
    ciphertext_path: &'a Path,
    encryption_key: &'a [u8; 32],
    signing_key: &'a SigningKey,
    account_id: &'a str,
    label: &'a str,
    size_bytes: u64,
    path_hash: [u8; 32],
    salted_hash: [u8; 32],
    encrypted_path: Vec<u8>,
    file_name: &'a str,
    relative_path: &'a str,
}

/// Encrypt the file and describe it in the manifest the server verifies.
///
/// The two belong together: the manifest signs the ciphertext's hash, so a
/// manifest built against a different encryption than the bytes actually
/// uploaded is a file that lands and cannot be read back.
fn seal_and_describe(req: SealRequest<'_>) -> Result<Manifest> {
    let ciphertext_hash = encrypt_to_temp(req.source, req.ciphertext_path, req.encryption_key)?;
    let signature = req.signing_key.sign(Manifest::generate_text(&ciphertext_hash).as_bytes());

    Ok(Manifest {
        ss58_address: req.account_id.to_string(),
        folder_hash: hcfs_client::drive::keys::folder_hash(req.label),
        ciphertext_hash,
        size_bytes: req.size_bytes,
        timestamp: chrono::Utc::now().timestamp(),
        signature: signature.to_bytes(),
        signing_key: req.signing_key.verifying_key().to_bytes(),
        path_hash: req.path_hash,
        salted_hash: req.salted_hash,
        // A first upload of this path has no base revision; the server
        // treats it as a new file and rejects a stale one on conflict.
        revision_seq: 0,
        base_revision_id: None,
        encrypted_path: req.encrypted_path,
        file_name: Some(req.file_name.to_string()),
        relative_path: Some(req.relative_path.to_string()),
        ..Default::default()
    })
}

/// Send one file to a folder this device does not sync.
///
/// `app` is optional so the live lane can drive this without a Tauri
/// runtime; when present, each phase is emitted so the sync widget can
/// show the file moving instead of a toast sitting there.
pub async fn upload_to_remote_folder(
    state: &AppState,
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    parent_path: &str,
    source: &Path,
    identity: &DriveIdentity,
) -> Result<()> {
    upload_to_remote_folder_with_progress(state, pool, account_id, label, parent_path, source, identity, None).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_to_remote_folder_with_progress(
    state: &AppState,
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    parent_path: &str,
    source: &Path,
    identity: &DriveIdentity,
    app: Option<&tauri::AppHandle>,
) -> Result<()> {
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("File has no usable name".into()))?
        .to_string();

    let mnemonic = crate::sync::fileops::remote::session_mnemonic(state)?;
    let encryption_key = crate::sync::fileops::remote::encryption_key_for_label(pool, account_id, label, &mnemonic, identity).await?;
    let signing_key = signing_key_for_folder(&mnemonic, label)?;

    // The salted hash is over the PLAINTEXT and is what the server uses to
    // recognise the same content again, so it is computed from the source
    // file, never from the ciphertext.
    let (salted_hash, size_bytes) = hcfs_client::crypto::compute_salted_hash_file(source, account_id)
        .map_err(|e| AppError::Crypto(format!("Failed to hash {}: {e}", source.display())))?;

    let relative_path = wire_relative_path(parent_path, &file_name);
    let path_hash = hcfs_client::crypto::compute_path_hash(&relative_path);
    let encrypted_path = hcfs_client::crypto::encrypt_small(relative_path.as_bytes(), &encryption_key)
        .map_err(|e| AppError::Crypto(format!("Failed to seal path: {e}")))?;

    // Encrypt beside the app's own temp area, not next to the user's file:
    // the source may sit on a read-only volume or one the app cannot write.
    let temp_dir = std::env::temp_dir().join("hippius-remote-upload");
    std::fs::create_dir_all(&temp_dir)?;
    let ciphertext_path = temp_dir.join(format!("{}.bin", uuid::Uuid::new_v4()));

    // One emitter for every phase, so a row cannot appear with one shape
    // here and another there.
    let emit = |status: &str, sent: u64, error: Option<String>| {
        if let Some(app) = app {
            let _ = app.emit(
                REMOTE_UPLOAD_PROGRESS,
                RemoteUploadProgress {
                    path: relative_path.clone(),
                    file_name: file_name.clone(),
                    label: label.to_string(),
                    bytes_transferred: sent,
                    total_bytes: size_bytes,
                    status: status.to_string(),
                    error,
                },
            );
        }
    };

    emit("encrypting", 0, None);
    let result = seal_and_describe(SealRequest {
        source,
        ciphertext_path: &ciphertext_path,
        encryption_key: &encryption_key,
        signing_key: &signing_key,
        account_id,
        label,
        size_bytes,
        path_hash,
        salted_hash,
        encrypted_path,
        file_name: &file_name,
        relative_path: &relative_path,
    });

    // The ciphertext is a plaintext-equivalent artifact; remove it whether
    // the upload succeeded, failed, or the manifest never got built.
    let cleanup = |path: &Path| {
        if let Err(e) = std::fs::remove_file(path) {
            tracing::warn!(error = %e, "failed to remove remote-upload ciphertext");
        }
    };

    let manifest = match result {
        Ok(m) => m,
        Err(e) => {
            cleanup(&ciphertext_path);
            emit("error", 0, Some(e.to_string()));
            return Err(e);
        }
    };

    let client = crate::sync::fileops::remote::build_client(pool, account_id, identity).await?;

    // The transfer callback runs on hcfs's thread, so it gets its own
    // owned copies rather than borrowing the closure above.
    let progress = app.map(|app| transfer_progress(app.clone(), &relative_path, &file_name, label, size_bytes));

    let outcome = client
        .upload(manifest, &ciphertext_path, progress)
        .await
        .map_err(|e| AppError::Hcfs(format!("Upload failed: {e}")));
    cleanup(&ciphertext_path);
    match &outcome {
        Ok(_) => emit("completed", size_bytes, None),
        Err(e) => emit("error", 0, Some(e.to_string())),
    }
    outcome.map(|_| ())
}

/// Upload files into a folder this device does not sync.
///
/// Gated like every other Drive write: the bytes have to fit the plan
/// allowance before anything is encrypted, so an over-quota account is
/// refused here rather than after the upload work is done.
///
/// Partial success is real — each file is independent, and one failure
/// should not discard the ones that landed — so failures come back per
/// file rather than as a single error.
#[tauri::command]
pub async fn upload_files_to_remote_folder(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    parent_path: Option<String>,
    file_paths: Vec<String>,
) -> Result<Vec<RemoteUploadFailure>> {
    let account_id = state.require_session_account(&account_id)?;

    let total_bytes: u64 = file_paths.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    crate::billing::eligibility::require_eligible(
        state.inner(),
        &account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload,
        total_bytes,
    )
    .await?;

    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    let parent = parent_path.unwrap_or_default();

    // Announce the WHOLE batch before uploading any of it, so the widget
    // shows a queue rather than one row that is replaced each time the
    // next file starts. Sizes come from disk here because nothing has
    // been read yet; a file that cannot be stat'd still gets a row, since
    // a missing row is worse than an unknown size.
    for path in &file_paths {
        let source = std::path::Path::new(path);
        let Some(name) = source.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let _ = app.emit(
            REMOTE_UPLOAD_PROGRESS,
            RemoteUploadProgress {
                path: wire_relative_path(&parent, name),
                file_name: name.to_string(),
                label: label.clone(),
                bytes_transferred: 0,
                total_bytes: std::fs::metadata(source).map_or(0, |m| m.len()),
                status: "pending".into(),
                error: None,
            },
        );
    }

    let mut failures = Vec::new();
    for path in &file_paths {
        let source = std::path::Path::new(path);
        let sent = upload_to_remote_folder_with_progress(state.inner(), pool, &account_id, &label, &parent, source, &identity, Some(&app)).await;
        if let Err(e) = sent {
            tracing::warn!(file = %path, error = %e, "remote upload failed");
            failures.push(RemoteUploadFailure {
                name: source.file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string(),
                // Rust owns the sentence the user reads — never reqwest's Display.
                error: e.to_string(),
            });
        }
    }
    Ok(failures)
}

/// One file that did not make it, named so the UI can say which.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUploadFailure {
    pub name: String,
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire path is hashed and encrypted, so a Windows separator would
    /// give the same logical file a different identity than a Mac client's.
    #[test]
    fn the_wire_path_always_uses_forward_slashes() {
        assert_eq!(wire_relative_path("Photos\\2024", "a.jpg"), "Photos/2024/a.jpg");
        assert_eq!(wire_relative_path("Photos/2024", "a.jpg"), "Photos/2024/a.jpg");
    }

    /// The folder root is the empty parent, and must not become "/a.jpg" —
    /// a leading slash is a different path_hash.
    #[test]
    fn a_root_upload_is_just_the_file_name() {
        for parent in ["", "/", "//"] {
            assert_eq!(wire_relative_path(parent, "a.jpg"), "a.jpg");
        }
    }

    #[test]
    fn surrounding_separators_do_not_leak_into_the_path() {
        assert_eq!(wire_relative_path("/Photos/", "a.jpg"), "Photos/a.jpg");
    }
}
