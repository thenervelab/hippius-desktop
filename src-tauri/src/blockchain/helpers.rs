//! Internal helpers shared across blockchain submodules.
//!
//! Transaction signers are `subxt_signer::sr25519::Keypair` values cloned
//! out of `AppState.auth`. That type implements subxt's `Signer` trait
//! directly, so there is no `PairSigner` wrapper and no `sp-core` type
//! leakage in the signing path.

use crate::auth::state::AuthCapabilities;
use crate::error::{AppError, NotReadyKind};
use subxt_signer::sr25519::Keypair;

/// Clone the sr25519 keypair from `AppState.auth` for transaction signing.
///
/// Returns `NotReady(SigningKeyUnavailable)` for OAuth users or sessions
/// restored from disk that haven't been unlocked with a passcode yet.
/// The frontend dispatches on `kind === "NotReady"` + the structured
/// message to show "this action requires your seed phrase".
pub(crate) fn get_signer(app_state: &crate::app_state::AppState) -> Result<Keypair, AppError> {
    let auth = app_state.auth.lock().map_err(|e| AppError::Other(format!("Lock error: {e}")))?;
    match auth.capabilities {
        AuthCapabilities::Full => auth.sr25519_pair.clone().ok_or(AppError::NotReady(NotReadyKind::SigningKeyUnavailable)),
        AuthCapabilities::OAuthOnly | AuthCapabilities::Restored => Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable)),
        AuthCapabilities::None => Err(AppError::Auth("Not authenticated — please log in first".into())),
    }
}

/// Read the SS58 address from the in-memory auth state.
pub(crate) fn get_substrate_address(app_state: &crate::app_state::AppState) -> Result<String, AppError> {
    let auth = app_state.auth.lock().map_err(|e| AppError::Other(format!("Lock error: {e}")))?;
    auth.substrate_address
        .clone()
        .ok_or(AppError::Auth("Not authenticated — please log in first".into()))
}

/// Get both the transaction signer and substrate address in a single lock acquisition.
///
/// Prefer this over separate [`get_signer`] + [`get_substrate_address`] calls
/// when both values are needed, to avoid acquiring the auth mutex twice.
/// Same capability gating as [`get_signer`].
pub(crate) fn get_signer_and_address(app_state: &crate::app_state::AppState) -> Result<(Keypair, String), AppError> {
    let auth = app_state.auth.lock().map_err(|e| AppError::Other(format!("Lock error: {e}")))?;
    match auth.capabilities {
        AuthCapabilities::Full => {
            let pair = auth.sr25519_pair.clone().ok_or(AppError::NotReady(NotReadyKind::SigningKeyUnavailable))?;
            let address = auth
                .substrate_address
                .clone()
                .ok_or(AppError::Auth("Not authenticated — please log in first".into()))?;
            Ok((pair, address))
        }
        AuthCapabilities::OAuthOnly | AuthCapabilities::Restored => Err(AppError::NotReady(NotReadyKind::SigningKeyUnavailable)),
        AuthCapabilities::None => Err(AppError::Auth("Not authenticated — please log in first".into())),
    }
}
