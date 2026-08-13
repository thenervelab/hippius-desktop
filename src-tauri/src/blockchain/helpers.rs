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
use subxt::blocks::ExtrinsicEvents;
use subxt::config::DefaultExtrinsicParamsBuilder;
use subxt::tx::Payload;
use subxt::{OnlineClient, PolkadotConfig};
use subxt_signer::{bip39::Mnemonic as SubxtMnemonic, sr25519::Keypair};

/// Richer sibling of [`TxOutcome`] that retains the finalized [`ExtrinsicEvents`]
/// on the success path. `TxOutcome` is the FE-facing wire type and discards the
/// events; callers that must read event data from a confirmed extrinsic (the
/// bridge, for `withdrawal_id` / `deposit_id`) match on this instead and then
/// project to `TxOutcome` for the FE. Same four states, same retry-safety
/// meaning as `TxOutcome` (see [`submit_tracked`]); only `Finalized` differs.
///
/// `pub(crate)` and deliberately NOT `Serialize` — it is an internal carrier;
/// the events do not cross the IPC boundary.
pub(crate) enum TrackedSubmission {
    /// Pre-broadcast failure — nothing reached the chain. Safe to retry.
    RejectedAtSubmission { reason: String },
    /// Broadcast / finalization-watch error — the extrinsic MAY be in the pool
    /// or already on-chain, so it must NOT be auto-retried (the double-spend the
    /// audit flagged, R-01).
    SubmittedUnconfirmed { tx_hash: String, reason: String },
    /// Finalized and dispatched successfully; carries the block's events.
    Finalized {
        tx_hash: String,
        events: ExtrinsicEvents<PolkadotConfig>,
    },
    /// Finalized but the on-chain dispatch failed (the nonce was consumed). Safe
    /// to retry as a NEW transaction.
    FinalizedFailed { tx_hash: String, reason: String },
}

impl TrackedSubmission {
    /// Project to the FE-facing [`TxOutcome`], dropping the events. Used by
    /// [`sign_submit_track`] and by the bridge for its non-finalized arms.
    pub(crate) fn into_tx_outcome(self) -> TxOutcome {
        match self {
            Self::RejectedAtSubmission { reason } => TxOutcome::RejectedAtSubmission { reason },
            Self::SubmittedUnconfirmed { tx_hash, reason } => TxOutcome::SubmittedUnconfirmed { tx_hash, reason },
            Self::Finalized { tx_hash, .. } => TxOutcome::Finalized { tx_hash },
            Self::FinalizedFailed { tx_hash, reason } => TxOutcome::FinalizedFailed { tx_hash, reason },
        }
    }
}

/// Sign, submit, and track an extrinsic, **retaining the finalized events** on
/// success. This is the core that [`sign_submit_track`] wraps; the bridge calls
/// it directly because it must read `WithdrawalRequestCreated` /
/// `DepositRequestCreated` out of the confirmed block.
///
/// The extrinsic is **mortal** (audit R-12): it carries a bounded era anchored
/// to the latest finalized block, so a signed payload can't be replayed
/// indefinitely. subxt's `_default` path is Immortal, so we build params
/// explicitly — and this is precisely why every funds-moving extrinsic (including
/// the bridge writes) must go through here, never `sign_and_submit_then_watch`.
///
/// Signing and broadcasting are deliberately SEPARATE awaits (`create_signed`
/// then `submit_and_watch`, not the fused `sign_and_submit_then_watch`), because
/// only the first is provably pre-broadcast. Classification:
/// 1. `create_signed` — metadata/nonce fetch + offline signing; no bytes leave
///    the machine, so an error here means nothing reached the chain →
///    `RejectedAtSubmission` (safe to retry).
/// 2. `submit_and_watch` — the `author_submitAndWatchExtrinsic` RPC round-trip.
///    Its `Err` can arrive AFTER the node has the bytes (transport drop mid-RPC
///    with the extrinsic already in the pool), so it is NOT retry-safe →
///    `SubmittedUnconfirmed`.
/// 3. `wait_for_finalized` — an error here means the extrinsic was accepted but
///    we lost the watch before seeing it land → `SubmittedUnconfirmed` (it MAY
///    be on-chain; the FE must not auto-resubmit).
/// 4. `wait_for_success` — runs only once the extrinsic IS in a finalized
///    block; its errors are classified by [`classify_post_finalization`]: only a
///    decoded on-chain dispatch error proves the call failed (`FinalizedFailed`);
///    anything else leaves a finalized extrinsic whose outcome is unproven →
///    `SubmittedUnconfirmed`.
///
/// The extrinsic hash is captured BEFORE broadcast, so it is available on every
/// `SubmittedUnconfirmed` path for the FE / user to reconcile against the chain.
pub(crate) async fn submit_tracked<Call>(client: &OnlineClient<PolkadotConfig>, tx: &Call, signer: &Keypair) -> Result<TrackedSubmission, AppError>
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

    // Build + sign locally. This fetches metadata/nonce but broadcasts
    // nothing, so an error here is provably pre-pool.
    let signed = match client.tx().create_signed(tx, signer, params).await {
        Ok(s) => s,
        Err(e) => return Ok(TrackedSubmission::RejectedAtSubmission { reason: e.to_string() }),
    };

    // Hash of the signed bytes — identical to what the watch handle would
    // report, but available before broadcast so every ambiguous path below
    // can hand it to the FE.
    let tx_hash = format!("{:?}", signed.hash());

    // Broadcast. An Err can arrive after the node already holds the bytes
    // (transport drop mid-RPC), so the extrinsic MAY be in the pool — never
    // classify this as retry-safe.
    let progress = match signed.submit_and_watch().await {
        Ok(p) => p,
        Err(e) => {
            return Ok(TrackedSubmission::SubmittedUnconfirmed {
                tx_hash,
                reason: e.to_string(),
            });
        }
    };

    match progress.wait_for_finalized().await {
        Err(e) => Ok(TrackedSubmission::SubmittedUnconfirmed {
            tx_hash,
            reason: e.to_string(),
        }),
        Ok(in_block) => match in_block.wait_for_success().await {
            Ok(events) => Ok(TrackedSubmission::Finalized { tx_hash, events }),
            Err(e) => Ok(match classify_post_finalization(&e) {
                PostFinalization::Failed => TrackedSubmission::FinalizedFailed {
                    tx_hash,
                    reason: e.to_string(),
                },
                PostFinalization::Unconfirmed => TrackedSubmission::SubmittedUnconfirmed {
                    tx_hash,
                    reason: e.to_string(),
                },
            }),
        },
    }
}

/// Sign, submit, and track an extrinsic to a precise [`TxOutcome`] for the FE.
///
/// Thin wrapper over [`submit_tracked`] that drops the finalized events — the
/// shape transfers/staking return. The mortal-era + four-state classification
/// (and the rationale) live on `submit_tracked`.
pub(crate) async fn sign_submit_track<Call>(client: &OnlineClient<PolkadotConfig>, tx: &Call, signer: &Keypair) -> Result<TxOutcome, AppError>
where
    Call: Payload,
{
    Ok(submit_tracked(client, tx, signer).await?.into_tx_outcome())
}

/// The two post-finalization error classes (the success path carries events and
/// is handled separately). Keeping this distinct from the outcome enums lets the
/// one Runtime-vs-other rule below be shared by both `TxOutcome` and
/// `TrackedSubmission` callers without duplicating it.
enum PostFinalization {
    /// A decoded on-chain dispatch failure (`subxt::Error::Runtime`) — proof the
    /// call took no effect; the nonce was consumed, so a NEW tx is safe.
    Failed,
    /// Anything else (RPC/transport drop, `BlockNotFound`, event/metadata decode
    /// failures — which can even mask a real dispatch failure whose error bytes
    /// failed to decode): the extrinsic IS finalized and MAY have succeeded, so
    /// the outcome is unprovable and must never be auto-retried.
    Unconfirmed,
}

/// Classify a `wait_for_success` error for an already-FINALIZED extrinsic. The
/// wildcard arm is future-proof: `subxt::Error` is `#[non_exhaustive]`, and any
/// variant we don't know about gets the conservative `Unconfirmed`.
fn classify_post_finalization(e: &subxt::Error) -> PostFinalization {
    match e {
        subxt::Error::Runtime(_) => PostFinalization::Failed,
        _ => PostFinalization::Unconfirmed,
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
    /// Static regression guard (audit R-12): `submit_tracked` — the core every
    /// signing path (transfers, staking, AND the bridge writes) goes through —
    /// MUST build a mortal era and submit with explicit params, never the
    /// Immortal `_default` path. A refactor that drops `.mortal(` (or reverts to
    /// `sign_and_submit_then_watch_default`) silently reopens the indefinite-
    /// replay window, so pin it on the core where the logic actually lives.
    #[test]
    fn signing_helper_uses_a_mortal_era() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/blockchain/helpers.rs")).expect("read helpers.rs");
        let sig_idx = src.find("pub(crate) async fn submit_tracked").expect("submit_tracked present");
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
        assert!(body.contains(".mortal("), "submit_tracked must build a mortal era (R-12)");
        assert!(
            !body.contains("sign_and_submit_then_watch_default"),
            "submit_tracked must NOT use the Immortal `_default` path (R-12)",
        );
    }

    /// Static regression guard (review F1): signing and broadcasting MUST be
    /// separate awaits. The fused `sign_and_submit_then_watch` collapses the
    /// pre-broadcast `create_signed` errors and the post-broadcast
    /// `submit_and_watch` errors into one `Err`, which forces a single
    /// classification — and classifying a broadcast-phase transport drop as
    /// `RejectedAtSubmission` ("safe to retry") reopens the R-01 double-spend:
    /// the bytes may already be in the node's pool.
    #[test]
    fn signing_helper_splits_sign_from_broadcast() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/blockchain/helpers.rs")).expect("read helpers.rs");
        let sig_idx = src.find("pub(crate) async fn submit_tracked").expect("submit_tracked present");
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
            body.contains("create_signed("),
            "must sign via create_signed (pre-broadcast errors → RejectedAtSubmission)"
        );
        assert!(
            body.contains("submit_and_watch()"),
            "must broadcast via submit_and_watch (its errors → SubmittedUnconfirmed)"
        );
        assert!(
            !body.contains("sign_and_submit_then_watch"),
            "must NOT use the fused sign_and_submit_then_watch — it conflates pre- and post-broadcast errors (R-01)",
        );
        assert!(
            body.contains("classify_post_finalization("),
            "wait_for_success errors must go through classify_post_finalization (only Runtime proves dispatch failure)",
        );
    }

    /// A decoded on-chain dispatch error is the ONLY proof that a finalized
    /// extrinsic's call failed — that and only that classifies as `Failed`
    /// (which both outcome enums surface as the retryable `FinalizedFailed`).
    #[test]
    fn runtime_error_after_finalization_is_failed() {
        let e = subxt::Error::Runtime(subxt::error::DispatchError::Other);
        assert!(
            matches!(super::classify_post_finalization(&e), super::PostFinalization::Failed),
            "Runtime error must classify as Failed",
        );
    }

    /// Transport drops, missing blocks, and decode failures after finalization
    /// do NOT disprove success — they classify as `Unconfirmed` (the no-retry
    /// `SubmittedUnconfirmed` for both outcome enums).
    #[test]
    fn non_runtime_errors_after_finalization_are_unconfirmed() {
        let errors: Vec<subxt::Error> = vec![
            subxt::Error::Other("websocket connection closed".into()),
            subxt::Error::Transaction(subxt::error::TransactionError::BlockNotFound),
            subxt::Error::Io(std::io::Error::other("connection reset")),
        ];
        for e in errors {
            assert!(
                matches!(super::classify_post_finalization(&e), super::PostFinalization::Unconfirmed),
                "{e:?} must classify as Unconfirmed",
            );
        }
    }

    /// `TrackedSubmission::into_tx_outcome` projects each non-success state to the
    /// matching `TxOutcome` variant, preserving tx_hash/reason (the `Finalized`
    /// arm needs real `ExtrinsicEvents` so it is exercised by the testnet smoke
    /// test, not here). Pins that the bridge↔transfers outcome mapping can't drift.
    #[test]
    fn tracked_submission_projects_to_tx_outcome() {
        use super::{TrackedSubmission, TxOutcome};
        assert!(matches!(
            TrackedSubmission::RejectedAtSubmission { reason: "r".into() }.into_tx_outcome(),
            TxOutcome::RejectedAtSubmission { reason } if reason == "r"
        ));
        assert!(matches!(
            TrackedSubmission::SubmittedUnconfirmed { tx_hash: "0x1".into(), reason: "r".into() }.into_tx_outcome(),
            TxOutcome::SubmittedUnconfirmed { tx_hash, reason } if tx_hash == "0x1" && reason == "r"
        ));
        assert!(matches!(
            TrackedSubmission::FinalizedFailed { tx_hash: "0x2".into(), reason: "r".into() }.into_tx_outcome(),
            TxOutcome::FinalizedFailed { tx_hash, reason } if tx_hash == "0x2" && reason == "r"
        ));
    }
}
