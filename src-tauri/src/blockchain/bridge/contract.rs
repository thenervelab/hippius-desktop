//! ink! contract error decoding for the bridge `deposit` dry-run/call.
//!
//! A `pallet-contracts` call returns the ink! message's
//! `Result<Result<T, bridge::Error>, ink::LangError>` as SCALE bytes. We decode
//! the failure case to a human variant name. This mirrors the byte patterns in
//! `app/lib/bridge/service.ts::dryRunReason` (which were validated against the
//! live contract) rather than a fresh derive, so the proven layout is preserved:
//!
//! - `[0x00, 0x01, variant]` — `Ok(Err(ContractError(variant)))`
//! - `[0x01, ..]`            — `Err(LangError)` (CouldNotReadInput)
//! - `[0x00, variant]`       — a directly-encoded variant
//! - `[variant]`             — a bare single-byte variant
//!
//! The variant table is the ink! `bridge::Error` enum, index-for-index from
//! `.papi/contracts/bridge.json` (verified to match the TS table).

/// `bridge::Error` variants by discriminant (0-24).
const CONTRACT_ERROR_VARIANTS: [&str; 25] = [
    "Unauthorized",                   // 0
    "NotGuardian",                    // 1
    "AlreadyVoted",                   // 2
    "InsufficientStake",              // 3
    "TransferNotVerified",            // 4
    "InsufficientContractStake",      // 5
    "AmountTooSmall",                 // 6
    "InvalidThresholds",              // 7
    "TooManyGuardians",               // 8
    "InvalidWithdrawalDetails",       // 9
    "InvalidTTL",                     // 10
    "BridgePaused",                   // 11
    "DepositRequestNotFound",         // 12
    "WithdrawalNotFound",             // 13
    "DepositRequestAlreadyFinalized", // 14
    "WithdrawalAlreadyFinalized",     // 15
    "Overflow",                       // 16
    "RuntimeCallFailed",              // 17
    "StakeQueryFailed",               // 18
    "TransferFailed",                 // 19
    "StakeConsolidationFailed",       // 20
    "CodeUpgradeFailed",              // 21
    "InvalidRequestId",               // 22
    "RecordNotFinalized",             // 23
    "TTLNotExpired",                  // 24
];

fn variant_name(idx: u8) -> String {
    CONTRACT_ERROR_VARIANTS
        .get(idx as usize)
        .map_or_else(|| format!("ContractError(variant={idx})"), |s| (*s).to_string())
}

/// Decode the SCALE return bytes of a reverted `deposit` ink! call into a
/// human-readable reason. Returns `None` for an `Ok(Ok(_))` (success) shape or
/// empty input — the caller treats `None` as "no decodable contract error".
#[must_use]
#[expect(
    clippy::match_same_arms,
    reason = "the `[0x00, variant, ..]` arm reads the SECOND byte (an Ok(directVariant) shape) while the catch-all reads the FIRST; identical body text, different byte, kept separate to mirror service.ts::dryRunReason"
)]
pub fn describe_contract_error(bytes: &[u8]) -> Option<String> {
    match bytes {
        // Ok(Err(ContractError(variant)))
        [0x00, 0x01, variant, ..] => Some(variant_name(*variant)),
        // Err(LangError::CouldNotReadInput)
        [0x01, ..] => Some("LangError::CouldNotReadInput (ABI mismatch or encoding error)".to_string()),
        // Directly-encoded variant after an Ok(...) prefix.
        [0x00, variant, ..] => Some(variant_name(*variant)),
        // Any other non-empty shape: treat the leading byte as the variant.
        [variant, ..] => Some(variant_name(*variant)),
        [] => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_known_contract_errors() {
        // Ok(Err(BridgePaused=11)).
        assert_eq!(describe_contract_error(&[0x00, 0x01, 11]).as_deref(), Some("BridgePaused"));
        // Ok(Err(StakeConsolidationFailed=20)) — the pattern the TS comment cites.
        assert_eq!(
            describe_contract_error(&[0x00, 0x01, 20]).as_deref(),
            Some("StakeConsolidationFailed")
        );
        // Err(LangError).
        assert!(describe_contract_error(&[0x01, 0x01]).unwrap().starts_with("LangError"));
        // Direct variant 6 = AmountTooSmall.
        assert_eq!(describe_contract_error(&[0x00, 6]).as_deref(), Some("AmountTooSmall"));
        // Bare single-byte variant.
        assert_eq!(describe_contract_error(&[24]).as_deref(), Some("TTLNotExpired"));
        // Out-of-range variant falls back to a labelled form, never panics.
        assert_eq!(describe_contract_error(&[0x00, 0x01, 99]).as_deref(), Some("ContractError(variant=99)"));
        // Empty → no decodable error.
        assert_eq!(describe_contract_error(&[]), None);
    }
}
