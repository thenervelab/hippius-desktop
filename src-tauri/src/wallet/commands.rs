//! Tauri IPC surface for the local-wallet feature.
//!
//! All persistence commands are scoped to the currently-logged-in account.
//! Every command that touches the DB starts with [`require_owner`] to:
//!   1. Refuse the call cleanly when no user is logged in (the FE listens
//!      for this and renders the "log in to manage wallets" empty state).
//!   2. Translate `AuthInfo.substrate_address` into the same `account_key`
//!      hash that `sync_paths` uses, so a multi-account install keeps each
//!      user's wallets isolated by `owner` column.
//!
//! Stateless mnemonic helpers (`generate_mnemonic`, `validate_mnemonic`,
//! `derive_address`) deliberately skip the gate — they don't read or
//! write the DB and the FE uses them during the pre-create preview.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::AppError;
use crate::wallet::crypto;
use crate::wallet::repo::{self, LocalWallet, PublicLocalWallet};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use serde::Serialize;
use sqlx::SqlitePool;
use subxt_signer::{
    bip39::Mnemonic as SubxtMnemonic,
    sr25519::Keypair as SrKeypair,
};
use tauri::State;
use tracing::info;
use zeroize::Zeroizing;

/// Resolve the active account's owner key, or return a friendly error the
/// FE can show when no one is logged in.
///
/// Wrapping `current_account_id`'s `Result<_, String>` into `AppError`
/// here keeps every command body a one-liner instead of duplicating the
/// `map_err` dance.
fn require_owner(state: &State<'_, AppState>) -> Result<String, AppError> {
    let account_id = state
        .current_account_id()
        .map_err(|_| AppError::Other("Log in to manage local wallets".into()))?;
    Ok(account_key(&account_id))
}

/// Derive a polkadot SS58 address from a BIP-39 mnemonic. Used both
/// internally (during create/import) and from the FE for previewing.
fn derive_address(mnemonic: &str) -> Result<String, AppError> {
    let parsed = SubxtMnemonic::parse(mnemonic).map_err(|e| AppError::Other(format!("Invalid BIP-39 mnemonic: {e}")))?;
    let pair = SrKeypair::from_phrase(&parsed, None).map_err(|e| AppError::Other(format!("Failed to derive sr25519 keypair: {e}")))?;
    Ok(pair.public_key().to_account_id().to_string())
}

/// Reject a backup whose stored `address` does not actually correspond to its
/// `encrypted_mnemonic`.
///
/// Password verification alone (`verify_password`) only proves the typed
/// password matches the backup's hash for the backup's address — it does not
/// prove the ciphertext decrypts to a mnemonic that *derives* that address. A
/// tampered or malformed backup could therefore persist a row whose advertised
/// `address` differs from its key material, so later signing
/// (`get_signer_and_address` / `local_wallet_sign`) would act on a different
/// address than the UI displays. The decrypt uses `address` as the AEAD salt,
/// so a consistent backup round-trips; we then derive the address from the
/// plaintext and require it to match. Costs one AEAD decrypt + key derivation,
/// at import time only.
fn verify_backup_address_binding(encrypted_mnemonic: &str, password: &str, address: &str) -> Result<(), AppError> {
    let (mnemonic, _legacy) = crypto::decrypt_mnemonic(encrypted_mnemonic, password, address)?;
    if derive_address(&mnemonic)? != address {
        return Err(AppError::Validation("Backup address does not match its mnemonic".into()));
    }
    Ok(())
}

/// Re-encrypt a wallet's mnemonic under Argon2id and re-hash its password when
/// the stored row is still in a legacy format (HKDF ciphertext or hex-SHA256
/// verifier hash).
///
/// Best-effort: a re-encrypt or DB-write failure is logged and swallowed so it
/// never blocks the unlock/sign the caller is performing — the next successful
/// unlock retries. Reuses the caller's already-decrypted `plain` so there is no
/// second AEAD pass, and preserves the address-as-salt invariant (the same
/// address feeds both the new ciphertext and the new verifier hash) so later
/// unlocks verify normally. No-op when the row is already on the current format.
///
/// Centralising this here keeps the two unlock paths
/// (`local_wallet_get_decrypted_mnemonic`, `local_wallet_sign`) from drifting
/// — both must migrate identically, and a divergence in a security-sensitive
/// re-encrypt would be easy to miss across two copies.
async fn maybe_migrate_secrets(
    pool: &SqlitePool,
    owner: &str,
    wallet: &LocalWallet,
    password: &str,
    plain: &str,
    ciphertext_was_legacy: bool,
) {
    if !(ciphertext_was_legacy || crypto::password_hash_is_legacy(&wallet.password_hash)) {
        return;
    }
    let new_ciphertext = match crypto::encrypt_mnemonic(plain, password, &wallet.address) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(wallet = %wallet.address, error = %e, "Failed to re-encrypt legacy wallet secrets; will retry on next unlock");
            return;
        }
    };
    let new_hash = crypto::password_hash(password, &wallet.address);
    match repo::update_secrets(pool, owner, wallet.id, &new_ciphertext, &new_hash).await {
        Ok(()) => tracing::info!(wallet = %wallet.address, "Migrated wallet secrets to Argon2id"),
        Err(e) => tracing::warn!(wallet = %wallet.address, error = %e, "Failed to persist migrated wallet secrets; will retry on next unlock"),
    }
}

/// Generate a fresh 12-word mnemonic. The mnemonic is returned to the FE
/// only so the user can write it down during the create flow — it must be
/// immediately re-submitted via `create` (along with the password) to be
/// stored encrypted; nothing in Rust holds onto it.
#[tauri::command]
pub fn local_wallet_generate_mnemonic() -> Result<String, AppError> {
    let mnemonic = bip39::Mnemonic::generate(12).map_err(|e| AppError::Other(format!("bip39 generate failed: {e}")))?;
    Ok(mnemonic.to_string())
}

/// Cheap mnemonic validity check the FE uses to decide whether to enable
/// the "Continue" button on the import screen.
#[tauri::command]
pub fn local_wallet_validate_mnemonic(mnemonic: String) -> bool {
    // Scrub the candidate phrase from the heap after the check — it's key
    // material even when it turns out to be invalid.
    let mnemonic = Zeroizing::new(mnemonic);
    bip39::Mnemonic::parse_normalized(&mnemonic).is_ok()
}

/// Derive an address from a mnemonic without persisting anything.
/// Surfaces address previews on the import / create-confirm screens.
#[tauri::command]
pub fn local_wallet_derive_address(mnemonic: String) -> Result<String, AppError> {
    let mnemonic = Zeroizing::new(mnemonic);
    derive_address(&mnemonic)
}

/// List every wallet owned by the active account, secrets stripped. Sorted
/// by creation time ascending (oldest first) so the active-wallet selector
/// renders deterministically.
#[tauri::command]
pub async fn local_wallet_list(state: State<'_, AppState>) -> Result<Vec<PublicLocalWallet>, AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let rows = repo::list_all(pool, &owner).await?;
    Ok(rows.iter().map(PublicLocalWallet::from).collect())
}

/// Return whether the active account has any wallets. Cheaper than `list`
/// for the onboarding gate which only cares about presence.
#[tauri::command]
pub async fn local_wallet_has_any(state: State<'_, AppState>) -> Result<bool, AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    Ok(repo::count_for_owner(pool, &owner).await? > 0)
}

/// Return the active account's active wallet, secrets stripped. `None` if
/// the account has no wallets at all.
#[tauri::command]
pub async fn local_wallet_get_active(state: State<'_, AppState>) -> Result<Option<PublicLocalWallet>, AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    Ok(repo::get_active(pool, &owner).await?.as_ref().map(PublicLocalWallet::from))
}

/// Create a new wallet from a mnemonic. The mnemonic is encrypted under
/// `password` at rest (Argon2id-derived ChaCha20-Poly1305) and an Argon2id
/// password-verifier hash is stored alongside for verification on unlock.
///
/// The mnemonic argument may be either freshly generated by
/// `local_wallet_generate_mnemonic` or pasted by the user during import —
/// the two paths are identical from Rust's perspective. The row is scoped
/// to whichever account is currently logged in.
#[tauri::command]
pub async fn local_wallet_create(state: State<'_, AppState>, name: String, mnemonic: String, password: String) -> Result<PublicLocalWallet, AppError> {
    // Wrap the secrets so their heap buffers are wiped on drop, however this
    // function returns.
    let mnemonic = Zeroizing::new(mnemonic);
    let password = Zeroizing::new(password);
    if bip39::Mnemonic::parse_normalized(&mnemonic).is_err() {
        return Err(AppError::Other("Invalid mnemonic".into()));
    }
    if name.trim().is_empty() {
        return Err(AppError::Other("Wallet name is required".into()));
    }
    if password.is_empty() {
        return Err(AppError::Other("Password is required".into()));
    }

    let owner = require_owner(&state)?;
    let address = derive_address(&mnemonic)?;
    let encrypted = crypto::encrypt_mnemonic(&mnemonic, &password, &address)?;
    let pw_hash = crypto::password_hash(&password, &address);

    let pool = state.pool()?;
    let row = repo::insert(pool, &owner, name.trim(), &address, &encrypted, &pw_hash).await?;
    info!(wallet = %row.address, "Local wallet created");
    Ok(PublicLocalWallet::from(&row))
}

/// Mark a wallet active. The previous active wallet for this owner (if
/// any) is transactionally cleared first so the "exactly one active per
/// owner" invariant holds throughout.
#[tauri::command]
pub async fn local_wallet_set_active(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    if repo::get_by_id(pool, &owner, id).await?.is_none() {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    }
    repo::set_active(pool, &owner, id).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_wallet_rename(state: State<'_, AppState>, id: i64, name: String) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::Other("Wallet name is required".into()));
    }
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    repo::rename(pool, &owner, id, name.trim()).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_wallet_delete(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    repo::delete(pool, &owner, id).await?;
    Ok(())
}

/// Verify the user typed the correct password for a wallet without
/// surfacing the mnemonic. Used by the unlock-on-action UX pattern in
/// the FE (the password prompt before signing).
///
/// Accepts both the new Argon2id PHC password hash and the legacy
/// hex-SHA256 hash via [`crypto::verify_password`] — `false` on either
/// a wrong password or an unrecognised stored-hash format.
///
/// Rate-limited: see `crate::wallet::rate_limit`. After repeated
/// failures the call returns `Err(RateLimited)` instead of a boolean,
/// telling the FE to display a wait-and-retry message instead of
/// "Incorrect password" so attackers can't disguise a lockout as a
/// regular wrong-password retry loop.
#[tauri::command]
pub async fn local_wallet_verify_password(state: State<'_, AppState>, id: i64, password: String) -> Result<bool, AppError> {
    let password = Zeroizing::new(password);
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let Some(wallet) = repo::get_by_id(pool, &owner, id).await? else {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    };
    // Serialize attempts on this wallet so a concurrent IPC burst can't all
    // clear `check` before any `record_failure` runs and thereby outrun the
    // lockout threshold (audit finding B1). Held to fn end — covers
    // check → verify → record.
    let _attempt_gate = state.wallet_rate_limit.attempt_gate(id).await;
    if let Err(rl) = state.wallet_rate_limit.check(id) {
        return Err(AppError::Other(rl.message()));
    }
    let ok = crypto::verify_password(&wallet.password_hash, &password, &wallet.address);
    if ok {
        state.wallet_rate_limit.record_success(id);
    } else {
        state.wallet_rate_limit.record_failure(id);
    }
    Ok(ok)
}

/// Decrypt and return a wallet's mnemonic. The FE uses this on the
/// "view recovery phrase" screen after the user re-types their password.
/// Wrong password yields `Err` (the AEAD tag mismatch is indistinguishable
/// from corrupt data at the API surface).
///
/// **Transparent migration**: if the row's stored ciphertext or
/// password hash is in the legacy (HKDF / hex-SHA256) format, the
/// successful unlock immediately re-encrypts the mnemonic under
/// Argon2id and re-hashes the password, then writes both back to the
/// DB atomically. The user sees nothing — the next call already finds
/// the row in the new format.
#[tauri::command]
pub async fn local_wallet_get_decrypted_mnemonic(state: State<'_, AppState>, id: i64, password: String) -> Result<String, AppError> {
    let password = Zeroizing::new(password);
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let Some(wallet) = repo::get_by_id(pool, &owner, id).await? else {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    };
    // Serialize attempts on this wallet so a concurrent IPC burst can't all
    // clear `check` before any `record_failure` runs and thereby outrun the
    // lockout threshold (audit finding B1). Held to fn end — covers
    // check → verify → record.
    let _attempt_gate = state.wallet_rate_limit.attempt_gate(id).await;
    // Rate-limit BEFORE the verifier so a locked-out attacker can't
    // measure Argon2id timing to distinguish "wrong password" from
    // "lockout" — both surface as a plain error string now.
    if let Err(rl) = state.wallet_rate_limit.check(id) {
        return Err(AppError::Other(rl.message()));
    }
    // Verifier check next for a friendlier error than AEAD-decrypt-failed.
    if !crypto::verify_password(&wallet.password_hash, &password, &wallet.address) {
        state.wallet_rate_limit.record_failure(id);
        return Err(AppError::Other("Incorrect password".into()));
    }
    state.wallet_rate_limit.record_success(id);
    let (plain, ciphertext_was_legacy) =
        crypto::decrypt_mnemonic(&wallet.encrypted_mnemonic, &password, &wallet.address)?;

    // Transparently upgrade a legacy row on this successful unlock (best-effort;
    // see `maybe_migrate_secrets`).
    maybe_migrate_secrets(pool, &owner, &wallet, &password, plain.as_str(), ciphertext_was_legacy).await;

    Ok(plain.as_str().to_owned())
}

/// Exported backup payload. The FE serialises this to a JSON file the
/// user saves to disk. Re-importing on another device uses
/// `local_wallet_import_encrypted_backup` below.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletBackup {
    pub name: String,
    pub address: String,
    pub encrypted_mnemonic: String,
    pub password_hash: String,
    pub exported_at: String,
}

#[tauri::command]
pub async fn local_wallet_export_backup(state: State<'_, AppState>, id: i64) -> Result<WalletBackup, AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let Some(wallet) = repo::get_by_id(pool, &owner, id).await? else {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    let exported_at = {
        // RFC3339-ish: just emit ms since epoch as a string. The FE displays
        // the file's own mtime so this field is informational only.
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        ms.to_string()
    };
    Ok(WalletBackup {
        name: wallet.name,
        address: wallet.address,
        encrypted_mnemonic: wallet.encrypted_mnemonic,
        password_hash: wallet.password_hash,
        exported_at,
    })
}

/// Import a wallet from the JSON payload produced by `export_backup`. The
/// ciphertext + password hash are stored verbatim — re-encryption is not
/// possible without the password, which the export file does not contain.
/// Stored under the currently-logged-in account.
#[tauri::command]
pub async fn local_wallet_import_encrypted_backup(
    state: State<'_, AppState>,
    name: String,
    address: String,
    encrypted_mnemonic: String,
    password_hash: String,
    password: String,
) -> Result<PublicLocalWallet, AppError> {
    let password = Zeroizing::new(password);
    if name.trim().is_empty() {
        return Err(AppError::Other("Wallet name is required".into()));
    }
    if address.trim().is_empty() {
        return Err(AppError::Other("Address is required".into()));
    }
    // Verify the user typed the correct password against the hash from
    // the backup. `crypto::verify_password` accepts both the new
    // Argon2id PHC format and the legacy hex-SHA256 format, so backups
    // produced by either version of the app are accepted.
    if !crypto::verify_password(&password_hash, &password, address.trim()) {
        return Err(AppError::Other("Incorrect password for this backup".into()));
    }
    // Reject a backup whose address doesn't derive from its mnemonic, so a
    // tampered file can't persist a row that later signs under a different key.
    verify_backup_address_binding(&encrypted_mnemonic, &password, address.trim())?;
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let row = repo::insert(pool, &owner, name.trim(), address.trim(), &encrypted_mnemonic, &password_hash).await?;
    Ok(PublicLocalWallet::from(&row))
}

/// Name of the JSON entry inside the wallet backup `.zip`. Kept as a
/// const so the writer and the reader can't drift apart silently.
const BACKUP_ZIP_ENTRY: &str = "wallet-backup.json";

/// Upper bound on the decompressed size of the backup JSON entry. A real
/// backup is a few hundred bytes; 64 KiB is generous headroom. The cap stops
/// a malicious/zip-bomb archive (small compressed, huge declared/decompressed
/// size) from OOM-ing the app when imported — both the pre-read `size()` check
/// and the bounded `take()` read enforce it (the latter in case the header
/// `size()` lies).
const MAX_BACKUP_JSON_BYTES: u64 = 64 * 1024;

/// Export the active account's wallet `id` as a `.zip` archive whose
/// only entry is `wallet-backup.json` (the same `WalletBackup` payload
/// `local_wallet_export_backup` returns, serialised pretty-printed).
///
/// The archive is **not** zip-encrypted: the JSON inside is already
/// ChaCha20-Poly1305-encrypted under the wallet password (the
/// `encryptedMnemonic` ciphertext), and the password is never escrowed
/// in either the file or the archive. The zip is purely a container
/// chosen to (a) mirror `feature/wallet-updates` for cross-compat with
/// the v1 frontend, and (b) give the FE a single binary blob to write
/// instead of pretty-printed JSON.
#[tauri::command]
pub async fn local_wallet_export_backup_zip(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<u8>, AppError> {
    use std::io::{Cursor, Write};

    let backup = local_wallet_export_backup(state, id).await?;
    let json = serde_json::to_vec_pretty(&serde_json::json!({
        "version": 2,
        "name": backup.name,
        "address": backup.address,
        "encryptedMnemonic": backup.encrypted_mnemonic,
        "passwordHash": backup.password_hash,
        "exportedAt": backup.exported_at,
    }))
    .map_err(|e| AppError::Other(format!("failed to serialise backup json: {e}")))?;

    let buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(BACKUP_ZIP_ENTRY, options)
        .map_err(|e| AppError::Other(format!("zip start_file: {e}")))?;
    zip.write_all(&json)
        .map_err(|e| AppError::Other(format!("zip write_all: {e}")))?;
    let cursor = zip
        .finish()
        .map_err(|e| AppError::Other(format!("zip finish: {e}")))?;
    Ok(cursor.into_inner())
}

/// Import a wallet from a `.zip` archive produced by
/// [`local_wallet_export_backup_zip`]. Pulls `wallet-backup.json` out of
/// the archive, validates its shape, and persists the row under the
/// currently-logged-in account.
///
/// `name` is the user-supplied label from the import screen — the
/// backup file carries a "name" hint but the FE always lets the user
/// rename on import, and treating the FE-supplied name as authoritative
/// matches the existing JSON-path command (`local_wallet_import_encrypted_backup`).
#[tauri::command]
pub async fn local_wallet_import_encrypted_backup_from_zip(
    state: State<'_, AppState>,
    name: String,
    zip_bytes: Vec<u8>,
    password: String,
) -> Result<PublicLocalWallet, AppError> {
    use std::io::{Cursor, Read};

    let password = Zeroizing::new(password);
    if name.trim().is_empty() {
        return Err(AppError::Other("Wallet name is required".into()));
    }

    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::Other(format!("Couldn't open backup zip: {e}")))?;

    let mut entry = archive
        .by_name(BACKUP_ZIP_ENTRY)
        .map_err(|_| AppError::Other(format!("Backup zip is missing `{BACKUP_ZIP_ENTRY}`")))?;
    // Reject an entry whose declared size is already oversized (cheap,
    // header-based), then read with a hard cap so a lying header can't make us
    // allocate/read unbounded memory. `Vec::with_capacity` is intentionally NOT
    // sized from the attacker-controlled `entry.size()`.
    if entry.size() > MAX_BACKUP_JSON_BYTES {
        return Err(AppError::Other("Backup entry is unexpectedly large".into()));
    }
    let mut json_bytes = Vec::new();
    (&mut entry)
        .take(MAX_BACKUP_JSON_BYTES + 1)
        .read_to_end(&mut json_bytes)
        .map_err(|e| AppError::Other(format!("Couldn't read backup entry: {e}")))?;
    drop(entry);
    if json_bytes.len() as u64 > MAX_BACKUP_JSON_BYTES {
        return Err(AppError::Other("Backup entry is unexpectedly large".into()));
    }

    let parsed: serde_json::Value = serde_json::from_slice(&json_bytes)
        .map_err(|e| AppError::Other(format!("Backup file isn't valid JSON: {e}")))?;
    let address = parsed
        .get("address")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Other("Backup is missing `address`".into()))?
        .trim()
        .to_owned();
    let encrypted_mnemonic = parsed
        .get("encryptedMnemonic")
        .or_else(|| parsed.get("encrypted_mnemonic"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Other("Backup is missing `encryptedMnemonic`".into()))?
        .to_owned();
    let password_hash = parsed
        .get("passwordHash")
        .or_else(|| parsed.get("password_hash"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Other("Backup is missing `passwordHash`".into()))?
        .to_owned();
    if address.is_empty() {
        return Err(AppError::Other("Backup `address` is empty".into()));
    }

    // Same verification as the JSON path: the user's typed password
    // must match the hash baked into the backup, otherwise we'd
    // store a wallet they can't actually sign with. Accepts legacy +
    // new hash formats via `crypto::verify_password`.
    if !crypto::verify_password(&password_hash, &password, &address) {
        return Err(AppError::Other("Incorrect password for this backup".into()));
    }
    // Reject a backup whose address doesn't derive from its mnemonic (see the
    // JSON import path) so a tampered zip can't persist a mismatched row.
    verify_backup_address_binding(&encrypted_mnemonic, &password, &address)?;

    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let row = repo::insert(
        pool,
        &owner,
        name.trim(),
        &address,
        &encrypted_mnemonic,
        &password_hash,
    )
    .await?;
    Ok(PublicLocalWallet::from(&row))
}

/// Return a wallet's Sr25519 public key as a base64-encoded 32-byte
/// blob. Public keys are not sensitive — they're derived from the
/// address — but exposing them via the IPC saves the FE from doing an
/// SS58 decode in JS and keeps `@polkadot/util-crypto` out of any
/// signing call path that doesn't need it.
///
/// Decoding the wallet's address would yield the same bytes; this IPC
/// just makes the data path explicit and lets us avoid the situation
/// where the FE has the public key from one source and the Rust signer
/// has it from another that could theoretically drift apart.
#[tauri::command]
pub async fn local_wallet_get_public_key(
    state: State<'_, AppState>,
    id: i64,
) -> Result<String, AppError> {
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let Some(wallet) = repo::get_by_id(pool, &owner, id).await? else {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    };
    // The public key in question is the 32-byte sr25519 public key
    // that the SS58 address encodes. We don't need the password to
    // produce it — derive_address goes mnemonic → keypair → public_key
    // → account_id (SS58). We can go from SS58 back to bytes via
    // subxt_signer's AccountId32 parser, which is a public-data
    // operation.
    use std::str::FromStr;
    use subxt::utils::AccountId32;
    let account = AccountId32::from_str(&wallet.address)
        .map_err(|e| AppError::Other(format!("Wallet address is not valid SS58: {e:?}")))?;
    Ok(B64.encode(account.0))
}

/// Sign an arbitrary payload with a wallet's Sr25519 key. The plaintext
/// mnemonic is decrypted in-process, used to derive the keypair, used
/// to produce one signature, and immediately dropped. Nothing
/// sensitive crosses the IPC boundary in either direction — the input
/// is a payload to sign and the output is just the 64-byte signature.
///
/// This is the primary signing surface for the bridge: the FE keeps
/// the user's password in a single closure-scoped variable for the
/// duration of a multi-step submit (one prompt → N signs) and calls
/// this IPC for each on-chain operation. The mnemonic never reaches
/// JS memory.
///
/// Rate-limited via the same per-wallet counter that protects the
/// other password-checking IPCs. Lockout messages are returned as the
/// rate-limiter's text so the FE can show a clear "wait N seconds"
/// banner instead of an opaque "Incorrect password" loop.
///
/// Also performs the same transparent legacy-format migration the
/// view-recovery-phrase path performs: a legacy HKDF-encrypted row
/// gets re-encrypted under Argon2id on the first sign.
///
/// # Errors
///
/// - `Other("Wallet {id} not found")` — bad id or cross-account access.
/// - `Other("Incorrect password")` — verifier failed.
/// - `Other("Too many failed attempts. Try again in …")` — rate-limited.
/// - `Other("…")` — base64 decode of payload failed.
/// - `Crypto(…)` — AEAD or Argon2id failure (very rare).
#[tauri::command]
pub async fn local_wallet_sign(
    state: State<'_, AppState>,
    id: i64,
    password: String,
    payload_b64: String,
) -> Result<String, AppError> {
    let password = Zeroizing::new(password);
    let owner = require_owner(&state)?;
    let pool = state.pool()?;
    let Some(wallet) = repo::get_by_id(pool, &owner, id).await? else {
        return Err(AppError::Other(format!("Wallet {id} not found")));
    };

    // Serialize attempts on this wallet so a concurrent IPC burst can't all
    // clear `check` before any `record_failure` runs and thereby outrun the
    // lockout threshold (audit finding B1). Held to fn end — covers
    // check → verify → record.
    let _attempt_gate = state.wallet_rate_limit.attempt_gate(id).await;
    if let Err(rl) = state.wallet_rate_limit.check(id) {
        return Err(AppError::Other(rl.message()));
    }
    if !crypto::verify_password(&wallet.password_hash, &password, &wallet.address) {
        state.wallet_rate_limit.record_failure(id);
        return Err(AppError::Other("Incorrect password".into()));
    }
    state.wallet_rate_limit.record_success(id);

    let payload = B64
        .decode(&payload_b64)
        .map_err(|e| AppError::Other(format!("Invalid payload base64: {e}")))?;

    let (mnemonic, ciphertext_was_legacy) =
        crypto::decrypt_mnemonic(&wallet.encrypted_mnemonic, &password, &wallet.address)?;

    // Transparent migration on legacy rows — same single audited path as
    // get_decrypted_mnemonic (best-effort; never blocks the sign).
    maybe_migrate_secrets(pool, &owner, &wallet, &password, mnemonic.as_str(), ciphertext_was_legacy).await;

    let parsed = SubxtMnemonic::parse_normalized(mnemonic.as_str())
        .map_err(|e| AppError::Crypto(format!("Stored mnemonic is not parseable: {e}")))?;
    let keypair = SrKeypair::from_phrase(&parsed, None)
        .map_err(|e| AppError::Crypto(format!("Failed to derive sr25519 keypair: {e}")))?;
    // `Keypair::sign` returns subxt_signer's Signature wrapper; we
    // unwrap to the raw 64 bytes via its `.0` since the FE needs a
    // plain Uint8Array. Keypair drops here, taking the secret key
    // with it.
    let sig = keypair.sign(&payload);
    Ok(B64.encode(sig.0))
}
