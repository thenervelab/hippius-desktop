//! The free plan's recording allowance: 25 recordings in total.
//!
//! Screenshots are never counted and sharing is never limited; paid plans
//! have no count at all. Like Loom, deleting a recording frees its slot and
//! moving or renaming one does not.
//!
//! A free account at the limit can still record, but the finished recording
//! is HELD: it is not uploaded and no link is minted. It is sealed (encrypted
//! with a key only this app holds) into a hidden folder no drive syncs, and
//! the plaintext is removed, so copying the held file into a synced folder or
//! the app's Upload sends only ciphertext nobody can open. When a slot frees
//! up or the plan changes to a paid one, held recordings are released oldest
//! first and delivered exactly like a fresh one (upload, link, card).
//!
//! # What is counted
//!
//! A per-account ledger in SQLite, one row per recording this app delivered,
//! keyed by the recording's salted content hash, the same `BLAKE3(ss58 ||
//! plaintext)` the sync engine stores for every file. A row stops counting
//! once the hash is in none of the account's drives synced here (on disk, on
//! the server or in the last synced base, `sync::files::content_hashes_present`).
//! Content, not path: a moved or renamed recording keeps its hash and stays
//! counted; a deleted one is gone from every tree and frees its slot.
//!
//! The rules are cautious in one direction only: a row is never freed on a
//! read that could not see everything. It must have been seen in a drive at
//! least once, every own drive here must have been read, and at least one of
//! them must share the row's salt. Anything less leaves it counted.
//!
//! KNOWN GAPS, until the server enforces this: the ledger is per device, so
//! recordings made on another device or before a reinstall are not counted
//! here, and a file uploaded through the website is not either. A recording
//! delivered to a drive not synced on this machine is never seen, so it stays
//! counted. While a recording runs its plaintext fragments sit in the app's
//! hidden temp folder (`screenshot::capture_tmp_root`), as every recording's do.
//!
//! The decision is Rust's alone; the card only draws `PreviewStatus::Held`.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use zeroize::Zeroizing;

use crate::app_state::AppState;
use crate::billing::storage_overview::PlanRead;
use crate::error::{AppError, Result};

/// Recordings a free account can have before new ones are held.
pub const FREE_RECORDING_LIMIT: usize = 25;

/// What a held recording's card (and the Captures page) says.
pub const HELD_MESSAGE: &str = "You've used your 25 free recordings. Upgrade to share this one, or delete an older recording.";

/// What a held recording's card says when it could not even be sealed: it
/// stays in the app's own hidden folder and Retry tries again.
pub const NOT_HELD_MESSAGE: &str = "This recording couldn't be put aside. Retry in a moment.";

/// The plan, as far as the recording count goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingPlan {
    Free,
    Paid,
}

/// Plan codes this build knows to be paid. `solo` is sold as Starter.
const PAID_PLAN_CODES: [&str; 4] = ["solo", "duo", "max", "scale"];

/// A plan read as a recording plan; `None` = unknown. No plan at all is the
/// free tier; a code this build has never heard of is unknown, not free.
#[must_use]
pub(crate) fn plan_from_read(read: &PlanRead) -> Option<RecordingPlan> {
    match read {
        PlanRead::NoPlan => Some(RecordingPlan::Free),
        PlanRead::Unknown => None,
        PlanRead::Plan(code) => {
            let code = code.trim().to_ascii_lowercase();
            if code == "free" {
                Some(RecordingPlan::Free)
            } else if PAID_PLAN_CODES.contains(&code.as_str()) {
                Some(RecordingPlan::Paid)
            } else {
                None
            }
        }
    }
}

/// The account's plan for the recording count; `None` when it cannot be told.
///
/// ── INTEGRATION POINT ── the ONE place the plan is read. Swap the body for
/// `super::allowance::recording_tier(state, &state.current_session_account().ok()?).await`
/// mapped `RecordingTier::Free => RecordingPlan::Free`, `RecordingTier::Paid
/// => RecordingPlan::Paid` (its `None` stays `None`) once that lands (the
/// recording length cap change), and drop
/// `billing::storage_overview::fetch_plan_read` with it.
pub async fn current_plan(state: &AppState, account_id: &str) -> Option<RecordingPlan> {
    let _ = account_id;
    match crate::billing::storage_overview::fetch_plan_read(state).await {
        Ok(read) => plan_from_read(&read),
        Err(e) => {
            tracing::warn!(error = %e, "plan not read for the recording allowance; not holding");
            None
        }
    }
}

/// What happens to a finished recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Deliver,
    Hold,
}

/// Hold only on a KNOWN free plan at the limit. An unknown plan fails open:
/// a recording is never held because the app could not read the plan.
#[must_use]
pub fn decide(plan: Option<RecordingPlan>, counted: usize) -> Verdict {
    match plan {
        Some(RecordingPlan::Free) if counted >= FREE_RECORDING_LIMIT => Verdict::Hold,
        _ => Verdict::Deliver,
    }
}

/// How many of `held` recordings to release now. Only on a KNOWN plan: a
/// failed plan read must not hand a free account its held recordings.
#[must_use]
pub fn release_count(plan: Option<RecordingPlan>, counted: usize, held: usize) -> usize {
    match plan {
        Some(RecordingPlan::Paid) => held,
        Some(RecordingPlan::Free) => held.min(FREE_RECORDING_LIMIT.saturating_sub(counted)),
        None => 0,
    }
}

// ── The ledger ──────────────────────────────────────────────────────────────

/// Created on first use rather than in `utils::schema`: nothing else reads it.
const LEDGER_DDL: &str = "CREATE TABLE IF NOT EXISTS capture_recording_ledger (
    owner TEXT NOT NULL,
    salted_hash TEXT NOT NULL,
    salt_ss58 TEXT NOT NULL,
    file_name TEXT NOT NULL,
    delivered_at INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    gone INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, salted_hash)
)";

const HELD_DDL: &str = "CREATE TABLE IF NOT EXISTS capture_held_recordings (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    file_name TEXT NOT NULL,
    sealed_path TEXT NOT NULL,
    held_at INTEGER NOT NULL,
    thumbnail TEXT
)";

async fn ensure_tables(pool: &SqlitePool) -> Result<()> {
    sqlx::query(LEDGER_DDL).execute(pool).await?;
    sqlx::query(HELD_DDL).execute(pool).await?;
    Ok(())
}

fn owner_of(account_id: &str) -> String {
    crate::auth::account_key::account_key(account_id)
}

/// A delivered recording the ledger still counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    pub hash: [u8; 32],
    /// The ss58 the hash is salted with; only a drive with the same salt can
    /// say whether it holds the recording.
    pub salt: String,
    /// Found in a drive at least once. Until then it is never freed: a
    /// recording just moved into the folder has not been scanned yet.
    pub seen: bool,
}

/// How many recordings the ledger counts for `account_id`.
///
/// # Errors
///
/// The database could not be read.
pub async fn counted(pool: &SqlitePool, account_id: &str) -> Result<usize> {
    ensure_tables(pool).await?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM capture_recording_ledger WHERE owner = ? AND gone = 0")
        .bind(owner_of(account_id))
        .fetch_one(pool)
        .await?;
    Ok(usize::try_from(n).unwrap_or(0))
}

async fn ledger_entries(pool: &SqlitePool, account_id: &str) -> Result<Vec<LedgerEntry>> {
    let rows = sqlx::query("SELECT salted_hash, salt_ss58, seen FROM capture_recording_ledger WHERE owner = ? AND gone = 0")
        .bind(owner_of(account_id))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let hash = decode_hash(&row.get::<String, _>("salted_hash"))?;
            Some(LedgerEntry {
                hash,
                salt: row.get("salt_ss58"),
                seen: row.get::<i64, _>("seen") != 0,
            })
        })
        .collect())
}

fn decode_hash(hex_hash: &str) -> Option<[u8; 32]> {
    hex::decode(hex_hash).ok()?.try_into().ok()
}

/// Count `hash` for `account_id` (a recording about to be delivered).
/// Idempotent: a recording counted already stays one row.
///
/// # Errors
///
/// The database could not be written.
pub async fn reserve(pool: &SqlitePool, account_id: &str, hash: &[u8; 32], salt: &str, file_name: &str, now_ms: i64) -> Result<()> {
    ensure_tables(pool).await?;
    sqlx::query(
        "INSERT INTO capture_recording_ledger (owner, salted_hash, salt_ss58, file_name, delivered_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner, salted_hash) DO UPDATE SET gone = 0, seen = 0, salt_ss58 = excluded.salt_ss58",
    )
    .bind(owner_of(account_id))
    .bind(hex::encode(hash))
    .bind(salt)
    .bind(file_name)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Whether the ledger already counts `hash` (a retry of a recording whose
/// delivery started before).
async fn is_counted(pool: &SqlitePool, account_id: &str, hash: &[u8; 32]) -> Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM capture_recording_ledger WHERE owner = ? AND salted_hash = ? AND gone = 0")
        .bind(owner_of(account_id))
        .bind(hex::encode(hash))
        .fetch_one(pool)
        .await?;
    Ok(n > 0)
}

/// Un-count `hash`: its delivery failed before the file reached the drive,
/// so Retry decides again.
///
/// # Errors
///
/// The database could not be written.
pub async fn forget(pool: &SqlitePool, account_id: &str, hash: &[u8; 32]) -> Result<()> {
    ensure_tables(pool).await?;
    sqlx::query("DELETE FROM capture_recording_ledger WHERE owner = ? AND salted_hash = ? AND seen = 0")
        .bind(owner_of(account_id))
        .bind(hex::encode(hash))
        .execute(pool)
        .await?;
    Ok(())
}

/// What one drive synced here was found to hold, of the hashes asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveView {
    pub ss58: String,
    pub present: HashSet<[u8; 32]>,
}

/// What a refresh learnt about a ledger entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    /// Found in a drive (first time).
    Seen,
    /// Seen before and now in none of the drives: deleted. Frees its slot.
    Gone,
}

/// Decide what changed for each entry. `drives` holds one item per own
/// drive synced here, `None` for one whose state could not be read now.
#[must_use]
pub fn reconcile(entries: &[LedgerEntry], drives: &[Option<DriveView>]) -> Vec<([u8; 32], Presence)> {
    let all_read = drives.iter().all(Option::is_some);
    let mut changes = Vec::new();
    for entry in entries {
        let same_salt: Vec<&DriveView> = drives.iter().flatten().filter(|d| d.ss58 == entry.salt).collect();
        if same_salt.iter().any(|d| d.present.contains(&entry.hash)) {
            if !entry.seen {
                changes.push((entry.hash, Presence::Seen));
            }
        } else if entry.seen && all_read && !same_salt.is_empty() {
            changes.push((entry.hash, Presence::Gone));
        }
    }
    changes
}

async fn apply(pool: &SqlitePool, account_id: &str, changes: &[([u8; 32], Presence)]) -> Result<()> {
    let owner = owner_of(account_id);
    for (hash, presence) in changes {
        let column = match presence {
            Presence::Seen => "UPDATE capture_recording_ledger SET seen = 1 WHERE owner = ? AND salted_hash = ?",
            Presence::Gone => "UPDATE capture_recording_ledger SET gone = 1 WHERE owner = ? AND salted_hash = ?",
        };
        sqlx::query(column).bind(&owner).bind(hex::encode(hash)).execute(pool).await?;
    }
    Ok(())
}

/// Bring the ledger up to date with the account's drives synced here.
///
/// # Errors
///
/// The database could not be read or written.
pub async fn refresh(state: &AppState, account_id: &str) -> Result<()> {
    let pool = state.pool()?;
    ensure_tables(pool).await?;
    let entries = ledger_entries(pool, account_id).await?;
    if entries.is_empty() {
        return Ok(());
    }
    let wanted: HashSet<[u8; 32]> = entries.iter().map(|e| e.hash).collect();
    let drives = super::destination::drives_here(pool, account_id).await?;
    let mut views = Vec::new();
    for drive in drives.iter().filter(|d| !d.member) {
        let view = crate::sync::files::content_hashes_present(&state.sync, &drive.label, &wanted)
            .await
            .map(|(ss58, present)| DriveView { ss58, present });
        views.push(view);
    }
    let changes = reconcile(&entries, &views);
    if !changes.is_empty() {
        tracing::info!(changes = changes.len(), "recording allowance ledger updated from the drives");
    }
    apply(pool, account_id, &changes).await
}

// ── The gate ────────────────────────────────────────────────────────────────

/// What delivery does with a finished recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Deliver it. `reserved` is the ledger row this delivery added, which
    /// a failed placement gives back ([`forget`]).
    Deliver {
        reserved: Option<[u8; 32]>,
    },
    Hold,
}

/// One decision at a time, so two recordings finishing together cannot both
/// take the last slot.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Decide whether `file` (a finished recording, salted with `salt_ss58`, the
/// destination drive's namespace) is delivered or held, and count it when
/// delivered. The plan is only asked for at the limit.
///
/// # Errors
///
/// The file could not be hashed or the ledger not read; the caller fails
/// open (delivers).
pub async fn gate(state: &AppState, account_id: &str, salt_ss58: &str, file: &Path) -> Result<Gate> {
    let hash = salted_hash(file, salt_ss58).await?;
    let pool = state.pool()?;
    ensure_tables(pool).await?;
    let _one_at_a_time = GATE.lock().await;
    if is_counted(pool, account_id, &hash).await? {
        return Ok(Gate::Deliver { reserved: None });
    }
    if let Err(e) = refresh(state, account_id).await {
        tracing::warn!(error = %e, "recording allowance ledger not refreshed");
    }
    let n = counted(pool, account_id).await?;
    let plan = if n >= FREE_RECORDING_LIMIT {
        current_plan(state, account_id).await
    } else {
        None
    };
    match decide(plan, n) {
        Verdict::Hold => {
            tracing::info!(counted = n, "free plan at its recording limit; recording held");
            Ok(Gate::Hold)
        }
        Verdict::Deliver => {
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            reserve(pool, account_id, &hash, salt_ss58, &name, chrono::Utc::now().timestamp_millis()).await?;
            Ok(Gate::Deliver { reserved: Some(hash) })
        }
    }
}

async fn salted_hash(file: &Path, salt: &str) -> Result<[u8; 32]> {
    let (file, salt) = (file.to_path_buf(), salt.to_string());
    tokio::task::spawn_blocking(move || hcfs_client::crypto::compute_salted_hash_file(&file, &salt))
        .await
        .map_err(|e| AppError::Other(format!("recording hash task failed: {e}")))?
        .map(|(hash, _)| hash)
        .map_err(|e| AppError::Other(format!("recording could not be hashed: {e}")))
}

/// Whether a file at `path` can never be picked up by the sync engine of any
/// drive rooted at `drive_roots`: it is outside every one of them, or inside
/// through a hidden (dot) folder, which the engine never walks. The recorder
/// writes only where this holds (`commands::begin_recording`).
#[must_use]
pub fn unsynced_by_every_drive(path: &Path, drive_roots: &[PathBuf]) -> bool {
    drive_roots.iter().all(|root| match path.strip_prefix(root) {
        Err(_) => true,
        Ok(inside) => inside.components().any(|c| match c {
            std::path::Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => false,
        }),
    })
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

/// Encrypt `src` into `dst` (written beside it under a hidden name, then
/// renamed, so a half-written file never carries the real name).
///
/// # Errors
///
/// Reading, encrypting or writing failed; `dst` is not left behind.
pub fn seal_file(key: &[u8; 32], account_id: &str, src: &Path, dst: &Path) -> Result<()> {
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

/// Decrypt a file [`seal_file`] wrote back into `dst`.
///
/// # Errors
///
/// Not a sealed recording, the wrong key or account, or a file that was cut
/// short or tampered with; `dst` is not left behind.
pub fn unseal_file(key: &[u8; 32], account_id: &str, src: &Path, dst: &Path) -> Result<()> {
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

/// The key held recordings are sealed with: derived from the account's
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

/// A recording waiting for a free slot or a paid plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldRecording {
    pub id: String,
    pub file_name: String,
    /// When it was held, ms since the epoch.
    pub held_at: i64,
    /// The card's small JPEG `data:` URL, when there was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// The sealed file. Never sent anywhere.
    #[serde(skip)]
    pub sealed_path: PathBuf,
}

/// Where held recordings are sealed: under `~/.hippius`, a hidden folder the
/// sync engine never walks even inside a synced home folder, one folder per
/// account, the user's alone.
///
/// # Errors
///
/// No home folder.
pub fn held_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("No home directory".into()))?;
    Ok(home.join(".hippius").join("held-recordings"))
}

fn held_dir(root: &Path, account_id: &str) -> Result<PathBuf> {
    let dir = root.join(owner_of(account_id));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Seal `file` into the holding folder, record it, and remove the plaintext.
///
/// # Errors
///
/// No key (signed out), or the file could not be sealed or recorded; the
/// plaintext is then left where it was (the app's hidden temp folder).
pub async fn hold(state: &AppState, account_id: &str, file: &Path, thumbnail: Option<String>) -> Result<HeldRecording> {
    let pool = state.pool()?;
    ensure_tables(pool).await?;
    let key = held_key(state, account_id)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Other("Recording has no name".into()))?;
    let sealed_path = held_dir(&held_root()?, account_id)?.join(format!("{id}.sealed"));
    tokio::task::spawn_blocking({
        let (account, src, dst) = (account_id.to_string(), file.to_path_buf(), sealed_path.clone());
        move || seal_file(&key, &account, &src, &dst)
    })
    .await
    .map_err(|e| AppError::Other(format!("seal task failed: {e}")))??;
    let held = HeldRecording {
        id,
        file_name,
        held_at: chrono::Utc::now().timestamp_millis(),
        thumbnail,
        sealed_path,
    };
    if let Err(e) = insert_held(pool, account_id, &held).await {
        let _ = std::fs::remove_file(&held.sealed_path);
        return Err(e);
    }
    // Only now, with the sealed copy recorded: the plaintext goes.
    if let Err(e) = std::fs::remove_file(file) {
        tracing::warn!(error = %e, "held recording sealed; its plaintext could not be removed");
    }
    Ok(held)
}

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
    ensure_tables(pool).await?;
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

/// Delete a held recording for good (the user's choice, or after release).
/// Returns whether there was one.
///
/// # Errors
///
/// The database could not be written.
pub async fn delete_held(pool: &SqlitePool, account_id: &str, id: &str) -> Result<bool> {
    ensure_tables(pool).await?;
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

/// What the Captures page lists while recordings are held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldList {
    pub message: String,
    pub items: Vec<HeldRecording>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "5Alice";

    async fn pool() -> SqlitePool {
        SqlitePool::connect("sqlite::memory:").await.unwrap()
    }

    fn hash(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn drive(ss58: &str, present: &[[u8; 32]]) -> Option<DriveView> {
        Some(DriveView {
            ss58: ss58.into(),
            present: present.iter().copied().collect(),
        })
    }

    fn entry(n: u8, seen: bool) -> LedgerEntry {
        LedgerEntry {
            hash: hash(n),
            salt: ACCOUNT.into(),
            seen,
        }
    }

    #[test]
    fn hold_only_a_free_plan_at_the_limit() {
        let free = Some(RecordingPlan::Free);
        assert_eq!(decide(free, 0), Verdict::Deliver);
        assert_eq!(
            decide(free, FREE_RECORDING_LIMIT - 1),
            Verdict::Deliver,
            "the 25th recording is delivered"
        );
        assert_eq!(decide(free, FREE_RECORDING_LIMIT), Verdict::Hold, "the 26th is held");
        assert_eq!(decide(free, FREE_RECORDING_LIMIT + 3), Verdict::Hold);
        assert_eq!(decide(Some(RecordingPlan::Paid), 500), Verdict::Deliver, "paid plans have no count");
        assert_eq!(decide(None, 500), Verdict::Deliver, "an unknown plan fails open");
    }

    #[test]
    fn a_plan_read_maps_to_free_paid_or_unknown() {
        assert_eq!(plan_from_read(&PlanRead::NoPlan), Some(RecordingPlan::Free));
        assert_eq!(plan_from_read(&PlanRead::Plan(" Free ".into())), Some(RecordingPlan::Free));
        for code in ["solo", "duo", "max", "scale"] {
            assert_eq!(plan_from_read(&PlanRead::Plan(code.into())), Some(RecordingPlan::Paid), "{code}");
        }
        assert_eq!(plan_from_read(&PlanRead::Plan(String::new())), None, "a plan with no code is unknown");
        assert_eq!(plan_from_read(&PlanRead::Plan("enterprise".into())), None);
        assert_eq!(plan_from_read(&PlanRead::Unknown), None);
    }

    #[test]
    fn release_follows_the_free_slots_and_never_an_unknown_plan() {
        assert_eq!(release_count(Some(RecordingPlan::Paid), 40, 3), 3, "an upgrade releases everything");
        assert_eq!(release_count(Some(RecordingPlan::Free), 24, 3), 1, "one slot, one recording");
        assert_eq!(release_count(Some(RecordingPlan::Free), 22, 2), 2);
        assert_eq!(release_count(Some(RecordingPlan::Free), 25, 3), 0);
        assert_eq!(release_count(Some(RecordingPlan::Free), 30, 3), 0);
        assert_eq!(release_count(None, 0, 3), 0, "a failed plan read releases nothing");
    }

    /// A recording deleted from the drive is in none of its trees: it frees
    /// its slot. Moved or renamed it keeps its content hash, so it is still
    /// found and stays counted.
    #[test]
    fn delete_frees_a_slot_and_move_or_rename_keeps_it() {
        let entries = [entry(1, true), entry(2, true)];
        // Recording 1 was renamed or moved to another drive: same hash, found.
        let drives = [drive(ACCOUNT, &[]), drive(ACCOUNT, &[hash(1)])];
        assert_eq!(reconcile(&entries, &drives), vec![(hash(2), Presence::Gone)], "only the deleted one goes");
    }

    #[test]
    fn nothing_is_freed_on_a_read_that_could_not_see_everything() {
        let entries = [entry(1, true)];
        assert!(
            reconcile(&entries, &[drive(ACCOUNT, &[]), None]).is_empty(),
            "a drive mid-sync could hold it"
        );
        assert!(
            reconcile(&entries, &[drive("5Other", &[])]).is_empty(),
            "a drive salted otherwise cannot answer for it"
        );
        assert!(reconcile(&entries, &[]).is_empty(), "no drive here at all says nothing");
        // Never seen: just moved into the folder and not scanned yet.
        assert!(reconcile(&[entry(3, false)], &[drive(ACCOUNT, &[])]).is_empty());
        // Seen for the first time.
        assert_eq!(
            reconcile(&[entry(3, false)], &[drive(ACCOUNT, &[hash(3)])]),
            vec![(hash(3), Presence::Seen)]
        );
    }

    /// The count end to end over the ledger: reserved recordings count, a
    /// deleted one stops, a moved one does not, and a failed delivery gives
    /// its reservation back.
    #[tokio::test]
    async fn the_ledger_counts_what_is_still_in_the_drives() {
        let pool = pool().await;
        for n in 1..=3 {
            reserve(&pool, ACCOUNT, &hash(n), ACCOUNT, "r.mp4", i64::from(n)).await.unwrap();
        }
        assert_eq!(counted(&pool, ACCOUNT).await.unwrap(), 3);
        assert_eq!(counted(&pool, "5Bob").await.unwrap(), 0, "per account");
        // Reserving the same recording again (a retry) is still one.
        reserve(&pool, ACCOUNT, &hash(1), ACCOUNT, "r.mp4", 9).await.unwrap();
        assert_eq!(counted(&pool, ACCOUNT).await.unwrap(), 3);

        // All three scanned into the drive.
        let all = [drive(ACCOUNT, &[hash(1), hash(2), hash(3)])];
        let entries = ledger_entries(&pool, ACCOUNT).await.unwrap();
        apply(&pool, ACCOUNT, &reconcile(&entries, &all)).await.unwrap();
        // 1 renamed (still there), 2 deleted, 3 moved to another drive.
        let later = [drive(ACCOUNT, &[hash(1)]), drive(ACCOUNT, &[hash(3)])];
        let entries = ledger_entries(&pool, ACCOUNT).await.unwrap();
        apply(&pool, ACCOUNT, &reconcile(&entries, &later)).await.unwrap();
        assert_eq!(counted(&pool, ACCOUNT).await.unwrap(), 2, "only the deleted recording freed its slot");

        // A delivery that never reached the drive is given back.
        reserve(&pool, ACCOUNT, &hash(4), ACCOUNT, "r.mp4", 10).await.unwrap();
        forget(&pool, ACCOUNT, &hash(4)).await.unwrap();
        assert_eq!(counted(&pool, ACCOUNT).await.unwrap(), 2);
        // But one already seen in a drive is never forgotten that way.
        forget(&pool, ACCOUNT, &hash(1)).await.unwrap();
        assert_eq!(counted(&pool, ACCOUNT).await.unwrap(), 2);
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
        ensure_tables(&pool).await.unwrap();
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
        let n = release_count(Some(RecordingPlan::Free), FREE_RECORDING_LIMIT - 1, held.len());
        assert_eq!(held.iter().take(n).map(|h| h.id.as_str()).collect::<Vec<_>>(), ["a"]);

        assert!(list_held(&pool, "5Bob").await.unwrap().is_empty(), "per account");
        assert!(delete_held(&pool, ACCOUNT, "b").await.unwrap());
        assert!(!dir.path().join("b.sealed").exists(), "its sealed file goes with it");
        assert!(!delete_held(&pool, ACCOUNT, "b").await.unwrap());
        assert_eq!(list_held(&pool, ACCOUNT).await.unwrap().len(), 2);
    }

    /// The recorder writes under `~/.hippius`: hidden, so no drive's engine
    /// ever walks it, even a drive that is the whole home folder.
    #[test]
    fn the_recorder_never_writes_where_a_drive_syncs() {
        let home = PathBuf::from("/Users/a");
        let tmp = home.join(".hippius").join("capture-tmp");
        let drives = [home.clone(), home.join("Documents/Hippius Captures"), PathBuf::from("/Volumes/X")];
        assert!(unsynced_by_every_drive(&tmp, &drives));
        assert!(unsynced_by_every_drive(&home.join(".hippius/held-recordings"), &drives));
        // The captures folder itself, or any visible folder in a drive, is not.
        assert!(!unsynced_by_every_drive(&home.join("Documents/Hippius Captures/tmp"), &drives));
        assert!(!unsynced_by_every_drive(&home.join("Movies"), std::slice::from_ref(&home)));
        assert!(unsynced_by_every_drive(&home.join("Movies"), &[]));
    }

    /// The real temp and holding roots are both somewhere no drive syncs.
    #[test]
    fn the_capture_temp_and_holding_roots_are_hidden_app_folders() {
        let _home = crate::test_helpers::HOME_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let home = dirs::home_dir().unwrap();
        for root in [super::super::screenshot::capture_tmp_root().unwrap(), held_root().unwrap()] {
            assert!(root.starts_with(home.join(".hippius")), "{}", root.display());
            assert!(unsynced_by_every_drive(&root, std::slice::from_ref(&home)), "{}", root.display());
        }
    }
}
