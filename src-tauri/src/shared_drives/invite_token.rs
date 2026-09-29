//! Invite-token sealing — cross-client crypto so an invites panel can
//! re-show a link after the mint dialog closes.
//!
//! The server stores `blake3(token)` and, after seal-back, the token sealed
//! under the DRIVE key — ciphertext it cannot read. A client holding the
//! drive key opens the blob and rebuilds the link. Byte-compatible with
//! console `invite-token.ts` (hcfs #457/#458); KATs pin the wire format.
//!
//! Contract:
//! - **Key** = `HKDF-SHA256(ikm = folder_entropy, salt = invite_id UTF-8,
//!   info = "hippius-drive-invite-token-v1")`, 32 bytes.
//! - **Sealing** = XChaCha20-Poly1305, 24-byte random nonce, AAD = invite_id.
//! - **Payload** = the invite token UTF-8 bytes.
//! - **Wire** = `{ v, nonce, ciphertext }` JSON, base64 PADDED STANDARD.
//!
//! `open_invite_token` returns a token only when `blake3(token)` equals the
//! invite id — integrity the server cannot check because it cannot decrypt.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

pub const INFO_INVITE_TOKEN: &str = "hippius-drive-invite-token-v1";

const ENVELOPE_VERSION: u32 = 1;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const ENTROPY_LEN: usize = 32;
const MAX_BLOB_BYTES: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum InviteTokenError {
    #[error("{0}")]
    Message(String),
}

#[derive(Serialize, Deserialize)]
struct SealedInviteToken {
    v: u32,
    nonce: String,
    ciphertext: String,
}

/// `hex(blake3(token))` — the id the server files an invite under.
pub fn invite_id_for_token(token: &str) -> String {
    hex::encode(blake3::hash(token.as_bytes()).as_bytes())
}

fn derive_invite_token_key(folder_entropy: &[u8], invite_id: &str) -> Result<[u8; KEY_LEN], InviteTokenError> {
    if folder_entropy.len() != ENTROPY_LEN {
        return Err(InviteTokenError::Message(format!(
            "folder-key entropy must be 32 bytes, got {}",
            folder_entropy.len()
        )));
    }
    if invite_id.is_empty() {
        return Err(InviteTokenError::Message("invite id must not be empty".into()));
    }
    let hk = Hkdf::<Sha256>::new(Some(invite_id.as_bytes()), folder_entropy);
    let mut key = [0u8; KEY_LEN];
    hk.expand(INFO_INVITE_TOKEN.as_bytes(), &mut key)
        .map_err(|_| InviteTokenError::Message("HKDF expand failed".into()))?;
    Ok(key)
}

/// Seal `token` for invite `invite_id` under the drive key. Returns the
/// `sealed_token` wire string (standard padded base64).
pub fn seal_invite_token(folder_entropy: &[u8], invite_id: &str, token: &str) -> Result<String, InviteTokenError> {
    if token.is_empty() {
        return Err(InviteTokenError::Message("invite token must not be empty".into()));
    }
    let mut key = derive_invite_token_key(folder_entropy, invite_id)?;
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let result = (|| {
        let cipher = XChaCha20Poly1305::new((&key).into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: token.as_bytes(),
                    aad: invite_id.as_bytes(),
                },
            )
            .map_err(|_| InviteTokenError::Message("invite token seal failed".into()))?;

        let blob = SealedInviteToken {
            v: ENVELOPE_VERSION,
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        };
        let json = serde_json::to_vec(&blob).map_err(|e| InviteTokenError::Message(format!("seal serialize: {e}")))?;
        if json.len() > MAX_BLOB_BYTES {
            return Err(InviteTokenError::Message(format!(
                "sealed token exceeds the {MAX_BLOB_BYTES}-byte maximum"
            )));
        }
        Ok(STANDARD.encode(json))
    })();

    key.zeroize();
    nonce.zeroize();
    result
}

/// Open a listing blob. `None` on anything that is not a token this key
/// opens — malformed envelope, wrong drive key, blob lifted onto another
/// invite, corrupt row. Callers treat absence as "no copy control".
pub fn open_invite_token(folder_entropy: &[u8], invite_id: &str, wire: &str) -> Option<String> {
    let mut key = derive_invite_token_key(folder_entropy, invite_id).ok()?;
    let opened = (|| {
        // Base64 expands ~4/3; refuse absurdly large wire strings early.
        if wire.len() > MAX_BLOB_BYTES * 2 {
            return None;
        }
        let blob_bytes = STANDARD.decode(wire).ok()?;
        if blob_bytes.len() > MAX_BLOB_BYTES {
            return None;
        }
        let parsed: SealedInviteToken = serde_json::from_slice(&blob_bytes).ok()?;
        if parsed.v != ENVELOPE_VERSION {
            return None;
        }
        let nonce = STANDARD.decode(&parsed.nonce).ok()?;
        if nonce.len() != NONCE_LEN {
            return None;
        }
        let ciphertext = STANDARD.decode(&parsed.ciphertext).ok()?;

        let cipher = XChaCha20Poly1305::new((&key).into());
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: invite_id.as_bytes(),
                },
            )
            .ok()?;
        let token = String::from_utf8(plaintext).ok()?;
        if token.is_empty() {
            return None;
        }
        // Blob opened under this drive key for this row — still check it
        // holds the token the row stands for.
        if invite_id_for_token(&token) != invite_id {
            return None;
        }
        Some(token)
    })();
    key.zeroize();
    opened
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frozen blob from console `invite-token.test.ts` — must not be
    /// regenerated. Pins the wire format desktop opens against.
    const FROZEN_BLOB: &str = "eyJ2IjoxLCJub25jZSI6IkcrMi9BT3RqZUpjZmpDSDY2aTV4ejNzT3ZiakV6a2tzIiwiY2lwaGVydGV4dCI6InBkby8zZVN4Z09SU0xEb3JCZ3p6N09Nd0hEY0RIS3NJa3lFbUtnYUYrcktPSjhmWG84blVZbkFWb3J0NHZHbS91Q3dLZ3NYcHh3TTlNaFdXeW04PSJ9";

    const TOKEN: &str = "Zm9vYmFyLXRva2VuLXRoaXJ0eS10d28tYnl0ZXMtaGVyZQ";
    const INVITE_ID: &str = "e00dd34c4d774dff8293bbf26252ea18f0e0a0536beccc8d74b34276d9b24b33";

    fn entropy(fill: u8) -> [u8; 32] {
        [fill; 32]
    }

    #[test]
    fn invite_id_matches_console_blake3() {
        assert_eq!(invite_id_for_token(TOKEN), INVITE_ID);
    }

    #[test]
    fn round_trips_a_token() {
        let key = entropy(7);
        let sealed = seal_invite_token(&key, INVITE_ID, TOKEN).expect("seal");
        assert_eq!(open_invite_token(&key, INVITE_ID, &sealed).as_deref(), Some(TOKEN));
    }

    #[test]
    fn opens_frozen_blob_from_console() {
        assert_eq!(INFO_INVITE_TOKEN, "hippius-drive-invite-token-v1");
        assert_eq!(open_invite_token(&entropy(7), INVITE_ID, FROZEN_BLOB).as_deref(), Some(TOKEN));
    }

    #[test]
    fn refuses_blob_whose_token_does_not_hash_to_invite_id() {
        let key = entropy(7);
        let sealed = seal_invite_token(&key, INVITE_ID, "a-token-for-another-drive").expect("seal");
        assert!(open_invite_token(&key, INVITE_ID, &sealed).is_none());
    }

    #[test]
    fn does_not_open_under_different_drive_key() {
        let sealed = seal_invite_token(&entropy(7), INVITE_ID, TOKEN).expect("seal");
        assert!(open_invite_token(&entropy(8), INVITE_ID, &sealed).is_none());
    }

    #[test]
    fn does_not_open_against_different_invite_id() {
        let key = entropy(7);
        let sealed = seal_invite_token(&key, INVITE_ID, TOKEN).expect("seal");
        assert!(open_invite_token(&key, &"b".repeat(64), &sealed).is_none());
    }

    #[test]
    fn returns_none_on_junk() {
        let key = entropy(7);
        for junk in [
            "",
            "not base64!!",
            &STANDARD.encode(b"not json"),
            &STANDARD.encode(br#"{"v":1}"#),
            &STANDARD.encode(br#"{"v":99,"nonce":"AA==","ciphertext":"AA=="}"#),
            &STANDARD.encode(br#"{"v":1,"nonce":"AA==","ciphertext":"AA=="}"#),
        ] {
            assert!(open_invite_token(&key, INVITE_ID, junk).is_none(), "junk={junk}");
        }
    }

    #[test]
    fn stays_inside_server_512_byte_cap() {
        let sealed = seal_invite_token(&entropy(7), INVITE_ID, TOKEN).expect("seal");
        let decoded = STANDARD.decode(&sealed).expect("b64");
        assert!(decoded.len() <= MAX_BLOB_BYTES);
    }

    #[test]
    fn rejects_wrong_sized_entropy_and_empty_inputs() {
        assert!(seal_invite_token(&[0u8; 16], INVITE_ID, TOKEN).is_err());
        assert!(seal_invite_token(&entropy(7), INVITE_ID, "").is_err());
        assert!(seal_invite_token(&entropy(7), "", TOKEN).is_err());
    }
}
