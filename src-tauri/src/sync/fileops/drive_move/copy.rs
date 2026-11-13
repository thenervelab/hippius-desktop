//! One file's copy: its plaintext encrypted again under the destination
//! drive's key, described in a signed manifest and staged on the move.
//!
//! No crypto is written here: the cipher, the path hash and seal, and the
//! manifest are the same hcfs primitives `remote_upload` assembles, and the
//! manifest itself comes from `remote_upload::signed_manifest`.

use super::api::MoveApi;
use super::wire::{MoveRefusal, StageMoveSessionRequest};
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;
use crate::sync::remote_upload::{ManifestFields, UPLOAD_CHUNK_SIZE, read_chunk, signed_manifest, transport_chunk_count};
use hcfs_crypto::FileKey;
use hcfs_shared::salted_hash::SaltedHash;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// A plaintext read once into its ciphertext, with what was learned on the
/// way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// BLAKE3 of the ciphertext, hex: what the manifest signs.
    pub ciphertext_hash: String,
    /// `BLAKE3(source owner || plaintext)`: compared with the source row's,
    /// so the bytes encrypted are exactly the revision the commit names.
    pub source_salted: [u8; 32],
    /// `BLAKE3(destination owner || plaintext)`: the copy's own hash, the
    /// one the destination's sync engine computes when it scans the file.
    pub dest_salted: [u8; 32],
    pub size: u64,
}

/// Feeds every byte read through two salted hashers.
struct Tee<R> {
    inner: R,
    source: blake3::Hasher,
    dest: blake3::Hasher,
    read: u64,
}

impl<R: Read> Read for Tee<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.source.update(&buf[..n]);
        self.dest.update(&buf[..n]);
        self.read += n as u64;
        Ok(n)
    }
}

/// Encrypt `plaintext` into `ciphertext` in ONE read, hashing the same
/// bytes for both salts as they pass. Reading the file once is what makes
/// the source check airtight: a file that changes during the read cannot
/// produce a ciphertext of one version and a hash of another.
pub fn seal(plaintext: &Path, ciphertext: &Path, key: &FileKey, source_salt: &str, dest_salt: &str) -> Result<Sealed> {
    let file = std::fs::File::open(plaintext)?;
    let size = file.metadata()?.len();
    let mut source = blake3::Hasher::new();
    source.update(source_salt.as_bytes());
    let mut dest = blake3::Hasher::new();
    dest.update(dest_salt.as_bytes());
    let mut reader = Tee {
        inner: std::io::BufReader::new(file),
        source,
        dest,
        read: 0,
    };
    let mut writer = std::io::BufWriter::new(std::fs::File::create(ciphertext)?);
    let mut ct_hasher = blake3::Hasher::new();
    hcfs_crypto::encrypt_stream_with_hash(&mut reader, &mut writer, key, size, &mut ct_hasher, None::<fn(u64, u64)>)
        .map_err(|e| AppError::Crypto(format!("Encryption failed: {e}")))?;
    std::io::Write::flush(&mut writer)?;
    if reader.read != size {
        // Grew or shrank while it was read: not the file that was measured.
        return Err(AppError::Validation(CHANGED_WHILE_MOVING.into()));
    }
    Ok(Sealed {
        ciphertext_hash: ct_hasher.finalize().to_hex().to_string(),
        source_salted: reader.source.finalize().into(),
        dest_salted: reader.dest.finalize().into(),
        size,
    })
}

/// What the person reads when a file's bytes are not the revision Hippius
/// holds (it changed here and has not synced, or changed while it was read).
pub const CHANGED_WHILE_MOVING: &str = "A file changed while it was being moved.";

/// Everything one copy's session needs.
pub struct StageRequest<'a> {
    pub api: &'a MoveApi,
    pub move_id: &'a str,
    pub dest: &'a DriveIdentity,
    pub key: &'a FileKey,
    pub signing_key: &'a ed25519_dalek::SigningKey,
    pub ciphertext: &'a Path,
    pub sealed: &'a Sealed,
    pub dest_path: &'a str,
    pub source_path_hash: [u8; 32],
    pub expected_revision_id: [u8; 32],
    pub cancel: &'a Arc<AtomicBool>,
}

/// Why staging one copy stopped.
#[derive(Debug)]
pub enum StageError {
    Cancelled,
    Refused(MoveRefusal),
    Local(AppError),
}

/// Open a copy session on the move, send the chunks, and finalize it,
/// which stages the copy. `progress` hears the bytes sent so far.
pub async fn stage(req: StageRequest<'_>, progress: impl Fn(u64)) -> std::result::Result<(), StageError> {
    let file_name = crate::sync::files::move_entries::basename_of(req.dest_path).to_string();
    let path_hash = hcfs_crypto::compute_path_hash(req.dest_path);
    let encrypted_path = hcfs_crypto::encrypt_small(req.dest_path.as_bytes(), req.key)
        .map_err(|e| StageError::Local(AppError::Crypto(format!("Failed to seal path: {e}"))))?;
    let mut manifest = signed_manifest(ManifestFields {
        signing_key: req.signing_key,
        identity: req.dest,
        ciphertext_hash: req.sealed.ciphertext_hash.clone(),
        size_bytes: req.sealed.size,
        path_hash,
        salted_hash: SaltedHash::from_bytes(req.sealed.dest_salted),
        encrypted_path,
        file_name: &file_name,
        relative_path: req.dest_path,
    });
    // A copy declares NO capture. The commit gives the destination row the
    // copy's capture kind when it declares one, else the SOURCE's
    // (`COALESCE(c.capture_kind, s.capture_kind)`, hcfs#1313), and the
    // Free plan's recording count and limit check follow the same rule. The
    // source's kind is not readable here (`get_state` does not carry it, and
    // a recording may have been tagged after upload), so any declaration
    // would be a guess: one on a recording adds nothing the source does not
    // already carry, and one on anything else would turn an ordinary video
    // into a recording. Declaring none keeps exactly what the source was.
    manifest.capture = None;
    let ciphertext_size = std::fs::metadata(req.ciphertext).map_err(|e| StageError::Local(e.into()))?.len();
    let chunk_count = transport_chunk_count(ciphertext_size).map_err(StageError::Local)?;
    let session = req
        .api
        .open_copy_session(
            req.move_id,
            &StageMoveSessionRequest {
                session: hcfs_shared::network::CreateSessionRequest {
                    manifest,
                    chunk_count,
                    chunk_size: UPLOAD_CHUNK_SIZE,
                    ciphertext_size,
                },
                source_path_hash: req.source_path_hash,
                expected_revision_id: req.expected_revision_id,
            },
        )
        .await
        .map_err(StageError::Refused)?;

    let mut sent = 0u64;
    for index in 0..chunk_count {
        if req.cancel.load(Ordering::SeqCst) {
            return Err(StageError::Cancelled);
        }
        let chunk = read_chunk(req.ciphertext, index, ciphertext_size).await.map_err(StageError::Local)?;
        let len = chunk.len() as u64;
        req.api.put_chunk(&session.session_id, index, chunk).await.map_err(StageError::Refused)?;
        sent += len;
        progress(sent.min(req.sealed.size));
    }
    if req.cancel.load(Ordering::SeqCst) {
        return Err(StageError::Cancelled);
    }
    req.api.finalize(&session.session_id).await.map_err(StageError::Refused)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_read_gives_the_cipher_and_both_salted_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("a.txt");
        std::fs::write(&plain, b"hello drive").unwrap();
        let key = FileKey::from_bytes([7; 32]);
        let sealed = seal(&plain, &dir.path().join("a.bin"), &key, "5Source", "5Dest").unwrap();

        let (source, size) = hcfs_crypto::compute_salted_hash(&mut std::fs::File::open(&plain).unwrap(), "5Source").unwrap();
        let (dest, _) = hcfs_crypto::compute_salted_hash(&mut std::fs::File::open(&plain).unwrap(), "5Dest").unwrap();
        assert_eq!(sealed.source_salted, source, "the same hash the server holds for the source");
        assert_eq!(sealed.dest_salted, dest, "the same hash the destination engine computes when it scans");
        assert_eq!(sealed.size, size);

        // The ciphertext opens with the key, back to the same bytes.
        let mut out = Vec::new();
        hcfs_crypto::decrypt_stream(
            &mut std::fs::File::open(dir.path().join("a.bin")).unwrap(),
            &mut out,
            &key,
            None,
            None::<fn(u64, u64)>,
        )
        .unwrap();
        assert_eq!(out, b"hello drive");
        let ct = std::fs::read(dir.path().join("a.bin")).unwrap();
        assert_eq!(sealed.ciphertext_hash, blake3::hash(&ct).to_hex().to_string());
    }
}
