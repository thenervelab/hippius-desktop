//! Grant-blob sealing — the cross-client crypto contract for shared drives.
//!
//! A grant blob hands ONE member the OWNER's per-folder key material, sealed
//! so only that member can open it:
//!
//! - **Passphrase** = `hex(HKDF-SHA256(bip39_seed(member_master)[..64],
//!   salt = member_ss58 bytes, info = [`INFO_DRIVE_GRANT`]))` — the
//!   [`crate::crypto::store::derive_key`] shape, see [`grant_passphrase`].
//! - **Sealing** = `hcfs_client::mnemonic_blob::seal_mnemonic` (Argon2id +
//!   XChaCha20-Poly1305), AAD = the MEMBER's ss58 — a blob sealed for one
//!   member fails the tag check under any other address.
//! - **Sealed payload** = the owner's folder-mnemonic PHRASE (the BIP-39
//!   english encoding of its 32-byte entropy). `mnemonic_blob` seals strings,
//!   and phrase and entropy are bijective through BIP-39, so this module's
//!   API surface exchanges the 32-byte ENTROPY while the ciphertext holds the
//!   phrase. Phase 3 console MUST do the same: `Mnemonic::from_entropy`
//!   (english) before sealing, `to_entropy` after opening.
//! - **Wire form** = the `SealedBlob` JSON bytes; the HTTP layer base64s them
//!   PADDED STANDARD into `grant_blob` (the server stores/returns bytes).
//!
//! Every half of this is KAT-pinned below — phase 3 console copies those
//! vectors verbatim, so a drift here fails CI before it strands a client.
//!
//! Argon2id at the default `mnemonic_blob` cost is ~1.5 s of blocking CPU:
//! callers on the async runtime MUST offload [`seal_grant`] / [`open_grant`]
//! via `spawn_blocking` (the `recovery.rs::run_kdf` pattern) — these are
//! deliberately synchronous functions.

use crate::crypto::store::{INFO_DRIVE_GRANT, derive_key};
use crate::error::{AppError, Result};
use hcfs_client::mnemonic_blob::{SealedBlob, open_mnemonic, seal_mnemonic};
use zeroize::{Zeroize, Zeroizing};

/// The Argon2id passphrase protecting a member's grant blobs.
///
/// Deterministic over `(member_master, member_ss58)`, so the member can open
/// any grant sealed for them with no extra secret exchanged — the passphrase
/// re-derives from the same master mnemonic their login already holds. Hex
/// (lowercase) of the 32-byte HKDF output; pinned by
/// `grant_passphrase_is_pinned`.
pub fn grant_passphrase(master_mnemonic: &str, member_ss58: &str) -> Result<Zeroizing<String>> {
    let key = derive_key(master_mnemonic, member_ss58, INFO_DRIVE_GRANT)?;
    Ok(Zeroizing::new(hex::encode(key.as_ref())))
}

/// Seal the owner's folder-mnemonic entropy for `member_ss58`, returning the
/// wire bytes (`SealedBlob` JSON).
///
/// `master_mnemonic` is the MEMBER's master (the passphrase derives from it)
/// — on the desktop this runs only in tests and the live-lane e2e, since
/// production sealing happens on the accepting client (console, phase 3).
pub fn seal_grant(master_mnemonic: &str, member_ss58: &str, folder_mnemonic_entropy: &[u8; 32]) -> Result<Vec<u8>> {
    let phrase = phrase_from_entropy(folder_mnemonic_entropy)?;
    let passphrase = grant_passphrase(master_mnemonic, member_ss58)?;

    let blob = seal_mnemonic(&phrase, &passphrase, member_ss58).map_err(|e| AppError::Crypto(format!("grant seal failed: {e}")))?;
    serde_json::to_vec(&blob).map_err(|e| AppError::Crypto(format!("grant blob serialization failed: {e}")))
}

/// Open a grant blob sealed for `member_ss58`, returning the owner's
/// folder-mnemonic entropy.
///
/// Fails as [`AppError::Crypto`] on a malformed blob, a wrong master
/// (passphrase mismatch), or a wrong/foreign ss58 (AEAD tag) — never the
/// FE-silenced `Auth`/`NotReady` kinds, since any of these means the stored
/// grant is unusable and the user must be told.
pub fn open_grant(master_mnemonic: &str, member_ss58: &str, blob: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let sealed: SealedBlob = serde_json::from_slice(blob).map_err(|e| AppError::Crypto(format!("grant blob is not valid SealedBlob JSON: {e}")))?;
    let passphrase = grant_passphrase(master_mnemonic, member_ss58)?;

    let phrase = open_mnemonic(&sealed, &passphrase, member_ss58).map_err(|e| AppError::Crypto(format!("grant open failed: {e}")))?;
    entropy_from_phrase(&phrase)
}

/// Entropy → BIP-39 english phrase (the sealed representation).
fn phrase_from_entropy(entropy: &[u8; 32]) -> Result<Zeroizing<String>> {
    let mnemonic =
        bip39::Mnemonic::from_entropy(entropy).map_err(|e| AppError::Crypto(format!("grant entropy does not encode a BIP-39 mnemonic: {e}")))?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

/// BIP-39 phrase → the exact 32-byte entropy it encodes.
///
/// Refuses any other entropy width: the grant contract fixes the payload at
/// 32 bytes (a 24-word folder mnemonic), and downstream key derivation
/// (`derive_folder_mnemonic` output parity) assumes it.
fn entropy_from_phrase(phrase: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mnemonic = bip39::Mnemonic::parse_normalized(phrase).map_err(|e| AppError::Crypto(format!("grant payload is not a BIP-39 mnemonic: {e}")))?;
    let mut entropy_vec = mnemonic.to_entropy();

    if entropy_vec.len() != 32 {
        let got = entropy_vec.len();
        entropy_vec.zeroize();
        return Err(AppError::Crypto(format!("grant payload entropy must be 32 bytes, got {got}")));
    }

    let mut entropy = Zeroizing::new([0u8; 32]);
    entropy.copy_from_slice(&entropy_vec);
    entropy_vec.zeroize();
    Ok(entropy)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical public BIP-39 zero-vector — a published fixture, never a
    /// real wallet. Same constant as `tests/hcfs_contract.rs`.
    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    const MEMBER_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const OTHER_SS58: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    /// A second published BIP-39 vector (all-0x80 entropy is not published;
    /// use the "legal winner..." vector's master for the wrong-master case).
    const OTHER_MNEMONIC: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

    fn test_entropy() -> [u8; 32] {
        let mut e = [0u8; 32];
        for (i, b) in e.iter_mut().enumerate() {
            *b = i as u8;
        }
        e
    }

    /// CROSS-CLIENT KAT: phase 3 console derives this exact passphrase for
    /// this (master, ss58) pair — copy the vector verbatim into its tests.
    /// A drift means every grant sealed by one client is unopenable by the
    /// other.
    #[test]
    fn grant_passphrase_is_pinned() {
        let passphrase = grant_passphrase(TEST_MNEMONIC, MEMBER_SS58).expect("derive grant passphrase");
        assert_eq!(
            passphrase.as_str(),
            "dab4e54d8424eb9dc05396035ad64cea593542b8b6abf4f64d499e4e9a2a1fb6",
            "grant passphrase derivation drifted (HKDF salt/info/master-seed contract)"
        );

        // Determinism + per-member separation: a different ss58 salts a
        // different passphrase, so one member's passphrase opens nothing
        // sealed for another.
        assert_eq!(
            grant_passphrase(TEST_MNEMONIC, MEMBER_SS58).expect("re-derive").as_str(),
            passphrase.as_str()
        );
        assert_ne!(
            grant_passphrase(TEST_MNEMONIC, OTHER_SS58).expect("other member").as_str(),
            passphrase.as_str()
        );
    }

    // Round-trip: seal for a member, open as that member, entropy identical.
    // The wire bytes must be the SealedBlob JSON object (the base64 layer is
    // the HTTP module's job, not this one's).
    #[test]
    fn seal_open_round_trips_the_entropy() {
        let entropy = test_entropy();
        let blob = seal_grant(TEST_MNEMONIC, MEMBER_SS58, &entropy).expect("seal");

        let parsed: serde_json::Value = serde_json::from_slice(&blob).expect("wire bytes are JSON");
        assert!(parsed.get("ciphertext").is_some(), "wire form must be the SealedBlob JSON object");

        let opened = open_grant(TEST_MNEMONIC, MEMBER_SS58, &blob).expect("open");
        assert_eq!(*opened, entropy, "entropy must survive the seal/open round-trip");
    }

    // The AAD binding: the correct passphrase-deriving master with the WRONG
    // ss58 must fail (the member's address is authenticated into the tag).
    // Note the wrong ss58 also changes the derived passphrase, so this case
    // fails on both layers — the assert is that it FAILS, which is what the
    // contract needs.
    #[test]
    fn open_with_wrong_ss58_fails() {
        let blob = seal_grant(TEST_MNEMONIC, MEMBER_SS58, &test_entropy()).expect("seal");
        let err = open_grant(TEST_MNEMONIC, OTHER_SS58, &blob).expect_err("wrong ss58 must fail");
        assert!(matches!(err, AppError::Crypto(_)), "got {err:?}");
    }

    // Wrong master: the passphrase derives differently, so the KDF yields a
    // different key and the tag check fails.
    #[test]
    fn open_with_wrong_master_fails() {
        let blob = seal_grant(TEST_MNEMONIC, MEMBER_SS58, &test_entropy()).expect("seal");
        let err = open_grant(OTHER_MNEMONIC, MEMBER_SS58, &blob).expect_err("wrong master must fail");
        assert!(matches!(err, AppError::Crypto(_)), "got {err:?}");
    }

    // Corrupt wire bytes are a Crypto error, not a panic or a silenced kind.
    #[test]
    fn open_with_malformed_blob_fails_closed() {
        let err = open_grant(TEST_MNEMONIC, MEMBER_SS58, b"not json at all").expect_err("malformed blob must fail");
        assert!(matches!(err, AppError::Crypto(_)), "got {err:?}");
    }

    // A sealed payload that opens but is NOT a 32-byte-entropy mnemonic is
    // refused: the contract fixes 24 words. Build the hostile blob through
    // the real sealing path with a 12-word (16-byte) payload.
    #[test]
    fn open_refuses_non_32_byte_entropy_payload() {
        let passphrase = grant_passphrase(TEST_MNEMONIC, MEMBER_SS58).expect("passphrase");
        let short_payload = TEST_MNEMONIC; // 12 words = 16-byte entropy
        let sealed = hcfs_client::mnemonic_blob::seal_mnemonic(short_payload, &passphrase, MEMBER_SS58).expect("seal short payload");
        let blob = serde_json::to_vec(&sealed).expect("wire bytes");

        let err = open_grant(TEST_MNEMONIC, MEMBER_SS58, &blob).expect_err("16-byte entropy must be refused");
        match err {
            AppError::Crypto(msg) => assert!(msg.contains("32 bytes"), "message names the width rule: {msg}"),
            other => panic!("expected Crypto, got {other:?}"),
        }
    }

    /// FROZEN-BLOB KAT: a grant sealed at the pinned hcfs rev (passphrase
    /// derivation + Argon2id params + AAD + SealedBlob JSON shape all baked
    /// in) must keep opening to the same entropy. This is the cross-rev
    /// data-loss guard the randomized round-trip cannot provide: if a bump
    /// changes any layer, every grant blob already stored on the server
    /// becomes unopenable and THIS fails before the bump ships. Regenerate
    /// deliberately (seal_grant + hex::encode) only on a purposeful contract
    /// change, shipping a migration.
    #[test]
    fn open_grant_frozen_blob_is_pinned() {
        let blob = hex::decode(FROZEN_GRANT_BLOB_HEX).expect("frozen blob hex");
        let opened = open_grant(TEST_MNEMONIC, MEMBER_SS58, &blob).expect("a grant sealed at the pinned rev must still open");
        assert_eq!(*opened, test_entropy(), "frozen grant blob no longer opens to its entropy");
    }

    /// `seal_grant(TEST_MNEMONIC, MEMBER_SS58, test_entropy())` captured at
    /// hcfs rev `3ff8e9f` — hex of the SealedBlob JSON wire bytes.
    const FROZEN_GRANT_BLOB_HEX: &str = "7b2263697068657274657874223a222f6367384b77726f733441726d4b572b357846324e6d75434159704d706543366b5338796766627651716339474e744b355158596e336f4149786c633945764f624d33547a4573645355563558463672556c7642516261676647325a6c70382b62694662534b52385550476469585a4a6a627a59446e45627836512b6b49514a6b57487971616e72745a474a744e7a74384258524142564e77755362754a6b7a4f6b4f56677034544d4b2b6b41535236396548695534716e785774486f466b574561636f3278544247753736643264534d58742f74584e323755374b222c2273616c74223a22487a4d6939787243434c4879775034564d7154566a513d3d222c226e6f6e6365223a22784355725431546a4242597a7462646a74794e434454792f7058487a795a4d2b222c22616164223a224e55647964335a6852555931656c68694d6a5a47656a6c7959314677524664544e546444644556535348424f5a5768595131426a546d3949523074316446465a222c226b6466223a7b22616c676f726974686d223a226172676f6e326964222c226d656d6f72795f6b6962223a3133313037322c2274696d655f636f7374223a332c22706172616c6c656c69736d223a317d7d";
}
