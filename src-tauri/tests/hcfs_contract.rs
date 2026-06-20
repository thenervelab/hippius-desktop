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
}
