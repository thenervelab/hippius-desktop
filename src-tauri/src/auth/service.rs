//! Core authentication logic shared between Tauri commands and the sync engine.
//!
//! Extracted from `commands/auth.rs` so that `hcfs_drive.rs` can refresh tokens
//! without importing the IPC layer.

use crate::auth::tokens::save_api_token;
use crate::sync::mnemonic::get_mnemonic_for_account;
use alloy_signer::SignerSync;
use alloy_signer_local::coins_bip39::English;
use alloy_signer_local::{MnemonicBuilder, PrivateKeySigner};
use sqlx::sqlite::SqlitePool;
use tauri::Emitter;
use tracing::{info, warn};

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.hippius.com";
pub(crate) const CHALLENGE_PATH: &str = "/api/auth/mnemonic/";
pub(crate) const VERIFY_PATH: &str = "/api/auth/verify/";

pub(crate) fn base_url() -> String {
    std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

#[derive(serde::Deserialize)]
struct ChallengeResponse {
    challenge: String,
    message: String,
}

#[derive(serde::Deserialize)]
struct VerifyResponse {
    token: String,
    user_id: serde_json::Value,
    username: String,
    #[serde(default)]
    is_new: bool,
}

/// Derive both Substrate (sr25519) and Ethereum (secp256k1) keypairs from a
/// BIP-39 mnemonic. Returns both keypairs and their formatted addresses.
///
/// Uses `subxt_signer::sr25519::Keypair` for the Substrate side, which
/// implements `subxt::tx::Signer<PolkadotConfig>` directly — no `PairSigner`
/// wrapper, no `sp-core` dependency on the signing path.
pub(crate) fn derive_keys(mnemonic: &str) -> Result<(subxt_signer::sr25519::Keypair, String, PrivateKeySigner, String), String> {
    use subxt_signer::bip39::Mnemonic as SubxtMnemonic;
    use subxt_signer::sr25519::Keypair as SrKeypair;

    // parse_normalized (NFKD) to match the wallet/signing derivation paths
    // (helpers.rs, wallet/commands.rs, recovery_binding.rs) — a non-NFKD phrase
    // must not derive a different address here than it does there (audit INFO-1).
    let parsed = SubxtMnemonic::parse_normalized(mnemonic).map_err(|e| format!("Invalid BIP-39 mnemonic: {e}"))?;
    let sr25519_pair = SrKeypair::from_phrase(&parsed, None).map_err(|e| format!("Failed to derive sr25519 keypair: {e}"))?;
    // subxt_signer's account_id uses the generic `42` SS58 prefix by
    // default, matching the previous `sp_core::sr25519::Pair::public().to_ss58check()`
    // behaviour and what the Hippius API expects.
    let substrate_address = sr25519_pair.public_key().to_account_id().to_string();

    let eth_signer: PrivateKeySigner = MnemonicBuilder::<English>::default()
        .phrase(mnemonic)
        .index(0)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let eth_address = format!("{}", eth_signer.address());

    Ok((sr25519_pair, substrate_address, eth_signer, eth_address))
}

/// Why a mnemonic-derived keypair failed to authenticate as a specific account.
///
/// Split into a typed enum (not a `String`) because the two cases demand
/// different handling at the call sites: a `DeriveFailed` is a hard error
/// everywhere, while `Mismatch` is the OAuth-account case — the sync
/// mnemonic is a locally minted key that is NOT the account's login
/// identity, so callers must refuse to authenticate but may treat it as a
/// non-fatal "this account cannot self-refresh" condition
/// (`ensure_billing_auth` skips; the token refresh errors so the engine's
/// 401/auth-required path takes over).
#[derive(Debug)]
pub(crate) enum IdentityError {
    /// The mnemonic itself failed key derivation (invalid phrase, etc.).
    DeriveFailed(String),
    /// The mnemonic derives a valid keypair, but for a different account.
    /// Carries the derived SS58 so logs can show both identities.
    Mismatch { derived: String },
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeriveFailed(e) => write!(f, "key derivation failed: {e}"),
            Self::Mismatch { derived } => write!(
                f,
                "mnemonic-derived identity {derived} does not match the account — refusing to re-authenticate as a different identity"
            ),
        }
    }
}

/// Derive keys from `mnemonic` and verify they belong to `account_id`.
///
/// Every path that RE-authenticates an EXISTING account from a stored
/// mnemonic must go through this guard instead of bare [`derive_keys`].
/// For mnemonic-login accounts the two identities always coincide; for
/// OAuth accounts the login SS58 is server-custodied while the sync
/// mnemonic is minted locally by `ensure_sync_mnemonic` — challenge-
/// response with it would authenticate as (and potentially CREATE) a
/// different server account, then persist that phantom identity's
/// session/token rows (audit `AUDIT_LOGIN_2026-08-06.md` H-3/H-4).
/// Fresh logins (`login_with_mnemonic`) have no expected account yet and
/// correctly use `derive_keys` directly.
pub(crate) fn derive_verified_keys(
    mnemonic: &str,
    account_id: &str,
) -> Result<(subxt_signer::sr25519::Keypair, String, PrivateKeySigner, String), IdentityError> {
    let (sr25519_pair, substrate_address, eth_signer, eth_address) = derive_keys(mnemonic).map_err(IdentityError::DeriveFailed)?;
    if substrate_address != account_id {
        return Err(IdentityError::Mismatch { derived: substrate_address });
    }
    Ok((sr25519_pair, substrate_address, eth_signer, eth_address))
}

/// Execute the two-step challenge-response authentication against the Hippius API.
///
/// 1. POST to `/api/auth/mnemonic/` with addresses to receive a challenge
/// 2. Sign the challenge message with the Ethereum key (EIP-191 personal_sign)
/// 3. POST to `/api/auth/verify/` with the signature to receive a session token
pub(crate) async fn challenge_response(
    client: &reqwest::Client,
    eth_signer: &PrivateKeySigner,
    eth_address: &str,
    substrate_address: &str,
    referral_code: Option<&str>,
) -> Result<(String, serde_json::Value, String, bool, i64), String> {
    let base = base_url();

    let challenge_res = client
        .post(format!("{base}{CHALLENGE_PATH}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "address": eth_address,
            "substrate_address": substrate_address,
        }))
        .send()
        .await
        .map_err(|e| format!("Challenge request failed: {e}"))?;

    if !challenge_res.status().is_success() {
        let status = challenge_res.status();
        let body = challenge_res.text().await.unwrap_or_default();
        warn!(status = %status, "Challenge request failed: {body}");
        return Err(format!("Authentication failed (HTTP {status}). Please try again."));
    }

    let cr: ChallengeResponse = challenge_res.json().await.map_err(|e| format!("Failed to parse challenge: {e}"))?;

    let sig = eth_signer
        .sign_message_sync(cr.message.as_bytes())
        .map_err(|e| format!("Signing failed: {e}"))?;
    let formatted_sig = format!("{sig}");

    let verify_res = client
        .post(format!("{base}{VERIFY_PATH}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .json(&serde_json::json!({
            "signature": formatted_sig,
            "address": eth_address,
            "substrate_address": substrate_address,
            "challenge": cr.challenge,
            "referral_code": referral_code.unwrap_or(""),
            "session_data": {
                "challenge": cr.challenge,
                "address": eth_address,
            },
        }))
        .send()
        .await
        .map_err(|e| format!("Verify request failed: {e}"))?;

    if !verify_res.status().is_success() {
        let status = verify_res.status();
        let body = verify_res.text().await.unwrap_or_default();
        warn!(status = %status, "Verify request failed: {body}");
        return Err(format!("Authentication failed (HTTP {status}). Please try again."));
    }

    let vr: VerifyResponse = verify_res.json().await.map_err(|e| format!("Failed to parse verify response: {e}"))?;

    // Token expires in 30 days (matching frontend authService behavior)
    let token_expiry = chrono::Utc::now().timestamp_millis() + 30 * 24 * 60 * 60 * 1000;

    Ok((vr.token, vr.user_id, vr.username, vr.is_new, token_expiry))
}

/// Internal implementation for token refresh, callable from both the Tauri
/// command and the sync loop (which only has an AppHandle, not tauri::State).
///
/// Acquires a [`hcfs_client::engine::runner::TokenRefreshGuard`] to pause sync while
/// the token is being replaced, preventing 401 races.
pub(crate) async fn refresh_auth_token_internal(pool: &SqlitePool, app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    // Serialize refreshes per account (F23): two concurrent callers for the same
    // account would otherwise each run challenge_response + upsert + save_api_token
    // in parallel, racing the two writes. Clone the per-account async lock (the
    // outer std lock guards only the map insert and is dropped immediately) and
    // hold its guard across the whole refresh so the second caller waits.
    let refresh_lock = {
        let mut locks = app_state.refresh_locks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        locks
            .entry(account_id.to_string())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _refresh_serialize = refresh_lock.lock().await;

    info!(account_id = %account_id, "Auth token refresh started");
    let sync = app_state.sync.clone();
    let _guard = hcfs_client::engine::runner::TokenRefreshGuard::new(sync);
    // get_mnemonic_for_account now returns Zeroizing<String> directly — no double-wrap needed.
    let mnemonic = get_mnemonic_for_account(&app_state, account_id)
        .await
        .map_err(|e| format!("get_mnemonic_for_account failed: {e}"))?;

    // Re-derive keys from the mnemonic. We can't reuse `AuthInfo.sr25519_pair`
    // alone because the challenge-response also needs the secp256k1
    // `eth_signer` to sign the challenge — and we don't cache the
    // `eth_signer` (only `eth_address`) in `AuthInfo`. The derive runs
    // ~50ms and fires roughly every 4 hours, so the perf cost is
    // negligible. If this becomes hot, cache `PrivateKeySigner` in
    // `AuthInfo` alongside `eth_address`.
    //
    // VERIFIED derive: refuse to refresh when the mnemonic does not derive
    // `account_id`. For OAuth accounts the sync mnemonic is a different
    // identity than the login SS58 — the old unverified path challenge-
    // responded as that derived identity (creating a phantom server
    // account + phantom `auth_session` row) and never refreshed the real
    // token (audit H-3). OAuth tokens cannot be refreshed client-side;
    // on this refusal the engine's 401 path emits AUTH_RELOGIN_REQUIRED
    // and the boot-time expiry check bounces to the login screen. NOTE:
    // the FE does not yet listen for AUTH_RELOGIN_REQUIRED, so mid-
    // session the user sees failing sync without a re-login prompt until
    // the next launch — wiring that listener is a tracked follow-up
    // (audit M-5 family).
    let (_sr25519_pair, substrate_address, eth_signer, eth_address) = derive_verified_keys(&mnemonic, account_id).map_err(|e| {
        warn!(account_id = %account_id, error = %e, "Refusing token refresh: mnemonic does not derive this account's identity");
        format!("token refresh refused: {e}")
    })?;

    let (token, user_id, username, _is_new, token_expiry) =
        challenge_response(&app_state.api_client, &eth_signer, &eth_address, &substrate_address, None).await?;

    crate::auth::auth_session_repo::upsert(
        pool,
        crate::auth::auth_session_repo::UpsertSession {
            substrate_address: &substrate_address,
            token: &token,
            token_expiry_ms: token_expiry,
            user_id: user_id.as_i64(),
            username: &username,
            provider: "mnemonic",
            logout_time_minutes: None, // refresh path: don't clobber the user's preference
        },
    )
    .await
    .map_err(|e| format!("Failed to save auth session: {e}"))?;

    save_api_token(pool, &substrate_address, &token)
        .await
        .map_err(|e| format!("Failed to persist API token: {e}"))?;

    if let Err(e) = app_state.sync.update_all_drive_tokens(&token).await {
        warn!("Could not update live drive token: {e}");
    }

    info!(address = %substrate_address, "Auth token refreshed");

    if let Err(e) = app.emit(
        "auth_token_refreshed",
        serde_json::json!({
            "substrateAddress": substrate_address,
        }),
    ) {
        warn!(error = %e, "Failed to emit auth_token_refreshed");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::derive_keys;

    /// Frozen derivation vectors (audit R-28). `derive_keys` turns one BIP-39
    /// mnemonic into the user's funds-bearing Substrate (sr25519) and Ethereum
    /// (secp256k1, `m/44'/60'/0'/0/0`) addresses. A silent change in either
    /// derivation — e.g. a `subxt_signer` or `alloy` bump that alters the
    /// scheme — would hand the user a *different* address: deposits to the old
    /// one, or signatures the chain rejects. This pins both so such a change
    /// fails CI instead of shipping.
    ///
    /// The mnemonic is the well-known Foundry/Anvil/Hardhat test phrase. Its
    /// Ethereum account-0 address is a published, cross-implementation constant
    /// (`0xf39F…2266`), so the ETH assertion is an INDEPENDENT correctness check
    /// of the `MnemonicBuilder` path — not merely a snapshot. The Substrate
    /// address is the value subxt_signer produces today (SS58 prefix 42); it is
    /// a regression anchor — if it changes, the sr25519 derivation moved and
    /// must be investigated before release.
    #[test]
    fn derive_keys_matches_frozen_vectors() {
        const MNEMONIC: &str = "test test test test test test test test test test test junk";
        // Independent ground truth: Foundry/Anvil/Hardhat default account 0.
        const EXPECTED_ETH: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
        // Regression anchor: subxt_signer sr25519, generic-substrate SS58 (42).
        const EXPECTED_SUBSTRATE: &str = "5GmS1wtCfR4tK5SSgnZbVT4kYw5W8NmxmijcsxCQE6oLW6A8";

        let (_sr, substrate, _eth_signer, eth) = derive_keys(MNEMONIC).expect("valid mnemonic derives");
        assert_eq!(eth, EXPECTED_ETH, "Ethereum derivation drifted from the published Foundry vector");
        assert_eq!(
            substrate, EXPECTED_SUBSTRATE,
            "sr25519 Substrate derivation changed — funds-critical, investigate"
        );
    }

    #[test]
    fn derive_keys_rejects_invalid_mnemonic() {
        assert!(derive_keys("not a valid bip39 mnemonic at all").is_err());
    }

    // ─── Identity guard (audit H-3/H-4) ────────────────────────────
    //
    // `derive_verified_keys` is the chokepoint that stops a stored
    // mnemonic from re-authenticating as a DIFFERENT account — the
    // OAuth phantom-account bug: an OAuth account's sync mnemonic
    // derives an identity that is not the login SS58, and the
    // unguarded path minted server accounts / session rows for it.

    use super::{IdentityError, derive_verified_keys};

    const TEST_MNEMONIC: &str = "test test test test test test test test test test test junk";
    /// The SS58 this mnemonic derives (pinned by `derive_keys_matches_frozen_vectors`).
    const TEST_MNEMONIC_SS58: &str = "5GmS1wtCfR4tK5SSgnZbVT4kYw5W8NmxmijcsxCQE6oLW6A8";
    /// A valid, unrelated SS58 — stands in for an OAuth login address.
    const OTHER_ACCOUNT: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    /// The mnemonic-login shape: mnemonic derives exactly the session
    /// account → the guard passes keys through unchanged.
    #[test]
    fn derive_verified_keys_accepts_matching_account() {
        let (_sr, substrate, _eth_signer, _eth) = derive_verified_keys(TEST_MNEMONIC, TEST_MNEMONIC_SS58).expect("matching identity must derive");
        assert_eq!(substrate, TEST_MNEMONIC_SS58);
    }

    /// The OAuth shape: the sync mnemonic derives a different identity
    /// than the login account. The guard must refuse with `Mismatch`
    /// (carrying the derived address for the log line) BEFORE any
    /// network call could authenticate as the wrong identity.
    #[test]
    fn derive_verified_keys_refuses_foreign_account() {
        let err = derive_verified_keys(TEST_MNEMONIC, OTHER_ACCOUNT).expect_err("foreign identity must be refused");
        let IdentityError::Mismatch { derived } = err else {
            panic!("expected Mismatch, got {err:?}");
        };
        assert_eq!(derived, TEST_MNEMONIC_SS58, "Mismatch must carry the derived SS58");
    }

    /// A garbage mnemonic is a hard derive failure, not a mismatch —
    /// callers treat the two differently (mismatch can be a non-fatal
    /// skip in billing auth; a derive failure never is).
    #[test]
    fn derive_verified_keys_distinguishes_derive_failure() {
        let err = derive_verified_keys("not a valid bip39 mnemonic at all", OTHER_ACCOUNT).expect_err("invalid phrase must fail");
        let IdentityError::DeriveFailed(_) = err else {
            panic!("expected DeriveFailed, got {err:?}");
        };
    }
}
