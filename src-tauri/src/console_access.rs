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
//! ## Scaffold status
//!
//! The Tauri command shells, types, and passphrase entropy scoring
//! live here. Seal / upload / rotate are stubbed with
//! `AppError::NotReady(...)` pending the `hcfs-client::mnemonic_blob`
//! module that the hcfs team is landing in parallel. Once the
//! `hcfs-client` git rev is bumped in `Cargo.toml`, the command
//! bodies wire the real calls in — see the `TODO(console-access):`
//! markers below.
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
//!   returns `Err(ConfirmationRequired)` if false).
//! - "Is Console access currently enabled?" → Rust
//!   (`console_access_status`).
//! - SS58 resolution, seal, upload, rotate → Rust.

use serde::Serialize;
use zeroize::Zeroizing;

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
#[tauri::command]
pub async fn console_access_status(
    _state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<ConsoleAccessStatus> {
    // TODO(console-access): after the hcfs-client rev lands and the
    // server endpoints ship, this should:
    //   1. Resolve the active SS58 from state.auth.
    //   2. GET /v1/mnemonic-blob with sr25519 sig; 404 → disabled.
    //   3. Read updated_at + optional GET /v1/passkey/list for count.
    // Until then: report "disabled" so the settings page renders the
    // onboarding section and nothing points at phantom state.
    Ok(ConsoleAccessStatus {
        enabled: false,
        last_updated_at: None,
        passkey_count: 0,
    })
}

/// Enable Console access for the active account.
///
/// `confirmed_backup` must be `true` — the UI only sets it after the
/// user has ticked the "I saved my recovery phrase offline" checkbox.
/// Rust re-checks here so a tampered frontend can't bypass. The
/// passphrase is zeroized on drop regardless of which branch returns.
#[tauri::command]
pub async fn enable_console_access(
    _state: tauri::State<'_, crate::app_state::AppState>,
    passphrase: String,
    confirmed_backup: bool,
) -> Result<()> {
    let passphrase = Zeroizing::new(passphrase);
    if let Some(err) = policy_to_err(check_enable_policy(&passphrase, confirmed_backup)) {
        return Err(err);
    }

    // TODO(console-access): after the hcfs-client rev lands:
    //   1. let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(&state, &account_id).await?;
    //   2. let ss58 = state.auth.lock()?.substrate_address.clone().ok_or(...)?;
    //   3. let blob = hcfs_client::mnemonic_blob::seal_mnemonic(&mnemonic, &passphrase, &ss58)?;
    //   4. For OAuth users: POST /v1/users/bind { oauth_sub, ss58 } (idempotent).
    //   5. POST /v1/mnemonic-blob { blob } (sr25519-signed).
    //
    // Passphrase and any derived material are already wrapped in
    // `Zeroizing` so they scrub on return.
    Err(AppError::NotReady(NotReadyKind::ConfigMissing))
}

/// Rotate the Console passphrase. Requires the current passphrase to
/// unlock the existing blob, plus a new passphrase to reseal under.
#[tauri::command]
pub async fn rotate_console_passphrase(
    _state: tauri::State<'_, crate::app_state::AppState>,
    old_passphrase: String,
    new_passphrase: String,
    confirmed_backup: bool,
) -> Result<()> {
    let old_passphrase = Zeroizing::new(old_passphrase);
    let new_passphrase = Zeroizing::new(new_passphrase);
    if let Some(err) = policy_to_err(check_rotation_policy(&old_passphrase, &new_passphrase, confirmed_backup)) {
        return Err(err);
    }

    // TODO(console-access): after the hcfs-client rev lands:
    //   1. GET /v1/mnemonic-blob → current sealed blob.
    //   2. let new = hcfs_client::mnemonic_blob::rotate_passphrase(&blob, &old, &new, &ss58)?;
    //   3. POST /v1/mnemonic-blob { new } (upsert).
    //      Server replaces the row atomically — no DELETE needed.
    Err(AppError::NotReady(NotReadyKind::ConfigMissing))
}

/// Disable Console access — delete the blob from the server. Does
/// not affect local sync or desktop access.
#[tauri::command]
pub async fn disable_console_access(
    _state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<()> {
    // TODO(console-access): DELETE /v1/mnemonic-blob (sr25519-signed).
    // Also revoke all passkeys registered against the account so the
    // user starts clean if they re-enable later.
    Err(AppError::NotReady(NotReadyKind::ConfigMissing))
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
