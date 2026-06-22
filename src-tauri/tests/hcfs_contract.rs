//! Golden-vector (known-answer) regression tests pinning the deterministic
//! output of the hcfs-client identity/crypto functions the desktop depends on.
//!
//! The IPC wire-contract guards (sync/events.rs, sync/tauri_bridge.rs) pin the
//! JSON *shape* an hcfs bump must not change. These pin the *values* three
//! pure functions must keep producing:
//!
//! - `folder_hash(label)` — the server namespace + on-disk subdir for a drive.
//! - `derive_folder_mnemonic(master, label)` — the per-folder BIP-39 identity.
//! - `derive_encryption_key(master, label)` — the per-folder content key.
//!
//! All three are deterministic over (master, label). If an hcfs bump changed
//! any of these algorithms, every existing user's data would silently become
//! undecryptable / their server identity would move — the data-loss class that
//! a wire-shape test cannot catch. A known-answer test catches it: the expected
//! values below were captured from the current pinned rev, so a drift fails here
//! BEFORE the bump ships. If you change an algorithm ON PURPOSE, regenerate the
//! goldens deliberately and document the migration.

use hcfs_client::crypto::{decrypt_small, encrypt_small};
use hcfs_client::drive::keys::{derive_folder_mnemonic, folder_hash};
use hcfs_client::drive::remote::derive_encryption_key;
use proptest::prelude::*;

/// Canonical public BIP-39 zero-vector ("entropy = all zeros"). A well-known
/// test mnemonic — NEVER a real wallet — safe to commit as a fixture.
const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn folder_hash_is_pinned() {
    // Real labels plus two external-boundary edges (empty + unicode): the
    // function hashes `label.as_bytes()`, so these probe its documented domain.
    assert_eq!(folder_hash("default"), "37a8eec1ce19687d", "folder_hash(\"default\") drifted");
    assert_eq!(folder_hash("alpha"), "8ed3f6ad685b959e", "folder_hash(\"alpha\") drifted");
    assert_eq!(folder_hash(""), "e3b0c44298fc1c14", "folder_hash(\"\") drifted");
    assert_eq!(folder_hash("Über/Δrive"), "4f768ad9fa301d1c", "folder_hash(unicode) drifted");

    // Per-folder uniqueness is the security property the namespace relies on.
    assert_ne!(folder_hash("alpha"), folder_hash("beta"), "distinct labels must hash distinctly");
}

#[test]
fn derive_folder_mnemonic_is_pinned() {
    let alpha = derive_folder_mnemonic(TEST_MNEMONIC, "alpha").expect("derive folder mnemonic");
    assert_eq!(
        alpha,
        "charge random negative trouble surprise sample suffer company unusual sound code rhythm prize much reveal link local morning clarify one cigar spare paddle hat",
        "derive_folder_mnemonic(master, \"alpha\") drifted"
    );

    // Deterministic: same (master, label) → same mnemonic (re-encryption relies on this).
    assert_eq!(
        derive_folder_mnemonic(TEST_MNEMONIC, "alpha").expect("re-derive"),
        alpha,
        "derive_folder_mnemonic must be deterministic"
    );
    // Per-folder distinct identity.
    assert_ne!(
        derive_folder_mnemonic(TEST_MNEMONIC, "beta").expect("beta"),
        alpha,
        "distinct labels must derive distinct folder mnemonics"
    );
}

#[test]
fn derive_encryption_key_is_pinned() {
    let alpha = derive_encryption_key(TEST_MNEMONIC, "alpha").expect("derive encryption key");
    assert_eq!(
        hex::encode(alpha),
        "b8a5eaafb059a3ed9860023f33622205851004ea2ee3750bb2b5c06653b45eec",
        "derive_encryption_key(master, \"alpha\") drifted"
    );

    // Deterministic over (master, label).
    assert_eq!(
        derive_encryption_key(TEST_MNEMONIC, "alpha").expect("re-derive"),
        alpha,
        "derive_encryption_key must be deterministic"
    );
    // Per-folder distinct key — the isolation property at-rest encryption needs.
    assert_ne!(
        derive_encryption_key(TEST_MNEMONIC, "beta").expect("beta"),
        alpha,
        "distinct labels must derive distinct content keys"
    );
}

proptest! {
    /// Format invariant across the whole label input space: `folder_hash` is
    /// always 16 lowercase-hex chars and deterministic. Hand-picked KATs above
    /// pin specific values; this pins the shape for inputs the author didn't list.
    #[test]
    fn folder_hash_format_invariant(label in ".*") {
        let h = folder_hash(&label);
        prop_assert_eq!(h.len(), 16, "folder_hash must be 16 chars");
        prop_assert!(h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "must be lowercase hex: {}", h);
        prop_assert_eq!(folder_hash(&label), h, "folder_hash must be deterministic");
    }

    /// `derive_encryption_key` determinism across the realistic label space (the
    /// golden above pins only "alpha"). The security property at-rest encryption
    /// relies on is per-`(master, label)` stability — a non-deterministic key
    /// would make a file written one launch undecryptable the next.
    #[test]
    fn derive_encryption_key_is_deterministic(label in "[A-Za-z0-9 _/.-]{0,64}") {
        let a = derive_encryption_key(TEST_MNEMONIC, &label).expect("derive");
        let b = derive_encryption_key(TEST_MNEMONIC, &label).expect("re-derive");
        prop_assert_eq!(a, b);
    }

    /// At-rest round-trip over arbitrary plaintext: `decrypt(encrypt(x)) == x`.
    /// The shrinker probes lengths and byte patterns the fixed fixtures below
    /// miss — an off-by-one in chunk framing surfaces here. Bounded under the
    /// 256 KiB chunk size so each case is a single chunk (fast).
    #[test]
    fn at_rest_round_trips_any_plaintext(plaintext in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let key = enc_key_alpha();
        let ciphertext = encrypt_small(&plaintext, &key).expect("encrypt");
        let decrypted = decrypt_small(&ciphertext, &key).expect("decrypt");
        prop_assert_eq!(decrypted, plaintext);
    }
}

// ── At-rest AEAD decrypt known-answer tests ────────────────────────────────
//
// The golden vectors above pin the deterministic KEY-DERIVATION functions. These
// pin the at-rest ENCRYPTION FORMAT itself — the XChaCha20-Poly1305 streaming
// layout (`[nonce:24][chunk_count:u32][len:u32][ciphertext][tag:16]`) the
// desktop's `download_remote_file` uses to decrypt every user file. A wire-shape
// test cannot see a format change here; this is the data-loss guard.

/// The per-folder content key for label `"alpha"` under the canonical test
/// mnemonic — the exact value pinned by `derive_encryption_key_is_pinned`.
/// Hardcoded (not re-derived) so this KAT isolates the at-rest AEAD format from
/// the key-derivation algorithm, which has its own golden above.
const ENC_KEY_ALPHA_HEX: &str = "b8a5eaafb059a3ed9860023f33622205851004ea2ee3750bb2b5c06653b45eec";

/// Fixed plaintext for the at-rest decrypt KATs.
const KAT_PLAINTEXT: &[u8] = b"hippius hcfs at-rest decrypt KAT v1";

/// One ciphertext of `KAT_PLAINTEXT` under `ENC_KEY_ALPHA`, captured at the pinned
/// hcfs rev `829ceb67`. The XChaCha20-Poly1305 nonce is random per encrypt, so
/// this is a single frozen instance — but `decrypt_small` of it is deterministic.
/// If an hcfs bump changes the streaming at-rest format (header layout, chunk
/// framing, nonce derivation, AEAD construction), every already-uploaded user file
/// becomes undecryptable and THIS test fails before the bump ships. Regenerate
/// deliberately — and ship a migration — only when changing the format on purpose.
const FROZEN_CIPHERTEXT_HEX: &str = "b76413f1c1633749ed02dfaee004b11d44a8126ee12f0ed10100000033000000cfd276eb49236f6c3a83df13c42a769f2c478a0415ae380801be09e0d30c1052eb4bf1a090bba946bc2d284f7e621ee0137eb2";

fn enc_key_alpha() -> [u8; 32] {
    hex::decode(ENC_KEY_ALPHA_HEX)
        .expect("valid hex key")
        .try_into()
        .expect("32-byte key")
}

#[test]
fn at_rest_decrypt_frozen_ciphertext_is_pinned() {
    let key = enc_key_alpha();
    let ciphertext = hex::decode(FROZEN_CIPHERTEXT_HEX).expect("valid frozen ciphertext hex");
    let plaintext = decrypt_small(&ciphertext, &key).expect("a file encrypted at the pinned rev must still decrypt");
    assert_eq!(
        plaintext, KAT_PLAINTEXT,
        "at-rest format drifted: a file encrypted at the pinned hcfs rev no longer decrypts to its plaintext"
    );
}
