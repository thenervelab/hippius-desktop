//! R-36 — the estimated-transfer-fee planck constant is mirrored between the
//! Rust source of truth (`blockchain/transfers.rs::ESTIMATED_TRANSFER_FEE_PLANCK`)
//! and `WalletBalanceCard.tsx`, which uses it for the FE affordability check. A
//! one-sided edit would silently desync that math; this test fails if the copy
//! drifts.
//!
//! The gas-fee BUFFER (`MAX_GAS_FEE_BUFFER_PLANCK`) is deliberately NOT checked
//! here: the FE business-logic audit (#26) centralized it in Rust and removed
//! the `StakeDialog.tsx` / `BridgeDialog.tsx` copies, so asserting they still
//! contain it would (and did) fail with "const not found". The FE side is now
//! guarded against *re-introducing* the buffer by
//! `app/lib/bridge/__tests__/noDuplicatedDomainConstants.test.ts` instead.
//!
//! It normalizes each definition to its digit string, so it is agnostic to the
//! literal format: Rust `270_233_151` and TS `BigInt("270233151")` reduce to the
//! same digits.

use std::fs;

fn read(rel: &str) -> String {
    fs::read_to_string(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

/// Digits of a `const NAME = <number>` definition. Picks the first line that
/// declares `const`, names the constant, and has an `=`; takes the RHS (before
/// any trailing `//` comment) and keeps only ASCII digits.
fn const_digits(src: &str, name: &str) -> String {
    for line in src.lines() {
        if line.contains("const ") && line.contains(name) && line.contains('=') {
            let rhs = line.split('=').nth(1).unwrap_or("");
            let rhs = rhs.split("//").next().unwrap_or(rhs);
            let digits: String = rhs.chars().filter(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                return digits;
            }
        }
    }
    panic!("const `{name}` definition not found");
}

#[test]
fn estimated_transfer_fee_constant_matches_across_rust_and_ts() {
    let transfers = read("src/blockchain/transfers.rs");
    let balance_card = read("../app/components/page-sections/wallet/WalletBalanceCard.tsx");

    // Rust is the source of truth.
    let fee = const_digits(&transfers, "ESTIMATED_TRANSFER_FEE_PLANCK");

    assert_eq!(
        const_digits(&balance_card, "ESTIMATED_TRANSFER_FEE_PLANCK"),
        fee,
        "WalletBalanceCard.tsx ESTIMATED_TRANSFER_FEE_PLANCK drifted from blockchain/transfers.rs"
    );
}
