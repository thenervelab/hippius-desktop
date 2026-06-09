//! R-36 — the gas-buffer / estimated-fee planck constants are hand-duplicated
//! between the Rust source of truth (`blockchain/transfers.rs`) and several
//! frontend files. A one-sided edit would silently desync the MAX / affordability
//! math between Rust and the FE. This test fails if any copy drifts.
//!
//! It normalizes each definition to its digit string, so it is agnostic to the
//! literal format: Rust `10_000_000_000_000_000`, TS `10_000_000_000_000_000n`,
//! and TS `BigInt("10000000000000000")` all reduce to the same digits.

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
fn gas_buffer_and_fee_constants_match_across_rust_and_ts() {
    let transfers = read("src/blockchain/transfers.rs");
    let stake = read("../app/components/page-sections/wallet/StakeDialog.tsx");
    let bridge = read("../app/components/page-sections/wallet/BridgeDialog.tsx");
    let balance_card = read("../app/components/page-sections/wallet/WalletBalanceCard.tsx");

    // Rust is the source of truth.
    let max_buffer = const_digits(&transfers, "MAX_GAS_FEE_BUFFER_PLANCK");
    let fee = const_digits(&transfers, "ESTIMATED_TRANSFER_FEE_PLANCK");

    assert_eq!(
        const_digits(&stake, "MAX_GAS_FEE_BUFFER_PLANCK"),
        max_buffer,
        "StakeDialog.tsx MAX_GAS_FEE_BUFFER_PLANCK drifted from blockchain/transfers.rs"
    );
    assert_eq!(
        const_digits(&bridge, "MAX_GAS_FEE_BUFFER_PLANCK"),
        max_buffer,
        "BridgeDialog.tsx MAX_GAS_FEE_BUFFER_PLANCK drifted from blockchain/transfers.rs"
    );
    assert_eq!(
        const_digits(&balance_card, "ESTIMATED_TRANSFER_FEE_PLANCK"),
        fee,
        "WalletBalanceCard.tsx ESTIMATED_TRANSFER_FEE_PLANCK drifted from blockchain/transfers.rs"
    );
}
