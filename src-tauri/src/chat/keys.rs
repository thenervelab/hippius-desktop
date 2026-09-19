//! Secret-storage ("4S") key derivation for team chat.
//!
//! Matrix end-to-end encryption keeps three per-account secrets — the
//! cross-signing private keys, the room-key backup key, and the
//! secret-storage key that protects the other two. Element asks the user to
//! write down a 48-character recovery key for the last one; Hippius derives
//! it from the account mnemonic the app already holds, so a device that is
//! unlocked for files is also unlocked for chat, and a fresh install recovers
//! every message from the key backup the moment the mnemonic is available.
//!
//! The derivation is a **cross-client contract** with the Hippius web
//! console (`src/lib/chat/KEYS.md` there): both clients must produce the
//! same 32 bytes from the same mnemonic or the second one to sign in cannot
//! open the account's secret storage. The parameters below are therefore
//! frozen; changing any of them is a key rotation for every user.
//!
//! ```text
//! key = HKDF-SHA256(
//!         ikm  = UTF-8(mnemonic),
//!         salt = UTF-8("hippius-chat-4s-v1"),
//!         info = UTF-8("matrix-secret-storage"),
//!         L    = 32 bytes )
//! ```
//!
//! Note the input keying material is the **mnemonic sentence itself**, not
//! the BIP-39 seed. The console derives from the sentence, so the desktop
//! does too; deriving from the seed would give a different key and split the
//! account's secret storage between the two clients.
//!
//! `ikm` is the canonical BIP-39 sentence: lower-case words separated by
//! single ASCII spaces, no surrounding whitespace. The desktop's mnemonic
//! sources (`sync::mnemonic::get_mnemonic_for_account`) already hold it in
//! that form; [`canonical_mnemonic`] re-applies the rule defensively so a
//! copy that picked up a trailing newline or a double space still lands on
//! the same key as the console.
//!
//! ## Known-answer vectors (the contract, from the console's `KEYS.md` §6)
//!
//! Mnemonic → key, lower-case hex. Vectors 1 and 3 are BIP-39 test
//! sentences; vector 2 has an invalid checksum on purpose — derivation does
//! not validate the phrase. `matches_console_known_answer_vectors` asserts
//! all three; the console's `keys.test.ts` asserts the same values, so a
//! change on either side fails a test before it forks secret storage.
//!
//! ```text
//! 1. "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
//!    28d1f8d8dd187fc10d89f4be00cde682049b0b60b234b070d02775454168b235
//! 2. "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
//!    0574e00d1a7803573e3ca5bed4d7cb4115b1de94c8019006c32d5fc1d0e1c078
//! 3. "legal winner thank year wave sausage worth useful legal winner thank yellow"
//!    5826f15b60ebb22aba735b6003eaef32d13eda1085c3fff213088b6a5b99744f
//! ```
//!
//! Reproduce vector 1 independently of both code bases:
//! `openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt key:"<mnemonic>"
//! -kdfopt salt:hippius-chat-4s-v1 -kdfopt info:matrix-secret-storage HKDF`.
//!
//! The console's `crypto/secret-storage-keys.ts` and `constants.ts` carry
//! the same id ([`CHAT_4S_KEY_ID`]) and display name ([`CHAT_4S_KEY_NAME`])
//! under which the key is published in account data.

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

/// HKDF salt. Versioned: a `v2` derivation would use a new salt and a
/// migration that re-encrypts secret storage. Never change silently.
pub const CHAT_4S_HKDF_SALT: &str = "hippius-chat-4s-v1";

/// HKDF info. Fixed domain separation from the other mnemonic-derived keys
/// (file keys, share grants) so the chat key is unrelated to all of them.
pub const CHAT_4S_HKDF_INFO: &str = "matrix-secret-storage";

/// Key size for `m.secret_storage.v1.aes-hmac-sha2`.
pub const CHAT_4S_KEY_LENGTH_BYTES: usize = 32;

/// Fixed, human-readable id under which the derived key is published in
/// account data (`m.secret_storage.key.<id>`), so a second device can tell
/// "this is the Hippius-derived key" before trying it. Shared with the
/// console — both clients must address the same key.
pub const CHAT_4S_KEY_ID: &str = "hippius-console-v1";

/// Display name stored in the key description on the server. Identical to
/// the console's so whichever client publishes the key first, the
/// description is byte-for-byte the same (matching is by id; the name is
/// what Element-style clients show in their "verify with recovery key"
/// prompts). No `passphrase` block accompanies it: the key is not
/// passphrase-derived in the Matrix sense, and publishing the HKDF
/// parameters as one would invite other clients to prompt for the mnemonic
/// as if it were a password.
pub const CHAT_4S_KEY_NAME: &str = "Hippius Console recovery key";

/// Canonical BIP-39 form of a mnemonic sentence: lower-case, words joined by
/// a single ASCII space, no leading or trailing whitespace.
///
/// The console applies no normalisation at derivation time because its
/// mnemonic atom already holds the canonical form. The desktop's sources do
/// too, but a mnemonic that crossed a file or a clipboard may carry a
/// trailing newline; collapsing whitespace is idempotent on an already
/// canonical sentence, so this cannot move a correct input off the console's
/// key — only bring a sloppy copy back onto it.
pub fn canonical_mnemonic(mnemonic: &str) -> Zeroizing<String> {
    let mut out = String::with_capacity(mnemonic.len());
    for (i, word) in mnemonic.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        for ch in word.chars() {
            out.extend(ch.to_lowercase());
        }
    }
    Zeroizing::new(out)
}

/// Derive the 32-byte secret-storage private key from the mnemonic.
///
/// Returns a zeroizing buffer; the caller gets the only copy and it is
/// scrubbed on drop. The canonicalised intermediate is scrubbed here.
pub fn derive_secret_storage_key(mnemonic: &str) -> Zeroizing<[u8; CHAT_4S_KEY_LENGTH_BYTES]> {
    let ikm = canonical_mnemonic(mnemonic);
    let hk = Hkdf::<Sha256>::new(Some(CHAT_4S_HKDF_SALT.as_bytes()), ikm.as_bytes());
    let mut okm = Zeroizing::new([0u8; CHAT_4S_KEY_LENGTH_BYTES]);
    hk.expand(CHAT_4S_HKDF_INFO.as_bytes(), okm.as_mut())
        .expect("32 bytes is far below the HKDF-SHA256 output bound (255 * 32)");
    okm
}

/// The derived key encoded for transport to the webview, where the Matrix
/// SDK consumes it. Base64 (standard alphabet, padded) rather than hex so
/// the decode on the other side is one `atob` and the encoded form is not
/// mistaken for a Matrix recovery key (which is base58).
pub fn encode_key_for_ipc(key: &[u8; CHAT_4S_KEY_LENGTH_BYTES]) -> Zeroizing<String> {
    use base64::Engine as _;
    Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(key))
}

/// Result of [`chat_derive_secret_storage_key`].
///
/// The key crosses the IPC boundary once per chat unlock and lives only in
/// the webview's heap after that (`secret-storage-keys.ts` mirrors the
/// console: never IndexedDB, never localStorage, never the server).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStorageKeyMaterial {
    /// Base64 of the 32-byte key.
    pub key_base64: String,
    /// [`CHAT_4S_KEY_ID`], so the webview and Rust cannot disagree on it.
    pub key_id: &'static str,
    /// [`CHAT_4S_KEY_NAME`].
    pub key_name: &'static str,
}

impl Drop for SecretStorageKeyMaterial {
    fn drop(&mut self) {
        self.key_base64.zeroize();
    }
}

/// Derive the secret-storage key for the active account.
///
/// Resolves the mnemonic through the same chain every other mnemonic
/// consumer uses (`get_mnemonic_for_account`: memory → encrypted master on
/// disk → drive export → DB), so an account that can sync files can unlock
/// chat with no extra prompt. Fails with the chain's own typed errors — in
/// particular `NotReady(MasterMnemonicUnrecoverable)` — which the chat UI
/// maps to "unlock with your seed phrase".
#[tauri::command]
pub async fn chat_derive_secret_storage_key(state: tauri::State<'_, crate::app_state::AppState>) -> crate::error::Result<SecretStorageKeyMaterial> {
    let account_id = state.current_account_id()?;
    let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(&state, &account_id).await?;
    let key = derive_secret_storage_key(&mnemonic);
    let key_base64 = encode_key_for_ipc(&key);
    Ok(SecretStorageKeyMaterial {
        key_base64: key_base64.to_string(),
        key_id: CHAT_4S_KEY_ID,
        key_name: CHAT_4S_KEY_NAME,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
    }

    /// Known-answer vectors from the console's `KEYS.md` §6. These are the
    /// cross-client contract: a desktop that fails any of them cannot open
    /// secret storage the console created, and vice versa.
    #[test]
    fn matches_console_known_answer_vectors() {
        let vectors = [
            (
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                "28d1f8d8dd187fc10d89f4be00cde682049b0b60b234b070d02775454168b235",
            ),
            // Invalid checksum on purpose: derivation does not validate the phrase.
            (
                "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
                "0574e00d1a7803573e3ca5bed4d7cb4115b1de94c8019006c32d5fc1d0e1c078",
            ),
            (
                "legal winner thank year wave sausage worth useful legal winner thank yellow",
                "5826f15b60ebb22aba735b6003eaef32d13eda1085c3fff213088b6a5b99744f",
            ),
        ];
        for (mnemonic, expected) in vectors {
            assert_eq!(hex(derive_secret_storage_key(mnemonic).as_ref()), expected, "vector for {mnemonic:?}");
        }
    }

    /// The IKM is the sentence, not the seed: deriving from the BIP-39 seed
    /// of vector 1 must NOT reproduce the console's key. Guards against a
    /// well-meaning "fix" that swaps in the seed and silently forks the
    /// account's secret storage between the two clients.
    #[test]
    fn ikm_is_the_sentence_not_the_seed() {
        let sentence = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let seed = bip39::Mnemonic::parse_normalized(sentence).expect("valid test mnemonic").to_seed("");
        let hk = Hkdf::<Sha256>::new(Some(CHAT_4S_HKDF_SALT.as_bytes()), &seed);
        let mut from_seed = [0u8; CHAT_4S_KEY_LENGTH_BYTES];
        hk.expand(CHAT_4S_HKDF_INFO.as_bytes(), &mut from_seed).unwrap();
        assert_ne!(hex(&from_seed), "28d1f8d8dd187fc10d89f4be00cde682049b0b60b234b070d02775454168b235");
    }

    #[test]
    fn canonicalisation_is_idempotent_and_repairs_sloppy_copies() {
        let canonical = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        assert_eq!(canonical_mnemonic(canonical).as_str(), canonical);
        assert_eq!(
            canonical_mnemonic("  Legal  winner\tthank year\nwave sausage worth useful legal winner thank YELLOW\n").as_str(),
            canonical
        );
        // And therefore the sloppy copy lands on the console's key.
        assert_eq!(
            hex(derive_secret_storage_key(" legal winner thank year wave sausage worth useful legal winner thank yellow\n").as_ref()),
            "5826f15b60ebb22aba735b6003eaef32d13eda1085c3fff213088b6a5b99744f"
        );
    }

    #[test]
    fn different_mnemonics_give_different_keys() {
        let a = derive_secret_storage_key("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong");
        let b = derive_secret_storage_key("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo");
        assert_ne!(a.as_ref(), b.as_ref());
    }

    #[test]
    fn ipc_encoding_round_trips() {
        use base64::Engine as _;
        let key = derive_secret_storage_key("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong");
        let encoded = encode_key_for_ipc(&key);
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).unwrap();
        assert_eq!(decoded.as_slice(), key.as_ref());
    }
}
