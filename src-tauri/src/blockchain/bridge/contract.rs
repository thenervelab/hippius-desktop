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
//! The variant table follows the ink! `bridge::Error` enum in `thebrain`
//! `contracts/bridge/src/errors.rs` at HEAD (24 variants). NOTE: the chain's
//! own generated ABI and the desktop `.papi` ABI both disagree with it (and
//! each other) — the desktop ABI the FE used had a stale extra
//! `InvalidWithdrawalDetails@9` (25 variants), which mislabels everything from
//! index 9 up. Because the enum the *deployed* contract uses can't be confirmed
//! here, `variant_name` always emits the raw index too (see its docs).

/// `bridge::Error` variants by discriminant (0-24).
const CONTRACT_ERROR_VARIANTS: [&str; 24] = [
    "Unauthorized",                   // 0
    "NotGuardian",                    // 1
    "AlreadyVoted",                   // 2
    "InsufficientStake",              // 3
    "TransferNotVerified",            // 4
    "InsufficientContractStake",      // 5
    "AmountTooSmall",                 // 6
    "InvalidThresholds",              // 7
    "TooManyGuardians",               // 8
    "InvalidTTL",                     // 9
    "BridgePaused",                   // 10
    "DepositRequestNotFound",         // 11
    "WithdrawalNotFound",             // 12
    "DepositRequestAlreadyFinalized", // 13
    "WithdrawalAlreadyFinalized",     // 14
    "Overflow",                       // 15
    "RuntimeCallFailed",              // 16
    "StakeQueryFailed",               // 17
    "TransferFailed",                 // 18
    "StakeConsolidationFailed",       // 19
    "CodeUpgradeFailed",              // 20
    "InvalidRequestId",               // 21
    "RecordNotFinalized",             // 22
    "TTLNotExpired",                  // 23
];

/// Map a variant index to a name, ALWAYS keeping the raw index in the output.
///
/// The index is authoritative (it's what the contract emits); the name is a
/// best-effort label from `thebrain` `contracts/bridge/src/errors.rs` at HEAD.
/// The three known sources disagree (chain `errors.rs` = 24 variants w/
/// InvalidRequestId, no InvalidWithdrawalDetails; the chain's own generated
/// ABI and the desktop `.papi` ABI each differ from it and each other), and the
/// enum the *deployed* testnet contract uses can't be confirmed from here — so
/// the index is surfaced alongside the name to stay debuggable if the label is
/// stale. Regenerate this table from the DEPLOYED contract's ABI when known.
fn variant_name(idx: u8) -> String {
    CONTRACT_ERROR_VARIANTS.get(idx as usize).map_or_else(
        || format!("contract error #{idx}"),
        |name| format!("{name} (contract error #{idx})"),
    )
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
        // Names per thebrain errors.rs HEAD; output always carries the raw index.
        // Ok(Err(BridgePaused=10)).
        let r = describe_contract_error(&[0x00, 0x01, 10]).unwrap();
        assert!(r.contains("BridgePaused") && r.contains("#10"), "got: {r}");
        // Ok(Err(StakeConsolidationFailed=19)).
        let r = describe_contract_error(&[0x00, 0x01, 19]).unwrap();
        assert!(r.contains("StakeConsolidationFailed") && r.contains("#19"), "got: {r}");
        // Err(LangError).
        assert!(describe_contract_error(&[0x01, 0x01]).unwrap().starts_with("LangError"));
        // Direct variant 6 = AmountTooSmall.
        assert!(describe_contract_error(&[0x00, 6]).unwrap().contains("AmountTooSmall"));
        // Bare single-byte variant 23 = TTLNotExpired.
        assert!(describe_contract_error(&[23]).unwrap().contains("TTLNotExpired"));
        // Out-of-range variant falls back to the index form, never panics.
        assert_eq!(describe_contract_error(&[0x00, 0x01, 99]).as_deref(), Some("contract error #99"));
        // Empty → no decodable error.
        assert_eq!(describe_contract_error(&[]), None);
    }
}
