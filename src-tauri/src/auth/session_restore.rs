//! Session restoration on app boot.
//!
//! Single-source flow: the `auth_session` table is the ONLY authority on
//! who is signed in. Rust resolves the token (keychain-first), validates
//! expiry, populates `AuthInfo`, and returns a structured result for the
//! frontend to render.
//!
//! The frontend used to pass its localStorage OAuth session in, and Rust
//! restored from that after checking the session's `token` against the DB
//! one. That design forced the renderer to persist the bearer token —
//! OWASP is unambiguous that session secrets do not belong in Web Storage
//! (audit S-4) — and turned any future token rotation into a forced
//! logout the moment the two copies diverged (M-5). Both problems vanish
//! by construction here: with the row as the only input there is no
//! renderer-supplied session left to validate, so `hippius_oauth_session`
//! survives purely as a token-free presence hint for the frontend's own
//! synchronous boot checks.

use crate::auth::auth_session_repo::{self, TokenStatus};
use crate::auth::keychain::{self, KeychainResult};
use crate::auth::state::AuthCapabilities;
use crate::error::AppError;
use tauri::Emitter;
use tracing::{info, warn};

/// Wall-clock bound for the OAuth-branch recovery-state network probe.
///
/// `restore_session` itself is deliberately *not* given an outer
/// deadline. It performs a synchronous OS-keychain read
/// (`rehydrate_or_restored` → `keychain::load_mnemonic`) which, on macOS,
/// blocks on a system password prompt the user may take minutes to
/// answer. A wall-clock cap over the whole call is exactly what surfaced
/// the "restore_session timed out" toast and abandoned boot when a user
/// typed slowly — waiting on a human is not a hang. The only step that
/// can hang on something *other than the user* is the network probe to
/// hcfs-server, so the deadline is scoped to just that probe.
const RECOVERY_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Run the best-effort recovery-state probe under [`RECOVERY_PROBE_TIMEOUT`].
///
/// Returns `Some(check)` when the probe completes in time, and `None`
/// when it errors or the deadline elapses. Both non-success cases
/// collapse to `None` on purpose: the probe is best-effort, so the caller
/// simply skips the `oauth_recovery_check_needed` emit and the dialog
/// re-fires on the next launch.
///
/// Shared with `complete_oauth_flow` (audit H-1): the fresh-OAuth path
/// runs the same probe after its session is persisted, where an
/// unbounded fatal probe used to fail the whole login at its last step.
///
/// The probe future is dropped on timeout. That is cancellation-safe
/// (axiom `rust_quality_128`): `check_recovery_state_inner` is a
/// read-mostly server probe whose only write
/// (`seed_hcfs_server_url_if_missing`) is idempotent, so a drop mid-flight
/// loses no durable state.
pub(crate) async fn probe_recovery_state_bounded<E: std::fmt::Display>(
    fut: impl std::future::Future<Output = Result<crate::recovery::RecoveryCheck, E>>,
) -> Option<crate::recovery::RecoveryCheck> {
    match tokio::time::timeout(RECOVERY_PROBE_TIMEOUT, fut).await {
        Ok(Ok(check)) => Some(check),
        Ok(Err(e)) => {
            warn!(error = %e, "session_restore: recovery probe failed; skipping oauth_recovery_check_needed emit");
            None
        }
        Err(_elapsed) => {
            warn!(
                timeout_secs = RECOVERY_PROBE_TIMEOUT.as_secs(),
                "session_restore: recovery probe timed out; skipping emit (dialog re-fires next launch)"
            );
            None
        }
    }
}

/// Decide the recovery-gate transition for an OAuth session restore from the
/// probe result.
///
/// `Some(Proceed)` is the only state that lets sync run straight away
/// (`Skipped`); every other resolved flow is `Pending` because the recovery
/// dialog must run first. Crucially, a **`None`** probe result (timeout or
/// error) is also `Pending`, not `Skipped`: a failed probe means we do not
/// know whether this device needs the server-sealed mnemonic, so the gate
/// must keep `ensure_sync_mnemonic` parked rather than let it mint a fresh
/// mnemonic on a fresh device — minting there collides with the server blob
/// the user later unlocks and corrupts the drive password (the race the gate
/// guards, see `ensure_sync_mnemonic`). The gate's startup default is
/// `Skipped` (`AppState::new`), so leaving it untouched on a `None` probe is
/// exactly the unsafe behavior this funnels away from.
pub(crate) fn recovery_gate_target(check: Option<&crate::recovery::RecoveryCheck>) -> crate::recovery::RecoveryGateState {
    match check {
        Some(c) if matches!(c.recommended_flow, crate::recovery::RecoveryFlow::Proceed) => crate::recovery::RecoveryGateState::Skipped,
        _ => crate::recovery::RecoveryGateState::Pending,
    }
}

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

/// The keychain read and its derived identity, resolved exactly ONCE per
/// restore.
///
/// Two independent consumers need this answer — the legacy-provider
/// repair ([`check_provider`]) and the `AuthInfo` rehydrate
/// ([`rehydrate_or_restored`]) — and `keychain::load_mnemonic` can block
/// on an OS password prompt the user takes minutes to answer (macOS). So
/// it is read once and threaded through, never read per consumer.
struct KeychainIdentity {
    mnemonic: Option<zeroize::Zeroizing<String>>,
    /// Whether the stored mnemonic derives the row's OWN account.
    ///
    /// `None` means nothing could be concluded — no mnemonic, an
    /// unreadable keychain, or a phrase that failed to derive — and every
    /// consumer must treat that as "do not act", never as a mismatch.
    derives_row_account: Option<bool>,
}

/// Read the OS keychain once and decide whether what it holds is this
/// account's own identity.
fn load_keychain_identity(addr: &str) -> KeychainIdentity {
    match keychain::load_mnemonic(addr) {
        KeychainResult::Found(mnemonic) => {
            // Routed through `derive_verified_keys` rather than a
            // hand-rolled compare against the bare `derive_keys`: CLAUDE.md's
            // identity guard keeps the "may this stored mnemonic act for
            // this account?" equality in exactly ONE place, so the H-3/H-4
            // phantom-identity class cannot reappear through a second,
            // subtly-different copy of the check.
            let derives_row_account = match crate::auth::service::derive_verified_keys(&mnemonic, addr) {
                Ok(_) => Some(true),
                Err(crate::auth::service::IdentityError::Mismatch { derived }) => {
                    warn!(
                        account = %crate::console_access::short_ss58(addr),
                        derived = %crate::console_access::short_ss58(&derived),
                        "restore: stored mnemonic derives a different identity than this session row"
                    );
                    Some(false)
                }
                Err(crate::auth::service::IdentityError::DeriveFailed(e)) => {
                    warn!(error = %e, "restore: keychain mnemonic failed to derive an identity");
                    None
                }
            };
            KeychainIdentity {
                mnemonic: Some(mnemonic),
                derives_row_account,
            }
        }
        KeychainResult::NotFound => {
            // Expected for users without a keychain entry yet (first launch
            // since keychain integration shipped, or post-logout). Mnemonic
            // users see "re-enter your seed phrase"; OAuth users see the
            // recovery-password Unlock dialog.
            KeychainIdentity {
                mnemonic: None,
                derives_row_account: None,
            }
        }
        KeychainResult::Unavailable(reason) => {
            warn!(reason = %reason, "OS keychain unavailable; restoring without a cached mnemonic");
            KeychainIdentity {
                mnemonic: None,
                derives_row_account: None,
            }
        }
    }
}

/// Verdict on a row's stored `provider` value.
#[derive(Debug, PartialEq, Eq)]
enum ProviderCheck {
    /// The stored value is trustworthy.
    Keep,
    /// The row claims `mnemonic` but the keychain mnemonic derives a
    /// DIFFERENT address than the row is keyed by — so this is really an
    /// OAuth account that a pre-#102 build mislabelled.
    RepairToOauth,
}

/// Detect a pre-#102 mislabelled OAuth session row.
///
/// Before the H-3/H-4 identity guard shipped (`6c7a5cda`),
/// `ensure_billing_auth` upserted `provider: "mnemonic"` keyed by the
/// account's real login SS58 while deriving from the account's *sync*
/// mnemonic — which for an OAuth account is a different identity
/// entirely. Those rows are still on disk wherever an older build ran.
///
/// The mislabel used to be harmless because restore read `provider` from
/// the frontend's localStorage session, which said `oauth`. Now that the
/// row is the only input, believing it would restore an OAuth account
/// down the mnemonic path: `rehydrate_full_session` writes the address it
/// DERIVES into `AuthInfo`, so `AuthInfo` and the returned session would
/// name two different accounts, and `needs_sync_mnemonic` would be false
/// so sync never receives its mnemonic.
///
/// The tell is exactly the H-3 condition: for a genuine mnemonic account
/// the stored phrase derives the row's own address; for a mislabelled
/// OAuth account it cannot. Repair is deliberately gated on a POSITIVE
/// mismatch — an unknown identity (`None`: missing or unreadable keychain)
/// keeps the stored value, so a real mnemonic user whose keychain is
/// merely locked is never relabelled.
fn check_provider(stored_provider: &str, derives_row_account: Option<bool>) -> ProviderCheck {
    if stored_provider == "mnemonic" && derives_row_account == Some(false) {
        ProviderCheck::RepairToOauth
    } else {
        ProviderCheck::Keep
    }
}

/// Default idle-logout budget, in minutes, for a session row that records
/// no preference of its own.
const DEFAULT_LOGOUT_MINUTES: i64 = 1440;

/// Resolve the frontend's idle-logout timer for a restored session.
///
/// An OAuth session is bounded by the server-side token expiry, not by the
/// local idle-logout preference, and gets NO timer.
///
/// This is not cosmetic. `complete_oauth_flow` never writes
/// `logout_time_minutes`, and the upsert binds that `None` as an explicit
/// NULL — which overrides the column's `DEFAULT 1440`. So every OAuth row
/// reads back as "no preference", and applying the default to it would
/// hand every OAuth user a 24-hour forced logout they never configured.
/// Restoring from the localStorage session used to sidestep this by
/// returning `None` unconditionally; the row-based path has to say so
/// explicitly.
///
/// `-1` is the "keep me logged in" sentinel and also means no timer.
fn resolve_logout_time_ms(auth_type: &str, logout_time_minutes: Option<i64>) -> Option<i64> {
    if auth_type == "oauth" {
        return None;
    }
    match logout_time_minutes.unwrap_or(DEFAULT_LOGOUT_MINUTES) {
        -1 => None,
        minutes => Some(minutes * 60_000),
    }
}

/// Populate `AuthInfo` from an already-resolved [`KeychainIdentity`].
///
/// For mnemonic users a keychain hit derives the full keypair via
/// [`crate::auth::login::rehydrate_full_session`]. For OAuth users it
/// populates `AuthInfo.mnemonic` (so the recovery check resolves to
/// `Proceed` instead of `Unlock` — no server round-trip to re-download
/// the sealed mnemonic blob) while leaving the capability at `OAuthOnly`
/// (OAuth users don't sign blockchain extrinsics from a mnemonic-derived
/// keypair). On a keychain miss either path falls through to the normal
/// Unlock / Restored flow.
fn rehydrate_or_restored(state: &crate::app_state::AppState, addr: &str, auth_type: &str, identity: KeychainIdentity) -> RehydrateOutcome {
    let KeychainIdentity {
        mnemonic,
        derives_row_account,
    } = identity;
    if let Some(mnemonic) = mnemonic {
        if auth_type == "mnemonic" {
            // Identity guard. `rehydrate_full_session` writes the address
            // it DERIVES into `AuthInfo`, so handing it a phrase that
            // derives someone else silently splits `AuthInfo` from the row
            // being restored — the same class the H-3/H-4 guard closes on
            // the re-authentication paths. Refuse and degrade to
            // `Restored`, which surfaces the "re-enter your seed phrase"
            // banner, rather than authenticate as the wrong account. An
            // unknown identity (`None`) is refused too: proceeding would
            // mean rehydrating on an unverified phrase.
            if derives_row_account != Some(true) {
                warn!(
                    account = %crate::console_access::short_ss58(addr),
                    "Keychain mnemonic derives a different identity than this session row; refusing to rehydrate"
                );
                return RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::Restored);
            }
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
            //
            // Deliberately NO identity check here: an OAuth account's sync
            // mnemonic legitimately derives a different SS58 than the
            // server-custodied login address, and `substrate_address` is
            // taken from the row rather than from the phrase, so nothing
            // can be confused. The equality guard belongs only on the
            // mnemonic path above, where the derived address IS the identity.
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
    let fallback = if auth_type == "mnemonic" {
        AuthCapabilities::Restored
    } else {
        AuthCapabilities::OAuthOnly
    };
    RehydrateOutcome::NeedsActiveAccount(fallback)
}

/// Outcome of validating a restored session's DB token (pure — see tests).
#[derive(Debug, PartialEq, Eq)]
enum RestoreTokenOutcome {
    /// Token resolved and unexpired — restore proceeds on this token.
    Valid(String),
    /// The expiry metadata says the session should still be alive, but
    /// the OS keychain — the only store holding the token after the
    /// keychain migration — is temporarily unreadable (locked keychain,
    /// D-Bus hiccup). Restore must fail SOFT: report unauthenticated
    /// but neither clear the FE's localStorage session nor bounce to
    /// `/login` (that path runs a full logout), so the next launch —
    /// keychain back — restores normally. Treating this as
    /// missing/expired destroyed valid sessions over a transient OS
    /// condition (audit M-1).
    KeychainUnavailable,
    /// The session's own metadata says it is over. Clear the row and
    /// bounce to login.
    Expired,
    /// No row, or a row with no token and no keychain excuse. Report
    /// unauthenticated, but do NOT bounce — there is nothing to clean up
    /// and no evidence the user was logged out.
    Missing,
}

/// Classify the token row for a session restore.
///
/// Expiry is evaluated FIRST and wins over every other signal: a session
/// whose own metadata says it is dead must be cleaned up regardless of
/// whether the keychain could be read, otherwise a permanently broken
/// keychain would keep an expired row alive across launches (audit M-1).
///
/// A `None` expiry means "no expiry recorded", which is treated as alive
/// — the same meaning as the `0` sentinel used by `is_token_valid`. Only
/// a positive expiry in the past kills the session.
fn classify_restore_token(row: Option<TokenStatus>, now_ms: i64) -> RestoreTokenOutcome {
    let Some(status) = row else {
        return RestoreTokenOutcome::Missing;
    };
    if let Some(exp) = status.expiry_ms
        && exp > 0
        && exp < now_ms
    {
        return RestoreTokenOutcome::Expired;
    }
    match status.token {
        Some(token) => RestoreTokenOutcome::Valid(token),
        // Unexpired (checked above) with no token, solely because the OS
        // keychain — the only store holding it after the keychain
        // migration — is temporarily unreadable. Fail SOFT so the next
        // launch retries instead of destroying a valid session.
        None if status.keychain_unavailable => RestoreTokenOutcome::KeychainUnavailable,
        None => RestoreTokenOutcome::Missing,
    }
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

impl SessionRestoreResult {
    /// Build the "not signed in" result returned by every bounce-to-login path
    /// in [`restore_session`].
    ///
    /// Collapses the six identical hand-written literals (audit P1-3): every
    /// field that means "no authenticated identity" is fixed here —
    /// `authenticated: false`, no `substrate_address`/`auth_type`/`oauth_session`,
    /// no logout timer, no sync mnemonic, and not the reauth-required state — so
    /// a future field added to the struct can't be forgotten in one branch and
    /// silently leak a half-populated unauthenticated result. The callers choose
    /// only the two axes that genuinely vary across the failure paths:
    /// `should_clear_oauth` (wipe the FE's OAuth localStorage?) and `redirect_to`
    /// (`Some("/login")` to bounce, `None` to leave navigation untouched).
    fn unauthenticated(should_clear_oauth: bool, redirect_to: Option<String>) -> Self {
        Self {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth,
            needs_sync_mnemonic: false,
            redirect_to,
            sync_requires_reauth: false,
        }
    }
}

/// Restore the user's session at app boot.
///
/// Replaces the 150-line boot cascade in `wallet-auth-context.tsx`. The
/// `auth_session` row is the single source of truth: the frontend passes
/// nothing in, so there is no renderer-controlled input to validate (see
/// the module docs for why that matters).
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Linear multi-stage auth flow (row lookup → token classification → provider repair → AuthInfo rehydrate → result build). Splitting fragments the early-return paths and has caused past regressions; the decision stages (classify_restore_token, check_provider) are extracted as pure functions and unit-tested."
)]
pub async fn restore_session(app: tauri::AppHandle, state: tauri::State<'_, crate::app_state::AppState>) -> Result<SessionRestoreResult, AppError> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // ── Resolve the session row ─────────────────────────────────────────
    // `get_latest` already skips cleared rows (audit M-6), so a row here
    // means an account really was signed in on this device.
    let Some(row) = auth_session_repo::get_latest(pool).await? else {
        return Ok(SessionRestoreResult::unauthenticated(true, None));
    };
    let Some(addr) = row.substrate_address.clone() else {
        warn!("auth_session row has no substrate_address; treating as unauthenticated");
        return Ok(SessionRestoreResult::unauthenticated(true, None));
    };

    // ── Validate the token ──────────────────────────────────────────────
    let auth_token = match classify_restore_token(
        Some(TokenStatus {
            token: row.auth_token.clone(),
            expiry_ms: row.token_expiry,
            keychain_unavailable: row.token_keychain_unavailable,
        }),
        now_ms,
    ) {
        RestoreTokenOutcome::Valid(token) => token,
        RestoreTokenOutcome::KeychainUnavailable => {
            warn!("restore: OS keychain unavailable while the session is unexpired — failing soft (localStorage untouched, retried next launch)");
            return Ok(SessionRestoreResult::unauthenticated(false, None));
        }
        RestoreTokenOutcome::Expired => {
            info!("restore: session token expired, clearing");
            let _ = auth_session_repo::clear(pool, &addr).await;
            return Ok(SessionRestoreResult::unauthenticated(true, Some("/login".into())));
        }
        RestoreTokenOutcome::Missing => return Ok(SessionRestoreResult::unauthenticated(true, None)),
    };

    // ── Resolve identity, repairing a mislabelled legacy row ────────────
    // ONE keychain read for the whole restore — see `KeychainIdentity`.
    let identity = load_keychain_identity(&addr);
    let stored_provider = row.provider.clone().unwrap_or_else(|| "mnemonic".into());
    let provider = match check_provider(&stored_provider, identity.derives_row_account) {
        ProviderCheck::RepairToOauth => {
            warn!(
                account = %crate::console_access::short_ss58(&addr),
                "Session row labels an OAuth account as provider=mnemonic (pre-#102 billing upsert); repairing to oauth"
            );
            // Best-effort: a failed write costs only that the same
            // detection runs again on the next launch.
            if let Err(e) = auth_session_repo::repair_provider(pool, &addr, "oauth").await {
                warn!(error = %e, "failed to persist the provider repair; continuing on the corrected value");
            }
            "oauth".to_string()
        }
        ProviderCheck::Keep => stored_provider,
    };
    let auth_type = if provider == "mnemonic" { "mnemonic" } else { "oauth" };
    let needs_sync_mnemonic = provider != "mnemonic";

    // ── Populate AuthInfo ───────────────────────────────────────────────
    let outcome = rehydrate_or_restored(&state, &addr, auth_type, identity);
    // `Restored` is specifically the mnemonic-user case where the keychain
    // missed or the identity guard refused; flag it so the FE shows the
    // "re-enter your seed phrase" banner.
    let sync_requires_reauth = matches!(outcome, RehydrateOutcome::NeedsActiveAccount(AuthCapabilities::Restored));
    let migrate_input: Option<(sqlx::SqlitePool, zeroize::Zeroizing<String>)> = match outcome {
        RehydrateOutcome::AlreadyWritten => {
            // The mnemonic is in AuthInfo — prepare the encryption-migration
            // inputs. Extract it synchronously under the auth mutex so the
            // lock is never held across an `.await`.
            state.pool().ok().and_then(|pool| {
                state
                    .auth
                    .lock()
                    .ok()
                    .and_then(|g| g.mnemonic.as_deref().map(|s| zeroize::Zeroizing::new(s.to_owned())))
                    .map(|m| (pool.clone(), m))
            })
        }
        RehydrateOutcome::NeedsActiveAccount(cap) => {
            state.set_active_account(&addr, cap)?;
            None
        }
    };
    info!(auth_type, account = %crate::console_access::short_ss58(&addr), "Restoring session");

    // ── Post-auth work, run concurrently ────────────────────────────────
    // Three independent I/O tasks with no shared mutable state.
    //
    // Encryption migration: transparent plaintext → encrypted upgrade of
    // the stored sub-account seed phrases.
    //
    // Asset scope: the static scope in `tauri.conf.json` only covers the
    // preview cache; user-chosen sync folders need a runtime
    // `allow_directory` call each launch. `auto_init_sync` also does this,
    // but if the mnemonic is unrecoverable it aborts before reaching that
    // step — and on macOS release builds the first `asset://` read of a
    // sync-folder file then re-triggers the system folder-permission
    // dialog every launch. Priming it here makes bootstrap deterministic.
    //
    // Recovery probe: for OAuth sessions, decide whether the recovery
    // dialog must run before sync may mint a mnemonic. Bounded inside the
    // helper so an unreachable hcfs-server cannot hang boot; the keychain
    // read above stays unbounded because waiting on a human is not a hang.
    let migrate_fut = async {
        if let Some((pool, mnemonic)) = migrate_input
            && let Err(e) = crate::crypto::store::migrate_if_needed(&pool, &mnemonic, &addr).await
        {
            warn!(error = %e, "Encryption migration failed — will retry on next login");
        }
    };
    let recovery_probe_fut = async {
        if auth_type == "oauth" {
            probe_recovery_state_bounded(crate::recovery::check_recovery_state_inner(&state)).await
        } else {
            None
        }
    };
    let ((), (), recovery_check) = tokio::join!(migrate_fut, arm_asset_scope_for_account(&app, &state, &addr), recovery_probe_fut);

    // The gate MUST be set for an OAuth restore even when the probe
    // produced no result: a `None` (timeout/error) leaves it `Pending` so
    // `ensure_sync_mnemonic` parks instead of minting a mnemonic on a
    // device that may need the server blob. Non-OAuth restore never
    // touches the gate — its startup default `Skipped` is correct.
    //
    // This block used to live only on the localStorage-driven path, so a
    // DB-restored OAuth session silently left the gate at `Skipped` — the
    // exact state `recovery_gate_target` documents as unsafe.
    if auth_type == "oauth" {
        let gate_target = recovery_gate_target(recovery_check.as_ref());
        state.set_recovery_state(gate_target);
        if let Some(recovery_check) = recovery_check {
            info!(
                flow = ?recovery_check.recommended_flow,
                gate = ?gate_target,
                "session_restore: emitting oauth_recovery_check_needed so FE can render dialog"
            );
            if let Err(e) = app.emit("oauth_recovery_check_needed", &recovery_check) {
                warn!(error = %e, "session_restore: failed to emit oauth_recovery_check_needed");
            }
        } else {
            warn!("session_restore: recovery probe unavailable; gate left Pending so sync waits for next launch");
        }
    }

    // Notify the FE if a recovery-password rotation is awaiting its
    // local-rewrite step.
    if crate::recovery::rotation_sidecar_path(&addr).is_ok_and(|p| p.exists()) {
        info!(
            account = %crate::console_access::short_ss58(&addr),
            "session_restore: rotation sidecar present → emitting recovery_rotation_pending"
        );
        if let Err(e) = app.emit("recovery_rotation_pending", &addr) {
            warn!(error = %e, "session_restore: failed to emit recovery_rotation_pending");
        }
    }

    // The session object the FE renders. `email` is deliberately absent:
    // `auth_session` has no column for it, so it has never survived a
    // restart on this path either.
    let oauth_session = serde_json::json!({
        "token": auth_token,
        "userId": row.user_id.unwrap_or(0),
        "username": row.username.clone().unwrap_or_default(),
        "provider": &provider,
        "expiresAt": row.token_expiry.and_then(|e| chrono::DateTime::from_timestamp_millis(e).map(|d| d.to_rfc3339())).unwrap_or_default(),
        "substrateAddress": &addr,
        "isNew": false,
    });

    let logout_time_ms = resolve_logout_time_ms(auth_type, row.logout_time_minutes);

    // Signal that AuthInfo is populated so the FE can retry
    // `auto_init_sync` if its first attempt raced ahead of the rehydrate.
    state.sync_bridge.emit_auth_ready();
    Ok(SessionRestoreResult {
        authenticated: true,
        substrate_address: Some(addr),
        auth_type: Some(auth_type.into()),
        oauth_session: Some(oauth_session),
        logout_time_ms,
        // Nothing to clear on success — the FE rewrites its token-free
        // hint from this result.
        should_clear_oauth: false,
        needs_sync_mnemonic,
        // An OAuth restore leaves navigation alone (the user may have deep
        // linked); a mnemonic restore lands on home, as it always has.
        redirect_to: if auth_type == "oauth" { None } else { Some("/".into()) },
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
        Some(TokenStatus { token: Some(_), expiry_ms: Some(expiry), .. })
            if expiry == 0 || expiry > chrono::Utc::now().timestamp_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::{RecoveryCheck, RecoveryFlow, RecoveryGateState};

    fn sample_check() -> RecoveryCheck {
        RecoveryCheck {
            has_server_blob: false,
            has_local_mnemonic: true,
            updated_at: None,
            recommended_flow: RecoveryFlow::Proceed,
        }
    }

    // A probe that completes within the deadline surfaces its result.
    #[tokio::test(start_paused = true)]
    async fn recovery_probe_returns_some_when_fast() {
        let out = probe_recovery_state_bounded(async { Ok::<_, String>(sample_check()) }).await;
        assert!(out.is_some(), "a fast probe must surface its RecoveryCheck");
    }

    // Fault injection (axiom rust_quality_30): a probe that stalls past the
    // deadline is dropped and collapses to `None` so boot proceeds rather
    // than hanging. `start_paused` auto-advances virtual time to the
    // timeout, so this resolves instantly instead of sleeping 20s.
    #[tokio::test(start_paused = true)]
    async fn recovery_probe_returns_none_on_timeout() {
        let out = probe_recovery_state_bounded(async {
            tokio::time::sleep(RECOVERY_PROBE_TIMEOUT * 2).await;
            Ok::<_, String>(sample_check())
        })
        .await;
        assert!(out.is_none(), "a stalled probe must time out to None, not hang boot");
    }

    // A probe error is best-effort: it collapses to `None`, never aborting restore.
    #[tokio::test(start_paused = true)]
    async fn recovery_probe_returns_none_on_error() {
        let out = probe_recovery_state_bounded(async { Err::<RecoveryCheck, _>("probe failed") }).await;
        assert!(out.is_none(), "a probe error must collapse to None");
    }

    fn check_with(flow: RecoveryFlow) -> RecoveryCheck {
        RecoveryCheck {
            recommended_flow: flow,
            ..sample_check()
        }
    }

    // Only a resolved Proceed lets sync run immediately.
    #[test]
    fn gate_target_proceed_is_skipped() {
        let check = check_with(RecoveryFlow::Proceed);
        assert_eq!(recovery_gate_target(Some(&check)), RecoveryGateState::Skipped);
    }

    // Every flow that needs the recovery dialog parks the gate.
    #[test]
    fn gate_target_recovery_flows_are_pending() {
        for flow in [RecoveryFlow::Unlock, RecoveryFlow::Signup, RecoveryFlow::Unknown] {
            let check = check_with(flow);
            assert_eq!(
                recovery_gate_target(Some(&check)),
                RecoveryGateState::Pending,
                "{flow:?} must keep the gate Pending"
            );
        }
    }

    // The regression guard: a failed/timed-out probe (None) must NOT leave the
    // gate at its Skipped default — that would let ensure_sync_mnemonic mint a
    // mnemonic on a fresh device and corrupt the drive once the user unlocks.
    #[test]
    fn gate_target_absent_probe_is_pending() {
        assert_eq!(recovery_gate_target(None), RecoveryGateState::Pending);
    }

    // ─── Restore-token classification (audit M-1) ──────────────────
    //
    // The keychain-unavailable soft path must be reachable ONLY when
    // the expiry metadata says the session is still alive and the
    // token is missing solely because the keychain could not be read.

    const NOW: i64 = 1_700_000_000_000;

    fn status(token: Option<&str>, expiry_ms: Option<i64>, keychain_unavailable: bool) -> TokenStatus {
        TokenStatus {
            token: token.map(String::from),
            expiry_ms,
            keychain_unavailable,
        }
    }

    #[test]
    fn classify_valid_unexpired_token() {
        let out = classify_restore_token(Some(status(Some("tok"), Some(NOW + 1), false)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Valid("tok".into()));
        // expiry == 0 means "never expires".
        let out = classify_restore_token(Some(status(Some("tok"), Some(0), false)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Valid("tok".into()));
    }

    // The M-1 case: token unreadable, session unexpired → soft.
    #[test]
    fn classify_keychain_unavailable_is_soft_when_unexpired() {
        let out = classify_restore_token(Some(status(None, Some(NOW + 1), true)), NOW);
        assert_eq!(out, RestoreTokenOutcome::KeychainUnavailable);
    }

    // Expiry metadata wins: an expired session is dead regardless of
    // whether the keychain could be read — it must be cleaned up, not
    // kept alive forever by a permanently broken keychain.
    #[test]
    fn classify_expired_session_is_hard_even_with_unavailable_keychain() {
        let out = classify_restore_token(Some(status(None, Some(NOW - 1), true)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Expired);
    }

    // A readable keychain with no token is a genuine logout — but there is
    // nothing to clean up, so it must NOT bounce to login.
    #[test]
    fn classify_genuinely_absent_token_is_missing_not_expired() {
        let out = classify_restore_token(Some(status(None, Some(NOW + 1), false)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Missing);
        assert_eq!(classify_restore_token(None, NOW), RestoreTokenOutcome::Missing);
    }

    // No token, no expiry metadata, unreadable keychain. The two former
    // restore branches disagreed here: the localStorage path called it
    // hard (its classifier required `expiry_ms: Some(_)` for the soft
    // arm), while the DB path — the one that survives — fell soft,
    // because its expiry guard was `if let Some(expiry)`. Soft is kept
    // deliberately: nothing proves the session is dead, and the previous
    // "it must be a cleared row" rationale no longer applies now that
    // `get_latest` filters cleared rows out (audit M-6).
    #[test]
    fn classify_missing_expiry_with_unreadable_keychain_stays_soft() {
        let out = classify_restore_token(Some(status(None, None, true)), NOW);
        assert_eq!(out, RestoreTokenOutcome::KeychainUnavailable);
    }

    // An expired token that IS readable stays the hard path (regression
    // guard for the pre-existing expiry behavior).
    #[test]
    fn classify_expired_readable_token_is_hard() {
        let out = classify_restore_token(Some(status(Some("tok"), Some(NOW - 1), false)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Expired);
    }

    // A row with a token but NO recorded expiry is alive, matching the
    // `0` sentinel. The pre-merge DB path behaved this way (its expiry
    // check was `if let Some(expiry)`), so collapsing it into "missing"
    // would have logged out anyone holding such a row.
    #[test]
    fn classify_token_without_expiry_metadata_is_valid() {
        let out = classify_restore_token(Some(status(Some("tok"), None, false)), NOW);
        assert_eq!(out, RestoreTokenOutcome::Valid("tok".into()));
    }

    // ─── Legacy provider repair (audit H-4 residue) ────────────────
    //
    // Pre-#102 `ensure_billing_auth` wrote `provider = "mnemonic"` keyed
    // by an OAuth account's login SS58. Restore now reads `provider` from
    // the row alone, so the mislabel has to be detected and corrected or
    // the account restores down the mnemonic path and splits `AuthInfo`
    // from the session being returned.

    #[test]
    fn provider_repaired_when_mnemonic_derives_a_different_account() {
        assert_eq!(check_provider("mnemonic", Some(false)), ProviderCheck::RepairToOauth);
    }

    #[test]
    fn provider_kept_for_a_genuine_mnemonic_account() {
        assert_eq!(check_provider("mnemonic", Some(true)), ProviderCheck::Keep);
    }

    // The safety rule: with the identity unknown nothing can be concluded,
    // so a mnemonic user whose keychain is merely locked (or empty) must
    // never be relabelled as OAuth.
    #[test]
    fn provider_never_repaired_without_a_derived_identity() {
        assert_eq!(check_provider("mnemonic", None), ProviderCheck::Keep);
    }

    // An OAuth row is already correct; its sync mnemonic derives a
    // different identity by design, which must not be read as a defect.
    #[test]
    fn provider_kept_for_an_oauth_row_whose_mnemonic_differs() {
        assert_eq!(check_provider("oauth", Some(false)), ProviderCheck::Keep);
    }

    // ─── Idle-logout timer ─────────────────────────────────────────
    //
    // The regression this guards: `complete_oauth_flow` writes no
    // `logout_time_minutes` and the upsert binds that NULL explicitly,
    // overriding the column's DEFAULT 1440. Applying the default to an
    // OAuth row would give every OAuth user a 24-hour forced logout they
    // never configured — which the deleted localStorage path avoided by
    // returning `None` unconditionally.
    #[test]
    fn oauth_sessions_get_no_idle_logout_timer() {
        assert_eq!(resolve_logout_time_ms("oauth", None), None);
        // Even a row that somehow carries a preference stays untimed:
        // OAuth lifetime is the server-side token expiry.
        assert_eq!(resolve_logout_time_ms("oauth", Some(30)), None);
    }

    #[test]
    fn mnemonic_sessions_keep_their_idle_logout_preference() {
        assert_eq!(resolve_logout_time_ms("mnemonic", Some(30)), Some(30 * 60_000));
        // No preference recorded → the 24h default.
        assert_eq!(resolve_logout_time_ms("mnemonic", None), Some(DEFAULT_LOGOUT_MINUTES * 60_000));
        // -1 is the "keep me logged in" sentinel.
        assert_eq!(resolve_logout_time_ms("mnemonic", Some(-1)), None);
    }
}
