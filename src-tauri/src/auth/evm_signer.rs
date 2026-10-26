//! The Ethereum (secp256k1) half of a wallet login.
//!
//! The Hippius API authenticates a recovery-phrase account with two
//! signatures over the same challenge: an sr25519 one by the Substrate key
//! (`service::sign_challenge_sr25519`) and an EIP-191 `personal_sign` one by
//! the Ethereum key derived from the same phrase at `m/44'/60'/0'/0/0`. This
//! module owns the second. Its outputs are what the server has on record for
//! every existing account, so the tests below pin them byte for byte: a
//! different address or signature for the same phrase would lock the user out.

use alloy_signer::SignerSync;
use alloy_signer_local::coins_bip39::English;
use alloy_signer_local::{MnemonicBuilder, PrivateKeySigner};

/// A secp256k1 signing key plus its Ethereum address.
pub(crate) struct EvmSigner {
    inner: PrivateKeySigner,
}

/// Shows the address only, so a `{:?}` can never print the secret key.
impl std::fmt::Debug for EvmSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EvmSigner").field("address", &self.address()).finish_non_exhaustive()
    }
}

impl EvmSigner {
    /// Derive the account-0 key (`m/44'/60'/0'/0/0`, empty BIP-39
    /// passphrase) from an English recovery phrase.
    ///
    /// The phrase must already be canonical: lowercase words separated by
    /// single spaces, nothing before or after. Anything else is refused
    /// rather than normalized, which is what the login flow has always done.
    pub(crate) fn from_phrase(phrase: &str) -> Result<Self, String> {
        let inner = MnemonicBuilder::<English>::default()
            .phrase(phrase)
            .index(0)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|_| "Invalid BIP-39 mnemonic for the Ethereum key".to_string())?;
        Ok(Self { inner })
    }

    /// A signer for a raw 32-byte secret key.
    #[cfg(test)]
    pub(crate) fn from_private_key(secret: &[u8; 32]) -> Result<Self, String> {
        let inner = PrivateKeySigner::from_slice(secret).map_err(|e| e.to_string())?;
        Ok(Self { inner })
    }

    /// The secret key's 32 big-endian bytes.
    #[cfg(test)]
    pub(crate) fn private_key_bytes(&self) -> [u8; 32] {
        self.inner.to_bytes().0
    }

    /// The EIP-55 checksummed address, `0x`-prefixed.
    pub(crate) fn address(&self) -> String {
        format!("{}", self.inner.address())
    }

    /// EIP-191 `personal_sign` over `message`: the 65-byte `r || s || v`
    /// signature (low-s, `v` = 27 or 28) as `0x` + 130 lowercase hex.
    pub(crate) fn sign_message(&self, message: &[u8]) -> Result<String, String> {
        let sig = self.inner.sign_message_sync(message).map_err(|e| e.to_string())?;
        Ok(format!("{sig}"))
    }

    /// Sign a 32-byte digest as-is (no EIP-191 prefix), same encoding as
    /// [`Self::sign_message`].
    #[cfg(test)]
    pub(crate) fn sign_hash(&self, hash: &[u8; 32]) -> Result<String, String> {
        let sig = self.inner.sign_hash_sync(&(*hash).into()).map_err(|e| e.to_string())?;
        Ok(format!("{sig}"))
    }
}

#[cfg(test)]
mod tests {
    use super::EvmSigner;

    /// The Foundry/Anvil/Hardhat development phrase.
    const TEST_PHRASE: &str = "test test test test test test test test test test test junk";
    /// The BIP-39 all-zero-entropy 12-word phrase.
    const ABANDON_12: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    /// The BIP-39 all-zero-entropy 24-word phrase.
    const ABANDON_24: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                              abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    fn hex32(s: &str) -> [u8; 32] {
        hex::decode(s.strip_prefix("0x").unwrap_or(s)).expect("hex").try_into().expect("32 bytes")
    }

    /// Phrase -> key -> address at `m/44'/60'/0'/0/0`. The first two rows
    /// are published, cross-implementation constants (Anvil account 0 and
    /// the BIP-39 "abandon ... about" account 0), so they check the BIP-39
    /// seed, the BIP-32 path and the address encoding independently of any
    /// one library. The 24-word row is a regression anchor.
    #[test]
    fn phrase_derives_the_pinned_key_and_address() {
        let cases = [
            (
                TEST_PHRASE,
                "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            ),
            (
                ABANDON_12,
                "1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727",
                "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            ),
            (
                ABANDON_24,
                "1053fae1b3ac64f178bcc21026fd06a3f4544ec2f35338b001f02d1d8efa3d5f",
                "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
            ),
        ];
        for (phrase, key, address) in cases {
            let signer = EvmSigner::from_phrase(phrase).expect("valid phrase");
            assert_eq!(hex::encode(signer.private_key_bytes()), key, "key for {phrase:?}");
            assert_eq!(signer.address(), address, "address for {phrase:?}");
        }
    }

    /// The login flow never normalized the phrase for the Ethereum key; a
    /// non-canonical spelling is refused, not silently re-derived.
    #[test]
    fn non_canonical_phrase_is_refused() {
        for phrase in [
            " test test test test test test test test test test test junk",
            "test test test test test test test test test test test junk ",
            "test  test test test test test test test test test test junk",
            "test test test test test test test test test test test\tjunk",
            "Test test test test test test test test test test test junk",
            "test test test test test test test test test test test test", // bad checksum
            "test test test test test test test test test test junk",      // 11 words
            "",
        ] {
            assert!(EvmSigner::from_phrase(phrase).is_err(), "{phrase:?} must be refused");
        }
    }

    /// Full 65-byte EIP-191 signatures for fixed messages. ECDSA here is
    /// RFC 6979 deterministic, so these never vary run to run; any change
    /// means the server would receive a different signature. Covers an
    /// empty message, a realistic challenge, multi-byte UTF-8 (the prefix
    /// counts bytes, not characters) and a message over 100 bytes (a
    /// three-digit length), with both recovery bytes 27 and 28 present.
    #[test]
    fn sign_message_matches_pinned_signatures() {
        let signer = EvmSigner::from_phrase(TEST_PHRASE).expect("valid phrase");
        let cases: [(&str, &str); 6] = [
            (
                "",
                "0xc1977b761f1dd36c29795783460d241885c8e7f9d962dbe7bba2753fd94e89b444a1cd9ed855dd09afa3b73f7c2bd097ec9abc2d2775d737505a02d3f0cafa591b",
            ),
            (
                "hello world",
                "0xa461f509887bd19e312c0c58467ce8ff8e300d3c1a90b608a760c5b80318eaf15fe57c96f9175d6cd4daad4663763baa7e78836e067d0163e9a2ccf2ff753f5b1b",
            ),
            (
                "Please sign this message to verify your ownership: abc123",
                "0xefdbaf719b4c9709dc15b3b9deb8f0db477883f419ac0f02524cd515fbffe85a2df4bc73055ee3462ff148027f8964d7fe39ec400500dd2173cbac14ff04e4c41b",
            ),
            (
                "héllo wörld ✓ 日本",
                "0x30d855a3564e4eb2f5b6a5a20ca344c4f9577fedda2d0985fdcce5a6025fb3765efd26904c3c7cb658bc73b3cd79810571f696eae2659c36255d093f654085781b",
            ),
            (
                "Hippius login challenge 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef nonce=42",
                "0x5b60b365fd891a791340058b6310d76e48157b0a72b79bbea20ded0b598ad0f8009b46671e02ea09f37c5ed2839a3acc83dcffbb9a71f5cef1c6db5cb2f47f021c",
            ),
            (
                "Hello World",
                "0x65e72b1cf8e189569963750e10ccb88fe89389daeeb8b735277d59cd6885ee823eb5a6982b540f185703492dab77b863a88ce01f27e21ade8b2879c10fc9e6531c",
            ),
        ];
        let mut seen_v = std::collections::BTreeSet::new();
        for (message, expected) in cases {
            let sig = signer.sign_message(message.as_bytes()).expect("sign");
            assert_eq!(sig, expected, "signature for {message:?}");
            let bytes = hex::decode(sig.strip_prefix("0x").expect("0x-prefixed")).expect("hex");
            assert_eq!(bytes.len(), 65, "r || s || v");
            seen_v.insert(bytes[64]);
            // Low-s (BIP-62 / EIP-2): s <= n/2.
            const HALF_N: [u8; 32] = [
                0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4,
                0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
            ];
            assert!(bytes[32..64] <= HALF_N[..], "high-s signature for {message:?}");
        }
        assert_eq!(seen_v.into_iter().collect::<Vec<_>>(), vec![27, 28], "both recovery bytes are covered");
    }

    /// `sign_message` is `sign_hash` over the EIP-191 digest. The digest of
    /// "Hello World" is a published constant
    /// (keccak256("\x19Ethereum Signed Message:\n11Hello World")), so this
    /// pins the prefix and the length encoding.
    #[test]
    fn sign_message_applies_the_eip191_prefix() {
        let signer = EvmSigner::from_phrase(TEST_PHRASE).expect("valid phrase");
        let digest = hex32("a1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2");
        assert_eq!(
            signer.sign_message(b"Hello World").expect("sign"),
            signer.sign_hash(&digest).expect("sign")
        );
    }

    /// A raw key, outside the phrase path. The addresses of secret key 1 and
    /// of `0x0123...0123` are published constants; the signatures by the
    /// latter are pinned.
    #[test]
    fn private_key_signer_matches_pinned_vectors() {
        let one = hex32("0000000000000000000000000000000000000000000000000000000000000001");
        assert_eq!(
            EvmSigner::from_private_key(&one).expect("valid key").address(),
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
        );

        let key = hex32("0123456789012345678901234567890123456789012345678901234567890123");
        let signer = EvmSigner::from_private_key(&key).expect("valid key");
        assert_eq!(signer.address(), "0x14791697260E4c9A71f18484C9f997B308e59325");
        assert_eq!(
            signer.sign_message(b"Hello World").expect("sign"),
            "0xe0ed34fbbe927a58267ce2e8067a611c69869e20e731bc99187a8bc97058664c16de07f7660f06ce0985d1d8e063726783033fda59b307897f26a21392d62b3a1c"
        );
        assert_eq!(
            signer.sign_hash(&hex32(&"11".repeat(32))).expect("sign"),
            "0x52b3774c49bda26d458c0eed1e3fdb146c8c331c24bd508f6ce1effa20aec38158309bc5daaaa9ae7e6ac4087d3ae7972796ebfa6f5af696a1e1b105bab1dfa91c"
        );
    }

    #[test]
    fn debug_output_never_contains_the_secret_key() {
        let signer = EvmSigner::from_phrase(TEST_PHRASE).expect("valid phrase");
        let shown = format!("{signer:?}");
        assert!(shown.contains("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
        assert!(
            !shown
                .to_lowercase()
                .contains("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
        );
    }

    #[test]
    fn zero_and_out_of_range_keys_are_refused() {
        assert!(EvmSigner::from_private_key(&[0u8; 32]).is_err());
        assert!(EvmSigner::from_private_key(&[0xff; 32]).is_err());
    }
}
