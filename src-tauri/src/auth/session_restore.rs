//! Session restoration on app boot.
//!
//! Two-tier flow: try the OAuth-session JSON the frontend reads from
//! localStorage first; if that's expired or absent, fall back to the
//! most recently updated row in the `auth_session` table. Either way,
//! Rust validates token expiry, populates `AuthInfo`, and returns a
//! structured result for the frontend to render.

use crate::auth::auth_session_repo::{self, TokenStatus};
use crate::auth::keychain::{self, KeychainResult};
use crate::auth::state::AuthCapabilities;
use crate::error::AppError;
use tauri::Emitter;
use tracing::{info, warn};

/// Re-arm the Tauri asset protocol scope for every configured sync path
/// of `account_id`.
///
/// The static scope in `tauri.conf.json` only covers `$HOME/.hippius/**`.
/// User-chosen sync folders live at arbitrary paths, so the runtime
/// scope needs to be re-expanded each launch. `auto_init_sync` does
/// this in step 4 — but when sync init is blocked upstream (e.g. the
/// keychain has no mnemonic for a restored mnemonic session, or the
/// credits check fails), that step never runs and the asset protocol
/// falls back to the narrower static scope. On macOS release builds
/// with `hardenedRuntime`, the first unscoped `asset://` read then
/// triggers the system folder-permission dialog every launch. Priming
/// the scope here, at the first success point in session restore,
/// makes the expansion deterministic regardless of whether sync init
/// eventually succeeds.
///
/// Best-effort — each path failure is logged and skipped. A missing
/// sync-paths table or a deleted folder must not abort the session
/// restore flow.
async fn arm_asset_scope_for_account(app: &tauri::AppHandle, state: &tauri::State<'_, crate::app_state::AppState>, account_id: &str) {
    let Ok(pool) = state.pool() else {
        warn!("arm_asset_scope_for_account: pool unavailable, skipping");
        return;
    };
    let paths = match crate::sync::folders::get_all_sync_paths_internal(pool, account_id).await {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "arm_asset_scope_for_account: failed to list sync paths");
            return;
        }
    };
    // Skip the internal `migration` pseudo-drive — its path is a
    // scratch directory used during S3 → HCFS migration and shouldn't
    // be served via the `asset://` protocol. Matches the filter used
    // in `get_all_drive_statuses_inner` and `auto_init_sync_inner`.
    for sp in paths.iter().filter(|sp| !sp.path.is_empty() && sp.label != "migration") {
        crate::sync::files::allow_asset_directory(app, &sp.path);
    }
}

/// Outcome of [`rehydrate_or_restored`]. Tells the caller whether the
/// helper has already populated `AuthInfo` (via the keychain rehydrate
/// path) or whether the caller still needs to write
/// `AuthInfo.substrate_address` + `capabilities` via
/// [`crate::app_state::AppState::set_active_account`].
enum RehydrateOutcome {
    /// Keychain hit. `login::rehydrate_full_session` already wrote
    /// `substrate_address`, `capabilities = Full`, and the keypair.
    /// The caller MUST NOT call `set_active_account` (it would
    /// redundantly re-acquire the lock and overwrite the same fields
    /// with the same values).
    AlreadyWritten,
    /// Keychain miss / unavailable, OR the session is OAuth-only.
    /// The caller still needs to call
    /// `state.set_active_account(addr, cap)` to write the address
    /// and capability.
    NeedsActiveAccount(AuthCapabilities),
}

/// Try to fully rehydrate `AuthInfo` from the OS keychain.
///
/// For mnemonic users this attempts a keychain load and, if successful,
/// derives the full keypair via [`crate::auth::login::rehydrate_full_session`].
/// For OAuth users a keychain hit populates `AuthInfo.mnemonic` (so the
/// recovery check resolves to `Proceed` instead of `Unlock` — i.e. no
/// server round-trip to re-download the sealed mnemonic blob) while
/// leaving the capability at `OAuthOnly` (OAuth users don't sign
/// blockchain extrinsics from a mnemonic-derived keypair). On a
/// keychain miss either path falls through to the normal Unlock /
/// Restored flow.
fn rehydrate_or_restored(state: &crate::app_state::AppState, addr: &str, auth_type: &str) -> RehydrateOutcome {
    match keychain::load_mnemonic(addr) {
        KeychainResult::Found(mnemonic) => {
            if auth_type == "mnemonic" {
                match crate::auth::login::rehydrate_full_session(state, mnemonic) {
                    Ok(_) => {
                        info!("Session fully restored from OS keychain — capability = Full");
                        return RehydrateOutcome::AlreadyWritten;
                    }
                    Err(e) => {
                        warn!(error = %e, "Keychain mnemonic failed to derive keys; falling back to Restored");
                    }
                }
            } else {
                // OAuth users: write `substrate_address`, capability, and the
                // mnemonic atomically under a single auth lock. Capability stays
                // `OAuthOnly` — a cached mnemonic only unblocks sync encryption,
                // it does not promote the session to signing-capable. The match
                // mirrors `rehydrate_full_session`'s atomicity guarantee so the
                // caller can safely rely on `AlreadyWritten` semantics (no
                // follow-up `set_active_account` call).
                match state.auth.lock() {
                    Ok(mut auth) => {
                        auth.capabilities = AuthCapabilities::OAuthOnly;
                        auth.substrate_address = Some(addr.to_string());
                        auth.mnemonic = Some(mnemonic);
                        info!("OAuth session restored from OS keychain — capability = OAuthOnly, mnemonic cached");
                        return RehydrateOutcome::AlreadyWritten;
                    }
                    Err(e) => {
                        warn!(error = %e, "auth lock poisoned during OAuth keychain rehydrate; falling back to Unlock path");
                    }
                }
            }
        }
        KeychainResult::NotFound => {
            // Expected for users without a keychain entry yet (first launch
            // since keychain integration shipped, or post-logout). Mnemonic
            // users see "re-enter your seed phrase"; OAuth users see the
            // recovery-password Unlock dialog.
        }
        KeychainResult::Unavailable(reason) => {
            warn!(reason = %reason, "OS keychain unavailable; falling back to Restored / OAuthOnly");
        }
    }
    let fallback = if auth_type == "mnemonic" {
        AuthCapabilities::Restored
    } else {
        AuthCapabilities::OAuthOnly
    };
    RehydrateOutcome::NeedsActiveAccount(fallback)
}

/// Result of session restoration, returned to the frontend for state setup.
///
/// The frontend reads localStorage (Rust can't), passes the OAuth data
/// to this command, and Rust makes all decisions about what's valid.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreResult {
    pub authenticated: bool,
    pub substrate_address: Option<String>,
    pub auth_type: Option<String>,
    pub oauth_session: Option<serde_json::Value>,
    /// Milliseconds until logout. None = infinite / no timer.
    pub logout_time_ms: Option<i64>,
    /// Frontend should clear OAuth localStorage entries.
    pub should_clear_oauth: bool,
    /// true = initSync with mnemonic from Rust; false = initSync without mnemonic (or skip)
    pub needs_sync_mnemonic: bool,
    /// Where to navigate: "/" for home, "/login" for login, null for no navigation
    pub redirect_to: Option<String>,
    /// True when the session was restored successfully BUT the OS
    /// keychain did not contain the user's BIP-39 mnemonic, so
    /// `AuthInfo.mnemonic` is `None` and the sync engine is wedged
    /// behind the encrypted `drive_password` chicken-and-egg lock.
    ///
    /// Only set for mnemonic-auth users (OAuth users use
    /// `ensure_sync_mnemonic` to generate a mnemonic on demand and
    /// aren't affected by this state). The frontend surfaces this
    /// as a persistent banner (`SyncReauthRequiredAlert`) with a
    /// call-to-action that routes to `/login` for re-entering the
    /// seed phrase — the only recovery path.
    pub sync_requires_reauth: bool,
}

/// Restore the user's session at app boot.
///
/// Replaces the 150-line boot cascade in `wallet-auth-context.tsx`.
/// The frontend reads localStorage OAuth data and passes it here.
/// Rust validates tokens, checks expiry, falls back to DB session,
/// and returns a structured result for the frontend to render.
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Linear multi-stage auth flow (OAuth JSON validation → DB fallback → result build). Splitting fragments the early-return error paths and has caused past regressions; auth_session_repo's inline unit tests cover the upsert/clear/COALESCE invariants."
)]
pub async fn restore_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    oauth_session_json: Option<String>,
    oauth_expiry_ms: Option<i64>,
) -> Result<SessionRestoreResult, AppError> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // ── Try OAuth session first ─────────────────────────────────────────
    if let (Some(json), Some(expiry)) = (&oauth_session_json, oauth_expiry_ms) {
        if now_ms < expiry {
            match serde_json::from_str::<serde_json::Value>(json) {
                Ok(session_data) => {
                    let substrate_address = session_data.get("substrateAddress").and_then(|v| v.as_str()).map(String::from);

                    // A valid OAuth session MUST carry a substrateAddress. The
                    // token-DB validation below only runs inside `if let
                    // Some(addr)`, so a session JSON that parses but lacks the
                    // address would skip that check entirely and fall through to
                    // `authenticated: true` with no identity — accepting a
                    // malformed or forged session. Treat a missing address as
                    // unauthenticated and bounce to login.
                    if substrate_address.is_none() {
                        info!("OAuth session JSON missing substrateAddress — treating as unauthenticated");
                        return Ok(SessionRestoreResult {
                            authenticated: false,
                            substrate_address: None,
                            auth_type: None,
                            oauth_session: None,
                            logout_time_ms: None,
                            should_clear_oauth: true,
                            needs_sync_mnemonic: false,
                            redirect_to: Some("/login".into()),
                            sync_requires_reauth: false,
                        });
                    }

                    // Validate token in Rust DB
                    if let Some(ref addr) = substrate_address {
                        let token_row = auth_session_repo::get_token_and_expiry(pool, addr).await?;
                        // `expiry_ms == 0` means "never expires" — the same
                        // convention the DB-fallback check (`expiry > 0 && expiry
                        // < now`) and `is_token_valid` use. Treating 0 as the
                        // never-expires sentinel here keeps a non-expiring token
                        // accepted on restore, matching everywhere else.
                        let token_valid = matches!(
                            token_row,
                            Some(TokenStatus { token: Some(_), expiry_ms: Some(exp) }) if exp == 0 || exp > now_ms
                        );
                        if !token_valid {
                            info!("OAuth token expired in DB, clearing session");
                            return Ok(SessionRestoreResult {
                                authenticated: false,
                                substrate_address: None,
                                auth_type: None,
                                oauth_session: None,
                                logout_time_ms: None,
                                should_clear_oauth: true,
                                needs_sync_mnemonic: false,
                                redirect_to: Some("/login".into()),
                                sync_requires_reauth: false,
                            });
                        }
                    }

                    let provider = session_data.get("provider").and_then(|v| v.as_str()).unwrap_or("oauth");
                    let auth_type = if provider == "mnemonic" { "mnemonic" } else { "oauth" };
                    let needs_mnemonic = provider != "mnemonic";

                    let mut sync_requires_reauth = false;
                    if let Some(ref addr) = substrate_address {
                        // For mnemonic users: try the OS keychain — if it
                        // has the seed phrase, fully rehydrate AuthInfo
                        // (capability = Full, signing works immediately).
                        // Otherwise fall back to Restored. For OAuth users:
                        // always OAuthOnly. The `AlreadyWritten` outcome
                        // means rehydrate already wrote `AuthInfo` and we
                        // must not double-write via `set_active_account`.
                        let outcome = rehydrate_or_restored(&state, addr, auth_type);
                        // The `Restored` capability is specifically the
                        // mnemonic-user-with-keychain-miss case (see
                        // `rehydrate_or_restored`); flag it so the FE
                        // shows the reauth banner.
                        sync_requires_reauth = matches!(outcome, RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::Restored));
                        match outcome {
                            RehydrateOutcome::AlreadyWritten => {
                                // Mnemonic is in AuthInfo — run encryption migration.
                                // Extract the mnemonic BEFORE awaiting (can't hold mutex across await).
                                if let Ok(pool) = state.pool() {
                                    let mnemonic_str = state
                                        .auth
                                        .lock()
                                        .ok()
                                        .and_then(|g| g.mnemonic.as_deref().map(|s| zeroize::Zeroizing::new(s.to_owned())));
                                    if let Some(m) = mnemonic_str
                                        && let Err(e) = crate::crypto::store::migrate_if_needed(pool, &m, addr).await
                                    {
                                        warn!(error = %e, "Encryption migration failed — will retry on next login");
                                    }
                                }
                            }
                            RehydrateOutcome::NeedsActiveAccount(cap) => {
                                state.set_active_account(addr, cap)?;
                            }
                        }
                    }
                    info!("Restoring OAuth session for {:?}", substrate_address);
                    // Re-arm the Tauri asset protocol scope and probe the
                    // OAuth recovery state concurrently. Both are post-auth
                    // reads with no shared mutable state, so they run in
                    // parallel via `tokio::join!`. Pre-parallelization the
                    // recovery probe alone could add seconds of cold-start
                    // latency on a slow network.
                    //
                    // Asset scope: the static scope in `tauri.conf.json`
                    // only covers `$HOME/.hippius/**`; user-chosen folders
                    // need a runtime `allow_directory` call each launch.
                    // `auto_init_sync` also does this in step 4, but if
                    // the mnemonic is unrecoverable (keychain evicted,
                    // reauth required), `auto_init_sync` aborts before
                    // the scope is expanded — on macOS release builds the
                    // first `asset://` read of a sync-folder file then
                    // re-triggers the system folder-permission dialog
                    // every launch. Priming the scope here makes
                    // bootstrap deterministic.
                    //
                    // Recovery probe: for OAuth-provider sessions, emit
                    // `oauth_recovery_check_needed` if a dialog is
                    // required. Mirrors `complete_oauth_flow` so
                    // returning OAuth users also get the signup / unlock
                    // prompt on session restore — otherwise the dialog
                    // only ever fires on fresh OAuth, and a frontend
                    // listener subscribing after the fresh-OAuth emit
                    // leaves the account permanently unrecoverable with
                    // no UI.
                    let asset_scope_fut = async {
                        if let Some(ref addr) = substrate_address {
                            arm_asset_scope_for_account(&app, &state, addr).await;
                        }
                    };
                    let recovery_probe_fut = async {
                        if auth_type == "oauth" {
                            Some(crate::recovery::check_recovery_state_inner(&state).await)
                        } else {
                            None
                        }
                    };
                    let ((), recovery_result) = tokio::join!(asset_scope_fut, recovery_probe_fut);

                    if let Some(rc_result) = recovery_result {
                        match rc_result {
                            Ok(recovery_check) => {
                                let gate_target = match recovery_check.recommended_flow {
                                    crate::recovery::RecoveryFlow::Proceed => crate::recovery::RecoveryGateState::Skipped,
                                    _ => crate::recovery::RecoveryGateState::Pending,
                                };
                                state.set_recovery_state(gate_target);
                                info!(
                                    flow = ?recovery_check.recommended_flow,
                                    gate = ?gate_target,
                                    "session_restore: emitting oauth_recovery_check_needed so FE can render dialog"
                                );
                                if let Err(e) = app.emit("oauth_recovery_check_needed", &recovery_check) {
                                    warn!(error = %e, "session_restore: failed to emit oauth_recovery_check_needed");
                                }
                            }
                            Err(e) => {
                                warn!(error = %e, "session_restore: check_recovery_state_inner failed; skipping emit");
                            }
                        }
                    }

                    // Notify FE if a rotation is awaiting its local-rewrite step.
                    if let Some(ref addr) = substrate_address
                        && crate::recovery::rotation_sidecar_path(addr).is_ok_and(|p| p.exists())
                    {
                        info!(
                            account = %crate::console_access::short_ss58(addr),
                            "session_restore: rotation sidecar present → emitting recovery_rotation_pending"
                        );
                        if let Err(e) = app.emit("recovery_rotation_pending", addr) {
                            warn!(error = %e, "session_restore: failed to emit recovery_rotation_pending");
                        }
                    }

                    // Signal that AuthInfo is populated so the FE can
                    // retry `auto_init_sync` if its first attempt raced
                    // ahead of `rehydrate_or_restored`. See the auth-
                    // readiness race fix in `sync/lifecycle.rs`.
                    state.sync_bridge.emit_auth_ready();
                    return Ok(SessionRestoreResult {
                        authenticated: true,
                        substrate_address,
                        auth_type: Some(auth_type.into()),
                        oauth_session: Some(session_data),
                        logout_time_ms: None, // OAuth uses server-side 30-day expiry
                        should_clear_oauth: false,
                        needs_sync_mnemonic: needs_mnemonic,
                        redirect_to: None,
                        sync_requires_reauth,
                    });
                }
                Err(e) => {
                    info!("Failed to parse OAuth session JSON: {e}");
                    // Fall through to DB session
                }
            }
        } else {
            info!("OAuth session expired");
        }
        // OAuth expired or invalid — tell frontend to clear localStorage
    }

    let should_clear = oauth_session_json.is_some();

    // ── Fall back to Rust DB session ────────────────────────────────────
    let row = auth_session_repo::get_latest(pool).await?;

    let Some(row) = row else {
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: None,
            sync_requires_reauth: false,
        });
    };

    let Some(auth_token) = row.auth_token else {
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: None,
            sync_requires_reauth: false,
        });
    };

    // Check token expiry
    if let Some(expiry) = row.token_expiry
        && expiry > 0
        && expiry < now_ms
    {
        info!("DB session token expired, clearing");
        if let Some(ref addr) = row.substrate_address {
            let _ = auth_session_repo::clear(pool, addr).await;
        }
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: Some("/login".into()),
            sync_requires_reauth: false,
        });
    }

    // Valid session — build OAuth session object for frontend display
    let oauth_session = serde_json::json!({
        "token": auth_token,
        "userId": row.user_id.unwrap_or(0),
        "username": row.username.clone().unwrap_or_default(),
        "provider": row.provider.clone().unwrap_or_else(|| "mnemonic".into()),
        "expiresAt": row.token_expiry.and_then(|e| chrono::DateTime::from_timestamp_millis(e).map(|d| d.to_rfc3339())).unwrap_or_default(),
        "substrateAddress": row.substrate_address.clone(),
        "isNew": false,
    });

    let auth_type = if row.provider.as_deref() == Some("oauth") { "oauth" } else { "mnemonic" };
    let eff_minutes = row.logout_time_minutes.unwrap_or(1440);
    let logout_time_ms = if eff_minutes == -1 { None } else { Some(eff_minutes * 60_000) };

    let mut sync_requires_reauth = false;
    // The post-rehydrate work splits into two halves:
    // - sync portion: outcome match (mutex write under sync lock, no awaits)
    //   plus mnemonic extraction (also sync, under the same mutex).
    // - async portion: encryption migration (DB I/O) + asset scope rearm.
    //   Both are reads of state with no shared mutable state, so they
    //   run concurrently via `tokio::join!`.
    let migrate_input: Option<(sqlx::SqlitePool, zeroize::Zeroizing<String>)> = if let Some(ref addr) = row.substrate_address {
        let outcome = rehydrate_or_restored(&state, addr, auth_type);
        sync_requires_reauth = matches!(outcome, RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::Restored));
        match outcome {
            RehydrateOutcome::AlreadyWritten => {
                // Mnemonic is in AuthInfo — prepare encryption migration inputs.
                // Extract the mnemonic synchronously under the auth mutex so we
                // never hold the lock across an `.await`.
                if let Ok(pool) = state.pool() {
                    let mnemonic_str = state
                        .auth
                        .lock()
                        .ok()
                        .and_then(|g| g.mnemonic.as_deref().map(|s| zeroize::Zeroizing::new(s.to_owned())));
                    mnemonic_str.map(|m| (pool.clone(), m))
                } else {
                    None
                }
            }
            RehydrateOutcome::NeedsActiveAccount(cap) => {
                state.set_active_account(addr, cap)?;
                None
            }
        }
    } else {
        None
    };
    info!("Restoring DB session for {:?}", row.substrate_address);

    // Re-arm the asset protocol scope for the restored account in parallel
    // with the encryption migration — same rationale as the OAuth branch
    // above. Both are pure async I/O on independent subsystems.
    let migrate_addr = row.substrate_address.clone();
    let migrate_fut = async move {
        if let (Some((pool, m)), Some(addr)) = (migrate_input, migrate_addr.as_ref())
            && let Err(e) = crate::crypto::store::migrate_if_needed(&pool, &m, addr).await
        {
            warn!(error = %e, "Encryption migration failed — will retry on next login");
        }
    };
    let asset_scope_fut = async {
        if let Some(ref addr) = row.substrate_address {
            arm_asset_scope_for_account(&app, &state, addr).await;
        }
    };
    tokio::join!(migrate_fut, asset_scope_fut);
    // Signal auth-ready for the DB-fallback restore path as well. The
    // FE's `auto_init_sync` retry listens on this single event for both
    // restore branches.
    state.sync_bridge.emit_auth_ready();
    Ok(SessionRestoreResult {
        authenticated: true,
        substrate_address: row.substrate_address,
        auth_type: Some(auth_type.into()),
        oauth_session: Some(oauth_session),
        logout_time_ms,
        should_clear_oauth: should_clear,
        needs_sync_mnemonic: row.provider.as_deref() != Some("mnemonic"),
        redirect_to: Some("/".into()),
        sync_requires_reauth,
    })
}

/// Server-side token expiry check. Returns `true` if the token exists
/// in `auth_session` and has not expired, `false` otherwise.
///
/// Used by the frontend's `useTokenValidation` hook to decide whether
/// to nudge the user to re-authenticate. Lives in `session_restore`
/// because it's a read-only inspection of session validity, the same
/// concern as `restore_session`.
#[tauri::command]
pub async fn is_token_valid(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, AppError> {
    let row = auth_session_repo::get_token_and_expiry(state.pool()?, &account_id).await?;
    Ok(matches!(
        row,
        Some(TokenStatus { token: Some(_), expiry_ms: Some(expiry) })
            if expiry == 0 || expiry > chrono::Utc::now().timestamp_millis()
    ))
}
