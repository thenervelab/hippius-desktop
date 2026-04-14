//! Shared helpers for hcfs-server HTTP calls and recovery-password
//! strength scoring.
//!
//! This module used to own the "Console Access" feature (optional
//! encrypted mnemonic blob for browser decryption). That feature was
//! folded into always-on OAuth account recovery — see
//! `docs/plans/2026-04-14-oauth-account-recovery.md`. The shared
//! plumbing stays here: the HTTP helpers that talk to `hcfs-server`
//! and the passphrase scoring used by the recovery dialog's strength
//! meter. The legacy `enable_console_access` / `disable_console_access`
//! / `console_access_status` / `rotate_console_passphrase` commands
//! are gone; their single caller (the Settings tab) was deleted at
//! the same time.
//!
//! The file name is legacy. A follow-up PR can rename it to
//! `hcfs_support.rs` or split it into `recovery/http.rs` +
//! `recovery/passphrase.rs`; not doing it now to keep this diff
//! focused on command removal.

use reqwest::StatusCode;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use tracing::warn;
use zeroize::Zeroizing;

use crate::auth::tokens::get_api_token;
use crate::error::{AppError, NotReadyKind, Result};

// ---------------------------------------------------------------------------
// Passphrase strength types (consumed by the recovery dialog's meter)
// ---------------------------------------------------------------------------

/// Strength verdict bucket used by the UI progress meter. Thresholds
/// (weak < 40 bits, ok < 50, strong ≥ 50) are set here so the UI never
/// has to know the rule. `snake_case` JSON so the TS discriminant
/// matches — `TooShort` → `"too_short"`.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PassphraseVerdict {
    TooShort,
    Weak,
    Ok,
    Strong,
}

/// Result of [`validate_recovery_password`]. The UI renders `label`,
/// `progress_percent`, and `hints` verbatim and gates the submit button
/// on `acceptable_for_submit`. Every string and threshold originates
/// here — the frontend has zero decisions to make about passphrase policy.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseStrength {
    pub bits: f64,
    pub verdict: PassphraseVerdict,
    pub label: String,
    pub progress_percent: u8,
    pub hints: Vec<String>,
    pub acceptable_for_submit: bool,
}

/// Minimum entropy the desktop will accept for a recovery password.
///
/// Higher than a typical "strong password" heuristic because the sealed
/// blob sits on the server indefinitely — an attacker with a DB exfil
/// has unlimited offline time against Argon2id. 50 bits plus Argon2id
/// (m=128 MiB, t=3) puts single-attempt cost at ~1.5 s on baseline
/// hardware, so a 50-bit space under that KDF is ≈ 2^50 × 1.5 s ≈
/// 53 million years on a single core.
const MIN_ENTROPY_BITS: f64 = 50.0;

/// Below this length we bail before running zxcvbn — short strings
/// score noisily and users need a clear "add words" hint anyway.
const MIN_PASSPHRASE_LEN: usize = 10;

fn verdict_label(verdict: PassphraseVerdict) -> &'static str {
    match verdict {
        PassphraseVerdict::TooShort => "Too short",
        PassphraseVerdict::Weak => "Weak",
        PassphraseVerdict::Ok => "OK",
        PassphraseVerdict::Strong => "Strong",
    }
}

fn bits_to_percent(bits: f64) -> u8 {
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

/// Score a recovery password. Called live as the user types (debounced
/// on the frontend). Pure function — no state reads, no network. The
/// `String` argument is wrapped in `Zeroizing` so the heap copy is
/// scrubbed before the stack frame returns.
#[tauri::command]
pub fn validate_recovery_password(passphrase: String) -> PassphraseStrength {
    let passphrase = Zeroizing::new(passphrase);
    score_passphrase(&passphrase)
}

// ---------------------------------------------------------------------------
// HTTP plumbing for hcfs-server (bearer-authenticated JSON)
//
// Kept as direct `reqwest` calls rather than widening `ApiClient`
// because `hcfs-server` expects `Authorization: Bearer <token>` while
// the legacy `api.hippius.com` client uses `Authorization: Token <token>`.
// Consolidate when that host migrates to Bearer.
// ---------------------------------------------------------------------------

/// Ambient context every HTTP helper needs. Resolved once per command.
pub(crate) struct HcfsServerCtx {
    pub(crate) client: reqwest::Client,
    pub(crate) base_url: String,
    pub(crate) bearer: String,
    pub(crate) ss58: String,
}

impl HcfsServerCtx {
    pub(crate) async fn resolve(state: &tauri::State<'_, crate::app_state::AppState>) -> Result<Self> {
        let account_id = state.current_account_id().map_err(AppError::Other)?;
        let ss58 = state
            .auth
            .lock()?
            .substrate_address
            .clone()
            .ok_or_else(|| AppError::Other("No active SS58 address — please log in first.".into()))?;
        if ss58 != account_id {
            // account_id and substrate_address track the same thing and
            // should never diverge. If they do, we want a loud error
            // rather than a silently-wrong blob fetch. Log the full
            // values; surface only prefixes to the user.
            tracing::error!(
                account_id = %account_id,
                active_ss58 = %ss58,
                "Recovery: account_id vs active SS58 mismatch — aborting"
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
            ss58,
        })
    }
}

/// Resolve the hcfs-server URL the desktop uses for blob traffic.
///
/// Reads `hcfs_config.server_url`. Refuses to fall back to a hardcoded
/// default here — a user who has never configured sync on this account
/// would otherwise upload their sealed blob to the public host even on
/// a self-hosted deployment, leaving orphaned ciphertext on the wrong
/// server. Recovery flows seed the default URL explicitly via
/// `recovery::seed_hcfs_server_url_if_missing` before calling this.
async fn resolve_hcfs_base_url(pool: &sqlx::SqlitePool, account_id: &str) -> Result<String> {
    let config = crate::sync::config::get_hcfs_config_internal(pool, account_id)
        .await
        .map_err(|e| AppError::Other(format!("Could not read sync config: {e}")))?;
    if config.server_url.is_empty() {
        return Err(AppError::NotReady(NotReadyKind::ConfigMissing));
    }
    Ok(config.server_url)
}

pub(crate) enum HttpOutcome<T> {
    Ok(T),
    NotFound,
}

pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(ctx: &HcfsServerCtx, path: &str) -> Result<HttpOutcome<T>> {
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

/// POST JSON and discard the response body. Used for upserts where the
/// server returns a trivial `{"status": "ok"}` we don't care about.
pub(crate) async fn post_json_discard<B: Serialize>(ctx: &HcfsServerCtx, path: &str, body: &B) -> Result<()> {
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

async fn http_err(status: StatusCode, resp: reqwest::Response, path: &str) -> AppError {
    let body = resp.text().await.unwrap_or_default();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return AppError::Validation(
            "You've hit the rate limit for recovery operations. Please wait a few minutes and try again.".into(),
        );
    }
    AppError::Api {
        status: status.as_u16(),
        body: format!("{path}: {body}"),
    }
}

/// Truncate an SS58 address (or anything resembling one) to its first 8
/// characters plus an ellipsis, for log hygiene and short UI fragments.
pub(crate) fn short_ss58(ss58: &str) -> String {
    let head: String = ss58.chars().take(8).collect();
    format!("{head}…")
}

pub(crate) fn crypto_to_err(e: hcfs_client::mnemonic_blob::MnemonicBlobError) -> AppError {
    use hcfs_client::mnemonic_blob::MnemonicBlobError as E;
    match &e {
        E::AeadTag => {
            // AeadTag fires on either a wrong passphrase or an SS58
            // mismatch. SS58 mismatch is unreachable in normal flows —
            // we always seal/open against the active session's SS58 and
            // the server serves rows keyed by the bearer-resolved SS58.
            // Surface "wrong passphrase" to users; log the raw error so
            // an SS58 mismatch is diagnosable from tracing.
            warn!(error = %e, "AEAD tag mismatch decrypting recovery blob");
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

    // ── Passphrase scoring ─────────────────────────────────────────────

    #[test]
    fn passphrase_too_short_is_rejected() {
        let s = score_passphrase("short");
        assert_eq!(s.verdict, PassphraseVerdict::TooShort);
        assert!(!s.acceptable_for_submit);
        assert!(!s.hints.is_empty(), "too-short input must include a hint");
    }

    #[test]
    fn passphrase_weak_common_password_is_rejected() {
        let s = score_passphrase("password1234");
        assert!(!s.acceptable_for_submit, "common passwords must be rejected");
        assert!(s.bits < MIN_ENTROPY_BITS);
    }

    #[test]
    fn passphrase_four_random_words_is_accepted() {
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

    // ── Progress bar math ──────────────────────────────────────────────

    #[test]
    fn progress_percent_is_clamped() {
        assert_eq!(bits_to_percent(0.0), 5);
        assert_eq!(bits_to_percent(MIN_ENTROPY_BITS), 100);
        assert_eq!(bits_to_percent(MIN_ENTROPY_BITS * 2.0), 100);
        let half = bits_to_percent(MIN_ENTROPY_BITS / 2.0);
        assert!((49..=51).contains(&half), "expected ~50%, got {half}");
    }

    #[test]
    fn verdict_labels_cover_all_variants() {
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

    // ── short_ss58 ─────────────────────────────────────────────────────

    #[test]
    fn short_ss58_truncates_long_address() {
        let full = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let short = short_ss58(full);
        assert_eq!(short, "5GrwvaEF…");
        assert!(
            !short.contains("Cut"),
            "short_ss58 must not echo the tail; callers rely on it for log hygiene"
        );
    }

    #[test]
    fn short_ss58_tolerates_short_input() {
        assert_eq!(short_ss58(""), "…");
        assert_eq!(short_ss58("abc"), "abc…");
    }

    // ── resolve_hcfs_base_url ──────────────────────────────────────────

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
        let pool = make_empty_pool_with_hcfs_config().await;
        let err = resolve_hcfs_base_url(&pool, "5GrwvaEF…").await.expect_err("empty config must fail");
        assert!(
            matches!(err, AppError::NotReady(NotReadyKind::ConfigMissing)),
            "expected NotReady(ConfigMissing), got {err:?}"
        );
    }

    #[tokio::test]
    async fn resolve_base_url_rejects_blank_string_row() {
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
}
