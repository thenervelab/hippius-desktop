//! The Ethereum (secp256k1) half of a wallet login.
//!
//! The Hippius API authenticates a recovery-phrase account with two
//! signatures over the same challenge: an sr25519 one by the Substrate key
//! (`service::sign_challenge_sr25519`) and an EIP-191 `personal_sign` one by
//! the Ethereum key derived from the same phrase at `m/44'/60'/0'/0/0`. This
//! module owns the second. Its outputs are what the server has on record for
//! every existing account, so the tests below pin them byte for byte: a
//! different address or signature for the same phrase would lock the user out.
//!
//! Built directly on `k256` 0.14 (RFC 6979 deterministic ECDSA, low-s) rather
//! than alloy: every alloy release, up to and including 2.x, pins `k256` /
//! `elliptic-curve` 0.13, whose `crypto-bigint` 0.5 carries RUSTSEC-2026-0387
//! with no patched 0.5 release. The pieces alloy supplied are small and
//! standard (BIP-39 seed, BIP-32 private derivation, Keccak-256, EIP-55,
//! EIP-191), and each is checked below against published vectors.

use hmac::{Hmac, Mac};
use k256::Scalar;
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::PrimeField;
use sha2::Sha512;
use sha3::{Digest, Keccak256};
use subxt_signer::bip39::{Language, Mnemonic};
use zeroize::Zeroize;

/// BIP-32 hardened-index offset (`i'` is `i + 2^31`).
const HARDENED: u32 = 0x8000_0000;
/// `m/44'/60'/0'/0/0`: BIP-44, coin type 60 (Ethereum), account 0, external
/// chain, address index 0. The only path the login flow has ever used.
const ACCOUNT_ZERO_PATH: [u32; 5] = [HARDENED + 44, HARDENED + 60, HARDENED, 0, 0];

/// A secp256k1 signing key plus its Ethereum address. `SigningKey` wipes
/// the secret on drop.
pub(crate) struct EvmSigner {
    key: SigningKey,
    address: String,
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
    /// rather than normalized, which is what the login flow has always done
    /// (the previous signer compared the input against its own rendering
    /// of the phrase, and so does this).
    pub(crate) fn from_phrase(phrase: &str) -> Result<Self, String> {
        const INVALID: &str = "Invalid BIP-39 mnemonic for the Ethereum key";
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, phrase).map_err(|_| INVALID.to_string())?;
        if mnemonic.to_string() != phrase {
            return Err(INVALID.to_string());
        }
        let mut seed = mnemonic.to_seed_normalized("");
        let key = derive_bip32(&seed, &ACCOUNT_ZERO_PATH);
        seed.zeroize();
        Ok(Self::from_key(key?))
    }

    /// A signer for a raw 32-byte secret key.
    #[cfg(test)]
    pub(crate) fn from_private_key(secret: &[u8; 32]) -> Result<Self, String> {
        let key = SigningKey::from_slice(secret).map_err(|_| "Invalid secp256k1 secret key".to_string())?;
        Ok(Self::from_key(key))
    }

    fn from_key(key: SigningKey) -> Self {
        let address = checksum_address(&key);
        Self { key, address }
    }

    /// The secret key's 32 big-endian bytes.
    #[cfg(test)]
    pub(crate) fn private_key_bytes(&self) -> [u8; 32] {
        self.key.to_bytes().into()
    }

    /// The EIP-55 checksummed address, `0x`-prefixed.
    pub(crate) fn address(&self) -> String {
        self.address.clone()
    }

    /// EIP-191 `personal_sign` over `message`: the 65-byte `r || s || v`
    /// signature (low-s, `v` = 27 or 28) as `0x` + 130 lowercase hex.
    pub(crate) fn sign_message(&self, message: &[u8]) -> Result<String, String> {
        self.sign_hash(&eip191_hash(message))
    }

    /// Sign a 32-byte digest as-is (no EIP-191 prefix), same encoding as
    /// [`Self::sign_message`].
    pub(crate) fn sign_hash(&self, hash: &[u8; 32]) -> Result<String, String> {
        // RFC 6979 nonce, s normalized to the low half with the recovery id
        // flipped to match (k256's secp256k1 sets NORMALIZE_S).
        let (sig, recovery_id) = self.key.sign_prehash_recoverable(hash);
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.to_bytes());
        // Ethereum's legacy `v`: 27 + y-parity. The "x reduced" bit of the
        // recovery id is not encoded, as before.
        out[64] = 27 + u8::from(recovery_id.is_y_odd());
        Ok(format!("0x{}", hex::encode(out)))
    }
}

/// keccak256("\x19Ethereum Signed Message:\n" + decimal byte length + message).
pub(crate) fn eip191_hash(message: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(b"\x19Ethereum Signed Message:\n");
    hasher.update(message.len().to_string().as_bytes());
    hasher.update(message);
    hasher.finalize().into()
}

/// The EIP-55 mixed-case address: the last 20 bytes of keccak256 of the
/// uncompressed public key (without its 0x04 tag), each hex letter
/// uppercased where the matching nibble of keccak256(lowercase hex) is >= 8.
fn checksum_address(key: &SigningKey) -> String {
    let point = key.verifying_key().to_sec1_point(false);
    let digest = Keccak256::digest(&point.as_bytes()[1..]);
    let lower = hex::encode(&digest[12..]);
    let check = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = if i % 2 == 0 { check[i / 2] >> 4 } else { check[i / 2] & 0x0f };
        out.push(if nibble >= 8 { c.to_ascii_uppercase() } else { c });
    }
    out
}

fn hmac_sha512(key: &[u8], parts: &[&[u8]]) -> [u8; 64] {
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    for part in parts {
        mac.update(part);
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

/// BIP-32 private-key derivation from a seed along `path` (indices at or
/// above [`HARDENED`] are hardened). Errors on the "invalid key, try the
/// next index" cases (I_L >= n or a zero child), which have probability
/// about 2^-127; the previous signer refused them too.
fn derive_bip32(seed: &[u8], path: &[u32]) -> Result<SigningKey, String> {
    let mut i = hmac_sha512(b"Bitcoin seed", &[seed]);
    let master = SigningKey::from_slice(&i[..32]);
    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&i[32..]);
    i.zeroize();
    let mut key = master.map_err(|_| "BIP-32 derivation produced an invalid key".to_string())?;

    for &index in path {
        let mut i = if index >= HARDENED {
            let mut secret: [u8; 32] = key.to_bytes().into();
            let out = hmac_sha512(&chain_code, &[&[0u8], &secret, &index.to_be_bytes()]);
            secret.zeroize();
            out
        } else {
            let public = key.verifying_key().to_sec1_point(true);
            hmac_sha512(&chain_code, &[public.as_bytes(), &index.to_be_bytes()])
        };
        let mut tweak_bytes = k256::FieldBytes::default();
        tweak_bytes.copy_from_slice(&i[..32]);
        chain_code.copy_from_slice(&i[32..]);
        i.zeroize();
        let tweak = Option::<Scalar>::from(Scalar::from_repr(tweak_bytes));
        tweak_bytes.zeroize();
        let tweak = tweak.ok_or_else(|| "BIP-32 derivation produced an out-of-range key".to_string())?;
        let child = tweak + key.as_nonzero_scalar().as_ref();
        key = SigningKey::from_bytes(&child.to_bytes()).map_err(|_| "BIP-32 derivation produced an invalid key".to_string())?;
    }
    chain_code.zeroize();
    Ok(key)
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

/// Checks for the pieces this module implements itself, against published
/// vectors, on top of the end-to-end pins in `tests`.
#[cfg(test)]
mod primitive_tests {
    use super::{HARDENED, derive_bip32, eip191_hash};

    /// BIP-32 test vector 1 (seed 000102...0f), private keys along
    /// m/0'/1/2'/2/1000000000: hardened and non-hardened steps, and an
    /// index above 2^29.
    #[test]
    fn bip32_matches_test_vector_1() {
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").expect("hex");
        let cases: [(&[u32], &str); 6] = [
            (&[], "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35"),
            (&[HARDENED], "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea"),
            (&[HARDENED, 1], "3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368"),
            (
                &[HARDENED, 1, HARDENED + 2],
                "cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca",
            ),
            (
                &[HARDENED, 1, HARDENED + 2, 2],
                "0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4",
            ),
            (
                &[HARDENED, 1, HARDENED + 2, 2, 1_000_000_000],
                "471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8",
            ),
        ];
        for (path, expected) in cases {
            let key = derive_bip32(&seed, path).expect("derives");
            assert_eq!(hex::encode(key.to_bytes()), expected, "path {path:?}");
        }
    }

    /// keccak256("\x19Ethereum Signed Message:\n11Hello World"), a
    /// published constant; and the empty message, whose length is "0".
    #[test]
    fn eip191_hash_matches_published_digests() {
        assert_eq!(
            hex::encode(eip191_hash(b"Hello World")),
            "a1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2"
        );
        assert_ne!(eip191_hash(b""), eip191_hash(b"0"), "length prefix separates messages");
    }
}
