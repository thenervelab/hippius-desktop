//! Pure money/unit math for the bridge, ported from `app/lib/bridge/config.ts`
//! (`calculateBridgeFee`/`calculateReceivedAmount`) and `service.ts`
//! (`alphaToHAlpha`/`hAlphaToAlpha`) plus `BridgeDialog.tsx`'s `toPlanckString`.
//!
//! All amounts are in the smallest unit ("rao"): Alpha has **9** decimals,
//! hAlpha has **18**. These are the authoritative figures the bridge submits,
//! so they live in Rust (audit H-8 Part B / bridge logic-placement) rather than
//! being recomputed in the renderer. Every function is pure + unit-tested so the
//! Rust values can be cross-checked against the TS they replace.

use crate::error::AppError;

/// Alpha (Bittensor side) smallest-unit decimals.
pub const ALPHA_DECIMALS: u32 = 9;
/// hAlpha (Hippius side) smallest-unit decimals.
pub const HALPHA_DECIMALS: u32 = 18;
/// Decimal gap between the two tokens — the Alpha↔hAlpha scale factor is `10^GAP`.
const SCALE_GAP: u32 = HALPHA_DECIMALS - ALPHA_DECIMALS; // 9
/// Bridge fee in basis points. TS: `feePercentage = 0.001` →
/// `floor(0.001 * 10000) = 10` bps, applied as `amount * 10 / 10000`.
const FEE_BPS: u128 = 10;
const BPS_DENOM: u128 = 10_000;

/// Minimum Alpha→hAlpha transfer: 15 Alpha = `15 * 10^9` rao (config.ts).
pub const MIN_TRANSFER_ALPHA_RAO: u128 = 15_000_000_000;
/// Minimum hAlpha→Alpha transfer: 15 hAlpha = `15 * 10^18` rao (config.ts).
pub const MIN_TRANSFER_HALPHA_RAO: u128 = 15_000_000_000_000_000_000;

/// 0.1% bridge fee on `amount`, truncating like the TS integer math
/// (`amount * 10 / 10000`).
#[must_use]
pub fn bridge_fee(amount: u128) -> u128 {
    amount.saturating_mul(FEE_BPS) / BPS_DENOM
}

/// Amount the recipient receives after the bridge fee.
#[must_use]
pub fn received_after_fee(amount: u128) -> u128 {
    amount - bridge_fee(amount)
}

/// Convert an Alpha rao amount (9 dec) to the hAlpha rao amount (18 dec) it
/// bridges to: `alpha * 10^9`. Returns `None` on `u128` overflow.
#[must_use]
pub fn alpha_to_halpha(alpha_rao: u128) -> Option<u128> {
    alpha_rao.checked_mul(10u128.pow(SCALE_GAP))
}

/// Convert an hAlpha rao amount (18 dec) to the Alpha rao amount (9 dec) it
/// bridges to: `halpha / 10^9` (truncating, matching the TS).
#[must_use]
pub fn halpha_to_alpha(halpha_rao: u128) -> u128 {
    halpha_rao / 10u128.pow(SCALE_GAP)
}

/// Parse a human decimal string (e.g. `"15.5"`) into the smallest unit for a
/// token with `decimals` places — the Rust counterpart to `BridgeDialog`'s
/// `toPlanckString`, used to turn the user's input into the rao `amount` the
/// extrinsic actually carries.
///
/// Rejects negatives, empty input, non-numeric characters, more than one `.`,
/// and a fractional part longer than `decimals` (which would silently lose
/// precision). Mirrors the strictness of `blockchain::convert::to_plancks` but
/// parameterised by `decimals` (9 for Alpha, 18 for hAlpha).
///
/// # Errors
/// [`AppError::Validation`] for any malformed or out-of-precision input.
pub fn to_rao(decimal: &str, decimals: u32) -> Result<u128, AppError> {
    let s = decimal.trim();
    if s.is_empty() {
        return Err(AppError::Validation("Amount is empty".into()));
    }
    if s.starts_with('-') {
        return Err(AppError::Validation("Amount must not be negative".into()));
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    // Reject a second '.' and any non-digit (split_once only handled the first).
    if frac_part.contains('.') || !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation("Amount is not a valid decimal number".into()));
    }
    let decimals = decimals as usize;
    if frac_part.len() > decimals {
        return Err(AppError::Validation(format!(
            "Amount has more than {decimals} decimal places"
        )));
    }
    // Right-pad the fraction to exactly `decimals` digits, concatenate, parse.
    let int_part = if int_part.is_empty() { "0" } else { int_part };
    let mut combined = String::with_capacity(int_part.len() + decimals);
    combined.push_str(int_part);
    combined.push_str(frac_part);
    for _ in 0..(decimals - frac_part.len()) {
        combined.push('0');
    }
    combined
        .parse::<u128>()
        .map_err(|e| AppError::Validation(format!("Amount is out of range: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_matches_ts_integer_math() {
        // calculateBridgeFee(15e9) = 15e9 * 10 / 10000 = 15_000_000.
        assert_eq!(bridge_fee(15_000_000_000), 15_000_000);
        assert_eq!(received_after_fee(15_000_000_000), 14_985_000_000);
        // 0.1% of 1000 rao truncates to 1 (1000*10/10000 = 1).
        assert_eq!(bridge_fee(1_000), 1);
        assert_eq!(bridge_fee(0), 0);
    }

    #[test]
    fn alpha_halpha_scaling_round_trips_whole_units() {
        // 15 Alpha (15e9 rao) -> 15 hAlpha (15e18 rao).
        assert_eq!(alpha_to_halpha(MIN_TRANSFER_ALPHA_RAO), Some(MIN_TRANSFER_HALPHA_RAO));
        assert_eq!(halpha_to_alpha(MIN_TRANSFER_HALPHA_RAO), MIN_TRANSFER_ALPHA_RAO);
        // Sub-1e9 hAlpha rao truncates to 0 Alpha rao (precision gap).
        assert_eq!(halpha_to_alpha(999_999_999), 0);
        // Overflow is reported, not silently wrapped.
        assert_eq!(alpha_to_halpha(u128::MAX), None);
    }

    #[test]
    fn to_rao_parses_and_validates() {
        assert_eq!(to_rao("15", ALPHA_DECIMALS).unwrap(), 15_000_000_000);
        assert_eq!(to_rao("15.5", ALPHA_DECIMALS).unwrap(), 15_500_000_000);
        assert_eq!(to_rao("1", HALPHA_DECIMALS).unwrap(), 1_000_000_000_000_000_000);
        assert_eq!(to_rao("0.000000001", ALPHA_DECIMALS).unwrap(), 1);
        // Too many fractional digits for the token's precision.
        assert!(to_rao("1.0000000001", ALPHA_DECIMALS).is_err());
        assert!(to_rao("-1", ALPHA_DECIMALS).is_err());
        assert!(to_rao("", ALPHA_DECIMALS).is_err());
        assert!(to_rao("1.2.3", ALPHA_DECIMALS).is_err());
        assert!(to_rao("abc", ALPHA_DECIMALS).is_err());
    }
}
