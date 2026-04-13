//! Console access feature — encrypted mnemonic blob on the server.
//!
//! Lets a user enable "decrypt my files from the browser" without the
//! desktop running. The desktop seals the mnemonic under a user-chosen
//! passphrase (Argon2id + XChaCha20-Poly1305, SS58 bound as AAD) and
//! uploads the ciphertext to `hcfs-server`. The Console browser later
//! downloads the ciphertext and unlocks it with the same passphrase.
//!
//! See `docs/plans/2026-04-13-console-password-blob-*.md` for the full
//! design (threat model, server API, browser flow).
//!
//! ## Rule: all logic in Rust
//!
//! Every domain decision happens here and surfaces to the frontend
//! as a structured result. The frontend only renders and captures
//! user input:
//!
//! - Passphrase strength scoring → Rust (`validate_console_passphrase`).
//! - "Did the user tick the recovery-phrase backup checkbox?" → sent
//!   to Rust as a boolean, Rust enforces it (`enable_console_access`
//!   returns `AppError::Validation(...)` if false).
//! - "Is Console access currently enabled?" → Rust
//!   (`console_access_status`).
//! - SS58 resolution, seal, upload, rotate → Rust.

use hcfs_client::mnemonic_blob::{SealedBlob, rotate_passphrase, seal_mnemonic};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tracing::info;
use zeroize::Zeroizing;

use crate::auth::tokens::get_api_token;
use crate::error::{AppError, NotReadyKind, Result};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Overall state of Console access for the active account. Returned by
/// [`console_access_status`] so the settings UI can pick the right
/// section (not-enabled explainer vs. enabled-with-rotate-controls).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleAccessStatus {
    /// `true` when an encrypted mnemonic blob exists on the server
    /// for the active account.
    pub enabled: bool,
    /// ISO-8601 timestamp of the last successful upload / rotation,
    /// or `None` when disabled or never enabled.
    pub last_updated_at: Option<String>,
    /// Number of passkeys the user has registered against this
    /// account on the server — purely informational in settings.
    pub passkey_count: u32,
}

/// Strength verdict bucket used by the UI progress meter. The
/// thresholds (weak < 40 bits, ok < 50, strong ≥ 50) are set here so
/// the UI never has to know the rule. `snake_case` JSON so the TS
/// discriminant matches — `TooShort` → `"too_short"`.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PassphraseVerdict {
    TooShort,
    Weak,
    Ok,
    Strong,
}

/// Result of [`validate_console_passphrase`]. The UI renders the
/// `label`, `progress_percent`, and `hints` verbatim and gates the
/// submit button on `acceptable_for_submit`. Every string and every
/// threshold originates here — the frontend has zero decisions to
/// make about passphrase policy.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseStrength {
    pub bits: f64,
    pub verdict: PassphraseVerdict,
    /// User-facing label for this verdict — "Too short", "Weak", "OK",
    /// "Strong". Owned here so the marketing copy can change in one
    /// place without touching the frontend.
    pub label: String,
    /// 0–100 progress-bar fill. Clamped so the bar is always visible
    /// even at 0 bits, and never exceeds 100% when the user picks
    /// something wildly over-strong. Owned here so that moving the
    /// entropy floor moves the bar's "full" point in lockstep.
    pub progress_percent: u8,
    pub hints: Vec<String>,
    pub acceptable_for_submit: bool,
}

// ---------------------------------------------------------------------------
// Passphrase policy
// ---------------------------------------------------------------------------

/// Minimum entropy the desktop will accept for a Console passphrase.
/// The number is deliberately higher than a "strong password" heuristic
/// because the blob sits on the server indefinitely — an attacker with
/// a DB exfil has unlimited offline time against Argon2id. 50 bits
/// plus Argon2id m=128 MiB / t=3 puts a single-attempt cost at ~1.5 s
/// on baseline hardware, so a 50-bit space under that KDF is
/// ≈ 2^50 × 1.5 s ≈ 53 million years on a single core.
const MIN_ENTROPY_BITS: f64 = 50.0;

/// Below this length we bail before running zxcvbn — short strings
/// score noisily and users need a clear "add words" hint anyway.
const MIN_PASSPHRASE_LEN: usize = 10;

/// Label shown next to the strength meter. Owned in Rust so copy
/// changes don't require a frontend edit.
fn verdict_label(verdict: PassphraseVerdict) -> &'static str {
    match verdict {
        PassphraseVerdict::TooShort => "Too short",
        PassphraseVerdict::Weak => "Weak",
        PassphraseVerdict::Ok => "OK",
        PassphraseVerdict::Strong => "Strong",
    }
}

/// Map a bits-of-entropy value to a 0–100 meter fill.
///
/// The bar is "full" at `MIN_ENTROPY_BITS` (the acceptable-for-submit
/// threshold), not at some arbitrary 80-bit visual maximum. That way
/// the full point moves with the policy if we ever raise the floor,
/// and users don't see a meter that looks half-empty when they've
/// already cleared the acceptance bar.
fn bits_to_percent(bits: f64) -> u8 {
    // Clamp below at 5% so the bar is visible even for the empty case.
    let raw = (bits / MIN_ENTROPY_BITS) * 100.0;
    raw.clamp(5.0, 100.0).round() as u8
}

fn score_passphrase(passphrase: &str) -> PassphraseStrength {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        let verdict = PassphraseVerdict::TooShort;
        return PassphraseStrength {
            bits: 0.0,
            verdict,
            label: verdict_label(verdict).to_string(),
            progress_percent: bits_to_percent(0.0),
            hints: vec![format!(
                "Use at least {MIN_PASSPHRASE_LEN} characters. A passphrase of 4+ unrelated words is easier to remember and stronger than a short complicated password."
            )],
            acceptable_for_submit: false,
        };
    }

    // zxcvbn estimates `guesses` (log10-encoded in `guesses_log10`); we
    // convert to bits = log2(guesses) = guesses_log10 / log10(2).
    let estimate = zxcvbn::zxcvbn(passphrase, &[]);
    let bits = estimate.guesses_log10() / core::f64::consts::LOG10_2;

    let verdict = if bits >= MIN_ENTROPY_BITS {
        PassphraseVerdict::Strong
    } else if bits >= 40.0 {
        PassphraseVerdict::Ok
    } else {
        PassphraseVerdict::Weak
    };

    let mut hints: Vec<String> = estimate
        .feedback()
        .map(|f| {
            let mut out = Vec::new();
            if let Some(warning) = f.warning() {
                out.push(warning.to_string());
            }
            for suggestion in f.suggestions() {
                out.push(suggestion.to_string());
            }
            out
        })
        .unwrap_or_default();

    // Always nudge toward passphrases over complicated passwords — zxcvbn
    // doesn't always emit this and users need the steer.
    if verdict != PassphraseVerdict::Strong && !hints.iter().any(|h| h.to_lowercase().contains("word")) {
        hints.push("Tip: four unrelated words (e.g. \"correct horse battery staple\") are both strong and memorable.".into());
    }

    PassphraseStrength {
        bits,
        verdict,
        label: verdict_label(verdict).to_string(),
        progress_percent: bits_to_percent(bits),
        hints,
        acceptable_for_submit: bits >= MIN_ENTROPY_BITS,
    }
}

/// Outcome of checking an operation's pre-conditions (passphrase
/// strength + backup-confirmed checkbox). Pure function — no state,
/// no network — so it can be unit-tested directly without spinning
/// up a Tauri `AppState`. The mutating commands below thread their
/// inputs through this gate before doing anything else, so the gate
/// is the single point of enforcement on the Rust side.
#[derive(Debug, PartialEq, Eq)]
enum PolicyGate {
    Ok,
    PassphraseTooWeak { bits_seen: u32 },
    BackupNotConfirmed,
    PassphraseSameAsOld,
}

fn check_enable_policy(passphrase: &str, confirmed_backup: bool) -> PolicyGate {
    let strength = score_passphrase(passphrase);
    if !strength.acceptable_for_submit {
        return PolicyGate::PassphraseTooWeak {
            bits_seen: strength.bits.round() as u32,
        };
    }
    if !confirmed_backup {
        return PolicyGate::BackupNotConfirmed;
    }
    PolicyGate::Ok
}

fn check_rotation_policy(old: &str, new: &str, confirmed_backup: bool) -> PolicyGate {
    let gate = check_enable_policy(new, confirmed_backup);
    if gate != PolicyGate::Ok {
        return gate;
    }
    if old == new {
        return PolicyGate::PassphraseSameAsOld;
    }
    PolicyGate::Ok
}

fn policy_to_err(gate: PolicyGate) -> Option<AppError> {
    match gate {
        PolicyGate::Ok => None,
        PolicyGate::PassphraseTooWeak { bits_seen } => Some(AppError::Validation(format!(
            "Passphrase is too weak: {bits_seen} bits (need ≥ {MIN_ENTROPY_BITS:.0}). Please pick a stronger passphrase.",
        ))),
        PolicyGate::BackupNotConfirmed => Some(AppError::Validation(
            "You must confirm that you have saved your recovery phrase offline before enabling Console access.".into(),
        )),
        PolicyGate::PassphraseSameAsOld => Some(AppError::Validation(
            "New passphrase must differ from the current one.".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Score a passphrase. Called live as the user types (debounced on
/// the frontend). Pure function — no state reads, no network. The
/// `String` argument is wrapped in `Zeroizing` so the heap copy is
/// scrubbed before the stack frame returns; the frontend keeps a
/// `Uint8Array` it can clear when appropriate.
#[tauri::command]
pub fn validate_console_passphrase(passphrase: String) -> PassphraseStrength {
    let passphrase = Zeroizing::new(passphrase);
    score_passphrase(&passphrase)
}

/// Fetch the current Console-access state for the active account.
///
/// `GET /v1/mnemonic-blob` on the configured `hcfs-server`. 200 means
/// enabled; 404 means disabled; any other status is an error. The
/// body is parsed only to extract `updated_at` for display — the
/// ciphertext is discarded here because this path is the "settings
/// page status" check, not an unlock.
#[tauri::command]
pub async fn console_access_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<ConsoleAccessStatus> {
    let ctx = HcfsServerCtx::resolve(&state).await?;
    match get_json::<BlobRecord>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(rec) => Ok(ConsoleAccessStatus {
            enabled: true,
            last_updated_at: rec.updated_at,
            passkey_count: 0, // TODO: wire /v1/passkey/list when the server exposes it.
        }),
        HttpOutcome::NotFound => Ok(ConsoleAccessStatus {
            enabled: false,
            last_updated_at: None,
            passkey_count: 0,
        }),
    }
}

/// Enable Console access for the active account.
///
/// `confirmed_backup` must be `true` — the UI only sets it after the
/// user has ticked the "I saved my recovery phrase offline" checkbox.
/// Rust re-checks here so a tampered frontend can't bypass. The
/// passphrase is zeroized on drop regardless of which branch returns.
#[tauri::command]
pub async fn enable_console_access(
    state: tauri::State<'_, crate::app_state::AppState>,
    passphrase: String,
    confirmed_backup: bool,
) -> Result<()> {
    let passphrase = Zeroizing::new(passphrase);
    if let Some(err) = policy_to_err(check_enable_policy(&passphrase, confirmed_backup)) {
        return Err(err);
    }

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let account_id = ctx.account_id.clone();
    let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(state.inner(), &account_id).await?;
    let blob = seal_mnemonic(&mnemonic, &passphrase, &ctx.ss58).map_err(crypto_to_err)?;

    // Note: `/v1/users/bind` exists on the server for operational
    // observability, but the authorization model resolves SS58 from
    // the bearer token on every request — the binding row is not
    // required on the request path. We skip it here to keep the flow
    // resilient to a missing endpoint in staging. Revisit if the
    // server starts relying on it.

    post_json_discard(&ctx, "/v1/mnemonic-blob", &blob).await?;
    info!("Console access enabled for account {}", short_ss58(&ctx.ss58));
    Ok(())
}

/// Rotate the Console passphrase. Fetches the current blob, decrypts
/// with the old passphrase, re-seals under the new one, and POSTs back.
/// The server upsert replaces the row atomically — no DELETE needed.
#[tauri::command]
pub async fn rotate_console_passphrase(
    state: tauri::State<'_, crate::app_state::AppState>,
    old_passphrase: String,
    new_passphrase: String,
    confirmed_backup: bool,
) -> Result<()> {
    let old_passphrase = Zeroizing::new(old_passphrase);
    let new_passphrase = Zeroizing::new(new_passphrase);
    if let Some(err) = policy_to_err(check_rotation_policy(&old_passphrase, &new_passphrase, confirmed_backup)) {
        return Err(err);
    }

    let ctx = HcfsServerCtx::resolve(&state).await?;
    let current: SealedBlob = match get_json::<SealedBlob>(&ctx, "/v1/mnemonic-blob").await? {
        HttpOutcome::Ok(b) => b,
        HttpOutcome::NotFound => {
            return Err(AppError::Other(
                "Console access isn't enabled on this account — nothing to rotate.".into(),
            ));
        }
    };
    // `rotate_passphrase` calls `open_mnemonic` under the hood; a wrong
    // old-passphrase surfaces as `MnemonicBlobError::AeadTag`.
    let next = rotate_passphrase(&current, &old_passphrase, &new_passphrase, &ctx.ss58).map_err(crypto_to_err)?;
    post_json_discard(&ctx, "/v1/mnemonic-blob", &next).await?;
    info!("Console access passphrase rotated for account {}", short_ss58(&ctx.ss58));
    Ok(())
}

/// Disable Console access — deletes the blob from the server. Does
/// not touch local sync or the desktop's own access.
#[tauri::command]
pub async fn disable_console_access(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<()> {
    let ctx = HcfsServerCtx::resolve(&state).await?;
    delete(&ctx, "/v1/mnemonic-blob").await?;
    info!("Console access disabled for account {}", short_ss58(&ctx.ss58));
    // TODO(console-access): also DELETE /v1/passkey/{id} for each
    // registered passkey once that endpoint is in use, so re-enabling
    // later starts from a clean credential set. Not critical today —
    // the server ignores passkey requirements when no blob exists.
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP helpers — bearer-authenticated JSON against `hcfs-server`.
//
// Small deliberate footprint: these paths don't need the
// `hcfs-client::drive` machinery, just plain JSON over an
// authenticated HTTP call. Reuses `state.api_client` for connection
// pooling and `state.auth` + `get_api_token` for the bearer token.
//
// ## Why not `ApiClient`?
//
// The project already ships `crate::api::client::ApiClient` against
// `api.hippius.com`, but that client uses the legacy
// `Authorization: Token <token>` scheme. `hcfs-server` (per PR #120)
// expects the modern `Authorization: Bearer <token>` scheme — the
// same token value, different header word. Rather than widen
// `ApiClient` with a variant that would risk bleeding the wrong
// scheme into unrelated call sites, we keep these handlers standalone
// with direct `reqwest` calls. Consolidate when `api.hippius.com`
// migrates to Bearer as well.
// ---------------------------------------------------------------------------

/// Ambient context every HTTP helper needs. Resolved once per command.
struct HcfsServerCtx {
    client: reqwest::Client,
    base_url: String,
    bearer: String,
    account_id: String,
    ss58: String,
}

impl HcfsServerCtx {
    async fn resolve(state: &tauri::State<'_, crate::app_state::AppState>) -> Result<Self> {
        let account_id = state.current_account_id().map_err(AppError::Other)?;
        let ss58 = state
            .auth
            .lock()?
            .substrate_address
            .clone()
            .ok_or_else(|| AppError::Other("No active SS58 address — please log in first.".into()))?;
        if ss58 != account_id {
            // Belt-and-braces guard: `current_account_id` and
            // `substrate_address` track the same thing and should never
            // diverge, but if they do we want the loud error not a
            // silently-wrong blob upload. Log the full values for
            // diagnosis; only a short prefix reaches the user so we
            // don't splatter both SS58s across a toast.
            tracing::error!(
                account_id = %account_id,
                active_ss58 = %ss58,
                "Console access: account_id vs active SS58 mismatch — aborting"
            );
            return Err(AppError::Other(format!(
                "Session identity check failed ({} vs {}). Please log out and back in.",
                short_ss58(&account_id),
                short_ss58(&ss58),
            )));
        }

        let pool = state.pool()?;
        let bearer = get_api_token(pool, &account_id)
            .await
            .map_err(AppError::Other)?
            .ok_or_else(|| AppError::Other("No authentication token — please log in again.".into()))?;

        let base_url = resolve_hcfs_base_url(pool, &account_id).await?;
        Ok(Self {
            client: state.api_client.clone(),
            base_url,
            bearer,
            account_id,
            ss58,
        })
    }
}

/// Resolve the hcfs-server URL the desktop is already syncing to.
///
/// Reuses the sync engine's `hcfs_config.server_url` so blob traffic
/// and drive traffic land on the same deployment (public Hippius,
/// self-hosted, staging). Refuses to fall back to the hardcoded
/// public URL — a user who has never configured sync on this account
/// would otherwise upload their sealed blob to `arion.hippius.com`
/// even on a self-hosted deployment, which is a footgun: blob lands
/// on the wrong server, subsequent `disable_console_access` on the
/// right server 404s, and `console_access_status` reports "disabled"
/// while ciphertext sits orphaned on the public host. Surface
/// `NotReady(ConfigMissing)` so the settings UI can prompt the user
/// to set up sync first.
async fn resolve_hcfs_base_url(pool: &sqlx::SqlitePool, account_id: &str) -> Result<String> {
    let config = crate::sync::config::get_hcfs_config_internal(pool, account_id)
        .await
        .map_err(|e| AppError::Other(format!("Could not read sync config: {e}")))?;
    if config.server_url.is_empty() {
        return Err(AppError::NotReady(NotReadyKind::ConfigMissing));
    }
    Ok(config.server_url)
}

enum HttpOutcome<T> {
    Ok(T),
    NotFound,
}

async fn get_json<T: serde::de::DeserializeOwned>(ctx: &HcfsServerCtx, path: &str) -> Result<HttpOutcome<T>> {
    let url = format!("{}{path}", ctx.base_url);
    let resp = ctx
        .client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {}", ctx.bearer))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("HTTP error: {e}")))?;
    match resp.status() {
        StatusCode::OK => {
            let v = resp.json::<T>().await.map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;
            Ok(HttpOutcome::Ok(v))
        }
        StatusCode::NOT_FOUND => Ok(HttpOutcome::NotFound),
        status => Err(http_err(status, resp, path).await),
    }
}

/// POST JSON and discard the response body. Used for upserts where
/// the server returns a trivial `{"status": "ok"}` we don't care
/// about; keeping a typed response parameter here would make every
/// caller choose a throwaway deserialize target, and silently break
/// if the server ever moves to 204 No Content.
async fn post_json_discard<B: Serialize>(ctx: &HcfsServerCtx, path: &str, body: &B) -> Result<()> {
    let url = format!("{}{path}", ctx.base_url);
    let resp = ctx
        .client
        .post(&url)
        .header(AUTHORIZATION, format!("Bearer {}", ctx.bearer))
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("HTTP error: {e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(http_err(resp.status(), resp, path).await)
    }
}

async fn delete(ctx: &HcfsServerCtx, path: &str) -> Result<()> {
    let url = format!("{}{path}", ctx.base_url);
    let resp = ctx
        .client
        .delete(&url)
        .header(AUTHORIZATION, format!("Bearer {}", ctx.bearer))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("HTTP error: {e}")))?;
    if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
        // 404 on delete = already gone = success from the user's POV.
        Ok(())
    } else {
        Err(http_err(resp.status(), resp, path).await)
    }
}

async fn http_err(status: StatusCode, resp: reqwest::Response, path: &str) -> AppError {
    let body = resp.text().await.unwrap_or_default();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return AppError::Validation(
            "You've hit the rate limit for Console access changes. Please wait a few minutes and try again.".into(),
        );
    }
    AppError::Api {
        status: status.as_u16(),
        body: format!("{path}: {body}"),
    }
}

/// Mnemonic-blob `updated_at` lives on the GET response but isn't part
/// of the `SealedBlob` the hcfs-client exports. A tiny local type
/// keeps the parse permissive — unknown fields are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRecord {
    #[serde(default)]
    updated_at: Option<String>,
}

fn short_ss58(ss58: &str) -> String {
    let head: String = ss58.chars().take(8).collect();
    format!("{head}…")
}

fn crypto_to_err(e: hcfs_client::mnemonic_blob::MnemonicBlobError) -> AppError {
    use hcfs_client::mnemonic_blob::MnemonicBlobError as E;
    match &e {
        E::AeadTag => {
            // AeadTag fires on either a wrong passphrase or an SS58
            // mismatch. The SS58-mismatch branch is unreachable from
            // this codebase — we always seal and open with the active
            // session's SS58, and the server serves the row keyed by
            // that same SS58 (resolved from the bearer token). The
            // only way to hit a mismatch is a compromised/buggy
            // server, which is a much worse problem than the error
            // text. Surface "wrong passphrase" to users and log the
            // raw error so an SS58-mismatch incident is still
            // diagnosable from tracing output.
            tracing::warn!(error = %e, "AEAD tag mismatch decrypting Console blob");
            AppError::Validation("Wrong passphrase.".into())
        }
        _ => AppError::Crypto(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passphrase_too_short_is_rejected() {
        let s = score_passphrase("short");
        assert_eq!(s.verdict, PassphraseVerdict::TooShort);
        assert!(!s.acceptable_for_submit);
        assert!(!s.hints.is_empty(), "too-short input must include a hint");
    }

    #[test]
    fn passphrase_weak_common_password_is_rejected() {
        // Common + long but low-entropy — zxcvbn should score low.
        let s = score_passphrase("password1234");
        assert!(!s.acceptable_for_submit, "common passwords must be rejected");
        assert!(s.bits < MIN_ENTROPY_BITS);
    }

    #[test]
    fn passphrase_four_random_words_is_accepted() {
        // "correct horse battery staple" is the canonical xkcd example;
        // zxcvbn dictionaries know it's famous so we pick similar-but-
        // not-identical words here.
        let s = score_passphrase("violet octopus hammer spruce");
        assert_eq!(s.verdict, PassphraseVerdict::Strong);
        assert!(s.acceptable_for_submit, "4 uncommon words must pass");
        assert!(s.bits >= MIN_ENTROPY_BITS);
    }

    #[test]
    fn passphrase_score_is_deterministic() {
        let a = score_passphrase("violet octopus hammer spruce");
        let b = score_passphrase("violet octopus hammer spruce");
        assert!((a.bits - b.bits).abs() < 0.01);
        assert_eq!(a.verdict, b.verdict);
    }

    // ── Policy gate — the actual gates the mutating commands run ──

    #[test]
    fn enable_policy_weak_passphrase_fails_with_bits() {
        match check_enable_policy("short", true) {
            PolicyGate::PassphraseTooWeak { bits_seen } => assert_eq!(bits_seen, 0),
            other => panic!("expected PassphraseTooWeak, got {other:?}"),
        }
    }

    #[test]
    fn enable_policy_backup_unconfirmed_fails_after_strength_passes() {
        // Use a strong passphrase so we know the failure is the
        // checkbox, not the entropy floor. If this assert swaps we'll
        // know the gate order changed.
        assert_eq!(
            check_enable_policy("violet octopus hammer spruce", false),
            PolicyGate::BackupNotConfirmed,
        );
    }

    #[test]
    fn enable_policy_happy_path() {
        assert_eq!(
            check_enable_policy("violet octopus hammer spruce", true),
            PolicyGate::Ok,
        );
    }

    #[test]
    fn rotation_policy_same_passphrase_fails() {
        let strong = "violet octopus hammer spruce";
        assert_eq!(
            check_rotation_policy(strong, strong, true),
            PolicyGate::PassphraseSameAsOld,
        );
    }

    #[test]
    fn rotation_policy_inherits_enable_gates() {
        // New passphrase too weak — same-passphrase check should not
        // fire first. This locks the gate ordering.
        assert!(matches!(
            check_rotation_policy("anything", "short", true),
            PolicyGate::PassphraseTooWeak { .. },
        ));
        // Weakness check happens BEFORE backup check — lock that too.
        assert!(matches!(
            check_rotation_policy("anything", "short", false),
            PolicyGate::PassphraseTooWeak { .. },
        ));
    }

    #[test]
    fn rotation_policy_happy_path() {
        assert_eq!(
            check_rotation_policy("old pass phrase alpha", "violet octopus hammer spruce", true),
            PolicyGate::Ok,
        );
    }

    #[test]
    fn policy_to_err_messages_mention_the_right_rule() {
        // We don't pin exact wording (copy can change) but we do pin
        // that each variant produces a user-facing Validation error
        // so the frontend always gets something renderable.
        for gate in [
            PolicyGate::PassphraseTooWeak { bits_seen: 12 },
            PolicyGate::BackupNotConfirmed,
            PolicyGate::PassphraseSameAsOld,
        ] {
            assert!(matches!(policy_to_err(gate), Some(AppError::Validation(_))));
        }
        assert!(policy_to_err(PolicyGate::Ok).is_none());
    }

    // ── Progress-bar math ──

    #[test]
    fn progress_percent_is_clamped() {
        assert_eq!(bits_to_percent(0.0), 5);
        assert_eq!(bits_to_percent(MIN_ENTROPY_BITS), 100);
        assert_eq!(bits_to_percent(MIN_ENTROPY_BITS * 2.0), 100);
        // Halfway to the threshold should be halfway on the bar.
        let half = bits_to_percent(MIN_ENTROPY_BITS / 2.0);
        assert!((49..=51).contains(&half), "expected ~50%, got {half}");
    }

    // ── short_ss58 ──────────────────────────────────────────────────

    #[test]
    fn short_ss58_truncates_long_address() {
        let full = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let short = short_ss58(full);
        // Format is "first8…" — 8 chars + one ellipsis. No tail, no
        // full address leak in user-facing strings.
        assert_eq!(short, "5GrwvaEF…");
        assert!(
            !short.contains("Cut"),
            "short_ss58 must not echo the tail; callers rely on it for log hygiene"
        );
    }

    #[test]
    fn short_ss58_tolerates_short_input() {
        // Degenerate case — a too-short SS58 shouldn't panic.
        assert_eq!(short_ss58(""), "…");
        assert_eq!(short_ss58("abc"), "abc…");
    }

    // ── resolve_hcfs_base_url ───────────────────────────────────────
    //
    // The branch under test (B1 from the review): a missing or empty
    // `hcfs_config.server_url` must surface as `NotReady(ConfigMissing)`,
    // not silently fall back to the public default. Without this the
    // settings UI could upload a sealed blob to the wrong deployment
    // on a self-hosted / staging setup.

    async fn make_empty_pool_with_hcfs_config() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
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

    #[tokio::test]
    async fn resolve_base_url_rejects_empty_server_url() {
        // No row at all — `get_hcfs_config_internal` returns an empty
        // `HcfsConfigResult`, which must surface as NotReady.
        let pool = make_empty_pool_with_hcfs_config().await;
        let err = resolve_hcfs_base_url(&pool, "5GrwvaEF…").await.expect_err("empty config must fail");
        assert!(
            matches!(err, AppError::NotReady(NotReadyKind::ConfigMissing)),
            "expected NotReady(ConfigMissing), got {err:?}"
        );
    }

    #[tokio::test]
    async fn resolve_base_url_rejects_blank_string_row() {
        // Row exists but `server_url` is empty — same story: don't
        // silently fall back to the public host.
        let pool = make_empty_pool_with_hcfs_config().await;
        let owner = crate::auth::account_key::account_key("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, '', '', 0)")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();
        let err = resolve_hcfs_base_url(&pool, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")
            .await
            .expect_err("blank server_url must fail");
        assert!(matches!(err, AppError::NotReady(NotReadyKind::ConfigMissing)));
    }

    #[tokio::test]
    async fn resolve_base_url_uses_configured_server() {
        let pool = make_empty_pool_with_hcfs_config().await;
        let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let owner = crate::auth::account_key::account_key(account);
        sqlx::query("INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, '', 0)")
            .bind(&owner)
            .bind("https://staging.example.com")
            .execute(&pool)
            .await
            .unwrap();
        let url = resolve_hcfs_base_url(&pool, account).await.expect("ok");
        assert_eq!(url, "https://staging.example.com");
    }

    #[test]
    fn verdict_labels_cover_all_variants() {
        // Guards against adding a new variant and forgetting the
        // label match arm — the exhaustive match in `verdict_label`
        // would stop compiling, and here we assert the strings are
        // non-empty and distinct.
        use std::collections::HashSet;
        let labels: HashSet<&str> = [
            verdict_label(PassphraseVerdict::TooShort),
            verdict_label(PassphraseVerdict::Weak),
            verdict_label(PassphraseVerdict::Ok),
            verdict_label(PassphraseVerdict::Strong),
        ]
        .into_iter()
        .collect();
        assert_eq!(labels.len(), 4, "each verdict needs a unique label");
        assert!(labels.iter().all(|l| !l.is_empty()));
    }
}
