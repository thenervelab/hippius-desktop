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
use crate::console_access::{HcfsServerCtx, HttpOutcome, crypto_to_err, get_json, post_json_discard};
use crate::error::{AppError, Result};

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

/// Canonical production hcfs-server URL.
///
/// Used as the default when `hcfs_config.server_url` is empty — i.e. on a fresh
/// device after OAuth login but before the user has configured sync. Recovery
/// needs a URL to fetch the sealed mnemonic blob from, and the normal config
/// save path requires a drive password the user hasn't entered yet.
pub const DEFAULT_HCFS_SERVER_URL: &str = "https://arion.hippius.com";

/// Ensure an `hcfs_config` row exists for the account with a non-empty
/// `server_url`, seeding `DEFAULT_HCFS_SERVER_URL` when missing.
///
/// Idempotent: if a row already exists with a non-empty URL, leaves it alone.
/// Drive password remains untouched — this runs before the user has chosen
/// one, so `drive_password` stays empty and `encryption_version` stays 0.
pub(crate) async fn seed_hcfs_server_url_if_missing(pool: &SqlitePool, account_id: &str) -> Result<()> {
    let owner = account_key(account_id);

    // Create a row if one doesn't exist yet. Drive password is empty; later
    // sync setup will populate it via the normal save_hcfs_config path.
    sqlx::query(
        r"
        INSERT OR IGNORE INTO hcfs_config
            (owner, server_url, drive_password, encryption_version, updated_at)
        VALUES (?, ?, '', 0, CURRENT_TIMESTAMP)
        ",
    )
    .bind(&owner)
    .bind(DEFAULT_HCFS_SERVER_URL)
    .execute(pool)
    .await?;

    // If the row existed but with an empty URL (e.g. partial earlier state),
    // fill it in. Does nothing when URL is already set.
    sqlx::query(
        r"
        UPDATE hcfs_config
        SET server_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE owner = ? AND (server_url IS NULL OR server_url = '')
        ",
    )
    .bind(DEFAULT_HCFS_SERVER_URL)
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
/// - `Signup` — no server blob and no local mnemonic. User sees the
///   "create a recovery password" wizard, which generates the mnemonic
///   and seals it to the server.
/// - `Unlock` — server blob exists but no local mnemonic (fresh device
///   returning user). User sees "enter your recovery password".
/// - `Proceed` — local mnemonic is already present. Nothing to do;
///   the dialog auto-skips and marks the gate resolved. Server-blob
///   state is intentionally ignored on this branch — if a local
///   mnemonic exists, it's authoritative.
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
    /// `true` iff the user has a local mnemonic but no server blob —
    /// i.e. the account pre-dates always-on recovery and is currently
    /// unrecoverable. `ExistingUserRecoveryPrompt` reads this flag
    /// directly instead of composing its own predicate over
    /// `has_local_mnemonic` and `has_server_blob`, so policy changes
    /// (rate-limiting the nag, server-side opt-out, kill switch)
    /// stay backend-owned.
    pub should_prompt_legacy_migration: bool,
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
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    seed_hcfs_server_url_if_missing(pool, &account_id).await?;

    let short = crate::console_access::short_ss58(&account_id);
    debug!(account = %short, "recovery: checking recovery state (probing server for sealed mnemonic blob)");

    let local = has_local_mnemonic(&account_id);
    let (has_server_blob, updated_at) = probe_server_blob(state).await;

    // Decision table:
    //   local=false, blob=false → Signup  (first-time OAuth user)
    //   local=false, blob=true  → Unlock  (returning user on fresh device)
    //   local=true,  *          → Proceed (local mnemonic is authoritative)
    //   probe failed            → Unknown (FE retries; never overwrite)
    //
    // Returning `has_server_blob` truthfully even on the Proceed branch
    // lets the existing-user migration prompt detect
    // "local + no blob" (needs server-side recovery setup).
    let recommended_flow = match (local, has_server_blob) {
        (true, _) => RecoveryFlow::Proceed,
        (false, Some(true)) => RecoveryFlow::Unlock,
        (false, Some(false)) => RecoveryFlow::Signup,
        (false, None) => RecoveryFlow::Unknown,
    };

    // Legacy-user predicate: known-absent server blob AND a local
    // mnemonic. `Some(false)` (server said 404), not `None` (probe
    // failed) — we only nag users we're certain are unrecoverable.
    let should_prompt_legacy_migration = local && matches!(has_server_blob, Some(false));

    info!(
        account = %short,
        has_local_mnemonic = local,
        has_server_blob = ?has_server_blob,
        flow = ?recommended_flow,
        legacy_migration_prompt = should_prompt_legacy_migration,
        "recovery: state decided (Signup=will upload blob, Unlock=will download blob, Proceed=no network, Unknown=probe failed)"
    );

    Ok(RecoveryCheck {
        has_server_blob: has_server_blob.unwrap_or(false),
        has_local_mnemonic: local,
        updated_at,
        recommended_flow,
        should_prompt_legacy_migration,
    })
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
pub async fn recover_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    password: String,
) -> Result<()> {
    let password = Zeroizing::new(password);
    let account_id = state.current_account_id().map_err(AppError::Other)?;
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
            return Err(AppError::Other(
                "No recovery data found for this account on the server.".into(),
            ));
        }
    };

    let mnemonic = open_mnemonic(&blob, &password, &ctx.ss58).map_err(crypto_to_err)?;

    // Persist the recovered mnemonic to the local store so subsequent
    // sync init picks it up without re-fetching. The file password is
    // the recovery password itself — the user only has to remember one.
    install_recovered_mnemonic(&account_id, &mnemonic, &password).await?;

    // Cache in AuthInfo so the current session can proceed without
    // round-tripping through disk decryption.
    {
        let mut auth = state.auth.lock()?;
        auth.cache_session_mnemonic(&account_id, mnemonic.to_string());
    }

    state.set_recovery_state(crate::recovery::RecoveryGateState::Resolved);
    info!(
        account = %crate::console_access::short_ss58(&account_id),
        "recovery: unlock complete — mnemonic decrypted and installed locally (no upload performed)"
    );
    Ok(())
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
pub async fn seal_and_upload_mnemonic(
    state: tauri::State<'_, crate::app_state::AppState>,
    password: String,
) -> Result<()> {
    let password = Zeroizing::new(password);
    let account_id = state.current_account_id().map_err(AppError::Other)?;
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

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let blob = seal_mnemonic(&mnemonic, &password, &ctx.ss58).map_err(crypto_to_err)?;

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

    state.set_recovery_state(crate::recovery::RecoveryGateState::Resolved);
    info!(
        account = %crate::console_access::short_ss58(&account_id),
        is_fresh_signup,
        "recovery: encrypted mnemonic blob uploaded to server successfully"
    );
    Ok(())
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


#[cfg(test)]
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
    async fn seeds_default_url_when_no_row_exists() {
        let pool = setup_pool().await;
        seed_hcfs_server_url_if_missing(&pool, "5TestAccountId").await.unwrap();

        let owner = account_key("5TestAccountId");
        let row: (String, String, i32) = sqlx::query_as("SELECT server_url, drive_password, encryption_version FROM hcfs_config WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(row.0, DEFAULT_HCFS_SERVER_URL);
        assert_eq!(row.1, "");
        assert_eq!(row.2, 0);
    }

    #[tokio::test]
    async fn leaves_non_empty_url_alone() {
        let pool = setup_pool().await;
        let owner = account_key("5TestAccountId");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, 'https://custom.example', 'secret', 0)")
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
    async fn fills_empty_url_on_existing_row() {
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
        assert_eq!(url, DEFAULT_HCFS_SERVER_URL);
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

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hcfs_config")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
