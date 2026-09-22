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

/// Delete the `.bak` sibling `save_encrypted_mnemonic` leaves behind.
///
/// Upstream's write is temp + fsync + **copy the old blob to `<name>.bak`** +
/// atomic rename (hcfs `auth.rs`, added between pins e66b58f and 02191cc).
/// The backup guards a torn write, and once the rename has returned the new
/// blob is already durable — so on a PASSWORD ROTATION the `.bak` is not
/// insurance, it is the mnemonic still sealed under the password the user
/// just decided to stop trusting, sitting next to the new one indefinitely.
///
/// Nothing else sweeps it: the cleanup lists in `clear_persisted_sync_state`
/// and `recover_drive` name `sync_state.json.bak`, never the key blobs.
///
/// Call this ONLY after a rotation write, not after every save — ordinary
/// writes should keep upstream's crash insurance.
///
/// Best-effort by design: a rotation must not fail because a stale file
/// could not be unlinked. The name is built by APPENDING `.bak` to the whole
/// filename, matching upstream's `sibling_with_suffix` —
/// `with_extension("bak")` would produce `master_enc_mnemonic.bak` and
/// silently sweep nothing.
pub(crate) fn retire_key_backup(path: &Path) {
    let Some(name) = path.file_name() else {
        return;
    };
    let mut backup = name.to_os_string();
    backup.push(".bak");
    let backup_path = path.with_file_name(backup);
    match std::fs::remove_file(&backup_path) {
        Ok(()) => info!(path = %backup_path.display(), "Retired key blob sealed under the previous password"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warn!(
            path = %backup_path.display(),
            error = %e,
            "Could not remove the key blob sealed under the previous password — \
             it is still openable with the old password"
        ),
    }
}

/// Filename of the rekey marker inside a drive's config directory.
pub(crate) const REKEY_MARKER: &str = ".needs_rekey";

/// Scratch filename used to swap [`REKEY_MARKER`] atomically.
///
/// Appending a record is a read-modify-write, so a crash part-way through an
/// in-place rewrite would truncate the history it is trying to extend. The
/// swap is a `rename` within the same directory, which replaces the target on
/// both Unix and Windows.
const REKEY_MARKER_TMP: &str = ".needs_rekey.tmp";

/// One occasion on which a drive's folder key was re-derived.
///
/// Appended, never deleted: it records a permanent property of the drive's
/// REMOTE contents (everything uploaded before `rekeyed_at` may be encrypted
/// under a key this device no longer has), not a task someone is going to
/// complete. The one path that legitimately retires the whole history is a
/// server-side folder delete, which takes the affected revisions with it.
///
/// It exists as a file with contents rather than a zero-byte flag so a
/// support bundle answers "was this drive re-keyed, and when?" without
/// anyone having to reproduce the failure. The previous zero-byte marker
/// was deleted at the next drive registration, so by the time a user
/// reported undecryptable files there was nothing left to find.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct RekeyRecord {
    /// Unix seconds at which the folder key was re-derived, or `0` when the
    /// marker predates this struct and carried no date.
    pub rekeyed_at: i64,
    /// What triggered it, for support triage. `None` means the marker exists
    /// but recorded no reason — a legacy zero-byte flag, or a file this build
    /// cannot parse. It is deliberately NOT defaulted to one of the variants:
    /// a fabricated cause in a support bundle is worse than an absent one.
    pub reason: Option<RekeyReason>,
}

/// What caused a re-derivation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub(crate) enum RekeyReason {
    /// The folder seal held the master mnemonic verbatim — copied during an
    /// early migration without running the derivation.
    RawMasterInFolderSeal,
    /// The folder seal held a mnemonic derived from a DIFFERENT master, so
    /// this account's master no longer reproduces it.
    DerivedFromAnotherMaster,
    /// Unlock failed and recovery had no login mnemonic to fall back on, so it
    /// generated a brand-new random ACCOUNT master. Every drive on the account
    /// is stranded by this, not just the one carrying the record — only this
    /// drive's config dir is reachable from where it is written.
    RecoveryGeneratedNewMaster,
}

impl RekeyReason {
    /// Stable label for logs. Not `Display`: this is a diagnostic token for a
    /// support bundle, not user-facing copy.
    fn as_str(self) -> &'static str {
        match self {
            RekeyReason::RawMasterInFolderSeal => "RawMasterInFolderSeal",
            RekeyReason::DerivedFromAnotherMaster => "DerivedFromAnotherMaster",
            RekeyReason::RecoveryGeneratedNewMaster => "RecoveryGeneratedNewMaster",
        }
    }
}

/// What a drive's config dir says about re-keying.
///
/// `Absent` and `Unreadable` are separate variants on purpose: collapsing an
/// unreadable marker into "never re-keyed" is the same silent-evidence-loss
/// this module exists to prevent, just caused by a permission change or a
/// transient FS error instead of a delete.
pub(crate) enum RekeyMarker {
    /// No marker file — this drive has never been re-keyed on this device.
    Absent,
    /// The marker exists and holds these records, oldest first. Never empty.
    Present(Vec<RekeyRecord>),
    /// The marker exists (or its absence could not be established) and could
    /// not be read. NOT the same as `Absent`.
    Unreadable(std::io::Error),
}

/// Read a drive's rekey history.
///
/// Three on-disk shapes are accepted, because a marker outlives the build that
/// wrote it: the current JSON array, a single JSON object from the first
/// revision that gave the marker contents, and a legacy zero-byte flag from
/// the builds before that. The last two are reported as one record; anything
/// that parses as none of them is reported as one record with no reason rather
/// than discarded, since the file's existence is itself the finding.
pub(crate) fn read_rekey_marker(folder_dir: &Path) -> RekeyMarker {
    let raw = match std::fs::read(folder_dir.join(REKEY_MARKER)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RekeyMarker::Absent,
        Err(e) => return RekeyMarker::Unreadable(e),
    };

    if let Ok(records) = serde_json::from_slice::<Vec<RekeyRecord>>(&raw) {
        // An empty array is a marker that says nothing; the file is still the
        // evidence, so keep the "something happened" record rather than
        // reporting a re-keyed drive as clean.
        if !records.is_empty() {
            return RekeyMarker::Present(records);
        }
    }

    if let Ok(record) = serde_json::from_slice::<RekeyRecord>(&raw) {
        return RekeyMarker::Present(vec![record]);
    }

    RekeyMarker::Present(vec![RekeyRecord { rekeyed_at: 0, reason: None }])
}

/// Append a record to a drive's rekey history, creating it if absent.
///
/// An unreadable or unparseable existing marker is NOT overwritten blind — the
/// new record is appended to whatever `read_rekey_marker` could recover, so the
/// fact that an earlier rekey happened survives even when its detail does not.
pub(crate) fn append_rekey_record(folder_dir: &Path, record: RekeyRecord) -> std::io::Result<()> {
    let mut history = match read_rekey_marker(folder_dir) {
        RekeyMarker::Present(records) => records,
        RekeyMarker::Absent => Vec::new(),
        RekeyMarker::Unreadable(e) => {
            // Keep the placeholder so the count still shows a prior event.
            warn!("Rekey marker at {:?} could not be read before appending: {e}", folder_dir);
            vec![RekeyRecord { rekeyed_at: 0, reason: None }]
        }
    };
    history.push(record);

    let encoded = serde_json::to_vec_pretty(&history).map_err(std::io::Error::other)?;
    let tmp = folder_dir.join(REKEY_MARKER_TMP);
    std::fs::write(&tmp, encoded)?;
    std::fs::rename(&tmp, folder_dir.join(REKEY_MARKER))
}

/// Discard a drive's rekey history.
///
/// The ONLY sanctioned caller is a successful server-side folder delete: the
/// remote revisions the history warns about are gone, so continuing to warn
/// about them reports a condition that no longer exists. Every other path must
/// leave the marker alone — see [`report_rekey_marker`].
pub(crate) fn clear_rekey_marker(folder_dir: &Path) {
    match std::fs::remove_file(folder_dir.join(REKEY_MARKER)) {
        Ok(()) => info!(
            "Cleared rekey marker at {:?} — the remote revisions it described were deleted",
            folder_dir
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warn!("Could not clear rekey marker at {:?}: {e}", folder_dir),
    }
}

/// Log a drive's rekey diagnosis, if it has one, and LEAVE THE MARKER ALONE.
///
/// Separate from its caller so the "does not delete" half of the contract is
/// directly testable — that is the regression this guards. The marker used
/// to be deleted at drive registration, which erased the only record of why
/// a drive's remote files had become undecryptable, usually before anyone
/// noticed they had.
///
/// Safe to call on every registration: the condition is permanent until the
/// affected remote revisions are replaced, so re-logging it each launch is
/// what puts the cause into a support bundle.
pub(crate) fn report_rekey_marker(folder_dir: &Path, label: &str) {
    match read_rekey_marker(folder_dir) {
        RekeyMarker::Absent => {}
        RekeyMarker::Unreadable(e) => {
            warn!(
                label = %label,
                "Rekey marker for this drive could not be read ({e}) — whether it was \
                 re-keyed is UNKNOWN, which is not the same as no. Check the config \
                 directory's permissions before concluding the drive is healthy."
            );
        }
        RekeyMarker::Present(records) => {
            let reasons = records
                .iter()
                .map(|r| format!("{}@{}", r.reason.map_or("unrecorded", RekeyReason::as_str), r.rekeyed_at))
                .collect::<Vec<_>>()
                .join(", ");
            warn!(
                label = %label,
                rekey_count = records.len(),
                rekeys = %reasons,
                "Drive was re-keyed: files uploaded under a previous folder key \
                 cannot be decrypted on this device and will fail to download. \
                 Replacing them (re-upload from a device that can read them, or \
                 delete them) is the only fix."
            );
        }
    }
}

/// Compute the account-level directory: `~/.hippius/drives/<account_key>/`
pub(crate) fn account_dir(account_id: &str) -> Result<PathBuf> {
    // `$HOME` unset is a genuine environment fault with no fitting typed
    // variant, so it deliberately stays the catch-all `Other`: the FE displays
    // it generically and never silences it (silencing is reserved for the
    // `Auth`/`NotReady` kinds), which is exactly the behaviour we want here.
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
    // A BIP-39 key-derivation failure (invalid master / seed) is cryptographic,
    // not an un-triaged catch-all — surface it as `Crypto` so the FE gets a
    // stable `kind: "Crypto"` instead of an opaque `Other` string.
    hcfs_client::drive::keys::derive_folder_mnemonic(master_mnemonic, label).map_err(|e| crate::error::AppError::Crypto(e.to_string()))
}

/// Ensure the folder uses the correct derived mnemonic for the current master.
///
/// Detects two legacy states:
///   1. Folder mnemonic == master verbatim (copied during migration without derivation)
///   2. Folder mnemonic != derive(master, label) (derived from a different/old master)
///
/// In either case it re-derives from the current master, writes a `.needs_rekey`
/// marker, and wipes local sync state so local files re-upload under the
/// correct key.
///
/// It does NOT purge the remote copies, and nothing downstream does either.
/// An earlier revision of this doc claimed `initialize_sync_inner` purged
/// them; that purge was removed in #302 and the claim was left behind, which
/// hid the real consequence for a year. State it plainly instead:
///
/// **Every remote file uploaded before the rekey stays encrypted under the
/// OLD key and can never be decrypted by this device again.** The local
/// copies are safe and re-upload fine; the stale remote revisions are dead
/// weight the sync engine will keep trying to download and failing to open.
///
/// The marker therefore records a diagnosis, not a pending task — see
/// [`RekeyRecord`]. Do not "consume" it by deleting it: the condition it
/// describes is permanent until those remote files are replaced, and
/// deleting the marker only destroys the evidence.
pub(crate) fn ensure_derived_mnemonic(folder_dir: &Path, master_path: &Path, password: &str, label: &str) -> Result<()> {
    use zeroize::Zeroizing;

    let folder_enc = folder_dir.join("enc_mnemonic.json");
    if !folder_enc.exists() || !master_path.exists() {
        return Ok(());
    }

    // Each decrypted/derived mnemonic is held in `Zeroizing` so its heap copy
    // is scrubbed by `Drop` on *every* exit — including every `?` below (the
    // folder `recover_mnemonic`, `derive_folder_mnemonic`, the marker
    // `File::create`, and `save_encrypted_mnemonic`). The prior bare-`String` +
    // manual `.zeroize()` form leaked the plaintext on those early returns: the
    // manual wipes only sat on the happy paths, so a `?` unwound past them.
    // (axiom rust_quality_167). The `==` comparisons below are variable-time,
    // which is acceptable here: both operands are locally derived (decrypted
    // from disk / derived from the local master), never an attacker-timed oracle.
    let master = hcfs_client::auth::recover_mnemonic(master_path, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let master_str = Zeroizing::new(master.to_string());

    let folder = hcfs_client::auth::recover_mnemonic(&folder_enc, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;
    let folder_str = Zeroizing::new(folder.to_string());

    let expected = Zeroizing::new(derive_folder_mnemonic(&master_str, label)?);

    if *folder_str == *expected {
        // Already correct — nothing to do (secrets scrubbed on drop).
        return Ok(());
    }

    // Folder mnemonic is wrong — either raw master or derived from an old master.
    let reason = if *folder_str == *master_str {
        RekeyReason::RawMasterInFolderSeal
    } else {
        RekeyReason::DerivedFromAnotherMaster
    };
    // WARN, not INFO: this silently strands every remote file the drive
    // already has. It was logged at INFO for a year and nobody saw it.
    warn!(
        label = %label,
        reason = ?reason,
        "Folder key does not match this account's master — re-deriving. \
         Remote files uploaded under the previous key become permanently \
         undecryptable on this device."
    );

    // `master_str`/`folder_str` are unused past this comparison; scrub them now —
    // before the marker + save I/O — so the plaintext window stays as narrow as
    // the pre-Zeroizing code's explicit early wipe. `expected` is still needed
    // for the save below and is scrubbed at end of scope.
    drop(folder_str);
    drop(master_str);

    // Create the rekey marker BEFORE saving the new mnemonic. If the
    // process crashes after the mnemonic is saved but before the marker
    // is written, the next startup would see folder == expected and
    // skip — leaving stale remote files encrypted with the old key.
    append_rekey_record(
        folder_dir,
        RekeyRecord {
            rekeyed_at: chrono::Utc::now().timestamp(),
            reason: Some(reason),
        },
    )?;

    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &expected, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;

    // Wipe sync state so files get re-uploaded with the new key
    let state_path = folder_dir.join("sync_state.json");
    let state_bak = folder_dir.join("sync_state.json.bak");
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&state_bak);

    // The remote copies are still THERE; what they no longer are is readable.
    // The previous wording ("remote files preserved") read as reassurance
    // directly contradicting the warning above, which is part of why this went
    // unnoticed — say only what this step actually did.
    info!(
        "Re-derived mnemonic for '{}', wiped local sync state so local files re-upload under the new key",
        label
    );

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
            && candidate_is_account_master(&mnemonic, account_id)
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
            && candidate_is_account_master(&mnemonic, account_id)
        {
            return Ok(zeroize::Zeroizing::new(mnemonic));
        }
    }

    // Stage 5: nothing recoverable. Frontend dispatches on this kind to
    // prompt the user to log in again with their seed phrase.
    Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::MasterMnemonicUnrecoverable))
}

/// Post-condition for the Stage 3/4 drive-export fallbacks: does `candidate`
/// actually derive to `account_id`'s SS58 address?
///
/// `DriveManager::export_mnemonic` returns the per-folder mnemonic, which
/// `init_new_drive` wrote as `derive_folder_mnemonic(master, label)` — a
/// one-way hash of the master, NOT the master itself. Returning it as the
/// account master would derive a different sr25519/SS58 keypair than
/// `account_id`, corrupting auth (a token persisted under a foreign address)
/// and showing the user the wrong "recovery phrase" to back up (audit R-06,
/// and the W-02 unguarded consumers downstream). Reject any candidate that
/// doesn't reproduce the account's own address so the chain falls through to
/// the safe `MasterMnemonicUnrecoverable` re-auth path.
///
/// DECIDED TRADE-OFF (review 2026-06-11): this check assumes the account's
/// address derives from the master. For OAuth accounts the address comes
/// from the server while the sync master is locally minted, so Stage 3/4
/// recovery is categorically unavailable to them — including the narrow
/// legacy case (v0 plaintext drive_password + verbatim pre-derivation folder
/// file) the old unguarded code happened to recover correctly. Accepted:
/// that population is tiny, the server-blob Unlock flow remains their
/// recovery path, and relaxing the guard re-admits installing a folder
/// mnemonic as master. Do not "fix" this by skipping the check for OAuth.
fn candidate_is_account_master(candidate: &str, account_id: &str) -> bool {
    match crate::auth::service::derive_keys(candidate) {
        Ok((_pair, substrate_address, _eth_signer, _eth_address)) => substrate_address == account_id,
        Err(e) => {
            warn!("Drive-fallback mnemonic failed key derivation during master validation: {e}");
            false
        }
    }
}

/// Tauri command wrapper: return the master BIP-39 mnemonic by decrypting it
/// from disk.
///
/// Unwraps the [`zeroize::Zeroizing<String>`] at the IPC boundary so that
/// Tauri can serialize it as a plain `String`. The `Zeroizing` wrapper is
/// dropped (and the in-process copy wiped) immediately after the clone.
#[tauri::command]
pub async fn get_drive_mnemonic(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<String> {
    // Returns the account's decrypted master mnemonic; authorize against the
    // session so a renderer can't read another local account's seed.
    let account_id = state.require_session_account(&account_id)?;
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
    // Generates/persists the account's master mnemonic; authorize against the
    // session (FE invokes it post-login for the current user).
    let account_id = state.require_session_account(&account_id)?;
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
        // Re-emit `hippius_auth_ready` so the FE's `tryAutoInitSync`
        // retry ladder picks up. The FE now fires
        // `ensure_sync_mnemonic` in parallel with `initSync` (no
        // longer awaiting it before invoking `auto_init_sync`), so
        // the first `auto_init_sync` attempt may land while
        // `AuthInfo.mnemonic` is still empty. The ladder's listener
        // is armed before attempt 1, so an emit here unblocks the
        // next retry the moment the cache is populated. Cheap (one
        // Tauri event), no-op for paths where the FE didn't actually
        // race.
        state.sync_bridge.emit_auth_ready();
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

    // Same rationale as the fast-recovery branch above — the FE
    // races `ensure_sync_mnemonic` with `initSync`, so emit
    // `hippius_auth_ready` once the cache is populated so the retry
    // ladder picks up.
    state.sync_bridge.emit_auth_ready();

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

    // `ZipError` flows through `?` via `AppError::Zip(#[from] …)`, preserving
    // its `source()` chain and surfacing as a stable `kind: "Zip"` to the FE —
    // the `.to_string()` collapse into `Other` discarded both.
    zip.start_file("recovery-phrase.txt", options)?;
    zip.write_all(mnemonic.as_bytes())?;

    let cursor = zip.finish()?;
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
/// Idempotent: `save_encrypted_mnemonic` replaces the blob atomically (write
/// to a temp sibling, fsync, rename), so re-running this function with the
/// same inputs leaves the same live file. Safe to re-run after a partial
/// failure.
///
/// It no longer truncates in place — the doc said so until the pin moved to
/// 02191cc, and that wording is exactly what hid the `.bak` this function
/// now has to retire (see [`retire_key_backup`]).
///
/// Skips the internal `migration` pseudo-drive label (see
/// `sync::drive_status` filters). Folders whose `enc_mnemonic.json` does
/// not exist yet are created under the new password as part of this call
/// — rotation brings every folder that has a `sync_paths` row up to date,
/// whether or not it had been realised on disk before.
///
/// MEMBER drives (shared-drives phase 2) are excluded at the query: their
/// seal holds the OWNER's folder mnemonic (installed from the invite grant),
/// which is NOT derivable from this account's master — re-deriving here would
/// overwrite the only local copy of the drive key with material that
/// addresses the owner's namespace under the wrong key (the same land mine
/// `prepare_config_dir`'s member gate guards in the init funnel). The member
/// seal therefore stays under the OLD password after a rotation; the drive's
/// next init fails to unlock and surfaces the member-unrepairable error,
/// whose remedy (re-add from the grant) restores the seal under the current
/// password. KNOWN GAP, tracked for Task 4+: rotating the member seal in
/// place needs either the old password (not available to this flow by
/// design) or a grant-blob re-open.
///
/// Each folder is rewritten independently and a per-folder failure is
/// warn-logged with its `label`, but — unlike the original best-effort
/// version — the function returns `Err` listing every folder that could not
/// be rewritten. A swallowed failure here is a silent data-loss bug: the
/// caller [`align_drive_password`](crate::recovery) would commit the new
/// `drive_password` while a folder file stayed under the old one, wedging that
/// drive on the next sync init. Surfacing the `Err` lets the rotation flow
/// keep its retry sidecar and converge (re-derivation is deterministic and
/// idempotent). Also returns `Err` when the `sync_paths` read itself fails.
pub(crate) async fn reencrypt_all_folder_mnemonics(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    master_mnemonic: &str,
    new_password: &str,
) -> crate::error::Result<()> {
    use crate::auth::account_key::account_key;

    let owner = account_key(account_id);
    // Own drives only — both member columns NULL (the `resolve_drive_identity`
    // own-drive shape). A half-set row is corrupt and conservatively skipped
    // too: writing a derived seal into a slot whose identity is undecidable
    // could still clobber member key material.
    let labels: Vec<String> = sqlx::query_scalar("SELECT label FROM sync_paths WHERE owner = ? AND owner_ss58 IS NULL AND wire_folder_hash IS NULL")
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

    let futures = labels.iter().filter(|l| l.as_str() != "migration").map(|label| {
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
                        "reencrypt_all_folder_mnemonics: failed to compute folder dir"
                    );
                    return Err(label.clone());
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
                        "reencrypt_all_folder_mnemonics: failed to derive folder mnemonic"
                    );
                    return Err(label.clone());
                }
            };

            if let Some(parent) = folder_enc.parent()
                && let Err(e) = tokio::fs::create_dir_all(parent).await
            {
                tracing::warn!(
                    label = %label,
                    error = %e,
                    "reencrypt_all_folder_mnemonics: failed to create folder dir"
                );
                return Err(label.clone());
            }

            // save_encrypted_mnemonic is sync + blocking; wrap in
            // spawn_blocking to match install_recovered_mnemonic.
            // Owned copy of the password for the 'static spawn_blocking
            // closure, kept in a Zeroizing wrapper so it scrubs on drop.
            let password_owned: zeroize::Zeroizing<String> = zeroize::Zeroizing::new(new_password.as_str().to_owned());
            let label_for_task = label.clone();
            let result = tokio::task::spawn_blocking(move || {
                let outcome =
                    hcfs_client::auth::save_encrypted_mnemonic(&folder_enc, &folder_mnemonic_owned, &password_owned).map_err(|e| e.to_string());
                // Only on success: a failed write leaves the OLD blob live,
                // and its backup is the only spare copy of a still-current key.
                if outcome.is_ok() {
                    retire_key_backup(&folder_enc);
                }
                outcome
            })
            .await;

            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => {
                    tracing::warn!(
                        label = %label_for_task,
                        error = %e,
                        "reencrypt_all_folder_mnemonics: failed to save folder mnemonic"
                    );
                    Err(label_for_task.clone())
                }
                Err(e) => {
                    tracing::warn!(
                        label = %label_for_task,
                        error = %e,
                        "reencrypt_all_folder_mnemonics: spawn_blocking join error"
                    );
                    Err(label_for_task.clone())
                }
            }
        }
    });

    // Collect per-folder outcomes. Healthy folders are rewritten regardless of
    // a sibling's failure (so a retry only re-touches the broken ones), but any
    // failure surfaces as an aggregate `Err` so the caller does not commit a
    // new drive password over a folder still under the old one.
    let results = futures_util::future::join_all(futures).await;
    let failed: Vec<String> = results.into_iter().filter_map(std::result::Result::err).collect();
    if !failed.is_empty() {
        // A re-derive / AEAD-encrypt failure for one or more folders is
        // cryptographic; surface it as `Crypto` while keeping the inspectable
        // folder-list message the rotation retry sidecar logs and converges on.
        return Err(crate::error::AppError::Crypto(format!(
            "failed to re-encrypt folder mnemonics for: {}",
            failed.join(", ")
        )));
    }

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
        // Pin the taxonomy: a derivation failure is `Crypto`, not the old `Other`.
        assert!(
            matches!(result, Err(crate::error::AppError::Crypto(_))),
            "invalid master must surface as Crypto, got {result:?}"
        );
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
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
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
        // A MEMBER drive row (shared drives phase 2): its seal holds the
        // OWNER's folder mnemonic and must survive the rotation untouched —
        // re-deriving it from this account's master would destroy the only
        // local copy of the drive key.
        sqlx::query("INSERT INTO sync_paths (owner, path, label, owner_ss58, wire_folder_hash) VALUES (?, ?, ?, ?, ?)")
            .bind(&owner)
            .bind("/tmp/team")
            .bind("team")
            .bind("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty")
            .bind("0123456789abcdef")
            .execute(&pool)
            .await
            .unwrap();

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

        // Seed the member drive's owner seal (any valid mnemonic that is NOT
        // derive(master, "team") — here the master itself as a stand-in).
        let team_dir = config_dir_for_folder(account, "team").unwrap();
        tokio::fs::create_dir_all(&team_dir).await.unwrap();
        let team_enc = team_dir.join("enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&team_enc, master, "old password").unwrap();
        let team_seal_before = tokio::fs::read(&team_enc).await.unwrap();

        reencrypt_all_folder_mnemonics(&pool, account, master, new_password).await.unwrap();

        // team (member drive): the owner seal must be byte-identical — not
        // re-derived, not re-encrypted under the new password.
        assert_eq!(
            tokio::fs::read(&team_enc).await.unwrap(),
            team_seal_before,
            "a member drive's owner seal must survive rotation untouched"
        );

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
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
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
    async fn reencrypt_with_invalid_master_returns_err_naming_all_folders() {
        use sqlx::sqlite::SqlitePoolOptions;

        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
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

        // Invalid master — every folder's derive step fails. The new contract
        // surfaces this as an aggregate Err naming every failed folder (a
        // swallowed Ok here would let the caller flip the drive password while
        // no folder was rewritten), and still writes no file.
        let err = reencrypt_all_folder_mnemonics(&pool, account, "not a bip39 mnemonic", "any-password")
            .await
            .unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("alpha") && msg.contains("beta"),
            "error must name every failed folder, got: {msg}"
        );
        // Pin the taxonomy: the aggregate re-encrypt failure is `Crypto`.
        assert!(
            matches!(err, crate::error::AppError::Crypto(_)),
            "aggregate re-encrypt failure must surface as Crypto, got {err:?}"
        );

        for label in ["alpha", "beta"] {
            let enc = config_dir_for_folder(account, label).unwrap().join("enc_mnemonic.json");
            assert!(!enc.exists(), "{label}: no file should be written when derivation fails");
        }
    }

    /// R-06: the Stage 3/4 post-condition must accept the real master and
    /// reject a folder-derived mnemonic (what `export_mnemonic` actually
    /// returns) for the account's address.
    #[test]
    fn candidate_is_account_master_accepts_master_rejects_folder() {
        let master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let (_pair, master_ss58, _eth_signer, _eth_address) = crate::auth::service::derive_keys(master).expect("derive master keys");

        // The genuine master reproduces its own account_id.
        assert!(candidate_is_account_master(master, &master_ss58));

        // The per-folder mnemonic Stages 3/4 export is one-way-derived from the
        // master and is NOT the account master — it must be rejected.
        let folder = derive_folder_mnemonic(master, "default").expect("derive folder mnemonic");
        assert_ne!(folder, master, "folder mnemonic must differ from master");
        assert!(
            !candidate_is_account_master(&folder, &master_ss58),
            "a folder mnemonic must not validate as the account master (R-06)"
        );

        // A different account_id is rejected even for the genuine master.
        // This is also the OAuth shape (address NOT derived from the local
        // master): Stage 3/4 recovery is deliberately unavailable there —
        // see the decided trade-off on `candidate_is_account_master`.
        assert!(!candidate_is_account_master(master, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"));
    }

    // ── key-blob backups ────────────────────────────────────────────

    /// THE security property: after a password rotation, nothing on disk may
    /// still open with the old password.
    ///
    /// Upstream's `save_encrypted_mnemonic` copies the previous blob to
    /// `<name>.bak` before replacing it (added between pins e66b58f and
    /// 02191cc). That backup is the mnemonic sealed under the OLD password.
    /// A user who rotates because they believe the old password is
    /// compromised would otherwise be left with a file that still answers to
    /// it, indefinitely — nothing else in the repo sweeps it.
    #[test]
    fn rotating_a_password_leaves_nothing_the_old_one_can_open() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let blob = tmp.path().join("enc_mnemonic.json");
        let backup = tmp.path().join("enc_mnemonic.json.bak");

        hcfs_client::auth::save_encrypted_mnemonic(&blob, TEST_MASTER, "old-password").expect("seal under the old password");
        hcfs_client::auth::save_encrypted_mnemonic(&blob, TEST_MASTER, "new-password").expect("re-seal under the new one");

        // Precondition: upstream really does leave the old blob behind, so
        // this test is guarding a live hazard rather than a hypothetical.
        assert!(
            backup.exists(),
            "upstream no longer writes a .bak — if that is deliberate, this \
             guard and `retire_key_backup` can go, but confirm it first"
        );
        assert!(
            hcfs_client::auth::recover_mnemonic(&backup, "old-password").is_ok(),
            "precondition: the backup is openable with the OLD password"
        );

        retire_key_backup(&blob);

        assert!(!backup.exists(), "the old-password blob must not survive a rotation");
        assert!(
            hcfs_client::auth::recover_mnemonic(&blob, "new-password").is_ok(),
            "and the live blob must still open with the new password"
        );
    }

    /// The name is built by APPENDING to the whole filename, matching
    /// upstream's `sibling_with_suffix`. `with_extension("bak")` would target
    /// `enc_mnemonic.bak` and sweep nothing at all, silently.
    #[test]
    fn retire_key_backup_targets_the_appended_name_not_a_replaced_extension() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let blob = tmp.path().join("enc_mnemonic.json");
        std::fs::write(&blob, b"live").expect("live blob");
        std::fs::write(tmp.path().join("enc_mnemonic.json.bak"), b"old").expect("appended");
        std::fs::write(tmp.path().join("enc_mnemonic.bak"), b"decoy").expect("decoy");

        retire_key_backup(&blob);

        assert!(!tmp.path().join("enc_mnemonic.json.bak").exists(), "must remove the appended name");
        assert!(tmp.path().join("enc_mnemonic.bak").exists(), "must not touch an unrelated sibling");
        assert!(blob.exists(), "must never remove the live blob");
    }

    /// Best-effort: a rotation must not fail because there was nothing to
    /// sweep (first-ever write) or the file was already gone.
    #[test]
    fn retiring_an_absent_backup_is_silent() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        retire_key_backup(&tmp.path().join("enc_mnemonic.json"));
    }

    // ── rekey marker ────────────────────────────────────────────────

    /// A stable BIP-39 test vector — a published fixture, never a real wallet.
    const TEST_MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const OTHER_MASTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

    /// Seal `folder_mnemonic` as the drive's folder key and `TEST_MASTER` as
    /// the account master, then run the repair. Returns the folder dir.
    fn rekey_fixture(folder_mnemonic: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let folder_dir = tmp.path().join("folder");
        std::fs::create_dir_all(&folder_dir).expect("mk folder dir");

        let master_path = tmp.path().join("master_enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&master_path, TEST_MASTER, "pw").expect("seal master");
        hcfs_client::auth::save_encrypted_mnemonic(folder_dir.join("enc_mnemonic.json"), folder_mnemonic, "pw").expect("seal folder");

        (tmp, folder_dir, master_path)
    }

    /// The marker's records, or a panic naming what was found instead.
    fn records_at(folder_dir: &Path) -> Vec<RekeyRecord> {
        match read_rekey_marker(folder_dir) {
            RekeyMarker::Present(records) => records,
            RekeyMarker::Absent => panic!("expected a rekey marker, found none"),
            RekeyMarker::Unreadable(e) => panic!("expected a readable rekey marker, got {e}"),
        }
    }

    fn is_absent(folder_dir: &Path) -> bool {
        match read_rekey_marker(folder_dir) {
            RekeyMarker::Absent => true,
            RekeyMarker::Present(_) | RekeyMarker::Unreadable(_) => false,
        }
    }

    #[test]
    fn no_marker_means_no_record() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        assert!(is_absent(tmp.path()));
    }

    /// A zero-byte marker written by an older build still means "this drive
    /// was re-keyed". Treating it as absent would re-create the blind spot
    /// this whole change exists to remove.
    #[test]
    fn a_legacy_empty_marker_still_reports_a_rekey() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join(REKEY_MARKER), b"").expect("legacy marker");

        let records = records_at(tmp.path());

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].rekeyed_at, 0, "an undated marker reports epoch, not a fabricated date");
    }

    /// The honesty guard. A marker this build cannot parse says only "a rekey
    /// happened" — inventing the likelier of the two causes would put a
    /// fabricated finding in a support bundle, which is the failure mode this
    /// whole file exists to remove.
    #[test]
    fn an_unparseable_marker_records_no_reason_rather_than_guessing() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join(REKEY_MARKER), b"{ truncated by a crash").expect("corrupt marker");

        let records = records_at(tmp.path());

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].reason, None, "an unparseable marker must not name a cause it never recorded");
        assert_eq!(records[0].rekeyed_at, 0);
    }

    /// An UNREADABLE marker is not a healthy drive. Collapsing the two is the
    /// same silent evidence loss as deleting it, caused by a permission change
    /// or a transient FS fault instead. A directory in the marker's place is
    /// the portable way to make the read fail with something != NotFound.
    #[test]
    fn an_unreadable_marker_is_not_reported_as_absent() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::create_dir(tmp.path().join(REKEY_MARKER)).expect("marker path occupied by a dir");

        match read_rekey_marker(tmp.path()) {
            RekeyMarker::Unreadable(_) => {}
            RekeyMarker::Absent => panic!("an unreadable marker must never read as 'never re-keyed'"),
            RekeyMarker::Present(_) => panic!("a directory holds no records"),
        }
    }

    /// The shape written by the first revision that gave the marker contents:
    /// a bare object, not an array. A marker outlives the build that wrote it.
    #[test]
    fn a_single_object_marker_still_reads_back() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(
            tmp.path().join(REKEY_MARKER),
            br#"{"rekeyed_at":1700000000,"reason":"RawMasterInFolderSeal"}"#,
        )
        .expect("v1 marker");

        let records = records_at(tmp.path());

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].rekeyed_at, 1_700_000_000);
        assert_eq!(records[0].reason, Some(RekeyReason::RawMasterInFolderSeal));
    }

    /// A seal holding the master verbatim is the migration-copy case.
    #[test]
    fn repairing_a_raw_master_seal_records_that_reason() {
        let (_tmp, folder_dir, master_path) = rekey_fixture(TEST_MASTER);

        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("repair succeeds");

        let records = records_at(&folder_dir);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].reason, Some(RekeyReason::RawMasterInFolderSeal));
        assert!(records[0].rekeyed_at > 0, "a fresh record must carry a real timestamp");
    }

    /// A seal derived from a DIFFERENT master is the case that strands remote
    /// files: the namespace still resolves, but nothing decrypts.
    #[test]
    fn repairing_a_foreign_derived_seal_records_that_reason() {
        let foreign = derive_folder_mnemonic(OTHER_MASTER, "docs").expect("derive foreign folder key");
        let (_tmp, folder_dir, master_path) = rekey_fixture(&foreign);

        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("repair succeeds");

        let records = records_at(&folder_dir);
        assert_eq!(records[0].reason, Some(RekeyReason::DerivedFromAnotherMaster));
    }

    /// Two rekeys strand two generations of remote revisions. Last-write-wins
    /// would hide the first window from triage entirely.
    #[test]
    fn a_second_rekey_appends_rather_than_overwriting_the_first() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        append_rekey_record(
            tmp.path(),
            RekeyRecord {
                rekeyed_at: 100,
                reason: Some(RekeyReason::RawMasterInFolderSeal),
            },
        )
        .expect("first record");
        append_rekey_record(
            tmp.path(),
            RekeyRecord {
                rekeyed_at: 200,
                reason: Some(RekeyReason::RecoveryGeneratedNewMaster),
            },
        )
        .expect("second record");

        let records = records_at(tmp.path());

        assert_eq!(records.len(), 2, "the earlier rekey window must survive the later one");
        assert_eq!(records[0].rekeyed_at, 100, "history is oldest-first");
        assert_eq!(records[1].reason, Some(RekeyReason::RecoveryGeneratedNewMaster));
    }

    /// Appending onto a legacy flag keeps the "something happened" evidence
    /// instead of replacing it with only the new event.
    #[test]
    fn appending_onto_a_legacy_marker_keeps_the_earlier_event() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join(REKEY_MARKER), b"").expect("legacy marker");

        append_rekey_record(
            tmp.path(),
            RekeyRecord {
                rekeyed_at: 200,
                reason: Some(RekeyReason::DerivedFromAnotherMaster),
            },
        )
        .expect("append");

        let records = records_at(tmp.path());

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].reason, None, "the legacy event survives as an unrecorded-reason entry");
        assert_eq!(records[1].rekeyed_at, 200);
    }

    /// A healthy drive must NOT be marked. A spurious marker would tell
    /// support that a drive's remote files are unreadable when they are fine.
    #[test]
    fn a_correctly_derived_seal_is_never_marked() {
        let correct = derive_folder_mnemonic(TEST_MASTER, "docs").expect("derive correct folder key");
        let (_tmp, folder_dir, master_path) = rekey_fixture(&correct);
        std::fs::write(folder_dir.join("sync_state.json"), b"{}").expect("sync state");

        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("no-op succeeds");

        assert!(is_absent(&folder_dir), "a healthy drive must not be marked");
        assert!(
            folder_dir.join("sync_state.json").exists(),
            "a healthy drive must not have its sync state wiped"
        );
    }

    /// The one sanctioned retirement: the remote revisions the history warns
    /// about were deleted server-side, so the warning no longer describes
    /// anything real.
    #[test]
    fn clearing_retires_the_marker_and_is_idempotent() {
        let (_tmp, folder_dir, master_path) = rekey_fixture(TEST_MASTER);
        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("repair succeeds");
        assert!(!is_absent(&folder_dir), "precondition: the drive is marked");

        clear_rekey_marker(&folder_dir);
        clear_rekey_marker(&folder_dir);

        assert!(is_absent(&folder_dir), "a cleared marker reads as absent");
    }

    /// THE regression guard: reporting the diagnosis must not consume it.
    ///
    /// `register_drive` used to delete the marker ("consuming without remote
    /// purge"), which made the one piece of evidence explaining a drive's
    /// undecryptable files disappear at the next launch. If someone
    /// reintroduces a delete here, this fails.
    #[test]
    fn reporting_the_marker_does_not_delete_it() {
        let (_tmp, folder_dir, master_path) = rekey_fixture(TEST_MASTER);
        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("repair succeeds");
        let before = std::fs::read(folder_dir.join(REKEY_MARKER)).expect("marker written");

        // Every launch reports it; none of them may consume it.
        for _ in 0..3 {
            report_rekey_marker(&folder_dir, "docs");
        }

        assert!(
            folder_dir.join(REKEY_MARKER).exists(),
            "reporting must leave the marker in place — the condition it \
             records is permanent until the remote files are replaced"
        );
        assert_eq!(
            std::fs::read(folder_dir.join(REKEY_MARKER)).expect("marker still readable"),
            before,
            "reporting must not rewrite the marker either",
        );
    }

    /// Reporting a drive that was never re-keyed must be inert.
    #[test]
    fn reporting_an_unmarked_drive_creates_nothing() {
        let tmp = tempfile::TempDir::new().expect("tempdir");

        report_rekey_marker(tmp.path(), "docs");

        assert!(!tmp.path().join(REKEY_MARKER).exists(), "reporting must never CREATE a marker");
    }

    /// Reporting an unreadable marker must not "tidy" it away either — the
    /// unreadable file is the evidence.
    #[test]
    fn reporting_an_unreadable_marker_leaves_it_alone() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        std::fs::create_dir(tmp.path().join(REKEY_MARKER)).expect("marker path occupied by a dir");

        report_rekey_marker(tmp.path(), "docs");

        assert!(tmp.path().join(REKEY_MARKER).exists(), "reporting must not remove an unreadable marker");
    }

    /// The atomic swap must not leave its scratch file behind — a stray
    /// `.needs_rekey.tmp` in a config dir is exactly the kind of debris that
    /// gets mistaken for a marker later.
    #[test]
    fn appending_leaves_no_scratch_file() {
        let tmp = tempfile::TempDir::new().expect("tempdir");

        append_rekey_record(
            tmp.path(),
            RekeyRecord {
                rekeyed_at: 1,
                reason: Some(RekeyReason::RawMasterInFolderSeal),
            },
        )
        .expect("append");

        assert!(!tmp.path().join(REKEY_MARKER_TMP).exists(), "the scratch file must be renamed away");
    }

    /// The repair wipes sync state so local files re-upload under the new
    /// key — but the local files themselves, and the drive's ability to
    /// sync going forward, must survive.
    #[test]
    fn the_repair_installs_the_correctly_derived_seal() {
        let (_tmp, folder_dir, master_path) = rekey_fixture(TEST_MASTER);
        std::fs::write(folder_dir.join("sync_state.json"), b"{}").expect("sync state");

        ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("repair succeeds");

        let sealed = hcfs_client::auth::recover_mnemonic(folder_dir.join("enc_mnemonic.json"), "pw").expect("recover repaired seal");
        assert_eq!(
            sealed.to_string(),
            derive_folder_mnemonic(TEST_MASTER, "docs").expect("expected derivation"),
            "the repair must install derive(master, label)"
        );
        assert!(!folder_dir.join("sync_state.json").exists(), "the repair wipes sync state");
    }
}
