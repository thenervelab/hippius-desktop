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

use crate::error::{AppError, NotReadyKind};
use crate::wallet::{crypto, repo};
use subxt_signer::{
    bip39::Mnemonic as SubxtMnemonic,
    sr25519::Keypair,
};

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
    let pool = app_state.pool()?;
    let active = repo::get_active(pool).await?;
    match active {
        Some(w) => Ok(w.address),
        None => Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable)),
    }
}

/// Derive the active local wallet's signing keypair from `password`.
///
/// 1. Look up the active wallet row.
/// 2. Verify the supplied password via the stored SHA-256 hash; bail
///    early on mismatch so AEAD decrypt isn't even attempted with the
///    wrong key.
/// 3. ChaCha20-Poly1305-decrypt the mnemonic with HKDF(password,
///    address).
/// 4. Parse the mnemonic and derive an sr25519 keypair via
///    `subxt_signer`.
///
/// Wrong-password and no-wallet cases both map to
/// `NotReady(SigningKeyUnavailable)` for FE error unification.
pub(crate) async fn get_signer_and_address(
    app_state: &crate::app_state::AppState,
    password: &str,
) -> Result<(Keypair, String), AppError> {
    let pool = app_state.pool()?;
    let active = repo::get_active(pool).await?.ok_or(AppError::NotReady(NotReadyKind::SigningKeyUnavailable))?;

    // Cheap hash check first — gives a clear wrong-password error rather
    // than the indistinguishable AEAD-tag-failed message.
    let expected = crypto::password_hash(password, &active.address);
    if !constant_time_eq(expected.as_bytes(), active.password_hash.as_bytes()) {
        return Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable));
    }

    let mnemonic = crypto::decrypt_mnemonic(&active.encrypted_mnemonic, password, &active.address)?;
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

/// Constant-time equality for the SHA-256 hex hash check. Both sides
/// are fixed-length so the timing channel is small in practice; using
/// constant-time eq makes it explicit.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
