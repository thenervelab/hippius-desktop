//! HCFS configuration CRUD operations.
//!
//! Contains commands and helpers for reading and writing HCFS server
//! configuration (server URL, drive password, bearer token) in the database.
//! Drive passwords are encrypted at rest using ChaCha20-Poly1305 with an
//! HKDF-derived key from the user's BIP-39 mnemonic.

use tracing::debug;

use crate::auth::account_key::account_key;
use crate::crypto::store;
use crate::error::Result;
use hcfs_client::client::HcfsClientConfig;
use sqlx::sqlite::SqlitePool;
use zeroize::Zeroizing;

/// Whether HCFS clients should accept invalid TLS certificates.
///
/// `true` only in debug builds so local development against a self-signed
/// HCFS server works without manual trust store setup. Release builds verify
/// certificates the same way every other `reqwest::Client` in the codebase
/// does, protecting bearer tokens and sync metadata from MITM tampering on
/// the path to the regional `*-arion.hippius.com` endpoints.
pub(crate) const ACCEPT_INVALID_CERTS: bool = cfg!(debug_assertions);

/// The legacy single-region production URL that older builds wrote into
/// `hcfs_config.server_url` (and that the FE used to seed in the setup
/// dialog). hcfs-client's region-probe behavior triggers when `base_url`
/// is empty — a non-empty URL is treated as an explicit override and skips
/// the probe. To opt every existing user into the EU/US race without a DB
/// migration, we treat this exact legacy value as the auto-detect sentinel
/// and rewrite it to an empty string before handing the config to
/// hcfs-client. Users who explicitly chose a different URL keep that
/// override; users who never customised stop hitting the single legacy
/// region.
const LEGACY_SINGLE_REGION_URL: &str = "https://arion.hippius.com";

/// Normalise a server URL read from the DB or supplied by the FE so that
/// hcfs-client's region probe fires when the user is on the legacy default.
///
/// Returns `""` for the empty input AND for [`LEGACY_SINGLE_REGION_URL`];
/// any other value is passed through untouched. The empty string is the
/// signal hcfs-client uses to enable [`hcfs_client::client::region::pick_fastest`]
/// — see `client/mod.rs::resolve_base_url` upstream.
pub(crate) fn normalize_for_region_probe(server_url: &str) -> String {
    if server_url.is_empty() || server_url == LEGACY_SINGLE_REGION_URL {
        String::new()
    } else {
        server_url.to_string()
    }
}

/// Reject a `server_url` that isn't a plausible HCFS endpoint before it is
/// persisted (audit H-5). The stored value becomes the client `base_url` and
/// the account's API bearer token is sent to it as a header on every request,
/// so an unvalidated URL is an SSRF + token-exfiltration vector. Rules:
/// - empty string is allowed — it is the region auto-detect sentinel (hcfs-client
///   races the regional endpoints itself; there is no single URL to hit);
/// - otherwise the URL must parse and use `https`;
/// - plain `http` is permitted ONLY for loopback hosts in debug builds (local dev).
///
/// # Errors
/// Returns [`crate::error::AppError::Validation`] for an unparseable URL or a
/// non-`https` scheme (outside the debug-loopback exception).
fn validate_server_url(server_url: &str) -> Result<()> {
    if server_url.is_empty() {
        return Ok(());
    }
    let parsed = reqwest::Url::parse(server_url).map_err(|e| crate::error::AppError::Validation(format!("Invalid HCFS server URL: {e}")))?;
    let is_loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if cfg!(debug_assertions) && is_loopback => Ok(()),
        _ => Err(crate::error::AppError::Validation(
            "HCFS server URL must use https (http is allowed only for localhost in debug builds)".into(),
        )),
    }
}

/// Resolve the `/health` URL for the init-time connectivity diagnostic, or
/// `None` when the drive is in region auto-detect mode.
///
/// The probe is a best-effort log line (see `check_init_server_health`). In
/// auto-detect mode there is no single endpoint to hit — hcfs-client races the
/// regional `/health` endpoints itself — so a blank base would only build the
/// relative URL `"/health"`, which `reqwest` rejects with "relative URL
/// without a base", logging a spurious failure every launch. Deciding via
/// [`normalize_for_region_probe`] keeps this identical to the engine's own
/// auto-detect rule, so a legacy-single-region user is treated as auto-detect
/// here too rather than probing an endpoint that may no longer exist.
pub(crate) fn health_probe_url(server_url: &str) -> Option<String> {
    let base = normalize_for_region_probe(server_url);
    if base.is_empty() { None } else { Some(format!("{base}/health")) }
}

/// HCFS server configuration returned by `get_hcfs_config`.
#[derive(serde::Serialize, Clone)]
pub struct HcfsConfigResult {
    pub server_url: String,
    pub has_password: bool,
}

/// Loaded sync configuration from the database for a single label.
pub(crate) struct SyncConfig {
    pub sync_path: String,
    /// Plaintext drive password (the user's unified recovery password). Held in
    /// `Zeroizing` so it is scrubbed from the heap on drop rather than lingering
    /// for the lifetime of the config across the whole sync-init call graph.
    pub drive_password: Zeroizing<String>,
    pub server_url: String,
}

#[tauri::command]
pub async fn save_hcfs_config(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    server_url: String,
    drive_password: String,
) -> Result<()> {
    let account_id = state.require_session_account(&account_id)?;
    validate_server_url(&server_url)?;
    let db = state.pool()?;
    let owner = account_key(&account_id);

    let (stored_password, enc_version) = {
        let guard = state.auth.lock()?;
        match guard.mnemonic.as_deref() {
            Some(m) => {
                let key = store::drive_password_key(m, &account_id)?;
                // encryption_version = 2: AEAD with the account id bound as AAD (audit R-33).
                let encrypted = store::encrypt_with_aad(&key, &drive_password, account_id.as_bytes())?;
                (encrypted, 2i32)
            }
            None => (drive_password, 0i32),
        }
    };

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            encryption_version = excluded.encryption_version,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(&owner)
    .bind(&server_url)
    .bind(&stored_password)
    .bind(enc_version)
    .execute(db)
    .await?;

    Ok(())
}

/// Internal helper that accepts a pool reference directly.
/// Used by both the Tauri command and other internal callers.
pub(crate) async fn get_hcfs_config_internal(pool: &SqlitePool, account_id: &str) -> Result<HcfsConfigResult> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, String, i32)> = sqlx::query_as(
        r"
        SELECT server_url, drive_password, COALESCE(encryption_version, 0)
        FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    match result {
        Some((server_url, password, enc_ver)) => Ok(HcfsConfigResult {
            server_url,
            has_password: enc_ver > 0 || !password.is_empty(),
        }),
        None => Ok(HcfsConfigResult {
            server_url: String::new(),
            has_password: false,
        }),
    }
}

#[tauri::command]
pub async fn get_hcfs_config(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<HcfsConfigResult> {
    let account_id = state.require_session_account(&account_id)?;
    get_hcfs_config_internal(state.pool()?, &account_id).await
}

/// Reads the drive password from `hcfs_config`, decrypting if necessary.
///
/// When `mnemonic` is `Some`, encrypted passwords (encryption_version=1) are
/// decrypted. When `None`, only plaintext passwords (encryption_version=0) are
/// returned — encrypted rows produce an error. This allows mnemonic-recovery
/// code paths (which don't yet have the mnemonic) to still read pre-migration
/// plaintext passwords.
///
/// Returns the plaintext in `Zeroizing` so callers hold the secret in
/// scrubbed-on-drop memory; the decrypt path forwards `store::decrypt`'s own
/// `Zeroizing` directly instead of cloning it into a bare `String`.
pub(crate) async fn get_drive_password(pool: &SqlitePool, account_id: &str, mnemonic: Option<&str>) -> Result<Zeroizing<String>> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String, i32)> = sqlx::query_as(
        r"
        SELECT drive_password, COALESCE(encryption_version, 0)
        FROM hcfs_config WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(db)
    .await?;

    // A missing `hcfs_config` row is a NotFound (the entity doesn't exist),
    // not the FE-silenced NotReady(ConfigMissing): most callers probe this with
    // `if let Ok(..)`, but the few that propagate it must keep it surfaced and
    // with its verbatim message — NotReady would both reword it and risk the
    // FE's `isExpectedNoSessionError` swallowing it.
    let (raw_password, enc_ver) = result.ok_or_else(|| crate::error::AppError::NotFound("HCFS config not found".into()))?;

    match (enc_ver, mnemonic) {
        (0, _) => Ok(Zeroizing::new(raw_password)),
        (1, Some(m)) => {
            let key = store::drive_password_key(m, account_id)?;
            Ok(store::decrypt(&key, &raw_password)?)
        }
        // v2 (audit R-33): same key, with the account id bound as AAD.
        (2, Some(m)) => {
            let key = store::drive_password_key(m, account_id)?;
            Ok(store::decrypt_with_aad(&key, &raw_password, account_id.as_bytes())?)
        }
        (1 | 2, None) => Err(crate::error::AppError::Crypto(
            "Drive password is encrypted but no mnemonic available for decryption".into(),
        )),
        (v, _) => Err(crate::error::AppError::Crypto(format!("unknown drive password encryption_version: {v}"))),
    }
}

/// Read the sync path for a specific label from the database.
pub(crate) async fn get_sync_path_for_label(pool: &SqlitePool, account_id: &str, label: &str) -> Result<String> {
    let db = pool;
    let owner = account_key(account_id);

    let result: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .fetch_optional(db)
        .await?;

    result
        .map(|(path,)| path)
        .ok_or_else(|| crate::error::AppError::NotReady(crate::error::NotReadyKind::SyncSetup))
}

/// Construct an `HcfsClientConfig` from the common connection parameters.
pub(crate) fn build_hcfs_config(server_url: &str, bearer_token: &str, account_id: &str, folder_hash: &str) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url: server_url.to_string(),
        bearer_token: bearer_token.to_string(),
        accept_invalid_certs: ACCEPT_INVALID_CERTS,
        billing_bypass_token: None,
        ss58_address: account_id.to_string(),
        folder_hash: folder_hash.to_string(),
        // `None` selects hcfs-client's `DEFAULT_READ_TIMEOUT_SECS` (60s).
        // The desktop has no reason to override yet — set explicitly only
        // if a deployment profile needs a different per-read deadline.
        read_timeout_ms: None,
    }
}

/// Read the sync path, drive password, and server URL from the DB.
pub(crate) async fn load_sync_config(pool: &SqlitePool, account_id: &str, label: &str, mnemonic: &str) -> Result<SyncConfig> {
    let sync_path = get_sync_path_for_label(pool, account_id, label).await?;
    debug!("Sync path: {}, label: {}", sync_path, label);

    let drive_password = get_drive_password(pool, account_id, Some(mnemonic)).await?;
    let config = get_hcfs_config_internal(pool, account_id).await?;

    // Empty string is hcfs-client's "race the regional endpoints and pick
    // the faster one" sentinel. We rewrite the legacy single-region URL
    // to empty too — see normalize_for_region_probe.
    let server_url = normalize_for_region_probe(&config.server_url);
    debug!(
        "Server URL: {}",
        if server_url.is_empty() { "<auto-detect>" } else { server_url.as_str() }
    );

    Ok(SyncConfig {
        sync_path,
        drive_password,
        server_url,
    })
}

/// Internal version of save_hcfs_config (no tauri::State wrapper).
///
/// When `mnemonic` is provided, the drive password is encrypted before storing.
/// Falls back to plaintext storage (encryption_version=0) when unavailable.
pub(crate) async fn save_hcfs_config_internal(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    server_url: &str,
    drive_password: &str,
    mnemonic: Option<&str>,
) -> Result<()> {
    // Same SSRF/token-exfil gate as the `save_hcfs_config` command (audit H-5):
    // this internal path is reached via `setup_and_init_sync`.
    validate_server_url(server_url)?;
    let owner = account_key(account_id);

    let (stored_password, enc_version) = match mnemonic {
        Some(m) => {
            let key = store::drive_password_key(m, account_id)?;
            // encryption_version = 2: AEAD with the account id bound as AAD (audit R-33).
            let encrypted = store::encrypt_with_aad(&key, drive_password, account_id.as_bytes())?;
            (encrypted, 2i32)
        }
        None => (drive_password.to_string(), 0i32),
    };

    sqlx::query(
        r"
        INSERT INTO hcfs_config (owner, server_url, drive_password, encryption_version) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET
            server_url = excluded.server_url,
            drive_password = excluded.drive_password,
            encryption_version = excluded.encryption_version
        ",
    )
    .bind(&owner)
    .bind(server_url)
    .bind(&stored_password)
    .bind(enc_version)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── get_drive_password ──────────────────────────────────────────

    /// Pin the taxonomy: a missing `hcfs_config` row surfaces as `NotFound`
    /// (typed + surfaced, verbatim message), not the old catch-all `Other` and
    /// not the FE-silenced `NotReady(ConfigMissing)`.
    #[tokio::test]
    async fn get_drive_password_missing_config_is_not_found() {
        use sqlx::sqlite::SqlitePool;
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE hcfs_config (
                owner TEXT NOT NULL UNIQUE,
                drive_password TEXT NOT NULL DEFAULT '',
                encryption_version INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // No row for this account → the missing-config branch.
        let Err(err) = get_drive_password(&pool, "5SomeAccountWithNoConfigRow000000000000000", None).await else {
            panic!("a missing hcfs_config row must error");
        };
        assert!(
            matches!(err, crate::error::AppError::NotFound(_)),
            "missing hcfs_config must surface as NotFound, got {err:?}"
        );
    }

    // ── build_hcfs_config ───────────────────────────────────────────

    #[test]
    fn build_hcfs_config_sets_all_fields() {
        let cfg = build_hcfs_config("https://example.com", "tok123", "5GrwvaEF", "abcd1234");
        assert_eq!(cfg.base_url, "https://example.com");
        assert_eq!(cfg.bearer_token, "tok123");
        assert_eq!(cfg.ss58_address, "5GrwvaEF");
        assert_eq!(cfg.folder_hash, "abcd1234");
        assert_eq!(cfg.accept_invalid_certs, ACCEPT_INVALID_CERTS);
        assert!(cfg.billing_bypass_token.is_none());
    }

    #[test]
    fn build_hcfs_config_preserves_empty_strings() {
        let cfg = build_hcfs_config("", "", "", "");
        assert_eq!(cfg.base_url, "");
        assert_eq!(cfg.bearer_token, "");
        assert_eq!(cfg.ss58_address, "");
        assert_eq!(cfg.folder_hash, "");
    }

    // ── normalize_for_region_probe ──────────────────────────────────

    /// Empty input is the canonical auto-detect sentinel: hcfs-client
    /// reads `base_url=""` as "race the regional endpoints."
    #[test]
    fn normalize_passes_empty_through() {
        assert_eq!(normalize_for_region_probe(""), "");
    }

    /// The legacy single-region URL gets rewritten to empty so existing
    /// users transparently opt into auto-detect. Without this, every
    /// upgrading user stays pinned to the legacy region forever.
    #[test]
    fn normalize_rewrites_legacy_single_region_to_empty() {
        assert_eq!(normalize_for_region_probe(LEGACY_SINGLE_REGION_URL), "");
        assert_eq!(normalize_for_region_probe("https://arion.hippius.com"), "");
    }

    /// Any other value (regional URL the probe might have written back, a
    /// self-hosted server, an internal staging endpoint) is an explicit
    /// user override — pass through verbatim.
    #[test]
    fn normalize_passes_explicit_overrides_through() {
        assert_eq!(
            normalize_for_region_probe("https://eu-central-1-arion.hippius.com"),
            "https://eu-central-1-arion.hippius.com"
        );
        assert_eq!(
            normalize_for_region_probe("https://us-east-1-arion.hippius.com"),
            "https://us-east-1-arion.hippius.com"
        );
        assert_eq!(
            normalize_for_region_probe("https://my-self-hosted.example"),
            "https://my-self-hosted.example"
        );
        assert_eq!(normalize_for_region_probe("http://localhost:8080"), "http://localhost:8080");
    }

    /// Trailing slash variant of the legacy URL is NOT rewritten — the
    /// rewrite is exact-match by design. Trailing-slash mismatches in
    /// stored URLs would have been user-typed customisations, and the
    /// safest assumption is "respect what the user typed."
    #[test]
    fn normalize_is_exact_match_for_legacy() {
        assert_eq!(normalize_for_region_probe("https://arion.hippius.com/"), "https://arion.hippius.com/");
    }

    // ── health_probe_url ────────────────────────────────────────────

    /// Auto-detect mode (empty base) yields no probe URL — the caller skips
    /// the probe instead of asking reqwest to GET the relative URL "/health".
    #[test]
    fn health_probe_url_is_none_for_empty() {
        assert_eq!(health_probe_url(""), None);
    }

    /// The legacy single-region URL is auto-detect too (mirrors
    /// `normalize_for_region_probe`), so it must not probe a possibly-dead
    /// endpoint — this is the case that produced the spurious launch warning.
    #[test]
    fn health_probe_url_is_none_for_legacy_single_region() {
        assert_eq!(health_probe_url(LEGACY_SINGLE_REGION_URL), None);
        assert_eq!(health_probe_url("https://arion.hippius.com"), None);
    }

    /// An explicit override resolves to that endpoint's `/health` path.
    #[test]
    fn health_probe_url_appends_health_to_explicit_override() {
        assert_eq!(
            health_probe_url("https://eu-central-1-arion.hippius.com"),
            Some("https://eu-central-1-arion.hippius.com/health".to_string())
        );
        assert_eq!(
            health_probe_url("http://localhost:8080"),
            Some("http://localhost:8080/health".to_string())
        );
    }

    /// The trailing-slash legacy variant is an explicit override (exact-match
    /// rewrite, per `normalize_is_exact_match_for_legacy`), so it DOES probe —
    /// pinning that `health_probe_url` defers its auto-detect decision wholly
    /// to `normalize_for_region_probe` rather than re-implementing it.
    #[test]
    fn health_probe_url_follows_normalize_exact_match() {
        assert_eq!(
            health_probe_url("https://arion.hippius.com/"),
            Some("https://arion.hippius.com//health".to_string())
        );
    }
}
