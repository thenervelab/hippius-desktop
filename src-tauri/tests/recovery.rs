//! OAuth account recovery — integration tests.
//!
//! These tests exercise the crypto contract the recovery flow depends on:
//! seal-then-open is lossless, wrong password or tampered SS58 both fail
//! with `AeadTag`, and the JSON wire format round-trips cleanly (since
//! the real flow sends the blob through hcfs-server as JSON).
//!
//! Command-level tests that need a running hcfs-server live under
//! `tests/recovery_commands.rs` (added later). These tests only need the
//! hcfs-client crate, so they're fast and deterministic.

use hcfs_client::mnemonic_blob::{MnemonicBlobError, SealedBlob, open_mnemonic, seal_mnemonic};

const SAMPLE_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SAMPLE_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

#[test]
fn seal_then_open_recovers_mnemonic() {
    let sealed = seal_mnemonic(SAMPLE_MNEMONIC, "correct horse battery staple", SAMPLE_SS58).expect("seal should succeed");
    let opened = open_mnemonic(&sealed, "correct horse battery staple", SAMPLE_SS58).expect("open should succeed with correct password + ss58");
    assert_eq!(&*opened, SAMPLE_MNEMONIC);
}

#[test]
fn wrong_password_returns_aead_tag() {
    let sealed = seal_mnemonic(SAMPLE_MNEMONIC, "correct horse battery staple", SAMPLE_SS58).expect("seal should succeed");
    let err = open_mnemonic(&sealed, "wrong password", SAMPLE_SS58).expect_err("open must fail with wrong password");
    assert!(matches!(err, MnemonicBlobError::AeadTag), "expected AeadTag, got {err:?}");
}

#[test]
fn wrong_ss58_returns_aead_tag() {
    // SS58 is bound as AAD, so decryption fails even if the ciphertext +
    // password are correct. The variant collapses to AeadTag — same as
    // wrong-password — which is why the desktop logs the raw error and
    // surfaces "Wrong passphrase" to users (an SS58 mismatch under normal
    // operation would indicate a compromised/buggy server, not user error).
    let sealed = seal_mnemonic(SAMPLE_MNEMONIC, "correct horse battery staple", SAMPLE_SS58).expect("seal should succeed");
    let other_ss58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    let err = open_mnemonic(&sealed, "correct horse battery staple", other_ss58).expect_err("open must fail with wrong SS58");
    assert!(matches!(err, MnemonicBlobError::AeadTag), "expected AeadTag, got {err:?}");
}

#[test]
fn json_wire_format_round_trips() {
    // The real recovery flow serialises the blob to JSON, sends it to
    // hcfs-server, retrieves it as JSON, and deserialises back. This
    // test asserts the round trip doesn't corrupt any field — catching
    // a future divergence between `SealedBlob`'s serde shape and what
    // the server stores.
    let sealed = seal_mnemonic(SAMPLE_MNEMONIC, "password123", SAMPLE_SS58).expect("seal should succeed");
    let json = serde_json::to_string(&sealed).expect("serialize SealedBlob");

    // Sanity: every field the server persists is present.
    for key in ["ciphertext", "salt", "nonce", "aad", "kdf"] {
        assert!(json.contains(key), "field `{key}` missing from serialised blob: {json}");
    }
    assert!(json.contains("argon2id"), "expected argon2id in kdf params: {json}");

    let round_tripped: SealedBlob = serde_json::from_str(&json).expect("deserialize SealedBlob");
    let opened = open_mnemonic(&round_tripped, "password123", SAMPLE_SS58).expect("open round-tripped blob");
    assert_eq!(&*opened, SAMPLE_MNEMONIC);
}

#[test]
fn blob_is_nondeterministic_across_seals() {
    // Each seal uses a fresh random salt + nonce, so two seals of the
    // same mnemonic+password+ss58 must produce different ciphertexts.
    // Verifying this protects against a future implementation bug that
    // makes sealing deterministic (which would leak information via
    // ciphertext equality).
    let a = seal_mnemonic(SAMPLE_MNEMONIC, "password", SAMPLE_SS58).expect("seal 1");
    let b = seal_mnemonic(SAMPLE_MNEMONIC, "password", SAMPLE_SS58).expect("seal 2");
    assert_ne!(a.ciphertext, b.ciphertext);
    assert_ne!(a.salt, b.salt);
    assert_ne!(a.nonce, b.nonce);
    // But both must decrypt to the same plaintext.
    assert_eq!(
        &*open_mnemonic(&a, "password", SAMPLE_SS58).expect("open a"),
        &*open_mnemonic(&b, "password", SAMPLE_SS58).expect("open b"),
    );
}
