//! OAuth account recovery.
//!
//! Desktop-side implementation of the always-on recovery flow: on fresh-device
//! OAuth login, the user's sealed mnemonic blob is fetched from hcfs-server,
//! decrypted with the user-supplied recovery password, and installed into the
//! local mnemonic store. See `docs/plans/2026-04-14-oauth-account-recovery.md`.
//!
//! This module owns:
//! - The default hcfs-server URL used before sync is configured.
//! - Helpers that seed the URL into `hcfs_config` so recovery can reach the
//!   server on a fresh device.
//! - The Tauri commands invoked by the recovery dialog.

use hcfs_client::mnemonic_blob::{SealedBlob, open_mnemonic, seal_mnemonic};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use tracing::{debug, info, warn};
use zeroize::Zeroizing;

use crate::auth::account_key::account_key;
use crate::auth::service::IdentityError;
use crate::console_access::{HcfsServerCtx, HttpOutcome, crypto_to_err, get_json, post_json_discard};
use crate::error::{AppError, Result};
use crate::recovery_proof::{
    MasterProof, Probe, ProofMethod, ProofProbes, RemoteAttempt, RemoteProbeOutcome, classify_remote_attempts, decide_master_proof,
};

/// Outcome of the OAuth recovery dialog, broadcast through a `watch` channel
/// so `ensure_sync_mnemonic` can await resolution before touching the local
/// mnemonic store.
///
/// `Pending` is the startup default — any code path that would mint a new
/// mnemonic must await a non-`Pending` state first. `Resolved` means either a
/// server blob was unlocked or a fresh mnemonic was sealed-and-uploaded, and
/// the local store is now authoritative. `Skipped` means no recovery action
/// was needed (e.g. local mnemonic already present).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryGateState {
    Pending,
    Resolved,
    Skipped,
}

impl RecoveryGateState {
    pub fn is_resolved(self) -> bool {
        !matches!(self, Self::Pending)
    }
}

/// Ensure an `hcfs_config` row exists for the account.
///
/// Idempotent. The row's `server_url` is left empty — that is the
/// auto-detect sentinel that hcfs-client interprets as "race the regional
/// endpoints and pick the faster one" (see
/// `crate::sync::config::normalize_for_region_probe`). Older builds
/// stored `https://arion.hippius.com` here; that legacy value is
/// transparently rewritten to empty at read time, so existing users
/// transparently opt into auto-detect without a DB migration.
///
/// Drive password remains untouched — this runs before the user has
/// chosen one, so `drive_password` stays empty and `encryption_version`
/// stays 0.
pub(crate) async fn seed_hcfs_server_url_if_missing(pool: &SqlitePool, account_id: &str) -> Result<()> {
    let owner = account_key(account_id);

    // Create a row if one doesn't exist yet. server_url defaults to '' via
    // the schema's NOT NULL DEFAULT '' — auto-detect fires on first sync.
    sqlx::query(
        r"
        INSERT OR IGNORE INTO hcfs_config
            (owner, server_url, drive_password, encryption_version, updated_at)
        VALUES (?, '', '', 0, CURRENT_TIMESTAMP)
        ",
    )
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Recovery state check
// ---------------------------------------------------------------------------

/// Discriminant the frontend uses to route the recovery dialog.
///
/// - `Signup` — no server blob, and either no local mnemonic (a
///   first-time user) OR a local mnemonic that we can decrypt (a legacy
///   user who pre-dates always-on recovery). Both see the "Protect Your
///   Account" wizard: the first-time case generates and seals a fresh
///   mnemonic, the legacy case seals the *existing* one. `seal_and_upload_mnemonic`
///   distinguishes the two and never mints over openable local state.
/// - `Unlock` — server blob exists but no usable local mnemonic (fresh
///   device returning user, or a local file we can't decrypt). User
///   sees "enter your recovery password".
/// - `Proceed` — local mnemonic is already present and either openable
///   with a server blob already in place, or unopenable (so sealing it
///   is unsafe). Nothing to do; the dialog auto-skips and marks the gate
///   resolved.
/// - `Unknown` — the server status check failed (network / auth). FE
///   shows a retry prompt; we never silently fall through to `Signup`
///   because that would upload a fresh blob and overwrite whatever
///   the user had before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryFlow {
    Signup,
    Unlock,
    Proceed,
    Unknown,
}

/// Result of [`check_recovery_state`]. Every field here drives a UI
/// decision; rendering only — no logic on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCheck {
    pub has_server_blob: bool,
    pub has_local_mnemonic: bool,
    pub updated_at: Option<String>,
    pub recommended_flow: RecoveryFlow,
}

/// Lightweight metadata-only fetch of the server blob.
///
/// Used by [`check_recovery_state`] to decide the flow without ever
/// materialising the ciphertext into memory.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobMetadata {
    #[serde(default)]
    updated_at: Option<String>,
}

/// Does the account have a usable master mnemonic on disk?
///
/// Cheap proxy: is `master_enc_mnemonic.json` present? A returning user
/// who's logged into this device before has the file; a fresh install
/// does not. We deliberately avoid decrypting — that would require the
/// drive password, which isn't available pre-recovery anyway.
fn has_local_mnemonic(account_id: &str) -> bool {
    crate::sync::mnemonic::master_mnemonic_path(account_id).is_ok_and(|p| p.exists())
}

/// Can the local `master_enc_mnemonic.json` be decrypted without prompting
/// the user for their recovery password?
///
/// Returns true in two cases:
/// 1. `AuthInfo.mnemonic` already holds the mnemonic for this account —
///    a seed-phrase login or a prior OAuth unlock this session populated it.
/// 2. `hcfs_config.drive_password` is plaintext (`encryption_version = 0`).
///    In that state, `get_drive_password(..., None)` succeeds and Stage 2 of
///    `sync::mnemonic::get_mnemonic_for_account` opens the master file on its
///    own.
///
/// Returns false for the canonical OAuth-returning-device state: no cached
/// mnemonic + drive_password encrypted under the mnemonic-derived key. In
/// that state Stage 2 chicken-and-eggs (needs mnemonic to decrypt
/// drive_password, needs drive_password to decrypt the master file), so the
/// recovery flow must route to `Unlock` and let the user supply the password
/// explicitly rather than silently proceeding into a dead-end.
async fn can_decrypt_local_mnemonic(state: &tauri::State<'_, crate::app_state::AppState>, account_id: &str, pool: &SqlitePool) -> bool {
    if let Ok(auth) = state.auth.lock()
        && auth.substrate_address.as_deref() == Some(account_id)
        && auth.mnemonic.is_some()
    {
        return true;
    }
    drive_password_is_plaintext(pool, account_id).await
}

/// Is `hcfs_config.drive_password` stored in its pre-unification plaintext
/// form (`encryption_version = 0`)?
///
/// Extracted so `can_decrypt_local_mnemonic` stays declarative and the DB
/// branch gets its own unit test (the AuthInfo-cache branch is a two-line
/// mutex check not worth fixturing).
async fn drive_password_is_plaintext(pool: &SqlitePool, account_id: &str) -> bool {
    let owner = account_key(account_id);
    matches!(
        sqlx::query_as::<_, (i32,)>("SELECT COALESCE(encryption_version, 0) FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_optional(pool)
            .await,
        Ok(Some((0,)))
    )
}

/// Check whether the active account needs recovery action.
///
/// Seeds the default hcfs-server URL if sync isn't configured yet, then
/// probes the blob endpoint for existence and combines that with local
/// mnemonic presence to recommend a UI flow. Network failure returns
/// [`RecoveryFlow::Unknown`] so the FE can retry instead of silently
/// overwriting server state.
#[tauri::command]
pub async fn check_recovery_state(state: tauri::State<'_, crate::app_state::AppState>) -> Result<RecoveryCheck> {
    check_recovery_state_inner(&state).await
}

/// Inner logic for [`check_recovery_state`]. Takes `tauri::State` so it can
/// reuse `HcfsServerCtx::resolve` (which in turn consults AuthInfo, pool,
/// and the API client). Callable from other commands (notably the OAuth
/// callback) without the `#[tauri::command]` boundary in the way.
pub(crate) async fn check_recovery_state_inner(state: &tauri::State<'_, crate::app_state::AppState>) -> Result<RecoveryCheck> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let short = crate::console_access::short_ss58(&account_id);
    debug!(account = %short, "recovery: checking recovery state (probing server for sealed mnemonic blob)");

    let local = has_local_mnemonic(&account_id);
    let can_decrypt = if local {
        can_decrypt_local_mnemonic(state, &account_id, pool).await
    } else {
        true
    };
    let (has_server_blob, updated_at) = probe_server_blob(state).await;

    let recommended_flow = decide_recovery_flow(local, can_decrypt, has_server_blob);

    info!(
        account = %short,
        has_local_mnemonic = local,
        can_decrypt_local = can_decrypt,
        has_server_blob = ?has_server_blob,
        flow = ?recommended_flow,
        "recovery: state decided (Signup=will upload blob, Unlock=will download blob, Proceed=local is authoritative, Unknown=probe failed)"
    );

    Ok(RecoveryCheck {
        has_server_blob: has_server_blob.unwrap_or(false),
        has_local_mnemonic: local,
        updated_at,
        recommended_flow,
    })
}

/// Map the three observable recovery facts to the UI flow.
///
/// Pure so the decision table is unit-testable without standing up
/// `AppState`, a pool, or the server probe. Inputs:
/// - `local` — a `master_enc_mnemonic.json` exists on disk.
/// - `can_decrypt` — that file (or `AuthInfo.mnemonic`) can be opened
///   without prompting for the recovery password.
/// - `has_server_blob` — `Some(true/false)` once the server probe
///   settles, `None` when it failed (network/auth).
///
/// Decision table:
///   local=false, blob=Some(false)         → Signup  (first-time user; mint + seal)
///   local=true,  decryptable, blob=false  → Signup  (legacy user; seal the EXISTING
///                                                     mnemonic — `seal_and_upload_mnemonic`
///                                                     reads it rather than minting)
///   local=false, blob=Some(true)          → Unlock  (returning user, fresh device)
///   local=true,  !decryptable, blob=true  → Unlock  (OAuth returning device: drive_password
///                                                     enc_ver=1, no cached mnemonic)
///   local=true,  decryptable, blob=true/None
///                                         → Proceed (local is authoritative)
///   local=true,  !decryptable, blob=Some(false)
///                                         → Proceed (unopenable AND definitively nothing
///                                                     to unlock — sealing it is unsafe:
///                                                     Signup would seal a master that
///                                                     can't reproduce the folder keys)
///   local=true,  !decryptable, blob=None  → Unknown (probe failed on the OAuth
///                                                     returning-device shape; the server
///                                                     may well hold the blob, so the FE
///                                                     must retry — Proceed here skipped
///                                                     the Unlock dialog and dead-ended
///                                                     `ensure_sync_mnemonic` into the
///                                                     seed-phrase banner, report 2026-08-19)
///   local=false, blob=None                → Unknown (probe failed; FE retries, never
///                                                     overwrites server state)
///
/// The legacy `Signup` arm is gated on `can_decrypt`: an undecryptable
/// local file stays on `Proceed` because `seal_and_upload_mnemonic`
/// would otherwise fall through to a freshly-minted master and either
/// trip `validate_master_against_existing_folders` or corrupt recovery
/// state.
///
/// An `Unknown` blob probe is only safe to fold into `Proceed` when the
/// local file is decryptable: `Proceed` maps to gate `Skipped`
/// (`recovery_gate_target`), and skipping the gate with an unopenable
/// local file sends `ensure_sync_mnemonic` into a guaranteed dead end
/// (`MasterMnemonicUnrecoverable` — its Stage 2 chicken-and-eggs and
/// Stages 3/4 are categorically unavailable to OAuth accounts).
// The two `Signup` arms are distinct decision-table rows, not an accidental
// duplicate: `(true, true, Some(false))` seals an EXISTING legacy mnemonic
// while `(false, _, Some(false))` mints a first-time one (see the doc table
// above + `seal_and_upload_mnemonic`'s two paths). Same for the `Proceed`
// and `Unknown` pairs. They are kept as separate arms to mirror that table
// 1:1; merging them via `|` would fold different recovery scenarios into one
// and break the spec-to-code traceability this security-sensitive function
// depends on.
#[allow(clippy::match_same_arms, reason = "distinct decision-table rows that share an outcome; see comment above")]
fn decide_recovery_flow(local: bool, can_decrypt: bool, has_server_blob: Option<bool>) -> RecoveryFlow {
    match (local, can_decrypt, has_server_blob) {
        (true, false, Some(true)) | (false, _, Some(true)) => RecoveryFlow::Unlock,
        (true, true, Some(false)) => RecoveryFlow::Signup,
        (true, true, Some(true) | None) => RecoveryFlow::Proceed,
        (true, false, Some(false)) => RecoveryFlow::Proceed,
        (true, false, None) => RecoveryFlow::Unknown,
        (false, _, Some(false)) => RecoveryFlow::Signup,
        (false, _, None) => RecoveryFlow::Unknown,
    }
}

/// Probe hcfs-server for blob existence.
///
/// Returns `(Some(true), Some(updated_at))` when present,
/// `(Some(false), None)` on 404, and `(None, None)` on any network or
/// auth failure so the caller distinguishes "known absent" from
/// "don't know". Local-only `Proceed` callers skip this probe.
async fn probe_server_blob(state: &tauri::State<'_, crate::app_state::AppState>) -> (Option<bool>, Option<String>) {
    let ctx = match HcfsServerCtx::resolve(state).await {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "recovery probe: failed to resolve hcfs context");
            return (None, None);
        }
    };
    debug!(server = %ctx.base_url, "recovery probe: GET /v1/mnemonic-blob (metadata only, no ciphertext fetch)");
    match get_json::<BlobMetadata>(&ctx, "/v1/mnemonic-blob").await {
        Ok(HttpOutcome::Ok(meta)) => {
            info!(updated_at = ?meta.updated_at, "recovery probe: server has a sealed mnemonic blob for this account");
            (Some(true), meta.updated_at)
        }
        Ok(HttpOutcome::NotFound) => {
            info!("recovery probe: server has NO sealed mnemonic blob for this account (404)");
            (Some(false), None)
        }
        Err(e) => {
            warn!(error = %e, "recovery probe: server call failed");
            (None, None)
        }
    }
}

// ---------------------------------------------------------------------------
// Recover mnemonic from server blob
// ---------------------------------------------------------------------------

/// Fetch the sealed blob, decrypt it with the user's recovery password,
/// install the mnemonic into the local store, and mark the recovery gate
/// resolved.
///
/// Wrong password surfaces as [`AppError::Validation("Wrong passphrase.")`]
/// — same mapping the existing Console Access flow uses, so the frontend
/// matches one error shape. SS58 mismatch collapses to the same variant
/// (hcfs-client's `AeadTag`) and is logged for diagnosis; in practice it
/// shouldn't happen because the blob is keyed by the bearer-resolved
/// SS58 on the server side.
#[tauri::command]
pub async fn recover_mnemonic(app: tauri::AppHandle, state: tauri::State<'_, crate::app_state::AppState>, password: String) -> Result<()> {
    // Serialize against other recovery/rotation commands (audit R-18).
    let _recovery_guard = state.recovery_lock.lock().await;
    let password = Zeroizing::new(password);
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: downloading sealed mnemonic blob from server (GET /v1/mnemonic-blob) — decrypting locally with user recovery password"
    );

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let blob: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => b,
        HttpOutcome::NotFound => {
            return Err(AppError::Other("No recovery data found for this account on the server.".into()));
        }
    };

    // Argon2id (~1.5 s) off the executor — see run_kdf. Owned, zeroizing copies
    // of the secrets move into the closure; `blob` is moved (unused afterward),
    // `password`/`ss58` are cloned because the function reuses them below.
    let blob_k = blob;
    let password_k = password.clone();
    let ss58_k = ctx.ss58.clone();
    let mnemonic = run_kdf(move || open_mnemonic(&blob_k, &password_k, &ss58_k).map_err(crypto_to_err)).await?;

    // Persist the recovered mnemonic to the local store so subsequent
    // sync init picks it up without re-fetching. The file password is
    // the recovery password itself — the user only has to remember one.
    install_recovered_mnemonic(&account_id, &mnemonic, &password).await?;

    align_drive_password(pool, &account_id, &ctx.base_url, &mnemonic, &password).await?;

    // Cache in AuthInfo so the current session can proceed without
    // round-tripping through disk decryption.
    {
        let mut auth = state.auth.lock()?;
        auth.cache_session_mnemonic(&account_id, mnemonic.to_string());
    }

    // Definitive provider classification (audit H-4 residue). A pre-#102
    // mislabelled OAuth row (`provider = "mnemonic"`) with an EMPTY
    // keychain evades `restore_session`'s repair — which needs a keychain
    // mnemonic for its positive-mismatch tell — so the account restores
    // down the mnemonic path every launch. The recovered master IS that
    // missing evidence: repair now so the next boot takes the correct
    // OAuth path, without waiting on the best-effort keychain
    // mirror-write above to enable the boot-time repair.
    crate::auth::session_restore::repair_provider_from_recovered_master(pool, &account_id, &mnemonic).await;

    state.set_recovery_state(crate::recovery::RecoveryGateState::Resolved);

    // The mnemonic just became reachable via `get_mnemonic_for_account`
    // stage 1. A parked `ensure_sync_mnemonic` (fresh-OAuth flow) emits
    // `hippius_auth_ready` itself when it resumes, but the restore paths
    // fire no `ensure_sync_mnemonic` for mnemonic-labelled sessions —
    // this emit wakes any `tryAutoInitSync` retry ladder still inside
    // its window. Cheap (one Tauri event), harmless when nothing listens.
    state.sync_bridge.emit_auth_ready();

    // Same-session sync resume. The FE's `tryAutoInitSync` retry ladder
    // gives up 10s after subscribing, and typing an unlock password takes
    // longer than that — so on the restore-time unlock paths (OAuth
    // restore, and the mnemonic-labelled pre-#102 row) nothing would
    // re-run sync init until the next launch. Rust owns the "unlock
    // succeeded ⇒ sync can start" transition, so kick auto-init here.
    spawn_post_unlock_sync_init(app, account_id.clone());

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: unlock complete — mnemonic decrypted and installed locally (no upload performed)"
    );
    Ok(())
}

/// Kick `auto_init_sync` in the background after an unlock made the
/// mnemonic available.
///
/// [`recover_mnemonic`], [`restore_with_mnemonic`], and
/// [`reset_unlock_password`] need this: they are the lockout-exit paths.
/// The other recovery flows are never sync-wedged (`seal_and_upload_mnemonic`
/// runs when the local mnemonic is already decryptable, and current-password
/// rotation holds the mnemonic throughout), and the fresh-OAuth login flow
/// has its own resume — a parked `ensure_sync_mnemonic` whose completion
/// drives `initSync` via `scheduleOAuthSyncInit`. When that FE-driven init
/// races this spawn, `auto_init_sync`'s `AutoInitGuard` makes the loser
/// a no-op — concurrent auto-init calls are its documented expected
/// condition.
///
/// Skips outright when any drive is already initialized: `auto_init_sync`
/// re-initializes every configured drive unconditionally (teardown +
/// re-init), so running it over live drives would restart their sync
/// cycles for nothing.
///
/// Spawned, not awaited: the unlock IPC must return promptly so the
/// dialog closes while init (network-heavy, seconds) proceeds behind it.
/// Failures are logged only — per-drive `DriveStatus::Error` events and
/// the FE's own triggers (drive add, resume, next launch) are the
/// recovery paths, exactly as for an FE-invoked `auto_init_sync`.
fn spawn_post_unlock_sync_init(app: tauri::AppHandle, account_id: String) {
    use tauri::Manager as _;

    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::app_state::AppState>();

        let already_running = !state.sync.drives.lock().await.is_empty();
        if already_running {
            debug!("post-unlock sync init skipped — drives already initialized");
            return;
        }

        match crate::sync::lifecycle::auto_init_sync(app.clone(), state, account_id, None).await {
            Ok(result) => {
                info!(
                    any_initialized = result.any_initialized,
                    skipped_reason = ?result.skipped_reason,
                    "post-unlock sync init finished"
                );
            }
            Err(e) => {
                warn!(error = %e, "post-unlock sync init failed — next drive trigger or launch retries");
            }
        }
    });
}

/// Run a CPU-bound key-derivation closure off the Tokio executor.
///
/// Argon2id (`open_mnemonic` / `seal_mnemonic`, ~1.5 s) and PBKDF2 (folder
/// `recover_mnemonic`, 600k iterations) are blocking; running them inline stalls
/// every other task on this worker thread (axiom r4r_ch10_01). The closure runs
/// on the blocking pool and must own `'static` copies of its secrets — wrap them
/// in `Zeroizing` so they are scrubbed when it drops. A `JoinError` (the task
/// panicked or was cancelled) maps to `AppError::Other`; the closure's own
/// `Result` error passes straight through.
async fn run_kdf<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("KDF task failed to join: {e}")))?
}

/// Write the recovered mnemonic to `master_enc_mnemonic.json` under the
/// account directory. Creates parent directories if missing.
///
/// The heap-backed copies passed into `spawn_blocking` are wrapped in
/// `Zeroizing` so the mnemonic and password are scrubbed from the
/// allocator when the closure drops — the caller's `Zeroizing` wrapper
/// doesn't extend into the moved clones automatically.
/// hcfs-client's `save_encrypted_mnemonic` chmods the file to `0o600`,
/// so no additional permission tightening is needed here.
async fn install_recovered_mnemonic(account_id: &str, mnemonic: &str, password: &str) -> Result<()> {
    let path = crate::sync::mnemonic::master_mnemonic_path(account_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mnemonic_owned = Zeroizing::new(mnemonic.to_string());
    let password_owned = Zeroizing::new(password.to_string());
    tokio::task::spawn_blocking(move || {
        hcfs_client::auth::save_encrypted_mnemonic(&path, &mnemonic_owned, &password_owned).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
    .map_err(AppError::Hcfs)?;

    // Cache the plaintext mnemonic in the OS keychain so the next app
    // launch can rehydrate `AuthInfo.mnemonic` without a server round
    // trip through `GET /v1/mnemonic-blob` + recovery-password prompt.
    // Seed-phrase login already writes the keychain in `auth::login`;
    // this mirror-write covers the OAuth paths (recover_mnemonic,
    // seal_and_upload_mnemonic, change_recovery_password, and the boot
    // resumption of a partial rotation) so the same keychain fast-path
    // in `session_restore::rehydrate_or_restored` applies to every
    // returning user regardless of how they originally authenticated.
    //
    // Best-effort: keychain failures are logged and swallowed. The
    // plaintext mnemonic is scrubbed at function-return by the
    // `Zeroizing` wrapper on `mnemonic_owned`; we already hold a second
    // reference via the `&str` parameter, but the caller's `Zeroizing`
    // scrubs that one too. The keychain write needs an owned `String`
    // anyway; the `keyring` crate copies internally.
    match crate::auth::keychain::store_mnemonic(account_id, mnemonic) {
        Ok(()) => {
            info!(
                account = %crate::console_access::short_ss58(account_id),
                "recovery: cached mnemonic to OS keychain; next launch will skip server round-trip"
            );
        }
        Err(e) => {
            warn!(
                account = %crate::console_access::short_ss58(account_id),
                error = %e,
                "recovery: could not cache mnemonic to OS keychain; next launch will re-fetch from server"
            );
        }
    }
    Ok(())
}

/// On-disk path of the rotation sidecar for `account_id`.
pub(crate) fn rotation_sidecar_path(account_id: &str) -> Result<std::path::PathBuf> {
    let master = crate::sync::mnemonic::master_mnemonic_path(account_id)?;
    let parent = master
        .parent()
        .ok_or_else(|| AppError::Other("master mnemonic path has no parent".into()))?;
    Ok(parent.join("recovery_pending_local_rewrite.json"))
}

async fn write_rotation_sidecar(account_id: &str) -> Result<()> {
    let path = rotation_sidecar_path(account_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let body = serde_json::json!({
        "ss58": account_id,
        "created_at_ms": chrono::Utc::now().timestamp_millis(),
    });
    tokio::fs::write(&path, body.to_string()).await?;
    // chmod 0o600 — match master_enc_mnemonic.json.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&path).await?.permissions();
        perms.set_mode(0o600);
        tokio::fs::set_permissions(&path, perms).await?;
    }
    Ok(())
}

/// Best-effort removal. Missing sidecar is not an error.
async fn clear_rotation_sidecar(account_id: &str) {
    if let Ok(path) = rotation_sidecar_path(account_id)
        && let Err(e) = tokio::fs::remove_file(&path).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        warn!(error = %e, path = ?path, "clear_rotation_sidecar: failed to remove");
    }
}

/// Verify a candidate master mnemonic actually derives the folder
/// mnemonics stored on disk for this account.
///
/// For every `sync_paths` row we can read a folder `enc_mnemonic.json`
/// from, compute `derive_folder_mnemonic(candidate, label)` and compare
/// with the stored value. If any folder fails the check, refuse — the
/// candidate would seal a master that can't reproduce existing per-folder
/// encryption keys, leaving uploads encrypted under one master and
/// recovery under another.
///
/// Vacuously succeeds when there are no folders (fresh signup) or when
/// the drive password isn't yet set (folder mnemonics aren't recoverable
/// to compare; we have to trust the caller).
/// Own-drive `sync_paths` rows only. Member drives store the *owner's*
/// folder mnemonic under a local label — comparing them to
/// `derive_folder_mnemonic(this_master, local_label)` is a false mismatch
/// (land mine 1). Same filter as `reencrypt_all_folder_mnemonics`.
async fn own_drive_folder_rows(pool: &SqlitePool, account_id: &str) -> Result<Vec<(String, String)>> {
    let owner = account_key(account_id);
    Ok(
        sqlx::query_as("SELECT path, label FROM sync_paths WHERE owner = ? AND owner_ss58 IS NULL AND wire_folder_hash IS NULL")
            .bind(&owner)
            .fetch_all(pool)
            .await?,
    )
}

async fn validate_master_against_existing_folders(pool: &SqlitePool, account_id: &str, candidate_master: &str) -> Result<()> {
    let owner = account_key(account_id);
    let folders = own_drive_folder_rows(pool, account_id).await?;
    if folders.is_empty() {
        return Ok(());
    }

    // Inspect the drive-password row directly so we can tell three cases apart.
    // Collapsing the last two into a silent skip would let a WRONG master be
    // sealed over an account that already had encrypted key material, leaving
    // its uploads undecryptable:
    //   (a) no row / empty password  → pre-config, nothing to compare → allow
    //   (b) plaintext (version 0)     → compare folders against it
    //   (c) encrypted (version 1)     → the candidate master MUST decrypt it;
    //                                   if it can't, it's the wrong master → refuse
    let row: Option<(String, i32)> = sqlx::query_as("SELECT drive_password, COALESCE(encryption_version, 0) FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    let drive_password = match row {
        None => return Ok(()),
        Some((pw, _)) if pw.is_empty() => return Ok(()),
        Some((pw, 0)) => Zeroizing::new(pw),
        // version 1 (no AAD) and 2 (AAD, audit R-33) both route through
        // `get_drive_password`, which decrypts per the version.
        Some((_, 1 | 2)) => match crate::sync::config::get_drive_password(pool, account_id, Some(candidate_master)).await {
            Ok(pw) => pw,
            // Only an AEAD/key failure (`Crypto`) means "wrong master". A
            // transient DB/pool error must propagate truthfully — labelling
            // it "does not match" sends the user chasing a mnemonic problem
            // they don't have.
            Err(AppError::Crypto(_)) => {
                return Err(AppError::Validation(
                    "Cannot seal recovery blob: the provided master mnemonic does not match this \
                     account's existing encrypted drive password. Unlock with your original recovery \
                     password first, then retry."
                        .into(),
                ));
            }
            Err(other) => return Err(other),
        },
        Some((_, v)) => return Err(AppError::Other(format!("unknown drive password encryption_version: {v}"))),
    };

    for (_path, label) in &folders {
        let folder_dir = crate::sync::mnemonic::config_dir_for_folder(account_id, label)?;
        let folder_enc = folder_dir.join("enc_mnemonic.json");
        if !folder_enc.exists() {
            continue;
        }
        // PBKDF2 (600k iterations) off the executor, once per folder — see
        // run_kdf. Owned copies move into the closure. `drive_password` is now
        // `Zeroizing<String>` at its source, so cloning it yields another
        // scrubbed-on-drop copy for the 'static closure — no bare-String copy
        // of the secret remains anywhere in this function.
        let folder_enc_k = folder_enc.clone();
        let drive_password_k = drive_password.clone();
        let recovered = run_kdf(move || {
            hcfs_client::auth::recover_mnemonic(&folder_enc_k, &drive_password_k)
                .map_err(|e| AppError::Other(format!("recover folder mnemonic: {e}")))
        })
        .await;
        let stored = match recovered {
            Ok(m) => Zeroizing::new(m.to_string()),
            Err(e) => {
                warn!(
                    label = %label,
                    error = %e,
                    "recovery validation: failed to read stored folder mnemonic; skipping"
                );
                continue;
            }
        };
        let expected = Zeroizing::new(
            hcfs_client::drive::keys::derive_folder_mnemonic(candidate_master, label)
                .map_err(|e| AppError::Other(format!("derive_folder_mnemonic failed: {e}")))?,
        );
        if *stored != *expected {
            return Err(AppError::Other(format!(
                "Cannot seal recovery blob: candidate master mnemonic does not derive folder '{label}'. \
                 The local master is out of sync with folder state — restoring recovery against this master \
                 would leave uploads in this folder undecryptable. \
                 Import your original master mnemonic via Settings → Recovery before retrying."
            )));
        }
    }

    Ok(())
}

/// Bring `hcfs_config.drive_password` and every folder `enc_mnemonic.json`
/// into line with `new_password`. Called by every flow that settles a
/// "the user's canonical password is this now" moment: fresh signup,
/// fresh-device unlock, and rotation.
///
/// Rewrites every folder `enc_mnemonic.json` under `new_password` FIRST, then
/// commits the drive-password DB row. The folder step is a no-op when there
/// are no folders yet (fresh signup / fresh-device).
///
/// Ordering is load-bearing: `drive_password` is a single value but folders
/// are encrypted individually, so a folder rewrite failure must abort BEFORE
/// the DB row is flipped. With folders-first, a systemic failure (server down,
/// master unrecoverable, disk full) leaves the DB on the OLD password and
/// nothing is wedged; the rotation flow keeps its retry sidecar and converges
/// because re-derivation is deterministic and idempotent. A db-row-first order
/// would flip the password and then have to swallow folder failures, wedging
/// every folder still under the old password.
///
/// Never logs `new_password` or the master mnemonic. The `master` arg is used
/// both to derive the encryption key for the DB row AND as the input to
/// `derive_folder_mnemonic(master, label)`.
async fn align_drive_password(pool: &SqlitePool, account_id: &str, server_url: &str, master: &str, new_password: &str) -> Result<()> {
    crate::sync::mnemonic::reencrypt_all_folder_mnemonics(pool, account_id, master, new_password).await?;
    crate::sync::config::save_hcfs_config_internal(pool, account_id, server_url, new_password, Some(master)).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Seal and upload (fresh signup)
// ---------------------------------------------------------------------------

/// Seal the active account's master mnemonic under `password` and upload
/// it to hcfs-server. Used by the signup flow (where the mnemonic was
/// just generated and the user is setting their recovery password for
/// the first time) and by the existing-user migration path (where a
/// local mnemonic exists but no server blob does yet).
///
/// Unlike `enable_console_access`, this does *not* gate on a
/// `confirmed_backup` checkbox — the sealed blob on the server IS the
/// backup. Requiring the user to also write down the seed phrase to
/// tick a box is friction without added safety.
#[tauri::command]
pub async fn seal_and_upload_mnemonic(state: tauri::State<'_, crate::app_state::AppState>, password: String) -> Result<()> {
    // Serialize against other recovery/rotation commands (audit R-18).
    let _recovery_guard = state.recovery_lock.lock().await;
    let password = Zeroizing::new(password);
    // This password protects the master-mnemonic blob uploaded to the server
    // (offline-brute-forceable once that blob is obtained), so enforce the same
    // strength bar as change_recovery_password — the FE gate is not authoritative
    // and a direct IPC call could otherwise seal an empty/trivial password (audit M-2).
    reject_if_weak(&password)?;
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    // Obtain a mnemonic. For existing users it already lives in AuthInfo
    // or on disk; for fresh-signup users we mint one here but DO NOT
    // persist it to disk until the server upload succeeds — see the
    // commit-point discussion below.
    let (mnemonic, is_fresh_signup) = match crate::sync::mnemonic::get_mnemonic_for_account(state.inner(), &account_id).await {
        Ok(m) if !m.is_empty() => (m, false),
        _ => (crate::auth::login::generate_mnemonic_internal()?, true),
    };

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        is_fresh_signup,
        "recovery: sealing encrypted mnemonic blob and UPLOADING to server (POST /v1/mnemonic-blob) — {}",
        if is_fresh_signup { "fresh signup" } else { "legacy-user migration" }
    );

    // Refuse to seal a mnemonic that doesn't derive the folder mnemonics
    // already on disk. Without this guard, a stale/missing
    // `master_enc_mnemonic.json` lets the resolver fall through to either
    // a freshly-generated master (`is_fresh_signup`) or the Stage-3
    // folder-mnemonic fallback in `get_mnemonic_for_account`, both of
    // which seal a master that can't reproduce the per-folder
    // encryption keys. Console then downloads the blob, derives keys
    // from this wrong master, and AEAD-tag-fails on chunk 0. Detect
    // here, surface a clear error, and abort instead of corrupting the
    // server-side recovery state.
    validate_master_against_existing_folders(pool, &account_id, &mnemonic).await?;

    let ctx = HcfsServerCtx::resolve(&state).await?;
    // Argon2id off the executor. `mnemonic` is reused after sealing (installed
    // locally once the upload commits), so clone a zeroizing copy for the closure.
    let mnemonic_k = Zeroizing::new(mnemonic.to_string());
    let password_k = password.clone();
    let ss58_k = ctx.ss58.clone();
    let blob = run_kdf(move || seal_mnemonic(&mnemonic_k, &password_k, &ss58_k).map_err(crypto_to_err)).await?;

    // Server upload is the commit point: if it fails on the fresh-signup
    // path, leaving a local `master_enc_mnemonic.json` behind would make
    // the next `check_recovery_state` return `Proceed` (local present),
    // silently skipping the upload retry and leaving the user
    // unrecoverable. By POSTing first and installing locally only after
    // a 2xx, a failed upload leaves no local state, so the user hits
    // the Signup branch again on retry.
    //
    // For existing-user migration (`is_fresh_signup=false`) there's
    // already a local mnemonic from a prior session — the POST is the
    // only side effect, and if it fails the existing-user prompt will
    // re-fire on the next launch.
    post_json_discard(&ctx, "/v1/mnemonic-blob", &blob).await?;

    if is_fresh_signup {
        install_recovered_mnemonic(&account_id, &mnemonic, &password).await?;
        let mut auth = state.auth.lock()?;
        auth.cache_session_mnemonic(&account_id, (*mnemonic).clone());
    }

    align_drive_password(pool, &account_id, &ctx.base_url, &mnemonic, &password).await?;

    state.set_recovery_state(crate::recovery::RecoveryGateState::Resolved);
    info!(
        account = %crate::console_access::short_ss58(&account_id),
        is_fresh_signup,
        "recovery: encrypted mnemonic blob uploaded to server successfully"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Change recovery password (rotation)
// ---------------------------------------------------------------------------

/// Rotate the password protecting the sealed mnemonic blob on hcfs-server.
///
/// Flow (filled in across Tasks 2-5; this is the skeleton):
/// 1. GET sealed blob.
/// 2. Decrypt with `current` (wrong password → `Validation("Wrong passphrase.")`).
/// 3. Validate `new` (non-empty, strength, != current).
/// 4. Derivation guard (reuses [`validate_master_against_existing_folders`]).
/// 5. Reseal under `new`.
/// 6. POST upsert (commit point).
/// 7. Re-encrypt local `master_enc_mnemonic.json`. On failure, write a
///    sidecar and return `Ok(())` anyway — boot-time retry finishes it.
///
/// The mnemonic itself is unchanged, so no sync re-init or session
/// invalidation is needed.
///
/// Returns [`RecoveryRotationResult`] so the FE can tell a clean rotation from
/// one that committed on the server but left this device's local key alignment
/// to finish on the next boot — the latter should surface a non-fatal "finishing
/// up" warning rather than a bare "success" (audit R-19).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRotationResult {
    /// `true` when the rotation is durable (server + master file under the new
    /// password) but the local per-folder/DB `drive_password` alignment did not
    /// fully complete. It self-heals on the next boot/login via the sidecar, but
    /// a synced drive may briefly fail to open until then — so the FE should warn
    /// rather than report a clean success.
    pub align_pending: bool,
}

#[tauri::command]
pub async fn change_recovery_password(
    state: tauri::State<'_, crate::app_state::AppState>,
    current: String,
    new: String,
) -> Result<RecoveryRotationResult> {
    // Serialize against other recovery/rotation commands (audit R-18).
    let _recovery_guard = state.recovery_lock.lock().await;
    let current = Zeroizing::new(current);
    let new = Zeroizing::new(new);

    validate_new_password_inputs(&current, &new)?;
    reject_if_weak(&new)?;

    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: starting password rotation (will GET /v1/mnemonic-blob → decrypt → reseal → POST)"
    );

    let ctx = HcfsServerCtx::resolve(&state).await?;

    // 1. Fetch the current sealed blob.
    let blob: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => b,
        HttpOutcome::NotFound => {
            return Err(AppError::Other(
                "No sealed recovery blob on the server. Set a recovery password first.".into(),
            ));
        }
    };

    // 2. Decrypt with `current`. Wrong password → Validation("Wrong passphrase.").
    //    Argon2id off the executor (see run_kdf).
    let blob_k = blob;
    let current_k = current.clone();
    let ss58_open_k = ctx.ss58.clone();
    let mnemonic = run_kdf(move || open_mnemonic(&blob_k, &current_k, &ss58_open_k).map_err(crypto_to_err)).await?;

    // 3. Derivation guard — refuse to rotate under a master that can't
    //    reproduce existing folder mnemonics.
    validate_master_against_existing_folders(pool, &account_id, &mnemonic).await?;

    commit_new_unlock_password(state.inner(), pool, &ctx, &account_id, &mnemonic, &new, None).await
}

/// Boot-time finish for [`change_recovery_password`] partial failures.
///
/// Called by the frontend when the user re-enters their new password
/// after a previous rotation left the local file encrypted under the
/// old password (see sidecar mechanism). Verifies `password` decrypts
/// the current server blob, then rewrites the local file and clears
/// the sidecar.
#[tauri::command]
pub async fn resume_recovery_password_rotation(state: tauri::State<'_, crate::app_state::AppState>, password: String) -> Result<()> {
    // Serialize against other recovery/rotation commands (audit R-18).
    let _recovery_guard = state.recovery_lock.lock().await;
    let password = Zeroizing::new(password);
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let blob: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => b,
        HttpOutcome::NotFound => {
            // Server blob vanished — nothing left to finish. Clean up.
            clear_rotation_sidecar(&account_id).await;
            return Err(AppError::Other("No sealed recovery blob on the server; nothing to finish.".into()));
        }
    };

    // Verify the password decrypts the (new) server blob.
    //
    // Stale-sidecar note: the sidecar has no upper lifetime and we don't
    // compare against the `updated_at` captured when it was written. If
    // the user rotated again on a different device between the failing
    // rotation and this resume, `password` is the NEW-new password (the
    // only one that opens the current server blob) — so this call
    // silently finishes with whatever the server currently holds. That's
    // acceptable because the underlying mnemonic is unchanged across
    // rotations; the cost is only that the user may see this prompt
    // asking for "the new password" and must remember which one is
    // current. If we ever need stricter semantics, store `updated_at`
    // in the sidecar and require it to match the server's before
    // accepting the resume.
    // Argon2id off the executor (see run_kdf).
    let blob_k = blob;
    let password_k = password.clone();
    let ss58_k = ctx.ss58.clone();
    let mnemonic = run_kdf(move || open_mnemonic(&blob_k, &password_k, &ss58_k).map_err(crypto_to_err)).await?;

    // Derivation guard — refuse to rewrite local key material under a master
    // that can't reproduce the existing per-folder mnemonics. The two other
    // folder-mutating paths (`change_recovery_password`, `seal_and_upload_mnemonic`)
    // validate here; resume must too. Without it, a divergent server blob
    // (sealed from a stale/fallback master on another device) would have
    // `align_drive_password` rewrite every `enc_mnemonic.json` under the wrong
    // master, destroying the folder keys that open already-uploaded ciphertext —
    // permanent AEAD-tag failures on later downloads (audit R-10).
    validate_master_against_existing_folders(pool, &account_id, &mnemonic).await?;

    install_recovered_mnemonic(&account_id, &mnemonic, &password).await?;

    // align_drive_password failure is soft — the master file is now under
    // `password`, and the sync layer's `recover_drive` self-heal will
    // re-derive per-folder files on next sync init if the bulk rewrite
    // here left any partial state. Leave the sidecar in place so the
    // next boot retries align idempotently.
    if let Err(align_err) = align_drive_password(pool, &account_id, &ctx.base_url, &mnemonic, &password).await {
        warn!(
            error = %align_err,
            account = %crate::console_access::short_ss58(&account_id),
            "recovery: resume finished master install, but drive_password alignment failed — leaving sidecar for next retry"
        );
        return Ok(());
    }
    clear_rotation_sidecar(&account_id).await;
    state.auth.lock()?.cache_session_mnemonic(&account_id, mnemonic.to_string());

    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: rotation-resume finished; local file now matches server"
    );
    Ok(())
}

/// Read-only IPC used by the frontend on boot to decide whether to show
/// the "finish rotation" prompt.
#[tauri::command]
pub async fn has_pending_rotation(state: tauri::State<'_, crate::app_state::AppState>) -> Result<bool> {
    let account_id = state.current_account_id()?;
    let path = rotation_sidecar_path(&account_id)?;
    Ok(path.exists())
}

// ---------------------------------------------------------------------------
// Skip (local mnemonic already present)
// ---------------------------------------------------------------------------

/// Mark the recovery gate as skipped without performing any recovery
/// action. Called by the frontend on the `Proceed` branch, where a
/// local mnemonic already exists and the server blob (if any) is
/// ignored. Unblocks `ensure_sync_mnemonic` so sync init can start.
#[tauri::command]
pub async fn mark_recovery_skipped(state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    info!("recovery: gate marked Skipped — local mnemonic is authoritative, no server upload or download");
    state.set_recovery_state(crate::recovery::RecoveryGateState::Skipped);
    Ok(())
}

/// Restore files and wrap a new unlock password from a typed mnemonic.
///
/// The phrase is proven against this account BEFORE any POST. A wrong
/// phrase must never upsert `/v1/mnemonic-blob` — that would overwrite
/// the real sealed backup. Never mints a master (`seal_and_upload_mnemonic`
/// does; this command must not call it).
const PHRASE_MISMATCH: &str = "This recovery phrase does not match this account's files. Check the words and try again.";
const PHRASE_UNPROVEN: &str = "We couldn't verify this recovery phrase against this account yet (no files on this device or in the cloud to check). The unlock password is the only way to open the backup until a file has been synced.";
const SESSION_MNEMONIC_MISSING: &str = "This device doesn't have your mnemonic seed unlocked. Enter the seed to restore.";

#[tauri::command]
pub async fn restore_with_mnemonic(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    mnemonic: String,
    new_password: String,
) -> Result<RecoveryRotationResult> {
    let _recovery_guard = state.recovery_lock.lock().await;
    let mnemonic = Zeroizing::new(mnemonic);
    let new_password = Zeroizing::new(new_password);
    reject_if_weak(&new_password)?;

    bip39::Mnemonic::parse_normalized(mnemonic.trim()).map_err(|e| AppError::Validation(format!("Invalid recovery phrase: {e}")))?;

    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let method = prove_master_for_account(pool, &account_id, mnemonic.trim()).await?;
    info!(
        account = %crate::console_access::short_ss58(&account_id),
        ?method,
        "recovery: typed mnemonic proven; resealing unlock password"
    );

    validate_master_against_existing_folders(pool, &account_id, mnemonic.trim()).await?;
    let ctx = HcfsServerCtx::resolve(&state).await?;
    commit_new_unlock_password(state.inner(), pool, &ctx, &account_id, mnemonic.trim(), &new_password, Some(&app)).await
}

/// Rotate the unlock wrap when this process already holds the master.
///
/// Settings "forgot current password" on a device whose session can
/// already open the mnemonic. No proof walk — holding the master is
/// the proof. If the session cannot open it, the FE switches to
/// [`restore_with_mnemonic`].
#[tauri::command]
pub async fn reset_unlock_password(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    new_password: String,
) -> Result<RecoveryRotationResult> {
    let _recovery_guard = state.recovery_lock.lock().await;
    let new_password = Zeroizing::new(new_password);
    reject_if_weak(&new_password)?;

    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(state.inner(), &account_id)
        .await
        .map_err(|_| AppError::Validation(SESSION_MNEMONIC_MISSING.into()))?;
    if mnemonic.is_empty() {
        return Err(AppError::Validation(SESSION_MNEMONIC_MISSING.into()));
    }

    validate_master_against_existing_folders(pool, &account_id, &mnemonic).await?;
    let ctx = HcfsServerCtx::resolve(&state).await?;
    commit_new_unlock_password(state.inner(), pool, &ctx, &account_id, &mnemonic, &new_password, Some(&app)).await
}

fn proof_to_result(proof: MasterProof) -> Result<ProofMethod> {
    match proof {
        MasterProof::Confirmed { method } => Ok(method),
        MasterProof::Mismatch => Err(AppError::Validation(PHRASE_MISMATCH.into())),
        MasterProof::Unproven => Err(AppError::Validation(PHRASE_UNPROVEN.into())),
    }
}

fn finished_proof(probes: ProofProbes) -> Option<Result<ProofMethod>> {
    match decide_master_proof(probes) {
        MasterProof::Unproven => None,
        other => Some(proof_to_result(other)),
    }
}

/// Prove `candidate` is this account's master. Fail closed: Unproven and
/// Mismatch both refuse to reseal.
///
/// Recovery-binding is not probed live. `challenge_response` as the
/// phrase's derived identity would mint a phantom server account for a
/// *wrong but valid* BIP-39 (audit H-3). Binding stays in the pure table
/// for tests; this gatherer leaves it [`Probe::Absent`].
async fn prove_master_for_account(pool: &SqlitePool, account_id: &str, candidate: &str) -> Result<ProofMethod> {
    let mut probes = ProofProbes::none();
    match crate::auth::service::derive_verified_keys(candidate, account_id) {
        Ok(_) => probes.identity_match = true,
        Err(IdentityError::Mismatch { .. }) => {}
        Err(IdentityError::DeriveFailed(e)) => {
            return Err(AppError::Validation(format!("Invalid recovery phrase: {e}")));
        }
    }
    if let Some(done) = finished_proof(probes) {
        return done;
    }

    probes.drive = probe_drive_password_row(pool, account_id, candidate).await?;
    if let Some(done) = finished_proof(probes) {
        return done;
    }

    probes.folders = probe_local_folder_seals(pool, account_id, candidate).await?;
    if let Some(done) = finished_proof(probes) {
        return done;
    }

    probes.remote = probe_remote_decrypt(pool, account_id, candidate).await?;
    proof_to_result(decide_master_proof(probes))
}

async fn probe_drive_password_row(pool: &SqlitePool, account_id: &str, candidate: &str) -> Result<Probe> {
    let owner = account_key(account_id);
    let row: Option<(String, i32)> = sqlx::query_as("SELECT drive_password, COALESCE(encryption_version, 0) FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    match row {
        Some((pw, _)) if pw.is_empty() => Ok(Probe::Absent),
        // No row, or a plaintext password: neither is keyed by this master.
        None | Some((_, 0)) => Ok(Probe::Absent),
        Some((_, 1 | 2)) => match crate::sync::config::get_drive_password(pool, account_id, Some(candidate)).await {
            Ok(_) => Ok(Probe::Confirmed),
            Err(AppError::Crypto(_)) => Ok(Probe::Mismatch),
            Err(other) => Err(other),
        },
        Some((_, v)) => Err(AppError::Other(format!("unknown drive password encryption_version: {v}"))),
    }
}

async fn probe_local_folder_seals(pool: &SqlitePool, account_id: &str, candidate: &str) -> Result<Probe> {
    let folders = own_drive_folder_rows(pool, account_id).await?;
    let mut compared = 0u32;
    for (_path, label) in &folders {
        let folder_enc = crate::sync::mnemonic::config_dir_for_folder(account_id, label)?.join("enc_mnemonic.json");
        if !folder_enc.exists() {
            continue;
        }
        let drive_password = match crate::sync::config::get_drive_password(pool, account_id, Some(candidate)).await {
            Ok(pw) if !pw.is_empty() => pw,
            Ok(_) | Err(AppError::Crypto(_)) => return Ok(Probe::Mismatch),
            Err(other) => return Err(other),
        };
        let folder_enc_k = folder_enc.clone();
        let recovered = run_kdf(move || {
            hcfs_client::auth::recover_mnemonic(&folder_enc_k, &drive_password).map_err(|e| AppError::Other(format!("recover folder mnemonic: {e}")))
        })
        .await;
        let stored = match recovered {
            Ok(m) => Zeroizing::new(m.to_string()),
            Err(e) => {
                warn!(label = %label, error = %e, "restore proof: skipping unreadable folder seal");
                continue;
            }
        };
        let expected = Zeroizing::new(
            hcfs_client::drive::keys::derive_folder_mnemonic(candidate, label)
                .map_err(|e| AppError::Other(format!("derive_folder_mnemonic failed: {e}")))?,
        );
        if *stored != *expected {
            return Ok(Probe::Mismatch);
        }
        compared += 1;
    }
    if compared == 0 { Ok(Probe::Absent) } else { Ok(Probe::Confirmed) }
}

async fn probe_remote_decrypt(pool: &SqlitePool, account_id: &str, candidate: &str) -> Result<Probe> {
    let folders = crate::sync::folders::list_remote_folders_internal(pool, account_id).await?;
    let mut attempts = Vec::new();
    for folder in folders.iter().filter(|f| f.file_count > 0).take(3) {
        attempts.push(try_decrypt_one_remote_file(pool, account_id, candidate, folder).await);
    }
    match classify_remote_attempts(&attempts) {
        RemoteProbeOutcome::Confirmed => Ok(Probe::Confirmed),
        RemoteProbeOutcome::Mismatch => Ok(Probe::Mismatch),
        RemoteProbeOutcome::Unproven => Ok(Probe::Absent),
        RemoteProbeOutcome::Transport => Err(AppError::Hcfs(
            "Couldn't reach the server to verify this recovery phrase. Try again.".into(),
        )),
    }
}

/// hcfs-client's `SyncError` module is private; classify on the public Display.
/// Decrypt/integrity failures are a wrong key; everything else is transport.
fn remote_attempt_from_err_display(err: &impl std::fmt::Display) -> RemoteAttempt {
    let msg = err.to_string().to_ascii_lowercase();
    if msg.contains("decrypt") || msg.contains("hash mismatch") {
        RemoteAttempt::DecryptMiss
    } else {
        RemoteAttempt::Transport
    }
}

async fn try_decrypt_one_remote_file(
    pool: &SqlitePool,
    account_id: &str,
    candidate: &str,
    folder: &crate::sync::folders::RemoteFolderInfoResult,
) -> RemoteAttempt {
    let Ok(key) = hcfs_client::drive::remote::derive_encryption_key(candidate, &folder.label) else {
        return RemoteAttempt::DecryptMiss;
    };
    let identity = crate::sync::identity::DriveIdentity::own(account_id, &folder.folder_hash);
    let Ok(client) = crate::sync::remote::build_client(pool, account_id, &identity).await else {
        return RemoteAttempt::Transport;
    };
    let access = hcfs_client::drive::remote::RemoteFileAccess {
        client: &client,
        ss58_address: account_id,
        folder_hash: &folder.folder_hash,
        encryption_key: &key,
    };
    let files = match hcfs_client::drive::remote::list_remote_files(&access).await {
        Ok(files) => files,
        Err(e) => return remote_attempt_from_err_display(&e),
    };
    let Some(file) = files.first() else {
        return RemoteAttempt::EmptyFolder;
    };
    let Ok(tmp) = tempfile::NamedTempFile::new() else {
        return RemoteAttempt::Transport;
    };
    match hcfs_client::drive::remote::download_remote_file(&access, &file.file_id, tmp.path(), Some(|_: u64, _: u64| {})).await {
        Ok(_) => RemoteAttempt::Opened,
        Err(e) => remote_attempt_from_err_display(&e),
    }
}

/// Seal the master under `new_password`, POST the upsert, rewrite local
/// wraps. `wake` is set for restore/reset so a lockout session starts
/// sync; rotation passes `None` (session already has the mnemonic).
async fn commit_new_unlock_password(
    state: &crate::app_state::AppState,
    pool: &SqlitePool,
    ctx: &HcfsServerCtx,
    account_id: &str,
    mnemonic: &str,
    new_password: &str,
    wake: Option<&tauri::AppHandle>,
) -> Result<RecoveryRotationResult> {
    let mnemonic_k = Zeroizing::new(mnemonic.to_string());
    let new_k = Zeroizing::new(new_password.to_string());
    let ss58_k = ctx.ss58.clone();
    let new_blob = run_kdf(move || seal_mnemonic(&mnemonic_k, &new_k, &ss58_k).map_err(crypto_to_err)).await?;
    post_json_discard(ctx, "/v1/mnemonic-blob", &new_blob).await?;
    info!(
        account = %crate::console_access::short_ss58(account_id),
        "recovery: sealed blob upserted under new password (server is now authoritative)"
    );
    apply_local_unlock_wrap(state, pool, ctx, account_id, mnemonic, new_password, wake).await
}

async fn apply_local_unlock_wrap(
    state: &crate::app_state::AppState,
    pool: &SqlitePool,
    ctx: &HcfsServerCtx,
    account_id: &str,
    mnemonic: &str,
    new_password: &str,
    wake: Option<&tauri::AppHandle>,
) -> Result<RecoveryRotationResult> {
    match install_recovered_mnemonic(account_id, mnemonic, new_password).await {
        Ok(()) => {
            let align_pending = if let Err(align_err) = align_drive_password(pool, account_id, &ctx.base_url, mnemonic, new_password).await {
                warn!(
                    error = %align_err,
                    account = %crate::console_access::short_ss58(account_id),
                    "recovery: server rotated and master file rewritten, but drive_password alignment failed — leaving sidecar for boot-time retry"
                );
                if let Err(sidecar_err) = write_rotation_sidecar(account_id).await {
                    warn!(
                        error = %sidecar_err,
                        account = %crate::console_access::short_ss58(account_id),
                        "recovery: sidecar write also failed; boot-time retry unavailable. Rotation is still durable on the server; next login or rotation will re-align."
                    );
                }
                true
            } else {
                clear_rotation_sidecar(account_id).await;
                false
            };
            state.auth.lock()?.cache_session_mnemonic(account_id, mnemonic.to_string());
            wake_after_restore(state, pool, account_id, mnemonic, wake).await;
            info!(
                account = %crate::console_access::short_ss58(account_id),
                align_pending,
                "recovery: password rotation complete"
            );
            Ok(RecoveryRotationResult { align_pending })
        }
        Err(e) => local_rewrite_failed(state, pool, account_id, mnemonic, wake, e).await,
    }
}

async fn wake_after_restore(
    state: &crate::app_state::AppState,
    pool: &SqlitePool,
    account_id: &str,
    mnemonic: &str,
    wake: Option<&tauri::AppHandle>,
) {
    let Some(app) = wake else {
        return;
    };
    crate::auth::session_restore::repair_provider_from_recovered_master(pool, account_id, mnemonic).await;
    state.set_recovery_state(RecoveryGateState::Resolved);
    state.sync_bridge.emit_auth_ready();
    spawn_post_unlock_sync_init(app.clone(), account_id.to_string());
}

async fn local_rewrite_failed(
    state: &crate::app_state::AppState,
    pool: &SqlitePool,
    account_id: &str,
    mnemonic: &str,
    wake: Option<&tauri::AppHandle>,
    error: AppError,
) -> Result<RecoveryRotationResult> {
    warn!(
        error = %error,
        account = %crate::console_access::short_ss58(account_id),
        "recovery: server rotated but local rewrite failed — writing sidecar for boot-time retry"
    );
    if let Err(sidecar_err) = write_rotation_sidecar(account_id).await {
        warn!(
            error = %sidecar_err,
            account = %crate::console_access::short_ss58(account_id),
            "recovery: sidecar write also failed; boot-time retry unavailable. Rotation is durable on the server — surfacing the error so the user can re-run the change."
        );
        return Err(AppError::Other(format!(
            "Recovery password was changed on the server, but this device's key file could \
             not be updated and no retry marker could be saved ({error}; sidecar: {sidecar_err}). \
             Please run the password change again to finish updating this device."
        )));
    }
    if wake.is_some() {
        state.auth.lock()?.cache_session_mnemonic(account_id, mnemonic.to_string());
        wake_after_restore(state, pool, account_id, mnemonic, wake).await;
    }
    Ok(RecoveryRotationResult { align_pending: true })
}

/// Pure input validation for [`change_recovery_password`]. Separated so
/// unit tests can exercise rules without a running Tauri app or network.
///
/// Rules (v1):
/// - new password must be non-empty
/// - new password must differ from current
///
/// Strength scoring is NOT here — it lives in
/// `crate::console_access::score_passphrase` and is called from the IPC
/// command itself so that the structured `PassphraseStrength` reasons
/// can be surfaced in the error message.
fn validate_new_password_inputs(current: &str, new: &str) -> Result<()> {
    if new.is_empty() {
        return Err(AppError::Validation("New recovery password cannot be empty.".into()));
    }
    if current == new {
        return Err(AppError::Validation("New password must differ from current.".into()));
    }
    Ok(())
}

/// Return `Err(Validation)` if `candidate` fails the signup strength bar.
/// Extracted for unit testability.
fn reject_if_weak(candidate: &str) -> Result<()> {
    let score = crate::console_access::score_passphrase(candidate);
    if !score.acceptable_for_submit {
        let reason = score.hints.first().cloned().unwrap_or_else(|| "too weak".into());
        return Err(AppError::Validation(format!("Password is too weak: {reason}")));
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
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        sqlx::query(
            r"
            CREATE TABLE hcfs_config (
                owner TEXT PRIMARY KEY,
                server_url TEXT NOT NULL DEFAULT '',
                drive_password TEXT NOT NULL DEFAULT '',
                encryption_version INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP
            )
            ",
        )
        .execute(&pool)
        .await
        .expect("create hcfs_config");
        pool
    }

    #[tokio::test]
    async fn seeds_empty_url_when_no_row_exists() {
        let pool = setup_pool().await;
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let owner = account_key("5TestAccountId");
        let row: (String, String, i32) = sqlx::query_as("SELECT server_url, drive_password, encryption_version FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();

        // Empty server_url is the auto-detect sentinel that triggers
        // hcfs-client's region probe. The seed function deliberately
        // does NOT write a default URL; per CLAUDE.md "Replace, don't
        // deprecate" — the legacy single-region URL is gone, not dual-tracked.
        assert_eq!(row.0, "");
        assert_eq!(row.1, "");
        assert_eq!(row.2, 0);
    }

    #[tokio::test]
    async fn leaves_non_empty_url_alone() {
        let pool = setup_pool().await;
        let owner = account_key("5TestAccountId");
        sqlx::query(
            "INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://custom.example', 'secret', 0)",
        )
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();

        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let row: (String, String) = sqlx::query_as("SELECT server_url, drive_password FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "https://custom.example");
        assert_eq!(row.1, "secret");
    }

    #[tokio::test]
    async fn drive_password_is_plaintext_false_when_no_row() {
        // Absent row = can't prove plaintext. Caller short-circuits on
        // `has_local_mnemonic=false` before reaching this helper anyway, so the
        // conservative "not plaintext" return keeps the decision tree sound if
        // someone ever calls it with local=true but no hcfs_config row.
        let pool = setup_pool().await;
        assert!(!super::drive_password_is_plaintext(&pool, "5NoRowAccount").await);
    }

    #[tokio::test]
    async fn drive_password_is_plaintext_true_when_enc_ver_zero() {
        let pool = setup_pool().await;
        let owner = account_key("5PlaintextAccount");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://x', 'plaintext-pw', 0)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();
        assert!(super::drive_password_is_plaintext(&pool, "5PlaintextAccount").await);
    }

    #[tokio::test]
    async fn drive_password_is_plaintext_false_when_encrypted() {
        // The canonical encrypted state: drive_password is encrypted under a
        // mnemonic-derived key, so callers without the mnemonic cannot read it.
        // This is what routes OAuth returning users to Unlock instead of Proceed.
        let pool = setup_pool().await;
        let owner = account_key("5EncryptedAccount");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://x', 'ciphertext', 1)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();
        assert!(!super::drive_password_is_plaintext(&pool, "5EncryptedAccount").await);
    }

    // Pins every cell of the recovery decision table — especially the
    // legacy-migration cell `(local, decryptable, no blob) → Signup`,
    // which routes existing users through the same "Protect Your Account"
    // dialog as first-time users, and its safety guard
    // `(local, !decryptable, no blob) → Proceed`, which must NOT seal an
    // unopenable master.
    #[test]
    fn decide_recovery_flow_covers_decision_table() {
        use super::{RecoveryFlow, decide_recovery_flow};

        // First-time user: nothing local, server confirms no blob.
        assert_eq!(decide_recovery_flow(false, false, Some(false)), RecoveryFlow::Signup);
        assert_eq!(decide_recovery_flow(false, true, Some(false)), RecoveryFlow::Signup);

        // Legacy user: local mnemonic, decryptable, no server blob → seal
        // the existing one via the Protect Your Account flow.
        assert_eq!(decide_recovery_flow(true, true, Some(false)), RecoveryFlow::Signup);

        // Legacy user we CAN'T open and the server DEFINITIVELY has no
        // blob: stay on Proceed so we never mint/seal a master that can't
        // reproduce the on-disk folder keys.
        assert_eq!(decide_recovery_flow(true, false, Some(false)), RecoveryFlow::Proceed);

        // Local present and authoritative: blob already there, or probe failed.
        assert_eq!(decide_recovery_flow(true, true, Some(true)), RecoveryFlow::Proceed);
        assert_eq!(decide_recovery_flow(true, true, None), RecoveryFlow::Proceed);

        // Returning user on a fresh device (or an unopenable local file)
        // with a server blob → Unlock.
        assert_eq!(decide_recovery_flow(false, false, Some(true)), RecoveryFlow::Unlock);
        assert_eq!(decide_recovery_flow(false, true, Some(true)), RecoveryFlow::Unlock);
        assert_eq!(decide_recovery_flow(true, false, Some(true)), RecoveryFlow::Unlock);

        // Probe failed: retry, never overwrite server state.
        assert_eq!(decide_recovery_flow(false, false, None), RecoveryFlow::Unknown);
        assert_eq!(decide_recovery_flow(false, true, None), RecoveryFlow::Unknown);
        // REGRESSION (banner report 2026-08-19): an OAuth returning device
        // (local file, undecryptable without the recovery password) whose
        // blob probe FAILED used to fall into the `(true, _, _) → Proceed`
        // catch-all. `recovery_gate_target` maps Proceed → Skipped, so
        // `ensure_sync_mnemonic` ran straight into its dead-end
        // (`MasterMnemonicUnrecoverable`) and the FE showed the seed-phrase
        // banner to a Google-login user — even though the server DID hold
        // their sealed blob. An unknown blob with an unopenable local file
        // must stay Unknown: gate Pending, retry dialog, no banner.
        assert_eq!(decide_recovery_flow(true, false, None), RecoveryFlow::Unknown);
    }

    #[tokio::test]
    async fn leaves_empty_url_alone_on_existing_row() {
        // Empty IS the default `server_url` — the auto-detect sentinel
        // hcfs-client looks for — so `seed_hcfs_server_url_if_missing` must
        // never overwrite it. This test pins that contract: an existing row
        // with empty URL is left alone, so the next call to `get_server_url`
        // returns "" and hcfs-client races the regional endpoints.
        let pool = setup_pool().await;
        let owner = account_key("5TestAccountId");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, '', '', 0)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();

        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let url: String = sqlx::query_scalar("SELECT server_url FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(url, "");
    }

    #[test]
    fn gate_state_is_resolved_for_non_pending() {
        assert!(!RecoveryGateState::Pending.is_resolved());
        assert!(RecoveryGateState::Resolved.is_resolved());
        assert!(RecoveryGateState::Skipped.is_resolved());
    }

    #[tokio::test]
    async fn app_state_recovery_gate_defaults_skipped_and_transitions() {
        let state = crate::app_state::AppState::new();
        // Default is Skipped so non-OAuth login paths don't block.
        assert_eq!(state.recovery_state(), RecoveryGateState::Skipped);

        state.set_recovery_state(RecoveryGateState::Pending);
        assert_eq!(state.recovery_state(), RecoveryGateState::Pending);

        state.set_recovery_state(RecoveryGateState::Resolved);
        assert_eq!(state.recovery_state(), RecoveryGateState::Resolved);

        // await returns immediately when already resolved.
        let awaited = tokio::time::timeout(std::time::Duration::from_millis(50), state.await_recovery_resolved())
            .await
            .expect("await should return immediately when already resolved");
        assert_eq!(awaited, RecoveryGateState::Resolved);
    }

    /// Proves the whole point of the recovery gate: when set to
    /// `Pending`, any code path that calls `await_recovery_resolved`
    /// (notably `ensure_sync_mnemonic`) parks until the gate transitions.
    /// Without this gate, a fresh-device OAuth login races
    /// `auto_init_sync` against the recovery dialog and mints a
    /// throwaway mnemonic that then corrupts the drive password.
    #[tokio::test]
    async fn await_recovery_resolved_blocks_while_pending() {
        use std::sync::Arc;
        use std::time::Duration;

        let state = Arc::new(crate::app_state::AppState::new());
        state.set_recovery_state(RecoveryGateState::Pending);

        let waiter_state = state.clone();
        let handle = tokio::spawn(async move { waiter_state.await_recovery_resolved().await });

        // Give the waiter time to park, then assert it's still pending.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!handle.is_finished(), "waiter must block while gate is Pending");

        // Flip to Resolved — waiter must wake.
        state.set_recovery_state(RecoveryGateState::Resolved);
        let resolved = tokio::time::timeout(Duration::from_millis(200), handle)
            .await
            .expect("waiter must wake within 200ms of gate resolution")
            .expect("task panicked");
        assert_eq!(resolved, RecoveryGateState::Resolved);
    }

    #[tokio::test]
    async fn app_state_recovery_gate_wakes_pending_waiters() {
        use std::sync::Arc;
        let state = Arc::new(crate::app_state::AppState::new());
        // OAuth callback flips Skipped → Pending so sync init can await the
        // dialog. Simulate that here.
        state.set_recovery_state(RecoveryGateState::Pending);

        let waiter_state = state.clone();
        let handle = tokio::spawn(async move { waiter_state.await_recovery_resolved().await });

        // Give the waiter a chance to park on the channel.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        state.set_recovery_state(RecoveryGateState::Resolved);

        let resolved = tokio::time::timeout(std::time::Duration::from_millis(100), handle)
            .await
            .expect("waiter must wake within timeout")
            .expect("task panicked");
        assert_eq!(resolved, RecoveryGateState::Resolved);
    }

    #[tokio::test]
    async fn idempotent_on_repeated_calls() {
        let pool = setup_pool().await;
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hcfs_config").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn change_password_rejects_empty_new() {
        let err = super::validate_new_password_inputs("current", "").unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("cannot be empty")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn change_password_rejects_new_equals_current() {
        let err = super::validate_new_password_inputs("same", "same").unwrap_err();
        match err {
            AppError::Validation(msg) => assert!(msg.contains("must differ")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn change_password_rejects_weak_new() {
        // Strength scorer lives in console_access and returns acceptable=false
        // for short/low-entropy inputs. We surface the first reason verbatim.
        use crate::console_access::score_passphrase;
        let score = score_passphrase("abc");
        assert!(!score.acceptable_for_submit);
        // The command layer turns this into a Validation error; we reproduce
        // the exact message here so a regression is caught at unit-test level.
        let expected = format!("Password is too weak: {}", score.hints.first().cloned().unwrap_or_default());
        let err = super::reject_if_weak("abc").unwrap_err();
        match err {
            AppError::Validation(msg) => assert_eq!(msg, expected),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn align_drive_password_writes_row_and_reencrypts_folders() {
        use sqlx::sqlite::SqlitePoolOptions;

        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE hcfs_config (owner TEXT PRIMARY KEY, server_url TEXT NOT NULL DEFAULT '', drive_password TEXT NOT NULL DEFAULT '', encryption_version INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
            .execute(&pool)
            .await
            .unwrap();

        let account = "5TestAlignAccount";
        let owner = crate::auth::account_key::account_key(account);

        // Seed one folder under an OLD password.
        sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, ?)")
            .bind(&owner)
            .bind("/tmp/alpha")
            .bind("alpha")
            .execute(&pool)
            .await
            .unwrap();
        let master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let alpha_dir = crate::sync::mnemonic::config_dir_for_folder(account, "alpha").unwrap();
        tokio::fs::create_dir_all(&alpha_dir).await.unwrap();
        let alpha_enc = alpha_dir.join("enc_mnemonic.json");
        let alpha_folder_mnemonic = hcfs_client::drive::keys::derive_folder_mnemonic(master, "alpha").unwrap();
        hcfs_client::auth::save_encrypted_mnemonic(&alpha_enc, &alpha_folder_mnemonic, "old drive password").unwrap();

        // Run under a new password.
        super::align_drive_password(&pool, account, "https://example.invalid", master, "new canonical password")
            .await
            .unwrap();

        // hcfs_config row exists, decrypts back to the new password.
        let recovered = crate::sync::config::get_drive_password(&pool, account, Some(master)).await.unwrap();
        assert_eq!(*recovered, "new canonical password");

        // Folder file re-encrypted under the new password.
        let folder_check = hcfs_client::auth::recover_mnemonic(&alpha_enc, "new canonical password").unwrap();
        assert_eq!(folder_check.to_string(), alpha_folder_mnemonic);
    }

    /// Seed a poolable hcfs_config + sync_paths schema in memory, set `HOME`
    /// to a tempdir, and plant a regular FILE where `bad_label`'s config dir
    /// must be created so that folder's `create_dir_all` fails. Returns the
    /// pool, account id, and master mnemonic. Caller holds `HOME_LOCK`.
    async fn setup_folder_failure(good_label: &str, bad_label: &str, account: &str) -> (sqlx::SqlitePool, String) {
        use sqlx::sqlite::SqlitePoolOptions;
        let master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE hcfs_config (owner TEXT PRIMARY KEY, server_url TEXT NOT NULL DEFAULT '', drive_password TEXT NOT NULL DEFAULT '', encryption_version INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let owner = crate::auth::account_key::account_key(account);
        for (label, path) in [(good_label, "/tmp/good"), (bad_label, "/tmp/bad")] {
            sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, ?)")
                .bind(&owner)
                .bind(path)
                .bind(label)
                .execute(&pool)
                .await
                .unwrap();
        }
        // Good folder: a real config dir + enc_mnemonic.json under the OLD password.
        let good_dir = crate::sync::mnemonic::config_dir_for_folder(account, good_label).unwrap();
        tokio::fs::create_dir_all(&good_dir).await.unwrap();
        let good_fm = hcfs_client::drive::keys::derive_folder_mnemonic(master, good_label).unwrap();
        hcfs_client::auth::save_encrypted_mnemonic(good_dir.join("enc_mnemonic.json"), &good_fm, "old canonical password").unwrap();
        // Bad folder: plant a FILE where its dir must be so create_dir_all fails.
        let bad_dir = crate::sync::mnemonic::config_dir_for_folder(account, bad_label).unwrap();
        tokio::fs::create_dir_all(bad_dir.parent().unwrap()).await.unwrap();
        tokio::fs::write(&bad_dir, b"blocker").await.unwrap();
        (pool, master.to_string())
    }

    #[tokio::test]
    async fn reencrypt_returns_err_naming_failed_folder_but_rewrites_others() {
        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestReencryptErrAccount";
        let (pool, master) = setup_folder_failure("alpha", "beta", account).await;

        let err = crate::sync::mnemonic::reencrypt_all_folder_mnemonics(&pool, account, &master, "new canonical password")
            .await
            .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("beta"), "error must name the failed folder, got: {msg}");

        // The healthy folder must still have been rewritten under the new password.
        let alpha_dir = crate::sync::mnemonic::config_dir_for_folder(account, "alpha").unwrap();
        let alpha_fm = hcfs_client::drive::keys::derive_folder_mnemonic(&master, "alpha").unwrap();
        let check = hcfs_client::auth::recover_mnemonic(alpha_dir.join("enc_mnemonic.json"), "new canonical password").unwrap();
        assert_eq!(
            check.to_string(),
            alpha_fm,
            "the good folder is still rewritten despite the bad one failing"
        );
    }

    #[tokio::test]
    async fn align_drive_password_does_not_flip_db_when_a_folder_fails() {
        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestAlignAbortAccount";
        let (pool, master) = setup_folder_failure("alpha", "beta", account).await;

        // Pre-seed the DB password under the OLD value.
        crate::sync::config::save_hcfs_config_internal(&pool, account, "https://example.invalid", "old canonical password", Some(&master))
            .await
            .unwrap();

        // align must fail because a folder rewrite fails...
        let err = super::align_drive_password(&pool, account, "https://example.invalid", &master, "new canonical password")
            .await
            .unwrap_err();
        let _ = err;

        // ...and the DB password must NOT have been flipped to NEW: folders are
        // rewritten BEFORE the DB row is committed, so a folder failure aborts
        // with the system still consistent on the OLD password.
        let pw = crate::sync::config::get_drive_password(&pool, account, Some(&master)).await.unwrap();
        assert_eq!(*pw, "old canonical password", "DB password must stay OLD when a folder rewrite fails");
    }

    /// Minimal hcfs_config + sync_paths schema for the recovery-validation
    /// tests, with `HOME` pointed at a tempdir (caller holds HOME_LOCK).
    async fn setup_validation_pool() -> sqlx::SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool");
        sqlx::query(
            "CREATE TABLE hcfs_config (owner TEXT PRIMARY KEY, server_url TEXT NOT NULL DEFAULT '', drive_password TEXT NOT NULL DEFAULT '', encryption_version INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP)",
        )
        .execute(&pool)
        .await
        .expect("create hcfs_config");
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL, is_paused INTEGER NOT NULL DEFAULT 0, owner_ss58 TEXT, wire_folder_hash TEXT)")
            .execute(&pool)
            .await
            .expect("create sync_paths");
        pool
    }

    const VALIDATION_MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[tokio::test]
    async fn validate_master_refuses_wrong_master_against_encrypted_drive_password() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // SAFETY: test-only; HOME is serialized by HOME_LOCK and Rust 2024
        // requires the unsafe block for std::env::set_var.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestValidateWrongMaster";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        // A folder row so validation doesn't take the empty-folders early return.
        sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, '/tmp/x', 'default')")
            .bind(&owner)
            .execute(&pool)
            .await
            .expect("seed sync_paths");
        // Seal an encrypted (version=1) drive password under the real master.
        crate::sync::config::save_hcfs_config_internal(&pool, account, "https://example.invalid", "drive pw", Some(VALIDATION_MASTER))
            .await
            .expect("seal encrypted drive password");

        // A DIFFERENT master can't decrypt that drive password → must be refused,
        // not silently skipped, which would allow sealing a wrong master.
        let wrong = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        let err = super::validate_master_against_existing_folders(&pool, account, wrong).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "wrong master must be refused, got {err:?}");
    }

    #[tokio::test]
    async fn validate_master_allows_when_no_drive_password_config() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // SAFETY: test-only; HOME is serialized by HOME_LOCK and Rust 2024
        // requires the unsafe block for std::env::set_var.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestValidateNoConfig";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, '/tmp/x', 'default')")
            .bind(&owner)
            .execute(&pool)
            .await
            .expect("seed sync_paths");
        // No hcfs_config row → pre-config → vacuously allowed.
        super::validate_master_against_existing_folders(&pool, account, VALIDATION_MASTER)
            .await
            .expect("validation allows pre-config");
    }

    const WRONG_MASTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const DRIVE_PW: &str = "drive pw";

    async fn insert_own_path(pool: &sqlx::SqlitePool, owner: &str, path: &str, label: &str) {
        sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, ?)")
            .bind(owner)
            .bind(path)
            .bind(label)
            .execute(pool)
            .await
            .expect("own sync_paths row");
    }

    async fn insert_member_path(pool: &sqlx::SqlitePool, owner: &str, path: &str, label: &str) {
        sqlx::query("INSERT INTO sync_paths (owner, path, label, owner_ss58, wire_folder_hash) VALUES (?, ?, ?, ?, ?)")
            .bind(owner)
            .bind(path)
            .bind(label)
            .bind("5OwnerSs58NotThisAccount")
            .bind("0123456789abcdef")
            .execute(pool)
            .await
            .expect("member sync_paths row");
    }

    async fn plant_folder_seal(account: &str, label: &str, master: &str, drive_pw: &str) {
        let dir = crate::sync::mnemonic::config_dir_for_folder(account, label).expect("config dir");
        tokio::fs::create_dir_all(&dir).await.expect("mkdir folder config");
        let phrase = hcfs_client::drive::keys::derive_folder_mnemonic(master, label).expect("derive");
        hcfs_client::auth::save_encrypted_mnemonic(dir.join("enc_mnemonic.json"), &phrase, drive_pw).expect("seal");
    }

    async fn seed_plaintext_drive_pw(pool: &sqlx::SqlitePool, owner: &str) {
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, '', ?, 0)")
            .bind(owner)
            .bind(DRIVE_PW)
            .execute(pool)
            .await
            .expect("plaintext drive_password");
    }

    /// A member drive's seal is the owner's folder mnemonic. Comparing it to
    /// `derive(this_master, local_label)` is a false mismatch — restore must
    /// skip those rows the same way rotation already does.
    #[tokio::test]
    async fn validate_master_ignores_member_drive_seals() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestValidateMemberSkip";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        insert_own_path(&pool, &owner, "/tmp/docs", "docs").await;
        insert_member_path(&pool, &owner, "/tmp/shared", "shared").await;
        seed_plaintext_drive_pw(&pool, &owner).await;
        plant_folder_seal(account, "docs", VALIDATION_MASTER, DRIVE_PW).await;
        plant_folder_seal(account, "shared", WRONG_MASTER, DRIVE_PW).await;

        super::validate_master_against_existing_folders(&pool, account, VALIDATION_MASTER)
            .await
            .expect("member seal must not fail a matching own-drive master");
    }

    #[tokio::test]
    async fn validate_master_still_refuses_a_wrong_own_folder_seal() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestValidateOwnMismatch";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        insert_own_path(&pool, &owner, "/tmp/docs", "docs").await;
        seed_plaintext_drive_pw(&pool, &owner).await;
        plant_folder_seal(account, "docs", WRONG_MASTER, DRIVE_PW).await;

        let err = super::validate_master_against_existing_folders(&pool, account, VALIDATION_MASTER)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("does not derive folder"),
            "own-drive mismatch must still refuse, got {err}"
        );
    }

    #[tokio::test]
    async fn probe_folder_seals_confirms_own_and_skips_member() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestProbeMemberSkip";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        insert_own_path(&pool, &owner, "/tmp/docs", "docs").await;
        insert_member_path(&pool, &owner, "/tmp/shared", "shared").await;
        seed_plaintext_drive_pw(&pool, &owner).await;
        plant_folder_seal(account, "docs", VALIDATION_MASTER, DRIVE_PW).await;
        plant_folder_seal(account, "shared", WRONG_MASTER, DRIVE_PW).await;

        assert_eq!(
            super::probe_local_folder_seals(&pool, account, VALIDATION_MASTER).await.expect("probe"),
            crate::recovery_proof::Probe::Confirmed
        );
    }

    #[tokio::test]
    async fn probe_folder_seals_mismatch_on_wrong_own_seal() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let account = "5TestProbeOwnMismatch";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        insert_own_path(&pool, &owner, "/tmp/docs", "docs").await;
        seed_plaintext_drive_pw(&pool, &owner).await;
        plant_folder_seal(account, "docs", WRONG_MASTER, DRIVE_PW).await;

        assert_eq!(
            super::probe_local_folder_seals(&pool, account, VALIDATION_MASTER).await.expect("probe"),
            crate::recovery_proof::Probe::Mismatch
        );
    }

    #[tokio::test]
    async fn probe_drive_password_confirms_matching_master_and_refuses_wrong() {
        let account = "5TestProbeDrivePw";
        let pool = setup_validation_pool().await;
        crate::sync::config::save_hcfs_config_internal(&pool, account, "", DRIVE_PW, Some(VALIDATION_MASTER))
            .await
            .expect("encrypt drive_password");

        assert_eq!(
            super::probe_drive_password_row(&pool, account, VALIDATION_MASTER).await.expect("probe"),
            crate::recovery_proof::Probe::Confirmed
        );
        assert_eq!(
            super::probe_drive_password_row(&pool, account, WRONG_MASTER).await.expect("probe"),
            crate::recovery_proof::Probe::Mismatch
        );
    }

    #[tokio::test]
    async fn prove_master_identity_match_does_not_need_local_state() {
        let pool = setup_validation_pool().await;
        let (_, ss58, _, _) = crate::auth::service::derive_keys(VALIDATION_MASTER).expect("derive");
        let method = super::prove_master_for_account(&pool, &ss58, VALIDATION_MASTER)
            .await
            .expect("identity match is Confirmed");
        assert_eq!(method, crate::recovery_proof::ProofMethod::MnemonicIdentity);
    }

    #[tokio::test]
    async fn prove_master_rejects_garbage_phrase() {
        let pool = setup_validation_pool().await;
        let err = super::prove_master_for_account(&pool, "5Whatever", "not a bip39 phrase")
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref msg) if msg.contains("Invalid recovery phrase")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn prove_master_oauth_own_seal_skips_member_and_confirms() {
        let _home = crate::test_helpers::HOME_LOCK.lock().expect("HOME_LOCK");
        let tmp = tempfile::TempDir::new().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        // Login SS58 that VALIDATION_MASTER does not derive (OAuth split).
        let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let pool = setup_validation_pool().await;
        let owner = crate::auth::account_key::account_key(account);
        insert_own_path(&pool, &owner, "/tmp/docs", "docs").await;
        insert_member_path(&pool, &owner, "/tmp/shared", "shared").await;
        seed_plaintext_drive_pw(&pool, &owner).await;
        plant_folder_seal(account, "docs", VALIDATION_MASTER, DRIVE_PW).await;
        plant_folder_seal(account, "shared", WRONG_MASTER, DRIVE_PW).await;

        let method = super::prove_master_for_account(&pool, account, VALIDATION_MASTER)
            .await
            .expect("own seal must confirm an OAuth account; member must not veto");
        assert_eq!(method, crate::recovery_proof::ProofMethod::LocalFolderSeals);
    }

    #[tokio::test]
    async fn rotation_sidecar_roundtrip() {
        // Use a tempdir as the `HOME` so master_mnemonic_path points into it.
        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let account = "5TestSidecarAccount";
        // master_mnemonic_path creates the parent on first write via
        // install_recovered_mnemonic. We mirror that here.
        let sidecar = super::rotation_sidecar_path(account).unwrap();
        tokio::fs::create_dir_all(sidecar.parent().unwrap()).await.unwrap();

        super::write_rotation_sidecar(account).await.unwrap();
        assert!(sidecar.exists(), "sidecar should be written");

        super::clear_rotation_sidecar(account).await;
        assert!(!sidecar.exists(), "sidecar should be removed");

        // Idempotent clear.
        super::clear_rotation_sidecar(account).await;
    }

    /// Regression pin: when the post-commit local rewrite fails AND the
    /// rotation sidecar also fails to write, the install-failed arm of
    /// `change_recovery_password` must `return Err`, not `Ok(())`.
    ///
    /// `change_recovery_password` is a `tauri::command` that needs a running
    /// hcfs-server and a managed `AppState`, so the doubly-failed branch can't
    /// be driven from a unit test under the project's no-`tauri::test` policy
    /// (axiom 111). A regression would silently restore the unconditional
    /// `Ok(())`; this pins that the sidecar-failure path inside the `Err(e)`
    /// arm carries a `return Err`, mirroring the `hippius_startup_window.rs`
    /// static-pin convention.
    #[test]
    fn local_rewrite_and_sidecar_double_failure_surfaces_an_error() {
        const SRC: &str = include_str!("recovery.rs");
        // Anchor on the warn unique to the install-failure `Err(e)` arm (the
        // align-branch shares the "sidecar write also failed" wording but
        // legitimately returns Ok, so we must not match on that).
        let anchor = "server rotated but local rewrite failed";
        let at = SRC.find(anchor).expect("install-failure arm warn present");
        let after = &SRC[at..];
        let next_return_err = after
            .find("return Err")
            .expect("double failure must return Err, not fall through to Ok(())");
        // The `return Err` (sidecar-failure bail-out) must come before the
        // arm's closing `Ok(())`, i.e. it surfaces instead of reporting success.
        let next_ok = after.find("Ok(())").unwrap_or(usize::MAX);
        assert!(
            next_return_err < next_ok,
            "the sidecar-write-failure path must `return Err` before the arm's `Ok(())`"
        );
    }

    /// After `seed_hcfs_server_url_if_missing`, the recovery base-URL
    /// resolver must NOT reject the seeded row. This pins the fix for the
    /// fresh-OAuth-device dead-end where empty server_url → ConfigMissing
    /// → probe (None,None) → RecoveryFlow::Unknown forever.
    /// See docs/plans/2026-05-18-oauth-recovery-region-resolution.md.
    #[tokio::test]
    async fn seeded_row_is_accepted_by_base_url_resolver() {
        let pool = crate::console_access::tests_support_make_hcfs_config_pool().await;
        let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        seed_hcfs_server_url_if_missing(&pool, account).await.expect("seed must succeed");
        let url = crate::console_access::resolve_hcfs_base_url_for_test(&pool, account)
            .await
            .expect("seeded empty row must resolve to the sentinel, not error");
        assert_eq!(url, "", "seeded server_url is the auto-detect sentinel");
    }

    /// Static regression guard (audit R-10): `resume_recovery_password_rotation`
    /// MUST validate the master against existing folders BEFORE it installs the
    /// recovered mnemonic / rewrites per-folder key material. The two sibling
    /// folder-mutating paths (`change_recovery_password`, `seal_and_upload_mnemonic`)
    /// already do; a refactor that drops it from resume would let a divergent
    /// server blob destroy the keys that open already-uploaded ciphertext.
    /// Mirrors the `initialize_sync_inner`/`spawn_backfill` source guard.
    #[test]
    fn resume_rotation_validates_master_before_install() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        let sig_idx = src
            .find("pub async fn resume_recovery_password_rotation(")
            .expect("resume_recovery_password_rotation declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        let validate_idx = body
            .find("validate_master_against_existing_folders")
            .expect("resume must call validate_master_against_existing_folders (R-10)");
        let install_idx = body
            .find("install_recovered_mnemonic")
            .expect("resume must call install_recovered_mnemonic");
        assert!(
            validate_idx < install_idx,
            "the derivation guard must run BEFORE install_recovered_mnemonic rewrites key material",
        );
    }

    /// Static regression guard (audit R-18): every mnemonic-mutating recovery /
    /// rotation command MUST acquire `recovery_lock` so two of them can't
    /// interleave the master-file write, per-folder rewrites, and DB-row flip.
    #[test]
    fn recovery_commands_acquire_recovery_lock() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        for func in [
            "pub async fn change_recovery_password(",
            "pub async fn recover_mnemonic(",
            "pub async fn seal_and_upload_mnemonic(",
            "pub async fn resume_recovery_password_rotation(",
            "pub async fn restore_with_mnemonic(",
            "pub async fn reset_unlock_password(",
        ] {
            let sig_idx = src.find(func).unwrap_or_else(|| panic!("{func} present"));
            let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
            let mut depth = 0usize;
            let mut body_end = body_start;
            for (i, ch) in src[body_start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            body_end = body_start + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let body = &src[body_start..=body_end];
            assert!(
                body.contains("recovery_lock.lock()"),
                "{func} must acquire state.recovery_lock to serialize against other recovery commands (R-18)",
            );
        }
    }

    /// Static regression guard (audit H-4 residue, banner report 2026-08-19):
    /// a successful unlock is the ONLY moment a device with an empty keychain
    /// holds positive evidence of a pre-#102 mislabelled OAuth row, so
    /// `recover_mnemonic` must run the provider repair there — and must wake
    /// any in-window `tryAutoInitSync` ladder, since the mnemonic-labelled
    /// restore paths park no `ensure_sync_mnemonic` that would emit
    /// `hippius_auth_ready` on resume.
    #[test]
    fn recover_mnemonic_repairs_provider_and_wakes_sync() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        let sig = "pub async fn recover_mnemonic(";
        let sig_idx = src.find(sig).unwrap_or_else(|| panic!("{sig} present"));
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        assert!(
            body.contains("repair_provider_from_recovered_master("),
            "recover_mnemonic must run the unlock-time provider repair — the recovered master is the \
             only positive-mismatch evidence an empty-keychain device ever gets",
        );
        assert!(
            body.contains("emit_auth_ready()"),
            "recover_mnemonic must emit hippius_auth_ready after caching the mnemonic so a still-listening \
             auto_init_sync retry ladder can pick it up",
        );
        assert!(
            body.contains("spawn_post_unlock_sync_init("),
            "recover_mnemonic must spawn the post-unlock auto-init — the FE retry ladder expires 10s after \
             subscribing, long before a human finishes typing the unlock password, so without this the \
             restore-time unlock paths stay sync-wedged until the next launch",
        );
    }

    /// A wrong phrase must never mint a new master or upsert a blob
    /// without proof. `seal_and_upload_mnemonic` mints on a miss;
    /// restore/reset must not call it.
    #[test]
    fn restore_commands_never_mint_a_master() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        for func in ["pub async fn restore_with_mnemonic(", "pub async fn reset_unlock_password("] {
            let sig_idx = src.find(func).unwrap_or_else(|| panic!("{func} present"));
            let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
            let mut depth = 0usize;
            let mut body_end = body_start;
            for (i, ch) in src[body_start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            body_end = body_start + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let body = &src[body_start..=body_end];
            assert!(!body.contains("generate_mnemonic_internal"), "{func} must never mint a master");
            assert!(!body.contains("seal_and_upload_mnemonic"), "{func} must not call the minting signup path");
            assert!(
                body.contains("commit_new_unlock_password"),
                "{func} must reseal through the shared commit helper"
            );
        }
        let sig = "pub async fn restore_with_mnemonic(";
        let sig_idx = src.find(sig).expect("restore_with_mnemonic present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        let prove_idx = body
            .find("prove_master_for_account")
            .expect("restore_with_mnemonic must prove the phrase before POST");
        let commit_idx = body
            .find("commit_new_unlock_password")
            .expect("restore_with_mnemonic must commit after proof");
        assert!(prove_idx < commit_idx, "proof must run before the blob upsert");
    }

    #[test]
    fn prove_master_must_not_challenge_response_as_the_typed_phrase() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        let sig = "async fn prove_master_for_account(";
        let sig_idx = src.find(sig).expect("prove_master_for_account present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        assert!(
            !body.contains("challenge_response"),
            "proving a typed phrase must not authenticate as its derived SS58 (audit H-3)"
        );
        assert!(!body.contains("generate_mnemonic_internal"), "prove must never mint");
    }

    #[test]
    fn folder_proof_queries_own_drives_only() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/recovery.rs")).expect("read recovery.rs");
        let helper = src
            .split("async fn own_drive_folder_rows(")
            .nth(1)
            .expect("own_drive_folder_rows present");
        let helper_body = &helper[..helper.find("async fn ").expect("next fn after helper")];
        assert!(
            helper_body.contains("owner_ss58 IS NULL") && helper_body.contains("wire_folder_hash IS NULL"),
            "own-drive filter must match reencrypt_all_folder_mnemonics"
        );
        for func in ["async fn validate_master_against_existing_folders(", "async fn probe_local_folder_seals("] {
            let sig_idx = src.find(func).unwrap_or_else(|| panic!("{func} present"));
            let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
            let mut depth = 0usize;
            let mut body_end = body_start;
            for (i, ch) in src[body_start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            body_end = body_start + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let body = &src[body_start..=body_end];
            assert!(body.contains("own_drive_folder_rows"), "{func} must skip member-drive seals");
        }
    }

    #[test]
    fn download_decryption_is_a_wrong_phrase_transport_is_not() {
        use crate::recovery_proof::RemoteAttempt;
        assert_eq!(
            super::remote_attempt_from_err_display(&"Decryption error: tag"),
            RemoteAttempt::DecryptMiss
        );
        assert_eq!(
            super::remote_attempt_from_err_display(&"Hash mismatch for downloaded file"),
            RemoteAttempt::DecryptMiss
        );
        assert_eq!(
            super::remote_attempt_from_err_display(&"Download failed: timeout"),
            RemoteAttempt::Transport
        );
        assert_eq!(
            super::remote_attempt_from_err_display(&"Failed to fetch remote files: dns"),
            RemoteAttempt::Transport
        );
    }
}
