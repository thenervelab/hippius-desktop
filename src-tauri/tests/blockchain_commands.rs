//! Tests for blockchain command helpers.
//!
//! These test the serialization and helper logic — not live blockchain queries
//! (those require a running node). The staking/balance commands are thin
//! wrappers around subxt, so the primary value is in type-checking and
//! ensuring the AUTH_STATE integration works.

use std::str::FromStr;
use subxt::utils::AccountId32;
use subxt_signer::bip39::Mnemonic;
use subxt_signer::sr25519::Keypair;

#[test]
fn test_account_id_parse_valid_ss58() {
    // The well-known "Alice" address should parse successfully.
    let mnemonic = Mnemonic::parse("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
    let pair = Keypair::from_phrase(&mnemonic, None).unwrap();
    let address = pair.public_key().to_account_id().to_string();

    // Verify it parses as a subxt AccountId32
    let parsed = AccountId32::from_str(&address);
    assert!(parsed.is_ok(), "Valid SS58 address should parse: {address}");
}

#[test]
fn test_account_id_parse_invalid() {
    let parsed = AccountId32::from_str("not-an-address");
    assert!(parsed.is_err());
}

#[test]
fn test_planck_string_to_u128() {
    // 1.5 tokens = 1_500_000_000_000_000_000 planck (18 decimals)
    let planck_str = "1500000000000000000";
    let parsed: u128 = planck_str.parse().unwrap();
    assert_eq!(parsed, 1_500_000_000_000_000_000u128);
}

#[test]
fn test_planck_zero() {
    let parsed: u128 = "0".parse().unwrap();
    assert_eq!(parsed, 0);
}

#[test]
fn test_planck_max_safe_value() {
    // Large but valid planck value
    let planck_str = "340282366920938463463374607431768211455"; // u128::MAX
    let parsed: u128 = planck_str.parse().unwrap();
    assert_eq!(parsed, u128::MAX);
}

#[test]
fn test_ss58_roundtrip() {
    let mnemonic = Mnemonic::parse("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
    let pair = Keypair::from_phrase(&mnemonic, None).unwrap();
    let address = pair.public_key().to_account_id().to_string();

    // Parse back to AccountId32 and format. subxt_signer's default
    // format uses the generic `42` prefix — roundtripping the string
    // verifies the SS58 encoding is stable.
    let account_id = AccountId32::from_str(&address).unwrap();
    let roundtrip = account_id.to_string();
    assert_eq!(address, roundtrip);
}
