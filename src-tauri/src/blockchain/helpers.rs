//! Signer + address helpers for blockchain-facing IPCs.
//!
//! As of Step 6 of the local-wallet port these read from the
//! `local_wallets` table (active row) instead of the legacy
//! `AppState.auth` session keypair. The session path is intentionally
//! gone: every on-chain transaction is now signed by the active local
//! wallet's sr25519 keypair, derived on demand from its
//! password-encrypted BIP-39 mnemonic.
//!
//! Read-only callers (querying balance, staking state, etc.) use
//! [`get_substrate_address`] — no password required, since address
//! derivation only needs the row from `local_wallets`.
//!
//! Signing callers use [`get_signer_and_address`] (or the address-less
//! [`get_signer`]) and pass the user's password. Wrong password is
//! surfaced as `NotReady(SigningKeyUnavailable)` so the frontend's
//! existing NotReady-shaped error handling continues to work; the
//! distinct "no local wallet at all" case maps to the same variant so
//! callers can recover the same way (prompt the user to create or
//! unlock a wallet).

use crate::auth::account_key::account_key;
use crate::blockchain::types::TxOutcome;
use crate::error::{AppError, NotReadyKind};
use crate::wallet::{crypto, repo};
use subxt::tx::Payload;
use subxt::config::DefaultExtrinsicParamsBuilder;
use subxt::{OnlineClient, PolkadotConfig};
use subxt_signer::{bip39::Mnemonic as SubxtMnemonic, sr25519::Keypair};

/// Sign, submit, and track an extrinsic to a precise [`TxOutcome`].
///
/// The extrinsic is **mortal** (audit R-12): it carries a bounded era anchored
/// to the latest finalized block, so a signed payload can't be replayed
/// indefinitely. subxt's `_default` path is Immortal, so we build params
/// explicitly and use `sign_and_submit_then_watch`.
///
/// The two awaits are deliberately kept distinct (see [`TxOutcome`] for why):
/// 1. `sign_and_submit_then_watch` — any error here is pre-pool (anchor/nonce
///    fetch, signing, or a rejected submission), so nothing reached the chain →
///    `RejectedAtSubmission` (safe to retry).
/// 2. `wait_for_finalized` — an error here means the extrinsic was accepted but
///    we lost the watch before seeing it land → `SubmittedUnconfirmed` (it MAY
///    be on-chain; the FE must not auto-resubmit). On success we further split
///    dispatch-success (`Finalized`) from a landed-but-failed dispatch
///    (`FinalizedFailed`).
///
/// The extrinsic hash is captured from the progress handle BEFORE the watch is
/// consumed, so it is available even on the `SubmittedUnconfirmed` path for the
/// FE / user to reconcile against the chain.
///
/// Returns `Err` only for the impossible-to-have-submitted cases handled by the
/// caller earlier; every post-submission state is an `Ok(TxOutcome)` so the FE
/// branches on one typed value instead of guessing from an error string.
pub(crate) async fn sign_submit_track<Call>(client: &OnlineClient<PolkadotConfig>, tx: &Call, signer: &Keypair) -> Result<TxOutcome, AppError>
where
    Call: Payload,
{
    // Mortal era: bound how long a signed extrinsic stays valid so it can't be
    // replayed indefinitely — e.g. after the account is reaped and later
    // re-funded, which resets the nonce. 64 blocks (~6 min at 6s) is the
    // polkadot-js default: ample for inclusion (sign→submit→include is normally
    // seconds) yet a tight replay bound, and small enough to stay within any
    // reasonable on-chain `BlockHashCount`. Anchored to the latest FINALIZED
    // block so the checkpoint can't reorg out from under the extrinsic.
    const MORTAL_PERIOD_BLOCKS: u64 = 64;
    let anchor = client
        .blocks()
        .at_latest()
        .await
        .map_err(|e| AppError::Substrate(format!("Failed to fetch anchor block for mortal era: {e}")))?;
    let params = DefaultExtrinsicParamsBuilder::<PolkadotConfig>::new()
        .mortal(anchor.header(), MORTAL_PERIOD_BLOCKS)
        .build();

    let progress = match client.tx().sign_and_submit_then_watch(tx, signer, params).await {
        Ok(p) => p,
        Err(e) => return Ok(TxOutcome::RejectedAtSubmission { reason: e.to_string() }),
    };

    // Capture the hash now — `wait_for_finalized` consumes `progress`.
    let tx_hash = format!("{:?}", progress.extrinsic_hash());

    match progress.wait_for_finalized().await {
        Err(e) => Ok(TxOutcome::SubmittedUnconfirmed { tx_hash, reason: e.to_string() }),
        Ok(in_block) => match in_block.wait_for_success().await {
            Ok(_events) => Ok(TxOutcome::Finalized { tx_hash }),
            Err(e) => Ok(TxOutcome::FinalizedFailed { tx_hash, reason: e.to_string() }),
        },
    }
}

/// Resolve the current account's owner key, returning the unified
/// `NotReady(SigningKeyUnavailable)` when nobody is logged in. The FE
/// already drops the user into the onboarding flow on that variant, so
/// "no session" and "no active wallet" share a recovery path.
fn require_owner(app_state: &crate::app_state::AppState) -> Result<String, AppError> {
    let account_id = app_state
        .current_account_id()
        .map_err(|_| AppError::NotReady(NotReadyKind::SigningKeyUnavailable))?;
    Ok(account_key(&account_id))
}

/// Read the active local wallet's SS58 address. Used by every
/// blockchain query (`get_account_balance`, `get_staking_info`,
/// `validate_send_balance`, …) so that those queries reflect whichever
/// wallet the user has selected in the active-wallet selector, not the
/// auth session.
///
/// Returns `NotReady(SigningKeyUnavailable)` if no local wallet has
/// been created yet. The FE drops the user into the onboarding flow on
/// that error.
pub(crate) async fn get_substrate_address(app_state: &crate::app_state::AppState) -> Result<String, AppError> {
    let owner = require_owner(app_state)?;
    let pool = app_state.pool()?;
    let active = repo::get_active(pool, &owner).await?;
    match active {
        Some(w) => Ok(w.address),
        None => Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable)),
    }
}

/// Derive the active local wallet's signing keypair from `password`.
///
/// 1. Look up the active wallet row.
/// 2. Verify the supplied password against the stored hash (Argon2id
///    PHC or the legacy hex-SHA256 — both formats are accepted by
///    `crypto::verify_password`). Bail early on mismatch so the AEAD
///    decrypt isn't attempted with the wrong key.
/// 3. ChaCha20-Poly1305-decrypt the mnemonic. The KDF used depends on
///    the ciphertext version byte: Argon2id for new rows, HKDF for
///    legacy rows. Successful legacy decrypt + verify triggers an
///    in-place upgrade of the row so subsequent signs use the new KDF.
/// 4. Parse the mnemonic and derive an sr25519 keypair via
///    `subxt_signer`.
///
/// Wrong-password and no-wallet cases both map to
/// `NotReady(SigningKeyUnavailable)` for FE error unification.
pub(crate) async fn get_signer_and_address(app_state: &crate::app_state::AppState, password: &str) -> Result<(Keypair, String), AppError> {
    let owner = require_owner(app_state)?;
    let pool = app_state.pool()?;
    let active = repo::get_active(pool, &owner)
        .await?
        .ok_or(AppError::NotReady(NotReadyKind::SigningKeyUnavailable))?;

    // Serialize attempts on this wallet so a concurrent IPC burst can't all
    // clear `check` before any `record_failure` runs and thereby outrun the
    // lockout threshold. Held to fn end — covers check → verify → record.
    // Every on-chain signing IPC funnels through here, so this is the path an
    // attacker would actually script.
    let _attempt_gate = app_state.wallet_rate_limit.attempt_gate(active.id).await;
    // Rate limiter before the verifier — see commands.rs for the
    // reasoning. Lockouts surface as the same generic error variant a
    // wrong password produces, so a script can't distinguish them.
    if app_state.wallet_rate_limit.check(active.id).is_err() {
        return Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable));
    }
    // Password verifier check next — gives a clean wrong-password
    // error rather than the indistinguishable AEAD-tag-failed message.
    if !crypto::verify_password(&active.password_hash, password, &active.address) {
        app_state.wallet_rate_limit.record_failure(active.id);
        return Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable));
    }
    app_state.wallet_rate_limit.record_success(active.id);

    let (mnemonic, ciphertext_was_legacy) = crypto::decrypt_mnemonic(&active.encrypted_mnemonic, password, &active.address)?;

    // Transparent migration: if either the ciphertext or the password
    // hash is in the legacy format, re-encrypt + re-hash and persist.
    // We do this on every signing path (Send / Stake / Unstake /
    // Withdraw / Bridge) so a user who already had a wallet under the
    // old KDF doesn't have to do anything to get the upgrade — the
    // first sign they attempt does it. A migration failure must NOT
    // block the sign: we log and move on.
    let needs_migration = ciphertext_was_legacy || crypto::password_hash_is_legacy(&active.password_hash);
    if needs_migration {
        migrate_to_argon2(app_state, &owner, &active, &mnemonic, password).await;
    }

    let parsed = SubxtMnemonic::parse_normalized(mnemonic.as_str())
        .map_err(|e| AppError::Crypto(format!("Active local wallet stored an unparseable mnemonic: {e}")))?;
    let keypair = Keypair::from_phrase(&parsed, None).map_err(|e| AppError::Crypto(format!("Failed to derive sr25519 keypair: {e}")))?;

    Ok((keypair, active.address))
}

/// Convenience wrapper over [`get_signer_and_address`] when the caller
/// only needs the keypair (e.g. `stake_unbond` reads the address from
/// chain state via the bonded account, not the local wallet).
pub(crate) async fn get_signer(app_state: &crate::app_state::AppState, password: &str) -> Result<Keypair, AppError> {
    let (signer, _addr) = get_signer_and_address(app_state, password).await?;
    Ok(signer)
}

/// Re-encrypt + re-hash a legacy wallet row under the new (Argon2id)
/// scheme and persist. Called from the signing-flow migration path —
/// failures are logged and swallowed so the user's signing operation
/// can still complete on the in-memory mnemonic we already decrypted.
async fn migrate_to_argon2(
    app_state: &crate::app_state::AppState,
    owner: &str,
    active: &repo::LocalWallet,
    mnemonic: &zeroize::Zeroizing<String>,
    password: &str,
) {
    let Ok(new_ct) = crypto::encrypt_mnemonic(mnemonic.as_str(), password, &active.address) else {
        tracing::warn!(
            wallet = %active.address,
            "Argon2id re-encrypt failed during signing flow migration"
        );
        return;
    };
    let new_hash = crypto::password_hash(password, &active.address);
    let Ok(pool) = app_state.pool() else {
        return;
    };
    match repo::update_secrets(pool, owner, active.id, &new_ct, &new_hash).await {
        Ok(()) => tracing::info!(
            wallet = %active.address,
            "Migrated wallet secrets to Argon2id during signing flow"
        ),
        Err(e) => tracing::warn!(
            wallet = %active.address,
            error = %e,
            "Failed to persist Argon2id-migrated wallet secrets"
        ),
    }
}

#[cfg(test)]
mod tests {
    /// Static regression guard (audit R-12): `sign_submit_track` MUST build a
    /// mortal era and submit with explicit params — never fall back to subxt's
    /// `_default` path, which is Immortal. A refactor that drops `.mortal(` (or
    /// reverts to `sign_and_submit_then_watch_default`) silently reopens the
    /// indefinite-replay window, so pin it here.
    #[test]
    fn signing_helper_uses_a_mortal_era() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/blockchain/helpers.rs")).expect("read helpers.rs");
        let sig_idx = src.find("pub(crate) async fn sign_submit_track").expect("sign_submit_track present");
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
        assert!(body.contains(".mortal("), "sign_submit_track must build a mortal era (R-12)");
        assert!(
            !body.contains("sign_and_submit_then_watch_default"),
            "sign_submit_track must NOT use the Immortal `_default` path (R-12)",
        );
    }
}
