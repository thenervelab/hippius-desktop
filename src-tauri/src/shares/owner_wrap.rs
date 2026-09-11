//! Upload mnemonic-sealed share wraps so other devices can rebuild
//! the recipient URL. Byte-compatible with `hcfs-client` `share_wrap`.
//!
//! Best-effort: a failed PUT must not fail mint or list. An old server
//! 404s the route; we log and move on. The desktop's hcfs-client pin
//! predates `owner_wrap` on list rows, so hydrate re-GETs the listing
//! JSON and reads that field directly.

use super::SqliteShareKeystore;
use crate::auth::tokens::get_api_token;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bip39::Mnemonic;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hcfs_client::client::folder_share::folder_share_token_hash;
use hcfs_client::client::share::{ShareKeystore, ShareSecret};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use tracing::debug;
use zeroize::Zeroizing;

const KDF_CONTEXT: &str = "hippius.hcfs.share-wrap.v1";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 24;
const FLAG_PRIVATE: u8 = 0x01;
const FLAG_FOLDER_TOKEN: u8 = 0x02;
const PRIVATE_BLOB_LEN: usize = hcfs_client::client::share::SHARE_WRAP_BLOB_LEN;
const MAX_FOLDER_TOKEN_LEN: usize = 64;
const MAX_BATCH: usize = 64;

/// The wrap key, derived once.
///
/// Deriving it costs a BIP-39 PBKDF2-HMAC-SHA512 at 2048 iterations, so a
/// per-entry derive turns a listing of N shares into N of them on a tokio
/// worker. Every batch path here derives once and passes this down.
type WrapKey = Zeroizing<[u8; 32]>;

fn derive_wrap_key(master_mnemonic: &str) -> std::result::Result<WrapKey, String> {
    let mnemonic = Mnemonic::from_str(master_mnemonic).map_err(|e| e.to_string())?;
    let mut seed = mnemonic.to_seed("");
    let key = blake3::derive_key(KDF_CONTEXT, &seed[..32]);
    seed.fill(0);
    Ok(Zeroizing::new(key))
}

fn seal_file_secret_with_key(key: &WrapKey, owner_ss58: &str, share_token: &str, secret: &ShareSecret) -> std::result::Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_with(key, owner_ss58, share_token, secret, None, &nonce)
}

fn seal_folder_secret_with_key(key: &WrapKey, owner_ss58: &str, token: &str, secret: &ShareSecret) -> std::result::Result<Vec<u8>, String> {
    let row_key = folder_share_token_hash(token);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_with(key, owner_ss58, &row_key, secret, Some(token), &nonce)
}

fn open_file_secret(key: &WrapKey, owner_ss58: &str, share_token: &str, wrap: &[u8]) -> std::result::Result<ShareSecret, String> {
    let opened = open_with(key, owner_ss58, share_token, wrap)?;
    if opened.folder_token.is_some() {
        return Err("file wrap opened as a folder share".into());
    }
    Ok(opened.secret)
}

fn open_folder_secret(key: &WrapKey, owner_ss58: &str, token_hash: &str, wrap: &[u8]) -> std::result::Result<(String, ShareSecret), String> {
    let opened = open_with(key, owner_ss58, token_hash, wrap)?;
    let Some(token) = opened.folder_token else {
        return Err("folder wrap missing token".into());
    };
    Ok((token, opened.secret))
}

struct Opened {
    secret: ShareSecret,
    folder_token: Option<String>,
}

fn seal_with(
    key: &WrapKey,
    owner_ss58: &str,
    row_key: &str,
    secret: &ShareSecret,
    folder_token: Option<&str>,
    nonce: &[u8; NONCE_LEN],
) -> std::result::Result<Vec<u8>, String> {
    let plaintext = encode_plaintext(secret, folder_token)?;
    let aad = bind_aad(owner_ss58, row_key);
    let cipher = XChaCha20Poly1305::new((&**key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: &plaintext, aad: &aad })
        .map_err(|_| "aead seal failed".to_string())?;

    let mut wrap = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    wrap.push(VERSION);
    wrap.extend_from_slice(nonce);
    wrap.extend_from_slice(&ciphertext);
    Ok(wrap)
}

fn open_with(key: &WrapKey, owner_ss58: &str, row_key: &str, wrap: &[u8]) -> std::result::Result<Opened, String> {
    let min_len = 1 + NONCE_LEN + 16;
    if wrap.len() < min_len {
        return Err("owner wrap is truncated".into());
    }
    if wrap[0] != VERSION {
        return Err("unsupported owner wrap version".into());
    }
    let nonce = &wrap[1..=NONCE_LEN];
    let ciphertext = &wrap[(1 + NONCE_LEN)..];

    let aad = bind_aad(owner_ss58, row_key);
    let cipher = XChaCha20Poly1305::new((&**key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: &aad })
        .map_err(|_| "owner wrap did not open".to_string())?;
    decode_plaintext(&plaintext)
}

fn bind_aad(owner_ss58: &str, row_key: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(owner_ss58.len() + 1 + row_key.len());
    aad.extend_from_slice(owner_ss58.as_bytes());
    aad.push(0);
    aad.extend_from_slice(row_key.as_bytes());
    aad
}

fn encode_plaintext(secret: &ShareSecret, folder_token: Option<&str>) -> std::result::Result<Vec<u8>, String> {
    let mut flags = 0u8;
    if secret.is_private() {
        flags |= FLAG_PRIVATE;
    }
    if folder_token.is_some() {
        flags |= FLAG_FOLDER_TOKEN;
    }

    let mut out = Vec::new();
    out.push(flags);
    if let Some(token) = folder_token {
        let bytes = token.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_FOLDER_TOKEN_LEN {
            return Err("folder token length out of range".into());
        }
        out.push(u8::try_from(bytes.len()).expect("checked against MAX_FOLDER_TOKEN_LEN"));
        out.extend_from_slice(bytes);
    }
    match secret {
        ShareSecret::Public(k) => out.extend_from_slice(k),
        ShareSecret::Private(blob) => {
            if blob.len() != PRIVATE_BLOB_LEN {
                return Err("private wrap blob has wrong length".into());
            }
            out.extend_from_slice(blob);
        }
    }
    Ok(out)
}

fn decode_plaintext(plaintext: &[u8]) -> std::result::Result<Opened, String> {
    let Some((&flags, rest)) = plaintext.split_first() else {
        return Err("owner wrap plaintext is empty".into());
    };
    if flags & !(FLAG_PRIVATE | FLAG_FOLDER_TOKEN) != 0 {
        return Err("owner wrap has unknown flags".into());
    }

    let (folder_token, secret_bytes) = if flags & FLAG_FOLDER_TOKEN != 0 {
        let Some((&len, after_len)) = rest.split_first() else {
            return Err("folder token length missing".into());
        };
        let len = usize::from(len);
        if len == 0 || len > MAX_FOLDER_TOKEN_LEN || after_len.len() < len {
            return Err("folder token is truncated".into());
        }
        let (token_bytes, secret_bytes) = after_len.split_at(len);
        let token = String::from_utf8(token_bytes.to_vec()).map_err(|_| "folder token is not utf-8".to_string())?;
        (Some(token), secret_bytes)
    } else {
        (None, rest)
    };

    let secret = if flags & FLAG_PRIVATE != 0 {
        if secret_bytes.len() != PRIVATE_BLOB_LEN {
            return Err("private secret has wrong length".into());
        }
        ShareSecret::Private(secret_bytes.to_vec())
    } else {
        if secret_bytes.len() != 32 {
            return Err("public secret has wrong length".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(secret_bytes);
        ShareSecret::Public(key)
    };

    Ok(Opened { secret, folder_token })
}

struct Transport {
    mnemonic: Zeroizing<String>,
    server_url: String,
    bearer: String,
}

async fn transport_for(state: &crate::app_state::AppState, account_id: &str) -> Option<Transport> {
    let pool = state.pool().ok()?;
    let mnemonic = crate::sync::mnemonic::get_mnemonic_for_account(state, account_id).await.ok()?;
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await.ok()?;
    let bearer = get_api_token(pool, account_id).await.ok().flatten()?;
    Some(Transport {
        mnemonic,
        server_url,
        bearer,
    })
}

/// PUT wraps for the given file-share secrets. Unknown tokens are
/// skipped by the server. Failures are logged, never returned.
async fn upload_file_wraps(
    http: &reqwest::Client,
    server_url: &str,
    bearer: &str,
    key: &WrapKey,
    owner_ss58: &str,
    entries: &[(String, ShareSecret)],
) {
    if entries.is_empty() {
        return;
    }
    let mut wraps = Vec::new();
    for (token, secret) in entries {
        match seal_file_secret_with_key(key, owner_ss58, token, secret) {
            Ok(wrap) => wraps.push(serde_json::json!({
                "token": token,
                "wrap": STANDARD.encode(wrap),
            })),
            Err(e) => debug!(error = %e, "share owner-wrap seal skipped"),
        }
    }
    put_wrap_chunks(
        http,
        &format!("{}/v1/shares/owner-wraps", server_url.trim_end_matches('/')),
        bearer,
        wraps,
    )
    .await;
}

async fn upload_folder_wraps(
    http: &reqwest::Client,
    server_url: &str,
    bearer: &str,
    key: &WrapKey,
    owner_ss58: &str,
    entries: &[(String, ShareSecret)],
) {
    if entries.is_empty() {
        return;
    }
    let mut wraps = Vec::new();
    for (token, secret) in entries {
        match seal_folder_secret_with_key(key, owner_ss58, token, secret) {
            Ok(wrap) => wraps.push(serde_json::json!({
                "token_hash": folder_share_token_hash(token),
                "wrap": STANDARD.encode(wrap),
            })),
            Err(e) => debug!(error = %e, "folder owner-wrap seal skipped"),
        }
    }
    put_wrap_chunks(
        http,
        &format!("{}/v1/folder-shares/owner-wraps", server_url.trim_end_matches('/')),
        bearer,
        wraps,
    )
    .await;
}

async fn put_wrap_chunks(http: &reqwest::Client, url: &str, bearer: &str, wraps: Vec<serde_json::Value>) {
    if wraps.is_empty() {
        return;
    }
    for chunk in wraps.chunks(MAX_BATCH) {
        let res = http
            .put(url)
            .bearer_auth(bearer)
            .json(&serde_json::json!({ "wraps": chunk }))
            .send()
            .await;
        match res {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                debug!(status = %resp.status(), "share owner-wrap PUT ignored");
            }
            Err(e) => debug!(error = %e, "share owner-wrap PUT failed"),
        }
    }
}

/// Mint-time push. A share that was just created has no wrap on the
/// server by construction, so this needs none of the reconciliation
/// [`sync_file_wraps`] does — it is always exactly one new row.
pub(crate) async fn push_for_account(state: &crate::app_state::AppState, account_id: &str, entries: &[(String, ShareSecret)]) {
    if entries.is_empty() {
        return;
    }
    let Some(t) = transport_for(state, account_id).await else {
        return;
    };
    let Ok(key) = derive_wrap_key(t.mnemonic.as_str()) else {
        return;
    };
    upload_file_wraps(&state.api_client, &t.server_url, &t.bearer, &key, account_id, entries).await;
}

/// Mint-time push for a folder share. See [`push_for_account`].
pub(crate) async fn push_folder_for_account(state: &crate::app_state::AppState, account_id: &str, entries: &[(String, ShareSecret)]) {
    if entries.is_empty() {
        return;
    }
    let Some(t) = transport_for(state, account_id).await else {
        return;
    };
    let Ok(key) = derive_wrap_key(t.mnemonic.as_str()) else {
        return;
    };
    upload_folder_wraps(&state.api_client, &t.server_url, &t.bearer, &key, account_id, entries).await;
}

#[derive(Deserialize)]
struct FileWrapRow {
    share_token: String,
    #[serde(default)]
    owner_wrap: Option<String>,
}

#[derive(Deserialize)]
struct FolderWrapRow {
    token_hash: String,
    #[serde(default)]
    owner_wrap: Option<String>,
}

/// Reconcile this device's keystore with the server's file-share wraps,
/// from a single listing fetch.
///
/// Hydrate first, then push only what the server says is missing. Both
/// halves of that are load-bearing. Pushing before hydrating re-sealed and
/// wrote straight back every wrap the device had just read from the
/// server. Pushing without the `owner_wrap: null` filter rewrote every row
/// this device held a key for on every open of Shared Links — a fresh
/// nonce and a new `BYTEA` write per row, per open, for a value that was
/// already correct.
///
/// The re-GET exists because the desktop's hcfs-client pin predates
/// `owner_wrap` on list rows; it is one request, and it is what makes the
/// filter possible at all.
pub(crate) async fn sync_file_wraps(
    state: &crate::app_state::AppState,
    account_id: &str,
    keystore: &SqliteShareKeystore,
    key_map: &mut HashMap<String, ShareSecret>,
    tokens: &[&str],
) {
    if tokens.is_empty() {
        return;
    }
    let Some(t) = transport_for(state, account_id).await else {
        return;
    };
    let Ok(key) = derive_wrap_key(t.mnemonic.as_str()) else {
        return;
    };
    let url = format!("{}/v1/shares", t.server_url.trim_end_matches('/'));
    let Ok(rows) = fetch_json::<Vec<FileWrapRow>>(&state.api_client, &url, &t.bearer).await else {
        return;
    };

    let listed: HashSet<&str> = tokens.iter().copied().collect();
    let mut unwrapped: Vec<String> = Vec::new();
    for row in rows {
        if !listed.contains(row.share_token.as_str()) {
            continue;
        }
        let Some(b64) = row.owner_wrap.as_deref() else {
            // No wrap on the server: a candidate for the push below, but
            // only if this device turns out to hold the key.
            unwrapped.push(row.share_token);
            continue;
        };
        if key_map.contains_key(&row.share_token) {
            continue;
        }
        let Ok(wrap) = STANDARD.decode(b64) else {
            continue;
        };
        let Ok(secret) = open_file_secret(&key, account_id, &row.share_token, &wrap) else {
            continue;
        };
        if keystore.put(&row.share_token, &secret).is_ok() {
            key_map.insert(row.share_token, secret);
        }
    }

    let to_push: Vec<(String, ShareSecret)> = unwrapped
        .into_iter()
        .filter_map(|token| key_map.get(&token).map(|secret| (token, secret.clone())))
        .collect();
    upload_file_wraps(&state.api_client, &t.server_url, &t.bearer, &key, account_id, &to_push).await;
}

/// The folder-share twin of [`sync_file_wraps`], addressed by `token_hash`
/// because the plaintext token is never echoed after create. Same order and
/// same `owner_wrap: null` filter, for the same reasons.
pub(crate) async fn sync_folder_wraps(
    state: &crate::app_state::AppState,
    account_id: &str,
    keystore: &SqliteShareKeystore,
    secrets_by_hash: &mut HashMap<String, (String, ShareSecret)>,
    token_hashes: &[String],
) {
    if token_hashes.is_empty() {
        return;
    }
    let Some(t) = transport_for(state, account_id).await else {
        return;
    };
    let Ok(key) = derive_wrap_key(t.mnemonic.as_str()) else {
        return;
    };
    let url = format!("{}/v1/folder-shares", t.server_url.trim_end_matches('/'));
    let Ok(rows) = fetch_json::<Vec<FolderWrapRow>>(&state.api_client, &url, &t.bearer).await else {
        return;
    };

    let listed: HashSet<&str> = token_hashes.iter().map(String::as_str).collect();
    let mut unwrapped: Vec<String> = Vec::new();
    for row in rows {
        if !listed.contains(row.token_hash.as_str()) {
            continue;
        }
        let Some(b64) = row.owner_wrap.as_deref() else {
            unwrapped.push(row.token_hash);
            continue;
        };
        if secrets_by_hash.contains_key(&row.token_hash) {
            continue;
        }
        let Ok(wrap) = STANDARD.decode(b64) else {
            continue;
        };
        let Ok((token, secret)) = open_folder_secret(&key, account_id, &row.token_hash, &wrap) else {
            continue;
        };
        if keystore.put(&token, &secret).is_ok() {
            secrets_by_hash.insert(row.token_hash, (token, secret));
        }
    }

    // The upload seals from the plaintext token (it derives the row key
    // itself), so a hash this device cannot resolve to a token is simply
    // not pushable — which is exactly the row that has no wrap yet and no
    // local secret either.
    let to_push: Vec<(String, ShareSecret)> = unwrapped.into_iter().filter_map(|hash| secrets_by_hash.get(&hash).cloned()).collect();
    upload_folder_wraps(&state.api_client, &t.server_url, &t.bearer, &key, account_id, &to_push).await;
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(http: &reqwest::Client, url: &str, bearer: &str) -> std::result::Result<T, ()> {
    let resp = http.get(url).bearer_auth(bearer).send().await.map_err(|_| ())?;
    if !resp.status().is_success() {
        return Err(());
    }
    resp.json::<T>().await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
    const SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const FILE_TOKEN: &str = "abcdefghijabcdefghijab";
    const FOLDER_TOKEN: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
    /// Synthetic, not a real `wrap_share_key` output — that carries a
    /// random Argon2id salt and could not be frozen. The point is the
    /// `FLAG_PRIVATE` bit and the 89-vs-32 length branch.
    const PRIVATE_BLOB: [u8; PRIVATE_BLOB_LEN] = [0x33u8; PRIVATE_BLOB_LEN];

    fn key() -> WrapKey {
        derive_wrap_key(MNEMONIC).unwrap()
    }

    #[test]
    fn frozen_vector_matches_hcfs_client() {
        let secret = ShareSecret::Public([0x11u8; 32]);
        let nonce = [0x22u8; NONCE_LEN];
        let wrap = seal_with(&key(), SS58, FILE_TOKEN, &secret, None, &nonce).unwrap();
        assert_eq!(
            hex::encode(&wrap),
            "01222222222222222222222222222222222222222222222222676b467839d9819c63b5c24cbf8b0e57e65d23673efbe1f99259db781ae28a7f0a74a7aa204ac51556007d805d2f74f138",
        );
        let opened = open_file_secret(&key(), SS58, FILE_TOKEN, &wrap).unwrap();
        assert_eq!(opened, secret);
    }

    #[test]
    fn frozen_vector_public_folder_matches_hcfs_client() {
        let secret = ShareSecret::Public([0x11u8; 32]);
        let nonce = [0x22u8; NONCE_LEN];
        let row_key = folder_share_token_hash(FOLDER_TOKEN);
        let wrap = seal_with(&key(), SS58, &row_key, &secret, Some(FOLDER_TOKEN), &nonce).unwrap();
        assert_eq!(
            hex::encode(&wrap),
            "012222222222222222222222222222222222222222222222226551162b6b8cd5cb35ec9a17e5d65208b81c63247cbea5bed41093336a91f80a7e4121d094030bc9dd2ed175cddf9baa2361676210b7f4e34c659feed9f8fcfde056e463b4fc887db5c95beea69ee55fa2ceed7f7c1bdb594a7d336bc8",
        );
        let (token, opened) = open_folder_secret(&key(), SS58, &row_key, &wrap).unwrap();
        assert_eq!(token, FOLDER_TOKEN);
        assert_eq!(opened, secret);
    }

    /// The public vectors above cannot catch a `FLAG_PRIVATE` or a
    /// 89-vs-32 length divergence, and that is where a bug is worst:
    /// opening a password-wrap blob as a raw key would let this device
    /// offer a `#k=` URL for a password-protected share.
    #[test]
    fn frozen_vector_private_file_matches_hcfs_client() {
        let secret = ShareSecret::Private(PRIVATE_BLOB.to_vec());
        let nonce = [0x22u8; NONCE_LEN];
        let wrap = seal_with(&key(), SS58, FILE_TOKEN, &secret, None, &nonce).unwrap();
        assert_eq!(
            hex::encode(&wrap),
            "012222222222222222222222222222222222222222222222226649645a1bfba3be4197e06e9da92c75c47f01451cd9c3dbb07bf95a38c0a85d2814758bce5a539683738d368ffdb988014345403295d6c16e47bdccfbdadedfc274c64196deaa5f97eb79cc841c5f6ce9c179b37f7bdd6aa735819c3ab7e5b81e9a7f452f9a82d54f89",
        );
        let opened = open_file_secret(&key(), SS58, FILE_TOKEN, &wrap).unwrap();
        assert!(opened.is_private(), "a password-protected share must never open as a #k= key");
        assert_eq!(opened, secret);
    }

    #[test]
    fn frozen_vector_private_folder_matches_hcfs_client() {
        let secret = ShareSecret::Private(PRIVATE_BLOB.to_vec());
        let nonce = [0x22u8; NONCE_LEN];
        let row_key = folder_share_token_hash(FOLDER_TOKEN);
        let wrap = seal_with(&key(), SS58, &row_key, &secret, Some(FOLDER_TOKEN), &nonce).unwrap();
        assert_eq!(
            hex::encode(&wrap),
            "012222222222222222222222222222222222222222222222226451162b6b8cd5cb35ec9a17e5d65208b81c63247cbea5bed41093336a91f80a7e4121d094030bc9dd2ed175cdfdb988014345403295d6c16e47bdccfbdadedfc274c64196deaa5f97eb79cc841c5f6ce9c179b37f7bdd6aa7356dfe0cbcedabcf305709643c1c579d073be2555a9013882b8b21a28c9a1019bc4afda1e80cb8f2aa635726350bf83296ebc733892113f5e8c8f6ece9",
        );
        let (token, opened) = open_folder_secret(&key(), SS58, &row_key, &wrap).unwrap();
        assert_eq!(token, FOLDER_TOKEN);
        assert!(opened.is_private());
        assert_eq!(opened, secret);
    }

    #[test]
    fn file_open_rejects_a_folder_wrap() {
        let secret = ShareSecret::Public([0x11u8; 32]);
        let wrap = seal_folder_secret_with_key(&key(), SS58, FOLDER_TOKEN, &secret).unwrap();
        assert!(open_file_secret(&key(), SS58, FOLDER_TOKEN, &wrap).is_err());
    }

    #[test]
    fn folder_open_rejects_a_file_wrap() {
        let secret = ShareSecret::Public([0x11u8; 32]);
        let wrap = seal_file_secret_with_key(&key(), SS58, FILE_TOKEN, &secret).unwrap();
        assert!(open_folder_secret(&key(), SS58, FILE_TOKEN, &wrap).is_err());
    }
}
