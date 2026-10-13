//! Recordings an earlier build HELD on this computer, and their release.
//!
//! Builds before the free plan's recording limit moved to the start of a
//! recording (`recording_allowance`) let a free account at its limit record,
//! then sealed the finished file (chunked ChaCha20-Poly1305, key derived from
//! the mnemonic, never stored) under `~/.hippius/held-recordings/<account>`
//! instead of uploading it. Nothing is held any more: a recording over the
//! limit is refused before it starts. What is left is the way OUT for files
//! already held on testers' machines, so none is stranded:
//!
//! - [`list_held`] reads them (oldest first), and [`release_count`] says how
//!   many the plan allows now: all on a paid plan, as many as there are free
//!   slots on a limited one, none when the plan or the count is unknown;
//! - [`unseal_for_release`] decrypts one into a fresh capture temp folder and
//!   forgets it, and the caller delivers it like a fresh recording.
//!
//! `commands::release_held` runs this once per sign-in. The table and folder
//! are only ever emptied here; nothing writes to them.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sqlx::{Row, SqlitePool};
use zeroize::Zeroizing;

use super::allowance::RecordingTier;
use super::recording_allowance::{FREE_RECORDING_LIMIT, is_limited};
use crate::app_state::AppState;
use crate::error::{AppError, Result};

const HELD_DDL: &str = "CREATE TABLE IF NOT EXISTS capture_held_recordings (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    file_name TEXT NOT NULL,
    sealed_path TEXT NOT NULL,
    held_at INTEGER NOT NULL,
    thumbnail TEXT
)";

async fn ensure_table(pool: &SqlitePool) -> Result<()> {
    sqlx::query(HELD_DDL).execute(pool).await?;
    Ok(())
}

fn owner_of(account_id: &str) -> String {
    crate::auth::account_key::account_key(account_id)
}

/// How many of `held` recordings to release now. Only on a KNOWN plan and,
/// for a limited one, a KNOWN count: a failed read must not hand a free
/// account past its limit.
#[must_use]
pub fn release_count(tier: Option<RecordingTier>, counted: Option<usize>, held: usize) -> usize {
    match (tier, counted) {
        (Some(tier), _) if !is_limited(tier) => held,
        (Some(_), Some(counted)) => held.min(FREE_RECORDING_LIMIT.saturating_sub(counted)),
        _ => 0,
    }
}

// ── Sealing ─────────────────────────────────────────────────────────────────

/// `HHRSEAL1 || nonce prefix (7) || plaintext length (u64 BE)`, then the
/// plaintext in 1 MiB chunks, each ChaCha20-Poly1305 with its own nonce
/// (`prefix || chunk index (u32 BE) || last flag`), the STREAM construction:
/// a chunk cannot be dropped, reordered or cut short without the tag
/// failing, and the file never has to fit in memory.
const SEAL_MAGIC: &[u8; 8] = b"HHRSEAL1";
const SEAL_CHUNK: usize = 1 << 20;
const SEAL_TAG: usize = 16;
const SEAL_PREFIX: usize = 7;

fn chunk_nonce(prefix: [u8; SEAL_PREFIX], index: u32, last: bool) -> chacha20poly1305::Nonce {
    let mut nonce = [0u8; 12];
    nonce[..SEAL_PREFIX].copy_from_slice(&prefix);
    nonce[SEAL_PREFIX..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(last);
    nonce.into()
}

fn chunk_count(len: u64) -> Result<u32> {
    let chunk = SEAL_CHUNK as u64;
    u32::try_from(len.div_ceil(chunk).max(1)).map_err(|_| AppError::Other("recording too large to seal".into()))
}

fn aad_for(account_id: &str) -> Vec<u8> {
    format!("{}:{account_id}", crate::crypto::store::INFO_HELD_RECORDING).into_bytes()
}

/// Encrypt `src` into `dst` the way an earlier build held a recording.
/// Test-only now: nothing is sealed any more, but the release path must
/// still open what was.
#[cfg(test)]
fn seal_file(key: &[u8; 32], account_id: &str, src: &Path, dst: &Path) -> Result<()> {
    use chacha20poly1305::aead::{Aead, AeadCore, OsRng, Payload};
    use chacha20poly1305::{ChaCha20Poly1305, KeyInit};

    let partial = partial_path(dst);
    let result = (|| -> Result<()> {
        let mut input = std::fs::File::open(src)?;
        let len = input.metadata()?.len();
        let chunks = chunk_count(len)?;
        let random = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let mut prefix = [0u8; SEAL_PREFIX];
        prefix.copy_from_slice(&random[..SEAL_PREFIX]);
        let cipher = ChaCha20Poly1305::new(key.into());
        let aad = aad_for(account_id);
        let mut out = std::io::BufWriter::new(std::fs::File::create(&partial)?);
        out.write_all(SEAL_MAGIC)?;
        out.write_all(&prefix)?;
        out.write_all(&len.to_be_bytes())?;
        let mut buf = vec![0u8; SEAL_CHUNK];
        let mut left = len;
        for index in 0..chunks {
            let take = usize::try_from(left.min(SEAL_CHUNK as u64)).unwrap_or(SEAL_CHUNK);
            input.read_exact(&mut buf[..take])?;
            left -= take as u64;
            let sealed = cipher
                .encrypt(
                    &chunk_nonce(prefix, index, index + 1 == chunks),
                    Payload {
                        msg: &buf[..take],
                        aad: &aad,
                    },
                )
                .map_err(|e| AppError::Crypto(format!("recording could not be sealed: {e}")))?;
            out.write_all(&sealed)?;
        }
        // The file must not have grown since its length was read.
        if input.read(&mut [0u8; 1])? != 0 {
            return Err(AppError::Other("recording changed while it was being sealed".into()));
        }
        let file = out.into_inner().map_err(|e| AppError::Io(e.into_error()))?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&partial, dst)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// Decrypt a held recording back into `dst`.
///
/// # Errors
///
/// Not a sealed recording, the wrong key or account, or a file that was cut
/// short or tampered with; `dst` is not left behind.
fn unseal_file(key: &[u8; 32], account_id: &str, src: &Path, dst: &Path) -> Result<()> {
    use chacha20poly1305::aead::{Aead, Payload};
    use chacha20poly1305::{ChaCha20Poly1305, KeyInit};

    let partial = partial_path(dst);
    let result = (|| -> Result<()> {
        let mut input = std::io::BufReader::new(std::fs::File::open(src)?);
        let mut magic = [0u8; 8];
        input.read_exact(&mut magic)?;
        if &magic != SEAL_MAGIC {
            return Err(AppError::Crypto("not a held recording".into()));
        }
        let mut prefix = [0u8; SEAL_PREFIX];
        input.read_exact(&mut prefix)?;
        let mut len_bytes = [0u8; 8];
        input.read_exact(&mut len_bytes)?;
        let len = u64::from_be_bytes(len_bytes);
        let chunks = chunk_count(len)?;
        let cipher = ChaCha20Poly1305::new(key.into());
        let aad = aad_for(account_id);
        let mut out = std::io::BufWriter::new(std::fs::File::create(&partial)?);
        let mut buf = vec![0u8; SEAL_CHUNK + SEAL_TAG];
        let mut left = len;
        for index in 0..chunks {
            let take = usize::try_from(left.min(SEAL_CHUNK as u64)).unwrap_or(SEAL_CHUNK);
            input.read_exact(&mut buf[..take + SEAL_TAG])?;
            left -= take as u64;
            let plain = cipher
                .decrypt(
                    &chunk_nonce(prefix, index, index + 1 == chunks),
                    Payload {
                        msg: &buf[..take + SEAL_TAG],
                        aad: &aad,
                    },
                )
                .map_err(|_| AppError::Crypto("held recording could not be opened: wrong key or damaged file".into()))?;
            out.write_all(&plain)?;
        }
        if input.read(&mut [0u8; 1])? != 0 {
            return Err(AppError::Crypto("held recording has data after its end".into()));
        }
        let file = out.into_inner().map_err(|e| AppError::Io(e.into_error()))?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&partial, dst)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// A hidden sibling of `dst` to write into first.
fn partial_path(dst: &Path) -> PathBuf {
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dst.with_file_name(format!(".{name}.partial"))
}

/// The key held recordings were sealed with: derived from the account's
/// mnemonic (as the drive password's is, `crypto::store`), so it is never
/// written anywhere and a sealed file is useless on another account or
/// without this app.
fn held_key(state: &AppState, account_id: &str) -> Result<Zeroizing<[u8; 32]>> {
    let guard = state.auth.lock()?;
    let mnemonic = guard
        .mnemonic
        .as_deref()
        .ok_or_else(|| AppError::Crypto("no key to seal the recording with".into()))?;
    crate::crypto::store::derive_key(mnemonic, account_id, crate::crypto::store::INFO_HELD_RECORDING)
}

// ── Held recordings ─────────────────────────────────────────────────────────

/// A recording an earlier build held, waiting for a free slot or a paid plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRecording {
    pub id: String,
    pub file_name: String,
    /// When it was held, ms since the epoch.
    pub held_at: i64,
    /// The card's small JPEG `data:` URL, when there was one.
    pub thumbnail: Option<String>,
    /// The sealed file. Never sent anywhere.
    pub sealed_path: PathBuf,
}

#[cfg(test)]
async fn insert_held(pool: &SqlitePool, account_id: &str, held: &HeldRecording) -> Result<()> {
    sqlx::query(
        "INSERT INTO capture_held_recordings (id, owner, file_name, sealed_path, held_at, thumbnail)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&held.id)
    .bind(owner_of(account_id))
    .bind(&held.file_name)
    .bind(held.sealed_path.to_string_lossy().as_ref())
    .bind(held.held_at)
    .bind(held.thumbnail.as_deref())
    .execute(pool)
    .await?;
    Ok(())
}

/// The account's held recordings, oldest first: the order they are released in.
///
/// # Errors
///
/// The database could not be read.
pub async fn list_held(pool: &SqlitePool, account_id: &str) -> Result<Vec<HeldRecording>> {
    ensure_table(pool).await?;
    let rows = sqlx::query(
        "SELECT id, file_name, sealed_path, held_at, thumbnail FROM capture_held_recordings
         WHERE owner = ? ORDER BY held_at, rowid",
    )
    .bind(owner_of(account_id))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| HeldRecording {
            id: row.get("id"),
            file_name: row.get("file_name"),
            held_at: row.get("held_at"),
            thumbnail: row.get("thumbnail"),
            sealed_path: PathBuf::from(row.get::<String, _>("sealed_path")),
        })
        .collect())
}

/// Forget a held recording and remove its sealed file (after release).
/// Returns whether there was one.
///
/// # Errors
///
/// The database could not be written.
pub async fn delete_held(pool: &SqlitePool, account_id: &str, id: &str) -> Result<bool> {
    ensure_table(pool).await?;
    let owner = owner_of(account_id);
    let path: Option<String> = sqlx::query_scalar("SELECT sealed_path FROM capture_held_recordings WHERE owner = ? AND id = ?")
        .bind(&owner)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let Some(path) = path else { return Ok(false) };
    sqlx::query("DELETE FROM capture_held_recordings WHERE owner = ? AND id = ?")
        .bind(&owner)
        .bind(id)
        .execute(pool)
        .await?;
    if let Err(e) = std::fs::remove_file(&path)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(error = %e, "held recording forgotten; its sealed file could not be removed");
    }
    Ok(true)
}

/// Take a held recording out: decrypt it into a fresh capture temp folder
/// under its own name, forget it, and return the file to deliver.
///
/// # Errors
///
/// No key, or the sealed file could not be opened; it is then kept held.
pub async fn unseal_for_release(state: &AppState, account_id: &str, held: &HeldRecording) -> Result<PathBuf> {
    let key = held_key(state, account_id)?;
    let name = Path::new(&held.file_name)
        .file_name()
        .ok_or_else(|| AppError::Other("Held recording has no name".into()))?
        .to_os_string();
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let dst = dir.join(name);
    let unsealed = tokio::task::spawn_blocking({
        let (account, src, dst) = (account_id.to_string(), held.sealed_path.clone(), dst.clone());
        move || unseal_file(&key, &account, &src, &dst)
    })
    .await
    .map_err(|e| AppError::Other(format!("unseal task failed: {e}")))
    .and_then(|r| r);
    if let Err(e) = unsealed {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    delete_held(state.pool()?, account_id, &held.id).await?;
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "5Alice";

    async fn pool() -> SqlitePool {
        SqlitePool::connect("sqlite::memory:").await.unwrap()
    }

    #[test]
    fn release_follows_the_free_slots_and_never_an_unknown_plan_or_count() {
        let free = Some(RecordingTier::Free);
        assert_eq!(release_count(Some(RecordingTier::Paid), None, 3), 3, "an upgrade releases everything");
        assert_eq!(release_count(free, Some(24), 3), 1, "one slot, one recording");
        assert_eq!(release_count(free, Some(22), 2), 2);
        assert_eq!(release_count(free, Some(25), 3), 0);
        assert_eq!(release_count(free, Some(40), 3), 0);
        assert_eq!(release_count(free, None, 3), 0, "an unread count releases nothing");
        assert_eq!(release_count(None, Some(0), 3), 0, "a failed plan read releases nothing");
    }

    const KEY: [u8; 32] = [7; 32];

    fn plaintext(len: usize) -> Vec<u8> {
        (0..len).map(|i| u8::try_from(i % 251).unwrap()).collect()
    }

    #[test]
    fn a_sealed_recording_round_trips_and_hides_its_content() {
        let dir = tempfile::tempdir().unwrap();
        // Over two chunks, not a multiple of one, and a recognisable marker.
        let mut data = plaintext(SEAL_CHUNK * 2 + 123);
        let marker = b"ftypisomRECORDING-PLAINTEXT-MARKER";
        data[..marker.len()].copy_from_slice(marker);
        let src = dir.path().join("Recording.mp4");
        std::fs::write(&src, &data).unwrap();
        let sealed = dir.path().join("x.sealed");
        seal_file(&KEY, ACCOUNT, &src, &sealed).unwrap();

        let bytes = std::fs::read(&sealed).unwrap();
        assert!(
            !bytes.windows(marker.len()).any(|w| w == marker),
            "the sealed file must not contain the plaintext"
        );
        assert!(!bytes.windows(32).any(|w| w == &data[1000..1032]), "no plaintext run survives");

        let back = dir.path().join("back.mp4");
        unseal_file(&KEY, ACCOUNT, &sealed, &back).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data);
        assert!(!partial_path(&back).exists() && !partial_path(&sealed).exists());
    }

    #[test]
    fn an_empty_recording_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("empty.mp4");
        std::fs::write(&src, b"").unwrap();
        let sealed = dir.path().join("e.sealed");
        seal_file(&KEY, ACCOUNT, &src, &sealed).unwrap();
        let back = dir.path().join("back.mp4");
        unseal_file(&KEY, ACCOUNT, &sealed, &back).unwrap();
        assert!(std::fs::read(&back).unwrap().is_empty());
    }

    /// A copied sealed file is useless elsewhere: another key or account
    /// cannot open it, and a cut or edited one is refused, never half-written.
    #[test]
    fn a_sealed_recording_opens_only_whole_with_its_key_and_account() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("r.mp4");
        std::fs::write(&src, plaintext(SEAL_CHUNK + 10)).unwrap();
        let sealed = dir.path().join("r.sealed");
        seal_file(&KEY, ACCOUNT, &src, &sealed).unwrap();
        let back = dir.path().join("back.mp4");

        assert!(unseal_file(&[8; 32], ACCOUNT, &sealed, &back).is_err(), "another key");
        assert!(unseal_file(&KEY, "5Bob", &sealed, &back).is_err(), "another account");

        let bytes = std::fs::read(&sealed).unwrap();
        let cut = dir.path().join("cut.sealed");
        std::fs::write(&cut, &bytes[..bytes.len() - SEAL_TAG - 10]).unwrap();
        assert!(unseal_file(&KEY, ACCOUNT, &cut, &back).is_err(), "cut short");
        // Dropping the last chunk entirely must fail too (the last-chunk flag).
        let header = SEAL_MAGIC.len() + SEAL_PREFIX + 8;
        let first_only = dir.path().join("first.sealed");
        std::fs::write(&first_only, &bytes[..header + SEAL_CHUNK + SEAL_TAG]).unwrap();
        assert!(unseal_file(&KEY, ACCOUNT, &first_only, &back).is_err(), "a dropped chunk");
        let mut flipped = bytes.clone();
        flipped[header + 5] ^= 1;
        let edited = dir.path().join("edited.sealed");
        std::fs::write(&edited, flipped).unwrap();
        assert!(unseal_file(&KEY, ACCOUNT, &edited, &back).is_err(), "edited");
        assert!(unseal_file(&KEY, ACCOUNT, &src, &back).is_err(), "a plain file is not a sealed one");
        assert!(!back.exists(), "a failed unseal leaves nothing under the real name");
        assert!(!partial_path(&back).exists());
    }

    /// Released oldest first, whatever order they were written in.
    #[tokio::test]
    async fn held_recordings_are_listed_oldest_first_and_deleted_with_their_file() {
        let pool = pool().await;
        ensure_table(&pool).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        for (id, at) in [("b", 20), ("c", 30), ("a", 10)] {
            let sealed_path = dir.path().join(format!("{id}.sealed"));
            std::fs::write(&sealed_path, b"x").unwrap();
            let held = HeldRecording {
                id: id.into(),
                file_name: format!("{id}.mp4"),
                held_at: at,
                thumbnail: None,
                sealed_path,
            };
            insert_held(&pool, ACCOUNT, &held).await.unwrap();
        }
        let held = list_held(&pool, ACCOUNT).await.unwrap();
        assert_eq!(held.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        // One free slot: only the oldest goes.
        let n = release_count(Some(RecordingTier::Free), Some(FREE_RECORDING_LIMIT - 1), held.len());
        assert_eq!(held.iter().take(n).map(|h| h.id.as_str()).collect::<Vec<_>>(), ["a"]);

        assert!(list_held(&pool, "5Bob").await.unwrap().is_empty(), "per account");
        assert!(delete_held(&pool, ACCOUNT, "b").await.unwrap());
        assert!(!dir.path().join("b.sealed").exists(), "its sealed file goes with it");
        assert!(!delete_held(&pool, ACCOUNT, "b").await.unwrap());
        assert_eq!(list_held(&pool, ACCOUNT).await.unwrap().len(), 2);
    }
}
