//! Internal helpers shared across blockchain submodules.

use subxt::tx::PairSigner;

/// Build a `PairSigner` from the sr25519 keypair in `AppState.auth`.
pub(crate) fn get_signer(
    app_state: &crate::app_state::AppState,
) -> Result<PairSigner<subxt::PolkadotConfig, sp_core::sr25519::Pair>, crate::error::AppError> {
    let auth = app_state
        .auth
        .lock()
        .map_err(|e| crate::error::AppError::Other(format!("Lock error: {e}")))?;
    let pair = auth
        .sr25519_pair
        .clone()
        .ok_or(crate::error::AppError::Other("Not authenticated — please log in first".into()))?;
    Ok(PairSigner::new(pair))
}

/// Read the SS58 address from the in-memory auth state.
pub(crate) fn get_substrate_address(app_state: &crate::app_state::AppState) -> Result<String, crate::error::AppError> {
    let auth = app_state
        .auth
        .lock()
        .map_err(|e| crate::error::AppError::Other(format!("Lock error: {e}")))?;
    auth.substrate_address
        .clone()
        .ok_or(crate::error::AppError::Auth("Not authenticated — please log in first".into()))
}

/// Get both the transaction signer and substrate address in a single lock acquisition.
///
/// Prefer this over separate [`get_signer`] + [`get_substrate_address`] calls
/// when both values are needed, to avoid acquiring the auth mutex twice.
pub(crate) fn get_signer_and_address(
    app_state: &crate::app_state::AppState,
) -> Result<(PairSigner<subxt::PolkadotConfig, sp_core::sr25519::Pair>, String), crate::error::AppError> {
    let auth = app_state
        .auth
        .lock()
        .map_err(|e| crate::error::AppError::Other(format!("Lock error: {e}")))?;
    let pair = auth
        .sr25519_pair
        .clone()
        .ok_or(crate::error::AppError::Other("Not authenticated — please log in first".into()))?;
    let address = auth
        .substrate_address
        .clone()
        .ok_or(crate::error::AppError::Auth("Not authenticated — please log in first".into()))?;
    Ok((PairSigner::new(pair), address))
}
