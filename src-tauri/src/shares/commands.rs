//! Tauri IPC commands for the file-sharing feature.
//!
//! Three owner-facing commands:
//!
//! - `hcfs_create_share` — mint a new share for a synced file.
//! - `hcfs_list_shares` — list this caller's currently-active shares.
//! - `hcfs_revoke_share` — revoke a share by token.
//!
//! All three delegate to `hcfs_client::client::HcfsClient` via
//! [`super::client::build_account_client`] and route their keystore
//! through [`super::SqliteShareKeystore`]. The recipient page lives in
//! `hippius-console`; this crate only handles the sender flow.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use crate::error::{AppError, Result};
use crate::shares::capabilities::fetch_capabilities;
use crate::shares::client::build_account_client;
use crate::shares::origin;
use crate::shares::SqliteShareKeystore;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use std::path::{Component, Path, PathBuf};
use tracing::{info, warn};

/// Public console origin used to build the recipient URL fragment.
/// Hard-coded for v1 to match the rest of the app's "static prod URL"
/// pattern — see the OAuth-recovery memory note. Bumping it later is
/// a single-constant change.
///
/// `hippicode.com` is the production hostname for the recipient page;
/// the share UI in `hippius-console` is served from this origin.
const CONSOLE_BASE_URL: &str = "https://console.hippicode.com";

// ─── Wire types ────────────────────────────────────────────────────────────

/// Result returned to the FE on a successful share creation.
///
/// `share_url` already includes the `#k=<key>` URL fragment so the
/// frontend can hand it directly to the user; the fragment is never
/// transmitted to the server because browsers don't send fragments
/// on navigation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub share_token: String,
    pub share_url: String,
    pub expires_at: String,
}

/// One row of the owner's "My Shares" page. Mirrors
/// `hcfs_client::client::share::ShareSummary` but with three
/// FE-friendly tweaks:
///
/// 1. `DateTime<Utc>` fields formatted as RFC 3339 strings.
/// 2. `revoked_at` omitted because the server only returns
///    currently-active shares — a revoked row is reaped before it
///    could surface here.
/// 3. `share_url` re-derived from `(share_token, share_key)` so the
///    "My Shares" page can offer a Copy button without a second IPC
///    round-trip per row. `None` when the keystore has lost the key
///    (different device, wiped DB) — same condition under which
///    `filename` is `<unknown>`. The two are correlated because
///    hcfs-client also looks up the key to decrypt the filename.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSummary {
    pub share_token: String,
    pub filename: String,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
    pub mime_type: String,
    pub created_at: String,
    pub expires_at: String,
    pub share_url: Option<String>,
    /// `(folder_label, relative_path)` of the source file, if this
    /// device knows it. `None` for legacy shares created before the
    /// `share_origin` sidecar table existed, or for shares minted on
    /// a different device whose origin row was never replicated. Both
    /// surface the same way in the UI: no per-file badge, no Reshare
    /// button — but Copy and Revoke still work.
    pub folder_label: Option<String>,
    pub relative_path: Option<String>,
}

// ─── Path resolution ───────────────────────────────────────────────────────

/// Look up the on-disk sync root for `(account_id, folder_label)`.
/// Reuses the same DB row the sync engine reads from, so a UI that
/// can see a label can always share files in it.
async fn sync_root_for_label(pool: &SqlitePool, account_id: &str, label: &str) -> Result<PathBuf> {
    let owner = account_key(account_id);
    let row: Option<(String,)> = sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .fetch_optional(pool)
        .await?;
    let raw = row
        .map(|(p,)| p)
        .ok_or_else(|| AppError::Validation(format!("Unknown sync folder label: {label}")))?;
    Ok(PathBuf::from(raw))
}

/// Join `relative_path` onto the sync root and verify the resolved
/// path is still inside it. Rejects absolute paths, parent-directory
/// hops (`..`), and any prefix-rewriting tricks.
///
/// We canonicalize both ends so symlinks and case-folded macOS
/// duplicates can't smuggle a sibling-directory file into the share.
async fn resolve_inside_sync_root(sync_root: &Path, relative_path: &str) -> Result<PathBuf> {
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        return Err(AppError::Validation("relative_path must not be absolute".into()));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            // Reject `..`, `.`, prefix (`C:`), and root components —
            // each could escape the sync root. We accept only plain
            // `Normal` segments.
            _ => return Err(AppError::Validation("relative_path contains an illegal component".into())),
        }
    }

    let canonical_root = tokio::fs::canonicalize(sync_root)
        .await
        .map_err(|e| AppError::Validation(format!("sync root unreachable: {e}")))?;
    let candidate = canonical_root.join(rel);
    let canonical_candidate = tokio::fs::canonicalize(&candidate)
        .await
        .map_err(|e| AppError::Validation(format!("file not found in sync folder: {e}")))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(AppError::Validation("relative_path escapes the sync folder".into()));
    }
    // TOCTOU acknowledgement: the canonical path is resolved here but
    // re-opened later by `tokio::fs::File::open` in `hcfs_create_share`
    // and stat'd by the size check in between. An attacker with write
    // access to the sync folder could swap the inode between calls.
    // The threat model already assumes the user controls writes inside
    // their sync folder, so closing this window is not pursued — same
    // posture as the existing `sync::files::resolve_file_path`.
    Ok(canonical_candidate)
}

// ─── Capability gate ───────────────────────────────────────────────────────

/// Single-shot capability check. The `Validation` error variant is the
/// one the FE already knows how to surface in the share modal; the
/// message is stable enough for an FE substring test if we ever need
/// one. A typed `NotReadyKind::FeatureUnavailable` would be cleaner
/// but would bloat that enum for a single one-off gate — revisit if a
/// second feature acquires the same shape.
///
/// No caching here on purpose. The frontend caches `serverCapabilitiesAtom`
/// for UX (hides the menu item without an HTTP round-trip per right-click),
/// but this gate is the IPC's security check: if a server toggles
/// `shares: false` mid-session, the FE atom won't notice but the next
/// `hcfs_create_share` call will. Favoring authority over latency on
/// the security path.
async fn require_shares_supported(state: &AppState, account_id: &str) -> Result<()> {
    let caps = fetch_capabilities(state, account_id).await?;
    if !caps.shares {
        return Err(AppError::Validation("File sharing is not enabled on this server.".into()));
    }
    Ok(())
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// Inner share-creation pipeline shared by [`hcfs_create_share`] and
/// [`hcfs_reshare`].
///
/// Caller responsibilities (everything outside the pipeline):
/// - extract `account_id`,
/// - run [`require_shares_supported`] and [`require_eligible`],
/// - hand us the `(folder_label, relative_path)` of the source file.
///
/// We do everything else: resolve the plaintext path, run the
/// streaming share via hcfs-client, persist the origin sidecar, and
/// return the wire `ShareLink`. Reshare reuses this verbatim so a
/// reshared link is indistinguishable from a freshly-minted one
/// (same TTL, same keystore lifecycle, same sidecar invariants).
async fn create_share_inner(state: &AppState, account_id: &str, folder_label: &str, relative_path: &str) -> Result<ShareLink> {
    let pool = state.pool()?;

    // Resolve the local plaintext path. Synced-folder files are
    // stored unencrypted on disk (the sync engine encrypts on the
    // way out), so no folder-key dance is required here — we just
    // need a `tokio::fs::File`.
    let sync_root = sync_root_for_label(pool, account_id, folder_label).await?;
    let local_path = resolve_inside_sync_root(&sync_root, relative_path).await?;

    let metadata = tokio::fs::metadata(&local_path).await?;
    if !metadata.is_file() {
        return Err(AppError::Validation("Cannot share a directory".into()));
    }
    let plaintext_size = metadata.len();

    let filename = local_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Validation("File has no usable name".into()))?
        .to_owned();
    // Extension-based MIME inference only — `mime_guess` does not read
    // the file's magic bytes. A `.txt` containing arbitrary content
    // will surface as `text/plain`. The recipient's browser is the
    // second line of validation (it sniffs and re-validates against
    // its own rules), so we accept the cheap guess here.
    let mime_type = mime_guess::from_path(&local_path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned();

    info!(
        label = %folder_label,
        relative_path = %relative_path,
        plaintext_size,
        mime_type = %mime_type,
        "Creating share"
    );

    // Build the client, open the file, run the share. The keystore
    // persists the per-share key automatically inside hcfs-client
    // via `ShareKeystore::put`, so on success the row is in our DB
    // before we even return.
    let client = build_account_client(pool, account_id).await?;
    let mut reader = tokio::fs::File::open(&local_path).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let result = client
        .create_share(&mut reader, plaintext_size, &filename, &mime_type, &keystore, CONSOLE_BASE_URL)
        .await
        .map_err(|e| {
            warn!(error = %e, "create_share failed");
            AppError::Hcfs(format!("create_share: {e}"))
        })?;

    // Record the (folder_label, relative_path) the share was minted
    // from in the local sidecar so the per-file badge and Reshare
    // button can find it later. A failure here does NOT fail the
    // user-facing share — the link is already live; missing the
    // sidecar row only means the file won't render its "Shared" badge
    // until a future create_share for the same path repopulates the
    // row. We log at warn so a stuck sidecar shows up in support logs.
    let owner = account_key(account_id);
    if let Err(e) = origin::record(pool, &result.share_token, &owner, folder_label, relative_path).await {
        warn!(
            share_token = %result.share_token,
            error = %e,
            "Failed to record share_origin (share itself succeeded)"
        );
    }

    Ok(ShareLink {
        share_token: result.share_token,
        share_url: result.share_url,
        expires_at: result.expires_at.to_rfc3339(),
    })
}

/// Mint a public share link for a file already inside a synced folder.
///
/// Resolves the on-disk plaintext path from `(folder_label, relative_path)`,
/// streams it through `hcfs_client::HcfsClient::create_share` (single-shot
/// for ≤ 8 MiB, chunked above), persists the per-share key in our
/// `share_keystore`, and returns a `ShareLink` whose `share_url` already
/// contains the `#k=<key>` URL fragment.
#[tauri::command]
pub async fn hcfs_create_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
) -> Result<ShareLink> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;

    // Capability + eligibility gates. The capability call is a single
    // anonymous HTTP request; we accept the round-trip so that an old
    // server hides the feature instead of failing create_share with a
    // 404 several KB into a multipart upload.
    require_shares_supported(&state, &account_id).await?;
    require_eligible(&state, &account_id, InsufficientCreditsAction::Sharing).await?;

    create_share_inner(&state, &account_id, &folder_label, &relative_path).await
}

/// Revoke an existing share and immediately mint a new one for the
/// same source file. Effectively a TTL extension built out of the
/// primitives we already have, since hcfs-server doesn't expose an
/// "extend share" endpoint.
///
/// Looks up `(folder_label, relative_path)` from the local
/// `share_origin` sidecar — which means reshare is only available on
/// the device that originally minted the share. A token whose origin
/// row was lost (legacy share, different device, wiped DB) returns a
/// `Validation` error so the FE can disable the button rather than
/// silently fail.
///
/// The new link gets a fresh expiry from the server (same TTL policy
/// as `hcfs_create_share`); the old token is revoked first so the
/// caller can hand out the new URL with confidence the old one stops
/// working. If the revoke fails (e.g. the token already expired
/// server-side), we still proceed with the new share — the FE's
/// reshare intent is "give me a working link from this file", not "I
/// require the old token to be alive".
#[tauri::command]
pub async fn hcfs_reshare(state: tauri::State<'_, AppState>, share_token: String) -> Result<ShareLink> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;

    require_shares_supported(&state, &account_id).await?;
    require_eligible(&state, &account_id, InsufficientCreditsAction::Sharing).await?;

    let pool = state.pool()?;

    // Look up the source file. A miss here is a hard "this device
    // can't reshare this token" — caller must use Copy/Revoke
    // instead.
    let mut origins = origin::fetch_for_tokens(pool, &[share_token.as_str()]).await?;
    let Some(origin) = origins.remove(&share_token) else {
        return Err(AppError::Validation(
            "Reshare is unavailable for this link on this device.".into(),
        ));
    };

    // Best-effort revoke of the old token. The server's revoke is
    // idempotent (already-missing tokens succeed), so we tolerate any
    // error here and proceed — see the doc comment for the rationale.
    let client = build_account_client(pool, &account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    if let Err(e) = client.revoke_share(&share_token, &keystore).await {
        warn!(
            share_token = %share_token,
            error = %e,
            "Reshare: revoke of old token failed; continuing with new share"
        );
    }
    // Drop the sidecar row for the old token regardless — the new
    // share will write its own. Best-effort.
    if let Err(e) = origin::forget(pool, &share_token).await {
        warn!(
            share_token = %share_token,
            error = %e,
            "Reshare: forget of old origin failed (non-fatal)"
        );
    }

    create_share_inner(&state, &account_id, &origin.folder_label, &origin.relative_path).await
}

/// List all of this caller's currently-active shares, newest first.
/// Filenames are decrypted client-side via the share keystore — a
/// row whose key has been forgotten (different device, wiped DB)
/// surfaces with `filename = "<unknown>"` so the UI can still render
/// the row and offer Revoke.
#[tauri::command]
pub async fn hcfs_list_shares(state: tauri::State<'_, AppState>) -> Result<Vec<ShareSummary>> {
    use hcfs_client::client::share::build_share_url;

    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    let client = build_account_client(pool, &account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let summaries = client
        .list_shares(&keystore)
        .await
        .map_err(|e| AppError::Hcfs(format!("list_shares: {e}")))?;

    // Rebuild the share URL per row from the keystore. We do this with
    // ONE batched `WHERE share_token IN (...)` SELECT instead of a
    // per-row `keystore.get` loop because every per-row lookup goes
    // through `block_in_place` on a small fixed-size sqlx connection
    // pool — a 50-share page would otherwise issue 50 sequential
    // round-trips on top of hcfs-client's own per-row keystore lookup
    // for filename decryption (which we can't avoid without an
    // upstream trait change). See `SqliteShareKeystore::get_many`.
    //
    // A keystore miss for a token leaves `share_url = None`; the FE
    // renders such rows as "key forgotten on this device" and still
    // offers Revoke.
    let tokens: Vec<&str> = summaries.iter().map(|s| s.share_token.as_str()).collect();
    let key_map = keystore.get_many(&tokens).map_err(|e| AppError::Hcfs(format!("keystore lookup: {e}")))?;
    // Same batched-IN trick as the keystore: one round-trip for the
    // whole page so the per-file badge and Reshare button can resolve
    // origin in O(1) per row.
    let origin_map = origin::fetch_for_tokens(pool, &tokens).await.unwrap_or_else(|e| {
        // A sidecar miss is never fatal — fall back to "no origin
        // known" for every row so the page still renders.
        warn!(error = %e, "share_origin fetch failed; rendering without origins");
        std::collections::HashMap::new()
    });

    // Mirror server-side TTL reaping into our local sidecar so the
    // table doesn't accumulate dangling rows after expiry. Scoped to
    // this `owner` so a multi-account install never cross-evicts.
    // Best-effort: prune logs but does not return errors.
    //
    // Correctness depends on `summaries` (and therefore `tokens`) being
    // the complete unpaged list of this owner's active shares — see
    // `origin::prune`'s "Caller invariant" doc. If hcfs-server ever
    // paginates `list_shares`, swap this prune for a TTL-based reaper.
    let owner = account_key(&account_id);
    origin::prune(pool, &owner, &tokens).await;

    let wire = summaries
        .into_iter()
        .map(|s| {
            let share_url = key_map.get(&s.share_token).map(|k| build_share_url(CONSOLE_BASE_URL, &s.share_token, k));
            let (folder_label, relative_path) = origin_map
                .get(&s.share_token)
                .map_or((None, None), |o| (Some(o.folder_label.clone()), Some(o.relative_path.clone())));
            ShareSummary {
                share_token: s.share_token,
                filename: s.filename,
                plaintext_size: s.plaintext_size,
                ciphertext_size: s.ciphertext_size,
                mime_type: s.mime_type,
                created_at: s.created_at.to_rfc3339(),
                expires_at: s.expires_at.to_rfc3339(),
                share_url,
                folder_label,
                relative_path,
            }
        })
        .collect();
    Ok(wire)
}

/// Revoke a share by token. Idempotent on the server — calling on a
/// missing or already-revoked token returns `Ok(())` so the FE doesn't
/// have to special-case "I just tapped Revoke twice".
#[tauri::command]
pub async fn hcfs_revoke_share(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    let client = build_account_client(pool, &account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    client
        .revoke_share(&share_token, &keystore)
        .await
        .map_err(|e| AppError::Hcfs(format!("revoke_share: {e}")))?;
    // Drop the sidecar row so the per-file badge clears and the
    // Reshare button stops offering this token. Idempotent — a missing
    // row is fine — and best-effort: a sidecar leftover after a
    // successful revoke would only show up as a "ghost" badge until
    // the next prune in `hcfs_list_shares`, never as a security issue.
    if let Err(e) = origin::forget(pool, &share_token).await {
        warn!(
            share_token = %share_token,
            error = %e,
            "Failed to forget share_origin after successful revoke"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_rejects_absolute_paths() {
        let dir = TempDir::new().expect("tempdir");
        let err = resolve_inside_sync_root(dir.path(), "/etc/passwd").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_rejects_parent_dir_components() {
        let dir = TempDir::new().expect("tempdir");
        let err = resolve_inside_sync_root(dir.path(), "../sibling.txt").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_accepts_nested_path_inside_root() {
        let dir = TempDir::new().expect("tempdir");
        let nested = dir.path().join("sub/deep");
        tokio::fs::create_dir_all(&nested).await.expect("mkdir");
        let target = nested.join("file.txt");
        tokio::fs::write(&target, b"hello").await.expect("write");
        let resolved = resolve_inside_sync_root(dir.path(), "sub/deep/file.txt").await.expect("resolve");
        // Compare canonical forms so macOS `/private/var` symlinks etc don't
        // make the equality test brittle.
        let expected = tokio::fs::canonicalize(&target).await.expect("canon");
        assert_eq!(resolved, expected);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_rejects_missing_file() {
        let dir = TempDir::new().expect("tempdir");
        let err = resolve_inside_sync_root(dir.path(), "missing.txt").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
