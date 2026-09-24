//! Emailed-invite key sealing: how a drive key reaches somebody invited by
//! email without the server ever holding it (hcfs #459).
//!
//! A link invite carries the drive key in its `#k=` fragment, which never
//! reaches a server. A MAILED invite cannot: the server composes the message,
//! so the mail carries only the token. The recipient's client publishes an
//! ephemeral X25519 public key on the invite (`key-request`), and a manager's
//! client (this module) seals the drive key to it.
//!
//! Byte-compatible with the console's `src/lib/shared-drives/invite-key-seal.ts`;
//! the known-answer vector below is copied from its test and must never be
//! regenerated.
//!
//! Contract:
//! - **Agreement** = X25519(fresh ephemeral secret, recipient public key); the
//!   ephemeral public half travels in the blob as `epk`.
//! - **Key** = `HKDF-SHA256(ikm = shared secret, salt = invite_id UTF-8,
//!   info = "hippius-drive-invite-key-v1")`, 32 bytes.
//! - **Sealing** = XChaCha20-Poly1305, 24-byte random nonce, AAD = invite_id.
//! - **Payload** = the 32-byte folder-key ENTROPY (what a link's `#k=` carries).
//! - **Wire** = `{ v: 1, epk, nonce, ciphertext }` JSON, each field standard
//!   padded base64, the whole JSON standard padded base64.
//!
//! The entropy sealed here must be the DRIVE's (resolved like the link mint
//! resolves it), never derived from the sealing manager's own master: a
//! manager's mnemonic derives a different folder key, and sealing that would
//! admit the recipient to a drive whose files they cannot decrypt.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

pub const INFO_INVITE_KEY: &str = "hippius-drive-invite-key-v1";

const ENVELOPE_VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const ENTROPY_LEN: usize = 32;
/// The server refuses anything larger (`MAX_SEALED_KEY_BYTES`).
const MAX_BLOB_BYTES: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum InviteKeyError {
    #[error("{0}")]
    Message(String),
}

/// Field ORDER is part of the wire: the console serialises
/// `{v, epk, nonce, ciphertext}` and the KAT pins the resulting bytes.
#[derive(Serialize, Deserialize)]
struct InviteKeyEnvelope {
    v: u32,
    epk: String,
    nonce: String,
    ciphertext: String,
}

fn derive_key(shared: &[u8; 32], invite_id: &str) -> Result<[u8; KEY_LEN], InviteKeyError> {
    if invite_id.is_empty() {
        return Err(InviteKeyError::Message("invite id must not be empty".into()));
    }
    let hk = Hkdf::<Sha256>::new(Some(invite_id.as_bytes()), shared);
    let mut key = [0u8; KEY_LEN];
    hk.expand(INFO_INVITE_KEY.as_bytes(), &mut key)
        .map_err(|_| InviteKeyError::Message("HKDF expand failed".into()))?;
    Ok(key)
}

fn decode_key(b64: &str, what: &str) -> Result<[u8; 32], InviteKeyError> {
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|_| InviteKeyError::Message(format!("{what} is not base64")))?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| InviteKeyError::Message(format!("{what} must be 32 bytes, got {}", bytes.len())))
}

/// Seal the drive key for the recipient who published `requester_pubkey_b64`
/// on invite `invite_id`. Returns the `sealed_key` wire string.
pub fn seal_invite_key(folder_entropy: &[u8], requester_pubkey_b64: &str, invite_id: &str) -> Result<String, InviteKeyError> {
    let mut ephemeral = [0u8; 32];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut ephemeral);
    OsRng.fill_bytes(&mut nonce);
    let sealed = seal_invite_key_with(folder_entropy, requester_pubkey_b64, invite_id, ephemeral, nonce);
    ephemeral.zeroize();
    sealed
}

/// [`seal_invite_key`] with the randomness injected. Real callers never use
/// this directly; it exists so the known-answer vector can pin the bytes.
fn seal_invite_key_with(
    folder_entropy: &[u8],
    requester_pubkey_b64: &str,
    invite_id: &str,
    ephemeral_secret: [u8; 32],
    nonce: [u8; NONCE_LEN],
) -> Result<String, InviteKeyError> {
    if folder_entropy.len() != ENTROPY_LEN {
        return Err(InviteKeyError::Message(format!(
            "folder-key entropy must be 32 bytes, got {}",
            folder_entropy.len()
        )));
    }
    let requester = PublicKey::from(decode_key(requester_pubkey_b64, "recipient key")?);
    let secret = StaticSecret::from(ephemeral_secret);
    let epk = PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&requester);
    let mut key = derive_key(shared.as_bytes(), invite_id)?;

    let result = (|| {
        let cipher = XChaCha20Poly1305::new((&key).into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: folder_entropy,
                    aad: invite_id.as_bytes(),
                },
            )
            .map_err(|_| InviteKeyError::Message("invite key seal failed".into()))?;
        let envelope = InviteKeyEnvelope {
            v: ENVELOPE_VERSION,
            epk: STANDARD.encode(epk.as_bytes()),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        };
        let json = serde_json::to_vec(&envelope).map_err(|e| InviteKeyError::Message(format!("seal serialize: {e}")))?;
        if json.len() > MAX_BLOB_BYTES {
            return Err(InviteKeyError::Message(format!("sealed key exceeds the {MAX_BLOB_BYTES}-byte maximum")));
        }
        Ok(STANDARD.encode(json))
    })();
    key.zeroize();
    result
}

/// Open a `sealed_key` with the recipient's secret. The desktop never
/// receives emailed invites (joining stays in the console), so this exists
/// to prove the seal round-trips and to pin the console's blob.
#[cfg(test)]
fn open_invite_key(sealed_key_b64: &str, secret_key: [u8; 32], invite_id: &str) -> Result<[u8; 32], InviteKeyError> {
    let raw = STANDARD
        .decode(sealed_key_b64)
        .map_err(|_| InviteKeyError::Message("sealed key is not base64".into()))?;
    if raw.len() > MAX_BLOB_BYTES {
        return Err(InviteKeyError::Message("sealed key is larger than any real one".into()));
    }
    let envelope: InviteKeyEnvelope = serde_json::from_slice(&raw).map_err(|_| InviteKeyError::Message("sealed key is not an envelope".into()))?;
    if envelope.v != ENVELOPE_VERSION {
        return Err(InviteKeyError::Message(format!("unsupported sealed key version {}", envelope.v)));
    }
    let epk = PublicKey::from(decode_key(&envelope.epk, "sealer key")?);
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| InviteKeyError::Message("nonce is not base64".into()))?;
    if nonce.len() != NONCE_LEN {
        return Err(InviteKeyError::Message("sealed key nonce has the wrong length".into()));
    }
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| InviteKeyError::Message("ciphertext is not base64".into()))?;
    let secret = StaticSecret::from(secret_key);
    let shared = secret.diffie_hellman(&epk);
    let key = derive_key(shared.as_bytes(), invite_id)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: invite_id.as_bytes(),
            },
        )
        .map_err(|_| InviteKeyError::Message("sealed key does not open with this invite".into()))?;
    <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| InviteKeyError::Message("sealed key did not hold a drive key".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Copied VERBATIM from the console's `invite-key-seal.test.ts` (computed
    // there independently of either client). Never regenerate these: a
    // mismatch means a manager on one client seals a key a recipient on the
    // other cannot open.
    const KAT_TOKEN: &str = "tok_kat_v1";
    const KAT_INVITE_ID: &str = "c14bc14a2dff24a67a9525cc620f92a188aacbdf37a8354cccfc4c862fba3484";
    const KAT_REQUESTER_PUBKEY: &str = "e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM=";
    const KAT_SEALED_KEY: &str = "eyJ2IjoxLCJlcGsiOiJENnBvVHRLSVo3bC9TbW90N2wzNHpwZE9kcmNCamo4aW9jVFBKbmhYRHlBPSIsIm5vbmNlIjoiTXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXoiLCJjaXBoZXJ0ZXh0IjoiV0M5cStXSW1WQndhemJuUmJVL05lVVpBaUNlSVo2YWVRMllTZGNBQmN1M3BJc1BmWGZUaEdyeW1zWVVONk5jcSJ9";

    fn kat_entropy() -> [u8; 32] {
        let mut e = [0u8; 32];
        for (i, b) in e.iter_mut().enumerate() {
            *b = i as u8;
        }
        e
    }

    #[test]
    fn kat_invite_id_is_the_servers() {
        assert_eq!(super::super::invite_token::invite_id_for_token(KAT_TOKEN), KAT_INVITE_ID);
    }

    #[test]
    fn kat_recipient_public_key() {
        let public = PublicKey::from(&StaticSecret::from([0x11u8; 32]));
        assert_eq!(STANDARD.encode(public.as_bytes()), KAT_REQUESTER_PUBKEY);
    }

    #[test]
    fn kat_seals_to_exactly_the_console_bytes() {
        let sealed = seal_invite_key_with(&kat_entropy(), KAT_REQUESTER_PUBKEY, KAT_INVITE_ID, [0x22; 32], [0x33; 24]).expect("seal");
        assert_eq!(sealed, KAT_SEALED_KEY);
    }

    #[test]
    fn kat_blob_opens_back_to_the_drive_key() {
        let entropy = open_invite_key(KAT_SEALED_KEY, [0x11; 32], KAT_INVITE_ID).expect("open");
        assert_eq!(entropy, kat_entropy());
    }

    #[test]
    fn round_trips_with_fresh_randomness_and_never_repeats() {
        let recipient = StaticSecret::from([0x44u8; 32]);
        let pubkey = STANDARD.encode(PublicKey::from(&recipient).as_bytes());
        let entropy = [9u8; 32];
        let a = seal_invite_key(&entropy, &pubkey, KAT_INVITE_ID).expect("seal a");
        let b = seal_invite_key(&entropy, &pubkey, KAT_INVITE_ID).expect("seal b");
        assert_ne!(a, b, "fresh ephemeral key and nonce every time");
        assert_eq!(open_invite_key(&a, [0x44; 32], KAT_INVITE_ID).expect("open"), entropy);
    }

    #[test]
    fn a_blob_is_bound_to_its_invite_and_its_recipient() {
        let sealed = seal_invite_key(&[9u8; 32], KAT_REQUESTER_PUBKEY, KAT_INVITE_ID).expect("seal");
        assert!(open_invite_key(&sealed, [0x12; 32], KAT_INVITE_ID).is_err(), "stranger");
        assert!(open_invite_key(&sealed, [0x11; 32], &"b".repeat(64)).is_err(), "other invite");
    }

    #[test]
    fn refuses_malformed_inputs() {
        assert!(seal_invite_key(&[1u8; 16], KAT_REQUESTER_PUBKEY, KAT_INVITE_ID).is_err(), "short entropy");
        assert!(seal_invite_key(&[1u8; 32], "not base64!", KAT_INVITE_ID).is_err(), "bad key");
        assert!(
            seal_invite_key(&[1u8; 32], &STANDARD.encode([0u8; 16]), KAT_INVITE_ID).is_err(),
            "short key"
        );
        assert!(seal_invite_key(&[1u8; 32], KAT_REQUESTER_PUBKEY, "").is_err(), "empty invite id");
    }

    #[test]
    fn stays_inside_the_server_cap() {
        let sealed = seal_invite_key(&[1u8; 32], KAT_REQUESTER_PUBKEY, KAT_INVITE_ID).expect("seal");
        assert!(STANDARD.decode(sealed).expect("b64").len() <= MAX_BLOB_BYTES);
    }
}
