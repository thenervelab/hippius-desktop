//! Read-only bridge IPC: fee quote + minimum-transfer constants.
//!
//! These are pure (no chain) — they replace the renderer's `calculateBridgeFee`
//! / `calculateReceivedAmount` / minimum constants so the FE renders figures the
//! backend authoritatively computes. Balance/stake reads (which DO hit the
//! chain) land with the write paths.

use crate::blockchain::bridge::convert;
use crate::blockchain::bridge::types::{FeeEstimate, MinTransfers};
use crate::error::AppError;

/// Quote the bridge fee + received amount for `amount` (a smallest-unit "rao"
/// decimal string). Direction doesn't change the fee math (a flat 0.1%), but it
/// is accepted so the FE can keep one call shape and a future asymmetric fee
/// stays a backend-only change.
///
/// # Errors
/// [`AppError::Validation`] if `amount` isn't a non-negative integer rao value.
#[tauri::command]
pub fn bridge_estimate_fees(amount: String, direction: String) -> Result<FeeEstimate, AppError> {
    let _ = direction; // reserved; fee is currently flat across directions
    let amount: u128 = amount
        .trim()
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid bridge amount: {e}")))?;
    Ok(FeeEstimate {
        bridge_fee: convert::bridge_fee(amount).to_string(),
        received_amount: convert::received_after_fee(amount).to_string(),
    })
}

/// The minimum transfer amounts (rao decimal strings) the UI gates input on.
#[must_use]
#[tauri::command]
pub fn bridge_min_transfers() -> MinTransfers {
    MinTransfers {
        alpha: convert::MIN_TRANSFER_ALPHA_RAO.to_string(),
        h_alpha: convert::MIN_TRANSFER_HALPHA_RAO.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_matches_convert_math() {
        let est = bridge_estimate_fees("15000000000".into(), "alpha-to-halpha".into()).unwrap();
        assert_eq!(est.bridge_fee, "15000000");
        assert_eq!(est.received_amount, "14985000000");
        assert!(bridge_estimate_fees("-1".into(), "x".into()).is_err());
    }

    #[test]
    fn minimums_are_the_15_token_constants() {
        let m = bridge_min_transfers();
        assert_eq!(m.alpha, "15000000000");
        assert_eq!(m.h_alpha, "15000000000000000000");
    }
}
