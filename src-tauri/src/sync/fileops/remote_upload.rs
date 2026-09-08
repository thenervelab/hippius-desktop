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

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

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

/// Send one file to a folder this device does not sync.
pub(crate) async fn upload_to_remote_folder(
    state: &AppState,
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    parent_path: &str,
    source: &Path,
    identity: &DriveIdentity,
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

    let result = (|| -> Result<Manifest> {
        let ciphertext_hash = encrypt_to_temp(source, &ciphertext_path, &encryption_key)?;
        let signature = signing_key.sign(Manifest::generate_text(&ciphertext_hash).as_bytes());

        Ok(Manifest {
            ss58_address: account_id.to_string(),
            folder_hash: hcfs_client::drive::keys::folder_hash(label),
            ciphertext_hash,
            size_bytes,
            timestamp: chrono::Utc::now().timestamp(),
            signature: signature.to_bytes(),
            signing_key: signing_key.verifying_key().to_bytes(),
            path_hash,
            salted_hash,
            // A first upload of this path has no base revision; the server
            // treats it as a new file and rejects a stale one on conflict.
            revision_seq: 0,
            base_revision_id: None,
            encrypted_path,
            file_name: Some(file_name.clone()),
            relative_path: Some(relative_path.clone()),
            ..Default::default()
        })
    })();

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
            return Err(e);
        }
    };

    let client = crate::sync::fileops::remote::build_client(pool, account_id, identity).await?;
    let outcome = client
        .upload(manifest, &ciphertext_path, None::<fn(u64, u64)>)
        .await
        .map_err(|e| AppError::Hcfs(format!("Upload failed: {e}")));
    cleanup(&ciphertext_path);
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

    let mut failures = Vec::new();
    for path in &file_paths {
        let source = std::path::Path::new(path);
        if let Err(e) = upload_to_remote_folder(state.inner(), pool, &account_id, &label, &parent, source, &identity).await {
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
