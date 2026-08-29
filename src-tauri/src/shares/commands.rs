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
use crate::release_channel::ReleaseChannel;
use crate::shares::SqliteShareKeystore;
use crate::shares::capabilities::fetch_capabilities;
use crate::shares::client::build_account_client;
use crate::shares::history::{self, HistoryEntry};
use crate::shares::origin;
use chrono::Utc;
use hcfs_client::client::folder_share::{FolderShareError, FolderShareListItem, build_folder_share_url_for, folder_share_token_hash};
use hcfs_client::client::share::{
    ShareKeystore, ShareOptions, ShareProgress, ShareProgressFn, ShareSecret, ShareSummary as UpstreamShareSummary, ShareTtl, build_share_url_for,
    generate_share_password, validate_share_password,
};
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tracing::{debug, info, warn};

/// Console origin used to build the recipient URL, for EVERY channel.
/// `console.hippius.com` serves the share recipient page in `hippius-console`.
///
/// There is deliberately no per-channel origin. Staging builds used to mint at
/// `console.hippicode.com`, which made the console the one behaviour that
/// differed between lanes — while every backend the app talks to (`api.hippius.com`
/// in `api/client.rs`, `auth/service.rs` and `auth/oauth.rs`, and the HCFS server
/// const) is the same on all of them. The staging console was therefore a
/// different front end onto the same data, and the split bought nothing but a
/// link that a recipient could not open from a production session.
const DEFAULT_CONSOLE_BASE_URL: &str = "https://console.hippius.com";

/// Whether this build honors the `HIPPIUS_CONSOLE_BASE_URL` runtime override.
///
/// Dev builds and STAGING builds do; production and beta release binaries do
/// not — their link base is not configuration, so a stray line in a bundled
/// `.env` can never repoint them. Beta sits with production rather than with
/// staging deliberately: it is a public lane shipped to real users, and it
/// carries the same "a link must go where the user expects" obligation.
fn honors_console_override(channel: ReleaseChannel, dev_build: bool) -> bool {
    dev_build || channel == ReleaseChannel::Staging
}

/// The console origin to embed in minted share links.
///
/// One origin for every channel, with the `HIPPIUS_CONSOLE_BASE_URL` runtime
/// override honored only where [`honors_console_override`] allows.
pub(crate) fn console_base_url() -> String {
    let channel = crate::release_channel::current();
    let dev_build = cfg!(debug_assertions);
    let override_value = std::env::var("HIPPIUS_CONSOLE_BASE_URL").ok();
    if override_value.is_some() && !honors_console_override(channel, dev_build) {
        warn!("HIPPIUS_CONSOLE_BASE_URL is set but ignored: release builds always mint links at the production console");
    }
    resolve_console_base_url(channel, dev_build, override_value)
}

/// Pure resolver for [`console_base_url`], split out so the env-independent
/// logic is unit-testable without mutating process env under the parallel test
/// runner (env writes are process-global and racy). A blank/whitespace override
/// falls back to the default, and any trailing `/` is trimmed so callers can
/// join `/share/<token>` without doubling the separator.
fn resolve_console_base_url(channel: ReleaseChannel, dev_build: bool, override_value: Option<String>) -> String {
    let channel_default = DEFAULT_CONSOLE_BASE_URL;
    if !honors_console_override(channel, dev_build) {
        return channel_default.to_string();
    }
    override_value
        // Strip leading whitespace, and any trailing run of whitespace-OR-`/`, in
        // ONE pass, so the result's last char is neither — which makes the
        // normalization idempotent. The two-step `.trim().trim_end_matches('/')`
        // was NOT idempotent: removing a trailing slash can re-expose trailing
        // whitespace (e.g. "x\u{b}/" → "x\u{b}"), which a second pass would then
        // trim (proptest `resolve_console_base_url_is_idempotent`).
        .map(|value| value.trim_start().trim_end_matches(|c: char| c.is_whitespace() || c == '/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| channel_default.to_string())
}

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
    /// `None` (JSON `null`) when the link stays reachable until revoked.
    pub expires_at: Option<String>,
    /// Present only for a password-protected share, and only on the response
    /// that created it. The password is never persisted, so this is the one
    /// and only time the app can show it — the Shares page cannot recover it
    /// later, by design.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// What the user chose about a share's visibility, after the untrusted IPC
/// strings have been validated at the boundary.
///
/// Modelled as an enum rather than a `(String, Option<String>)` pair so the
/// contradictory combinations — private with no password, public with one —
/// are unrepresentable everywhere downstream of [`ShareChoice::parse`].
#[derive(Debug, Clone)]
pub enum ShareChoice {
    /// Anyone holding the link can open it.
    Public,
    /// The link carries a password-wrapped key and is useless without the
    /// password.
    Private { password: String },
}

impl ShareChoice {
    /// Validate the `(visibility, password)` pair coming off the IPC
    /// boundary.
    ///
    /// A `None` password on the private branch means "generate one for me",
    /// which is what the modal sends when the user does not type their own.
    /// A caller-supplied password is checked here, in Rust — the frontend
    /// never decides whether a password is acceptable.
    ///
    /// # Errors
    ///
    /// [`AppError::Validation`] for an unknown visibility token or a
    /// password below hcfs-client's minimum length.
    pub fn parse(visibility: &str, password: Option<String>) -> Result<Self> {
        match visibility {
            "public" => Ok(Self::Public),
            "private" => {
                let password = match password {
                    Some(supplied) => {
                        validate_share_password(&supplied).map_err(|e| AppError::Validation(e.to_string()))?;
                        supplied
                    }
                    None => generate_share_password(),
                };
                Ok(Self::Private { password })
            }
            other => Err(AppError::Validation(format!("Unknown share visibility: {other}"))),
        }
    }

    /// The password to wrap the share key under, if any.
    fn password(&self) -> Option<&str> {
        match self {
            Self::Public => None,
            Self::Private { password } => Some(password),
        }
    }

    /// The password to surface to the user, cloned onto the response. Only
    /// a private share has one.
    fn into_password(self) -> Option<String> {
        match self {
            Self::Public => None,
            Self::Private { password } => Some(password),
        }
    }
}

/// Parse an untrusted `ttl` string from the IPC boundary into a
/// [`ShareTtl`].
///
/// Goes through serde so the accepted vocabulary is literally the one
/// hcfs-server validates against, rather than a hand-written match that
/// could drift from it.
///
/// # Errors
///
/// [`AppError::Validation`] for anything outside the preset set.
pub(crate) fn parse_ttl(ttl: &str) -> Result<ShareTtl> {
    serde_json::from_value(serde_json::Value::String(ttl.to_owned())).map_err(|_| AppError::Validation(format!("Unknown share expiry: {ttl}")))
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
///    round-trip per row. `None` when the keystore on this device
///    has lost the key (different device, wiped DB). `filename` is
///    independent: the server now returns plaintext filenames, so
///    a row can have a real `filename` and `share_url = None` when
///    the share was minted on another device.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSummary {
    pub share_token: String,
    pub filename: String,
    pub plaintext_size: u64,
    pub ciphertext_size: u64,
    pub mime_type: String,
    pub created_at: String,
    /// `None` (JSON `null`) when the link stays reachable until revoked.
    pub expires_at: Option<String>,
    pub share_url: Option<String>,
    /// Whether this link is password-protected. Drives the lock badge and
    /// tells the UI that Copy hands out a link the recipient still needs a
    /// password for. `false` when this device has no key material for the
    /// row (a share minted elsewhere), which is also when `share_url` is
    /// `None` — the UI shows neither a lock nor a Copy button then.
    pub is_private: bool,
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

/// Inner share-creation pipeline for a file inside a synced folder.
///
/// Caller responsibilities (everything outside the pipeline):
/// - extract `account_id`,
/// - run [`require_shares_supported`] and [`require_eligible`],
/// - hand us the `(folder_label, relative_path)` of the source file.
///
/// We do everything else: resolve the plaintext path, run the
/// streaming share via hcfs-client, persist the origin sidecar, and
/// return the wire `ShareLink`.
///
/// `progress`, when `Some`, is hcfs-client's per-phase
/// encrypting→uploading→finalizing callback, so the share modal can render
/// a live bar.
async fn create_share_inner(
    state: &AppState,
    account_id: &str,
    folder_label: &str,
    relative_path: &str,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
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
    let mime_type = mime_guess::from_path(&local_path).first_or_octet_stream().essence_str().to_owned();

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
    let console_base = console_base_url();
    let result = client
        .create_share(
            &mut reader,
            plaintext_size,
            &ShareOptions {
                filename: &filename,
                mime_type: &mime_type,
                ttl,
                password: choice.password(),
                console_base_url: &console_base,
            },
            &keystore,
            progress,
        )
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
        expires_at: result.expires_at.map(|e| e.to_rfc3339()),
        password: choice.into_password(),
    })
}

/// Adapt a webview [`Channel`] into hcfs-client's [`ShareProgressFn`].
///
/// hcfs-client invokes the returned closure on every phase edge and
/// byte-ramp tick; we forward each [`ShareProgress`] straight to the
/// channel, which serializes it to the FE's committed camelCase shape
/// (`{bytesDone, bytesTotal, phase}`) with no adapter struct.
///
/// A `send` failure means the webview side of the channel is gone (the
/// share modal was closed, the window dropped) — that is expected and
/// non-fatal: the share itself is the user-facing outcome, so we log at
/// debug and keep going rather than aborting the upload. The closure is
/// deliberately `send`-only and panic-free because hcfs-client may call
/// it from the chunked path's blocking encryption thread, where a panic
/// would surface as a misleading `ShareError::Crypto`.
pub(crate) fn share_progress_forwarder(channel: Channel<ShareProgress>) -> ShareProgressFn {
    Arc::new(move |update: ShareProgress| {
        if let Err(e) = channel.send(update) {
            debug!(error = %e, "share progress channel send failed (receiver gone)");
        }
    })
}

/// Mint a share link for a file already inside a synced folder.
///
/// Resolves the on-disk plaintext path from `(folder_label, relative_path)`,
/// streams it through `hcfs_client::HcfsClient::create_share` (single-shot
/// for ≤ 8 MiB, chunked above), persists the per-share secret in our
/// `share_keystore`, and returns a `ShareLink` whose `share_url` already
/// contains the key fragment — `#k=` for a public share, `#p=` for a
/// password-protected one.
///
/// `ttl` is one of `24h` / `7d` / `30d` / `never`; `visibility` is `public`
/// or `private`. On the private branch, `password` may be omitted to have one
/// generated — the generated value comes back on the response, and that is
/// the only time it is ever available, since it is never persisted.
///
/// `on_progress` is a webview channel the FE opens with `new Channel()`;
/// progress updates flow through it while the share runs so the modal
/// can show a determinate bar.
#[tauri::command]
pub async fn hcfs_create_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
    ttl: String,
    visibility: String,
    password: Option<String>,
    on_progress: Channel<ShareProgress>,
) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;

    // Validate the untrusted arguments before any network or disk work, so a
    // bad preset or a too-short password costs nothing.
    let ttl = parse_ttl(&ttl)?;
    let choice = ShareChoice::parse(&visibility, password)?;

    // Capability + eligibility gates. The capability call is a single
    // anonymous HTTP request; we accept the round-trip so that an old
    // server hides the feature instead of failing create_share with a
    // 404 several KB into a multipart upload.
    //
    // Sharing's bytes-priced layer is intentionally `0`: the file
    // already exists in paid storage (the user paid to upload it), and
    // minting a share token serves anonymous reads from the SAME
    // ciphertext, not a new upload. The static `Sharing` threshold
    // (any positive balance) is the right gate here — keeps the
    // pre-Task-3.1 behavior unchanged for shares.
    require_shares_supported(&state, &account_id).await?;
    require_eligible(&state, &account_id, InsufficientCreditsAction::Sharing, 0).await?;

    let progress = share_progress_forwarder(on_progress);
    create_share_inner(&state, &account_id, &folder_label, &relative_path, ttl, choice, Some(progress)).await
}

/// Mint a share for a synced file with the same capability + eligibility
/// guards as [`hcfs_create_share`]. Entry point for the macOS Finder bridge
/// dispatcher. `progress` streams the encrypt/upload bar to the confirm modal
/// (`Some`) — the Finder confirm flow opens a webview `Channel`.
///
/// macOS-only: the Finder dispatcher is its sole caller, so leaving it un-gated
/// would be dead code on the Linux CI job.
#[cfg(any(unix, windows))]
pub(crate) async fn share_synced_file(
    state: &AppState,
    account_id: &str,
    folder_label: &str,
    relative_path: &str,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    require_shares_supported(state, account_id).await?;
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, 0).await?;
    create_share_inner(state, account_id, folder_label, relative_path, ttl, choice, progress).await
}

/// Mint a public share for a file that is NOT inside a synced folder by reading
/// its bytes directly ("upload & share"). The byte stream is uploaded to the
/// same encrypted-share storage as a synced file; only the reshare-origin
/// sidecar is skipped (there is no `(folder_label, relative_path)` to reshare
/// from). Entry point for the macOS Finder dispatcher, and the last Finder
/// path that uploads bytes now that a folder mints a browsable link instead
/// of a zip.
#[cfg(any(unix, windows))]
pub(crate) async fn share_external_file(
    state: &AppState,
    account_id: &str,
    abs_path: &Path,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    require_shares_supported(state, account_id).await?;
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, 0).await?;

    let pool = state.pool()?;
    let metadata = tokio::fs::metadata(abs_path).await?;
    if !metadata.is_file() {
        return Err(AppError::Validation("Cannot share a directory".into()));
    }
    let plaintext_size = metadata.len();

    let filename = abs_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Validation("File has no usable name".into()))?;
    let mime_type = mime_guess::from_path(abs_path).first_or_octet_stream().essence_str().to_owned();

    info!(filename, plaintext_size, mime_type = %mime_type, "Creating share from local file");

    let client = build_account_client(pool, account_id).await?;
    let mut reader = tokio::fs::File::open(abs_path).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let result = client
        .create_share(
            &mut reader,
            plaintext_size,
            &ShareOptions {
                filename,
                mime_type: &mime_type,
                ttl,
                password: choice.password(),
                console_base_url: &console_base,
            },
            &keystore,
            progress,
        )
        .await
        .map_err(|e| {
            warn!(error = %e, "create_share failed");
            AppError::Hcfs(format!("create_share: {e}"))
        })?;

    Ok(ShareLink {
        share_token: result.share_token,
        share_url: result.share_url,
        expires_at: result.expires_at.map(|e| e.to_rfc3339()),
        password: choice.into_password(),
    })
}

// ─── Remote (server-only) file shares ──────────────────────────────────────

/// Mint a share link for a file that exists ONLY on the server — a row inside
/// a browsable remote drive with no local copy on this machine.
///
/// Console parity, built from existing parts: the file is downloaded and
/// decrypted to a private temp path (`sync::remote::download_cloud_file_to`,
/// the same folder-key chain the remote preview uses), streamed through the
/// SAME `create_share` pipeline as a local file — re-encrypted under a fresh
/// per-share key, uploaded to share storage — and the temp copy is removed on
/// every exit. The share therefore costs a download + upload, which is why
/// the FE offers it only on remote rows: a locally synced file shares
/// straight from disk via [`create_share_inner`].
///
/// `relative_path` is the file's drive-relative path (for the share-origin
/// sidecar, so the "Shared" badge finds it), `file_id` the hex path_hash the
/// remote listing carries — the same id `download_remote_file` takes.
#[allow(clippy::too_many_arguments)] // mirrors hcfs_create_share's surface + the file_id the remote listing adds
async fn create_remote_share_inner(
    state: &AppState,
    account_id: &str,
    folder_label: &str,
    relative_path: &str,
    file_id: &str,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    require_shares_supported(state, account_id).await?;
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, 0).await?;

    let filename = relative_path
        .trim_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::Validation("File has no usable name".into()))?
        .to_owned();

    // Per-ATTEMPT-unique staging path (pid + counter — two concurrent shares
    // of the same file must not interleave one temp), placed under the
    // preview cache rather than the OS temp dir so a crash-orphaned
    // plaintext copy is eventually reclaimed by the cache's eviction sweep.
    let cache_root = crate::sync::remote::preview_cache_root_dir()?;
    tokio::fs::create_dir_all(&cache_root).await?;
    let tmp = crate::sync::remote::unique_transient_path(&cache_root, &format!("remote-share-{file_id}"));

    let minted = mint_remote_share_at(
        state,
        account_id,
        folder_label,
        relative_path,
        file_id,
        &filename,
        &tmp,
        ttl,
        choice,
        progress,
    )
    .await;
    // The temp copy is plaintext — remove it on success AND on every error.
    let _ = tokio::fs::remove_file(&tmp).await;
    minted
}

/// Body of [`create_remote_share_inner`] between temp-path creation and
/// cleanup, split out so the caller can guarantee the plaintext temp file is
/// removed on every exit without a maze of early-return cleanup calls.
#[allow(clippy::too_many_arguments)]
async fn mint_remote_share_at(
    state: &AppState,
    account_id: &str,
    folder_label: &str,
    relative_path: &str,
    file_id: &str,
    filename: &str,
    tmp: &Path,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    let pool = state.pool()?;

    crate::sync::remote::download_cloud_file_to(state, account_id, folder_label, file_id, tmp).await?;

    let metadata = tokio::fs::metadata(tmp).await?;
    let plaintext_size = metadata.len();
    // MIME from the REAL filename, not the `.part` temp name.
    let mime_type = mime_guess::from_path(filename).first_or_octet_stream().essence_str().to_owned();

    info!(
        label = %folder_label,
        relative_path = %relative_path,
        plaintext_size,
        mime_type = %mime_type,
        "Creating share from remote file (download → re-encrypt → upload)"
    );

    let client = build_account_client(pool, account_id).await?;
    let mut reader = tokio::fs::File::open(tmp).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let result = client
        .create_share(
            &mut reader,
            plaintext_size,
            &ShareOptions {
                filename,
                mime_type: &mime_type,
                ttl,
                password: choice.password(),
                console_base_url: &console_base,
            },
            &keystore,
            progress,
        )
        .await
        .map_err(|e| {
            warn!(error = %e, "create_share (remote source) failed");
            AppError::Hcfs(format!("create_share: {e}"))
        })?;

    // Same best-effort share-origin sidecar as the local path — the remote
    // row has a real (label, relative_path), so the "Shared" badge works.
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
        expires_at: result.expires_at.map(|e| e.to_rfc3339()),
        password: choice.into_password(),
    })
}

/// Mint a share link for a file in a REMOTE (server-only) drive. Same
/// argument surface as [`hcfs_create_share`] plus the `file_id` the remote
/// listing carries; the download → re-encrypt → upload behavior is
/// documented on [`create_remote_share_inner`].
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one arg over hcfs_create_share: the file_id the remote listing carries
pub async fn hcfs_create_remote_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
    file_id: String,
    ttl: String,
    visibility: String,
    password: Option<String>,
    on_progress: Channel<ShareProgress>,
) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;
    let ttl = parse_ttl(&ttl)?;
    let choice = ShareChoice::parse(&visibility, password)?;
    let progress = share_progress_forwarder(on_progress);
    create_remote_share_inner(&state, &account_id, &folder_label, &relative_path, &file_id, ttl, choice, Some(progress)).await
}

// ─── Folder shares (browsable live links) ──────────────────────────────────

/// Capability gate for the folder-share mint. Same posture as
/// [`require_shares_supported`]: the FE atom hides the menu item for UX, but
/// this check is the IPC's authority — an old server (or a mid-session
/// toggle) must be refused here, with a message the modal can show verbatim.
async fn require_folder_shares_supported(state: &AppState, account_id: &str) -> Result<()> {
    let caps = fetch_capabilities(state, account_id).await?;
    if !caps.folder_shares {
        return Err(AppError::Validation("Folder sharing is not enabled on this server.".into()));
    }
    Ok(())
}

/// Normalize and validate an untrusted drive-relative folder path into the
/// `path_prefix` the server scopes the share to.
///
/// Surrounding `/` runs are trimmed — the FE and the Finder resolver both
/// produce clean paths, but a stray separator must not change WHICH folder is
/// shared — and the result may be empty: that is the whole-drive share. The
/// component check mirrors [`resolve_inside_sync_root`]'s rules without
/// touching the disk, because the mint is metadata-only: the folder does not
/// need to exist locally (a cloud-only folder is shareable), but a `..` or a
/// prefix/root component must still never reach the wire.
fn folder_share_path_prefix(relative_path: &str) -> Result<&str> {
    let prefix = relative_path.trim_matches('/');
    for component in Path::new(prefix).components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(AppError::Validation("relative_path contains an illegal component".into())),
        }
    }
    Ok(prefix)
}

/// The plaintext name the recipient page titles itself with: the shared
/// folder's last path segment, or the drive label for a whole-drive share —
/// the same choice the console's mint makes for its rows.
fn folder_share_display_name<'a>(folder_label: &'a str, path_prefix: &'a str) -> &'a str {
    path_prefix
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(folder_label)
}

/// Map hcfs-client's folder-share failures onto the app error taxonomy. The
/// one case a user can act on — the server does not know this drive — stays a
/// `Validation` message the share modal shows verbatim; everything else is a
/// transport-shaped `Hcfs` error.
fn map_folder_share_error(e: hcfs_client::client::folder_share::FolderShareError) -> AppError {
    match e {
        hcfs_client::client::folder_share::FolderShareError::FolderNotRegistered => {
            AppError::Validation("This drive isn't registered on the server yet. Let it finish a sync, then share again.".into())
        }
        other => AppError::Hcfs(format!("create_folder_share: {other}")),
    }
}

/// Inner folder-share mint shared by the in-app IPC and the Finder
/// right-click. EVERY gate lives here rather than in the commands — the same
/// lesson the zip pipeline learned: the Finder path calls this directly, and
/// a guard sitting one level up would silently not cover it.
///
/// The mint is one metadata POST, so two zip-era guards are deliberately
/// absent: no settlement check (the recipient browses the SERVER's state, not
/// this disk, so a half-downloaded local copy cannot corrupt the share) and
/// no billing eligibility gate (nothing is uploaded — the shared bytes were
/// already paid for when they were stored).
///
/// `pub` (not `pub(crate)`) so the mock-server integration suite can drive it
/// without a `tauri::State` — the same seam `list_remote_folder_files_inner`
/// and the shared-drives helpers expose.
pub async fn create_folder_share_inner(
    state: &AppState,
    account_id: &str,
    folder_label: &str,
    relative_path: &str,
    ttl: ShareTtl,
    choice: ShareChoice,
) -> Result<ShareLink> {
    let pool = state.pool()?;
    let path_prefix = folder_share_path_prefix(relative_path)?;

    require_folder_shares_supported(state, account_id).await?;

    // Resolve the drive's wire identity ONCE and thread it down (resolver
    // call discipline). The LENIENT variant (the remote-browse IPCs' form):
    // since remote drives became browsable, `folder_label` may legitimately
    // name a server-only drive with no local row — the mint is metadata-only
    // and the derived key chain below works from the master mnemonic, so a
    // local sync path was never actually required. A member row still
    // resolves to member identity and is refused just below.
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, folder_label).await?;

    // Folder shares are owner-mint-only (server v1), and a member's derived
    // key would be wrong anyway — the drive's file key belongs to the OWNER's
    // derivation chain. Refuse with a message the modal can show, instead of
    // letting the server's folder_not_found 404 misreport it.
    if identity.is_member {
        return Err(AppError::Validation(
            "Only the owner of a shared drive can share its folders as a link.".into(),
        ));
    }

    info!(label = %folder_label, path_prefix = %path_prefix, "Creating folder share");

    // The DERIVED drive file key, from the same chain the sync engine and the
    // remote preview use (`encryption_key_for_label`) — the link fragment
    // carries this key, never folder-mnemonic entropy. Wiped on drop.
    let mnemonic = crate::sync::remote::session_mnemonic(state)?;
    let file_key =
        zeroize::Zeroizing::new(crate::sync::remote::encryption_key_for_label(pool, account_id, folder_label, &mnemonic, &identity).await?);

    // Drive-scoped client: `create_folder_share` sends the folder_hash from
    // the client CONFIG, so `build_account_client`'s label-less client would
    // be refused (`MissingFolderHash`) before any request went out.
    let client = crate::sync::remote::build_client(pool, account_id, &identity).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let result = client
        .create_folder_share(
            &file_key,
            &hcfs_client::client::folder_share::FolderShareOptions {
                path_prefix,
                display_name: folder_share_display_name(folder_label, path_prefix),
                ttl,
                password: choice.password(),
                console_base_url: &console_base,
            },
            &keystore,
        )
        .await
        .map_err(|e| {
            warn!(error = %e, "create_folder_share failed");
            map_folder_share_error(e)
        })?;

    Ok(ShareLink {
        share_token: result.share_token,
        share_url: result.share_url,
        expires_at: result.expires_at.map(|e| e.to_rfc3339()),
        password: choice.into_password(),
    })
}

/// Mint a live, browsable share link for a folder inside a synced drive.
///
/// One metadata POST against `/v1/folder-shares`: the recipient browses and
/// downloads the drive's EXISTING ciphertext through the console's share
/// page, so the link is live (later changes appear in it) and creation is
/// instant regardless of folder size — nothing is packed or uploaded, which
/// is why this command has no progress channel. `relative_path` may be empty
/// to share the whole drive.
///
/// Deliberately records NO `share_origin` row: folder shares live server-side
/// keyed by `(folder_hash, path_prefix)`, and the owner listing resolves them
/// back to local rows by that identity — a `share_origin` row keyed by a
/// folder-share token would be evicted by `hcfs_list_shares`' file-share
/// prune on the next refresh anyway.
#[tauri::command]
pub async fn hcfs_create_folder_share(
    state: tauri::State<'_, AppState>,
    folder_label: String,
    relative_path: String,
    ttl: String,
    visibility: String,
    password: Option<String>,
) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;

    // Validate the untrusted arguments before any network work, mirroring
    // `hcfs_create_share`.
    let ttl = parse_ttl(&ttl)?;
    let choice = ShareChoice::parse(&visibility, password)?;

    create_folder_share_inner(&state, &account_id, &folder_label, &relative_path, ttl, choice).await
}

// ─── Folder-share owner ops (list / revoke / expiry) ───────────────────────

/// One row of the owner's folder-share listing, resolved against this
/// device's keystore. Mirrors the server's listing fields (camelCased,
/// timestamps as RFC 3339 strings) plus the local resolution.
///
/// The server returns `token_hash` (blake3 hex) only — a folder-share
/// token is never echoed after create. A row minted on THIS machine
/// matches a token in the persistent SQLite keystore
/// (`folder_share_token_hash(stored) == token_hash`), so it comes back
/// with the plaintext token — the handle `hcfs_revoke_folder_share` and
/// `hcfs_update_folder_share_expiry` take — and the rebuilt recipient
/// URL. A row minted elsewhere is view-only: `resolvable: false`, token
/// and URL `null`.
///
/// Unlike the file-share listing, revoked and expired rows ARE present
/// (with `revoked_at` set / `expires_at` in the past) until the server's
/// reaper sweeps them; the FE renders their dead state from the row.
/// `folder_hash` + `path_prefix` are the share's stable identity — the
/// per-folder "Shared" badge keys on that pair (console
/// `folderShareTarget` parity), never on `share_origin` rows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderShareSummary {
    pub token_hash: String,
    pub folder_hash: String,
    /// `""` means the share covers the whole drive.
    pub path_prefix: String,
    pub display_name: String,
    /// RFC 3339 timestamp.
    pub created_at: String,
    /// `None` (JSON `null`) when the link stays reachable until revoked.
    pub expires_at: Option<String>,
    /// `Some` once the owner has revoked the share.
    pub revoked_at: Option<String>,
    /// Whether this device's keystore holds the plaintext token.
    pub resolvable: bool,
    /// Plaintext token, present only for resolvable rows.
    pub share_token: Option<String>,
    /// Recipient URL rebuilt from the stored secret, `None` when the row
    /// is not resolvable on this device.
    pub share_url: Option<String>,
    /// Whether the link is password-protected. `None` for a foreign row:
    /// there is no secret to inspect, so protection is UNKNOWN on this
    /// device — reporting `false` would label a password-protected share
    /// "public". `None` coincides with `share_url` being `None`.
    pub is_private: Option<bool>,
}

/// Index the keystore's stored tokens by their blake3 hex — the join key
/// the folder-share listing speaks. File-share tokens share the table and
/// get hashed too; their hashes simply never appear in the folder listing.
fn folder_share_secrets_by_hash(keystore: &SqliteShareKeystore) -> Result<HashMap<String, (String, ShareSecret)>> {
    let entries = keystore.all_entries().map_err(|e| AppError::Hcfs(format!("keystore scan: {e}")))?;
    Ok(entries
        .into_iter()
        .map(|(token, secret)| (folder_share_token_hash(&token), (token, secret)))
        .collect())
}

/// Join the server's listing rows to the locally stored tokens. Pure —
/// the IPC does the I/O — so the resolution rules are unit-testable.
///
/// URL rebuilding goes through `build_folder_share_url_for`, which
/// dispatches on the stored [`ShareSecret`] variant: a password share can
/// only ever yield its `#p=` link, same invariant as the file-share list.
fn resolve_folder_share_rows(
    rows: Vec<FolderShareListItem>,
    secrets_by_hash: &HashMap<String, (String, ShareSecret)>,
    console_base: &str,
) -> Vec<FolderShareSummary> {
    rows.into_iter()
        .map(|row| {
            let resolved = secrets_by_hash.get(&row.token_hash);
            FolderShareSummary {
                resolvable: resolved.is_some(),
                share_token: resolved.map(|(token, _)| token.clone()),
                share_url: resolved.map(|(token, secret)| build_folder_share_url_for(console_base, token, secret)),
                is_private: resolved.map(|(_, secret)| secret.is_private()),
                token_hash: row.token_hash,
                folder_hash: row.folder_hash,
                path_prefix: row.path_prefix,
                display_name: row.display_name,
                created_at: row.created_at.to_rfc3339(),
                expires_at: row.expires_at.map(|e| e.to_rfc3339()),
                revoked_at: row.revoked_at.map(|e| e.to_rfc3339()),
            }
        })
        .collect()
}

/// List every folder share this account has minted, newest first —
/// including revoked and not-yet-reaped expired rows in their dead state.
/// Rows minted on this machine resolve against the persistent keystore
/// (token + rebuilt URL); rows minted elsewhere come back view-only.
///
/// Deliberately NO `shared_link_history` integration here:
/// `history::diff_active_lists` detects death by DISAPPEARANCE between
/// consecutive active lists, and this listing retains dead rows until the
/// server reaper sweeps them — a row would only "disappear" at reap time,
/// recording a bogus end moment. The dead state is already ON the row
/// (`revoked_at` / past `expires_at`), so the FE renders it directly,
/// same as the console's owner page.
///
/// Also deliberately NO `share_origin` involvement: folder-share badge
/// identity is `(folder_hash, path_prefix)` from these rows, and a
/// sidecar row keyed by a folder token would be evicted by
/// `hcfs_list_shares`' file-share prune anyway.
#[tauri::command]
pub async fn hcfs_list_folder_shares(state: tauri::State<'_, AppState>) -> Result<Vec<FolderShareSummary>> {
    let account_id = state.current_account_id()?;
    list_folder_shares_inner(&state, &account_id).await
}

/// Inner of [`hcfs_list_folder_shares`], taking `&AppState` so the mock-server
/// integration suite can drive it without a `tauri::State` (the `*_inner`
/// split `list_remote_folder_files` uses).
pub async fn list_folder_shares_inner(state: &AppState, account_id: &str) -> Result<Vec<FolderShareSummary>> {
    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let rows = client
        .list_folder_shares()
        .await
        .map_err(|e| AppError::Hcfs(format!("list_folder_shares: {e}")))?;

    let keystore = SqliteShareKeystore::new(pool.clone());
    let secrets_by_hash = folder_share_secrets_by_hash(&keystore)?;
    Ok(resolve_folder_share_rows(rows, &secrets_by_hash, &console_base_url()))
}

/// Revoke a folder share by its plaintext token (from a resolvable
/// listing row). hcfs-client forgets the keystore secret on the wire
/// success — there is no further use for it.
///
/// The server collapses unknown / someone else's / already-revoked
/// tokens into one bodiless 404. That maps to `Ok(())` here, mirroring
/// the file-share revoke's "I just tapped Revoke twice" idempotency, and
/// the local secret is forgotten too so a token revoked from another
/// device stops resolving on this one — but only after a capability
/// probe confirms the 404 came from a folder-shares-capable server (a
/// rolled-back server 404s the route itself, and its 404 says nothing
/// about the token). The token itself never reaches a log line — it is
/// the capability.
#[tauri::command]
pub async fn hcfs_revoke_folder_share(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    revoke_folder_share_inner(&state, &account_id, &share_token).await
}

/// Inner of [`hcfs_revoke_folder_share`], taking `&AppState` so the
/// mock-server integration suite can drive it without a `tauri::State`.
pub async fn revoke_folder_share_inner(state: &AppState, account_id: &str, share_token: &str) -> Result<()> {
    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    match client.revoke_folder_share(share_token, &keystore).await {
        Ok(()) => Ok(()),
        Err(FolderShareError::NotFound) => {
            // A 404 normally means already-revoked / never-existed, which
            // makes forgetting the local secret safe. But a server ROLLBACK
            // to a build without /v1/folder-shares answers every route with
            // the same bare 404, and forgetting on that would delete the
            // ONLY plaintext copy of a token that still guards a live share
            // once the server rolls forward. Probe the capability first:
            // only a folder-shares-capable server's 404 is authoritative.
            require_folder_shares_supported(state, account_id).await?;
            if let Err(e) = keystore.forget(share_token) {
                warn!(error = %e, "folder-share keystore forget failed after 404 revoke (non-fatal)");
            }
            Ok(())
        }
        Err(e) => Err(AppError::Hcfs(format!("revoke_folder_share: {e}"))),
    }
}

/// Change an existing folder share's expiry, returning the new one
/// (`None` when the link now stays reachable until revoked). Only the
/// expiry is mutable — same contract as `hcfs_update_share_expiry`; the
/// PATCH response deliberately carries no token echo.
#[tauri::command]
pub async fn hcfs_update_folder_share_expiry(state: tauri::State<'_, AppState>, share_token: String, ttl: String) -> Result<Option<String>> {
    let account_id = state.current_account_id()?;
    let ttl = parse_ttl(&ttl)?;
    update_folder_share_expiry_inner(&state, &account_id, &share_token, ttl).await
}

/// Inner of [`hcfs_update_folder_share_expiry`], taking `&AppState` (and an
/// already-parsed [`ShareTtl`]) so the mock-server integration suite can
/// drive it without a `tauri::State`.
pub async fn update_folder_share_expiry_inner(state: &AppState, account_id: &str, share_token: &str, ttl: ShareTtl) -> Result<Option<String>> {
    require_folder_shares_supported(state, account_id).await?;

    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let expires_at = client.update_folder_share_expiry(share_token, ttl).await.map_err(|e| {
        warn!(error = %e, "update_folder_share_expiry failed");
        // The server's bodiless 404 covers unknown / not-yours / revoked /
        // already-expired alike — say what the user can act on instead.
        match e {
            FolderShareError::NotFound => AppError::Validation("This link is no longer active, so its expiry cannot be changed.".into()),
            other => AppError::Hcfs(format!("update_folder_share_expiry: {other}")),
        }
    })?;

    Ok(expires_at.map(|e| e.to_rfc3339()))
}

/// Generate a share password for the modal to pre-fill.
///
/// Exists so the password the user sees is produced by the same CSPRNG and the
/// same alphabet as the one the backend would pick for them — rather than the
/// frontend rolling its own, which would put key-adjacent crypto in
/// TypeScript and let the two drift.
///
/// Purely a UI convenience: the user can overwrite it, and leaving the
/// password unset entirely still makes the backend generate one during the
/// mint. Nothing here is persisted.
#[tauri::command]
pub fn hcfs_generate_share_password() -> String {
    generate_share_password()
}

/// Change an existing share's expiry.
///
/// Replaces the former `hcfs_reshare`, which "extended" a link by revoking it
/// and re-uploading the whole file under a brand-new URL — the only option
/// before hcfs-server exposed `PATCH /v1/shares/{token}`. This changes one
/// row and leaves the link the user already handed out working.
///
/// The share's password, if it has one, is untouched and cannot be changed:
/// the server holds no key material and this device does not persist a
/// private share's raw key. Handing out a different password means revoking
/// and re-sharing, which is also the only thing that cuts off whoever already
/// has the old link.
///
/// Returns the new expiry, or `None` when the share now stays reachable until
/// revoked.
#[tauri::command]
pub async fn hcfs_update_share_expiry(state: tauri::State<'_, AppState>, share_token: String, ttl: String) -> Result<Option<String>> {
    let account_id = state.current_account_id()?;
    let ttl = parse_ttl(&ttl)?;

    require_shares_supported(&state, &account_id).await?;

    let pool = state.pool()?;
    let client = build_account_client(pool, &account_id).await?;
    let expires_at = client.update_share_expiry(&share_token, ttl).await.map_err(|e| {
        warn!(share_token = %share_token, error = %e, "update_share_expiry failed");
        // The server collapses unknown / not-yours / revoked / expired into
        // one 404, so we cannot tell the user which it was — say what they
        // can act on instead.
        match e {
            hcfs_client::client::share::ShareError::NotFound => {
                AppError::Validation("This link is no longer active, so its expiry cannot be changed.".into())
            }
            other => AppError::Hcfs(format!("update_share_expiry: {other}")),
        }
    })?;

    Ok(expires_at.map(|e| e.to_rfc3339()))
}

/// List all of this caller's currently-active shares, newest first.
/// The server returns plaintext filenames, so every row has a real
/// `filename` regardless of whether this device knows the share key.
/// Only `share_url` is keystore-dependent — a row whose key has been
/// forgotten (different device, wiped DB) surfaces with
/// `share_url = None` and the UI hides the Copy button while still
/// offering Revoke.
#[tauri::command]
pub async fn hcfs_list_shares(state: tauri::State<'_, AppState>) -> Result<Vec<ShareSummary>> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    let client = build_account_client(pool, &account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let summaries = client.list_shares().await.map_err(|e| AppError::Hcfs(format!("list_shares: {e}")))?;

    // Rebuild the share URL per row from the keystore. We do this with
    // ONE batched `WHERE share_token IN (...)` SELECT instead of a
    // per-row `keystore.get` loop because every per-row lookup goes
    // through `block_in_place` on a small fixed-size sqlx connection
    // pool — a 50-share page would otherwise issue 50 sequential
    // round-trips. See `SqliteShareKeystore::get_many`.
    //
    // A keystore miss for a token leaves `share_url = None`; the FE
    // renders such rows as "key forgotten on this device" (the row
    // still has a real plaintext `filename` from the server) and
    // still offers Revoke.
    let tokens: Vec<&str> = summaries.iter().map(|s| s.share_token.as_str()).collect();
    let key_map = keystore.get_many(&tokens).map_err(|e| AppError::Hcfs(format!("keystore lookup: {e}")))?;
    // Same batched-IN trick as the keystore: one round-trip for the
    // whole page so the per-file badge and Reshare button can resolve
    // origin in O(1) per row.
    let owner = account_key(&account_id);
    let origin_map = origin::fetch_for_tokens(pool, &owner, &tokens).await.unwrap_or_else(|e| {
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
    // `owner` is computed above (shared with the origin fetch).
    origin::prune(pool, &owner, &tokens).await;

    // Diff the previous active-list snapshot against the current one
    // and persist any tokens that have left the set. Best-effort: a
    // diff/upsert failure must never fail the user-facing list call.
    // The cache is per-account (mirrors origin::prune's scoping) and
    // lives only in memory — see AppState::share_active_list_cache.
    let previous_snapshot = state.share_active_list_cache.lock().map_or_else(
        |e| {
            warn!(error = %e, "share_active_list_cache lock poisoned; skipping diff");
            Vec::new()
        },
        |guard| guard.get(&account_id).cloned().unwrap_or_default(),
    );
    let now = Utc::now();
    let events = history::diff_active_lists(&previous_snapshot, &summaries, now);
    for event in events {
        if let Err(e) = history::record_event(pool, &account_id, &event.entry).await {
            warn!(
                share_token = %event.entry.share_token,
                end_reason = ?event.end_reason,
                error = %e,
                "shared_link_history upsert failed (non-fatal)"
            );
        }
    }
    // Replace the snapshot with the current list so the next call
    // diffs against this baseline. We store the upstream summaries
    // (not the wire ShareSummary) because the diff path and the
    // revoke-here lookup both consume `UpstreamShareSummary`.
    if let Ok(mut cache) = state.share_active_list_cache.lock() {
        cache.insert(account_id.clone(), summaries.clone());
    }

    let console_base = console_base_url();
    let wire = summaries
        .into_iter()
        .map(|s| {
            // Dispatch on the stored variant. This is the fix for the defect
            // where every row was rendered as a `#k=` link from a raw key:
            // a password-protected share persists only its wrapped blob, so
            // the only URL derivable from it is the `#p=` one.
            let secret = key_map.get(&s.share_token);
            let share_url = secret.map(|secret| build_share_url_for(&console_base, &s.share_token, secret));
            let is_private = secret.is_some_and(ShareSecret::is_private);
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
                expires_at: s.expires_at.map(|e| e.to_rfc3339()),
                share_url,
                is_private,
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
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;

    // Snapshot the cached active-list entry for this token BEFORE the
    // revoke fires so we can carry filename/mime/timestamps into the
    // history row. Cloning out of the lock keeps the mutex-hold to
    // microseconds. A `None` here is the rare race where the user
    // revokes before this device has called `list_shares` even once;
    // history::entry_for_revoke_here handles that minimally.
    let cached_summary: Option<UpstreamShareSummary> = state.share_active_list_cache.lock().ok().and_then(|guard| {
        guard
            .get(&account_id)
            .and_then(|list| list.iter().find(|s| s.share_token == share_token).cloned())
    });

    let client = build_account_client(pool, &account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    client
        .revoke_share(&share_token, &keystore)
        .await
        .map_err(|e| AppError::Hcfs(format!("revoke_share: {e}")))?;

    // Record the revoke in the history sidecar. Best-effort — a
    // history miss is purely cosmetic (the row won't appear in the
    // FE's history list until the next call_share that detects it as
    // RevokedElsewhere), never a reason to fail a successful revoke.
    let entry: HistoryEntry = history::entry_for_revoke_here(share_token.clone(), cached_summary.as_ref(), Utc::now());
    if let Err(e) = history::record_event(pool, &account_id, &entry).await {
        warn!(
            share_token = %share_token,
            error = %e,
            "Failed to record shared_link_history after successful revoke"
        );
    }

    // Drop the active-list cache entry for this token so a near-immediate
    // follow-up `list_shares` doesn't re-detect it as RevokedElsewhere
    // (the server has the revoke, but the cached snapshot still shows it).
    if let Ok(mut cache) = state.share_active_list_cache.lock()
        && let Some(list) = cache.get_mut(&account_id)
    {
        list.retain(|s| s.share_token != share_token);
    }

    // Drop the sidecar row so the per-file badge clears and the
    // Reshare button stops offering this token. Idempotent — a missing
    // row is fine — and best-effort: a sidecar leftover after a
    // successful revoke would only show up as a "ghost" badge until
    // the next prune in `hcfs_list_shares`, never as a security issue.
    if let Err(e) = origin::forget(pool, &account_key(&account_id), &share_token).await {
        warn!(
            share_token = %share_token,
            error = %e,
            "Failed to forget share_origin after successful revoke"
        );
    }
    Ok(())
}

// ─── History IPC commands ──────────────────────────────────────────────────

/// List all share-link history rows for the current account, newest
/// first. See [`crate::shares::history`] for the lifecycle and
/// `EndReason` semantics.
#[tauri::command]
pub async fn hcfs_list_share_history(state: tauri::State<'_, AppState>) -> Result<Vec<HistoryEntry>> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    Ok(history::list_for_account(pool, &account_id).await?)
}

/// Remove a single history row. Idempotent — calling on a missing row
/// returns `Ok(())` so the FE doesn't have to special-case "I just
/// tapped Remove twice".
#[tauri::command]
pub async fn hcfs_remove_share_history(state: tauri::State<'_, AppState>, share_token: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    history::remove_one(pool, &account_id, &share_token).await?;
    Ok(())
}

/// Bulk clear all history rows for the current account. Scoped per
/// account so a multi-account install never wipes another account's
/// rows.
#[tauri::command]
pub async fn hcfs_clear_share_history(state: tauri::State<'_, AppState>) -> Result<()> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    history::clear_all_for_account(pool, &account_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use tempfile::TempDir;

    proptest! {
        // Normalizing an already-resolved base is a no-op: whatever the resolver
        // produces from arbitrary input must be a fixed point. Guards against a
        // future edit that trims or re-defaults inconsistently on the second pass.
        #[test]
        fn resolve_console_base_url_is_idempotent(raw in ".*", staging in proptest::bool::ANY) {
            let channel = if staging { ReleaseChannel::Staging } else { ReleaseChannel::Production };
            let once = resolve_console_base_url(channel, true, Some(raw));
            let twice = resolve_console_base_url(channel, true, Some(once.clone()));
            prop_assert_eq!(once, twice);
        }
    }

    #[test]
    fn console_base_url_defaults_when_override_absent_or_blank() {
        let dev = true;
        assert_eq!(resolve_console_base_url(ReleaseChannel::Production, dev, None), DEFAULT_CONSOLE_BASE_URL);
        // A set-but-empty / whitespace-only env value is a no-op, not a broken base.
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Production, dev, Some(String::new())),
            DEFAULT_CONSOLE_BASE_URL
        );
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Production, dev, Some("   ".into())),
            DEFAULT_CONSOLE_BASE_URL
        );
        // A value that is only slashes trims to empty → still the default.
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Production, dev, Some("/".into())),
            DEFAULT_CONSOLE_BASE_URL
        );
    }

    #[test]
    fn console_base_url_uses_override_and_normalizes_it() {
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Production, true, Some("https://console.hippicode.com".into())),
            "https://console.hippicode.com"
        );
        // Surrounding whitespace and trailing slashes are stripped so callers can
        // append `/share/<token>` without doubling the separator.
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Production, true, Some("  https://console.hippicode.com///  ".into())),
            "https://console.hippicode.com"
        );
    }

    /// Regression guard for the console unification.
    ///
    /// Staging used to default to `console.hippicode.com`. Deleting a branch is
    /// exactly the kind of change that comes back — a later reader sees a
    /// `channel` parameter that no longer selects anything and "restores" the
    /// arm. Every channel now mints at the production console by default.
    #[test]
    fn every_channel_mints_production_links_by_default() {
        for channel in [ReleaseChannel::Production, ReleaseChannel::Beta, ReleaseChannel::Staging] {
            assert_eq!(
                resolve_console_base_url(channel, false, None),
                DEFAULT_CONSOLE_BASE_URL,
                "{channel:?} must mint at the production console"
            );
        }
    }

    /// Staging keeps the override so an internal build can still be pointed at
    /// a staging or local console deliberately — the capability survives, only
    /// the automatic default is gone.
    #[test]
    fn a_staging_build_can_still_be_repointed() {
        assert_eq!(
            resolve_console_base_url(ReleaseChannel::Staging, false, Some("https://console.example.dev".into())),
            "https://console.example.dev"
        );
    }

    #[test]
    fn release_builds_ignore_the_override() {
        // A RELEASE binary on a public lane always mints prod links — a stray
        // HIPPIUS_CONSOLE_BASE_URL in a bundled .env must not repoint it (the
        // pre-channel design's standing release hazard). Beta is a public lane
        // shipped to real users, so it is bound by this too, not by staging's
        // looser rule.
        for channel in [ReleaseChannel::Production, ReleaseChannel::Beta] {
            assert_eq!(
                resolve_console_base_url(channel, false, Some("https://console.hippicode.com".into())),
                DEFAULT_CONSOLE_BASE_URL,
                "{channel:?} is a release lane and must ignore the override"
            );
        }
    }

    /// Wire-contract pin for the FOREIGN `hcfs_client::client::share::ShareProgress`,
    /// which `share_progress_forwarder` rides straight onto a `Channel<ShareProgress>`
    /// to the webview — no desktop adapter. The FE `shares.ts` reads `{bytesDone,
    /// bytesTotal, phase}` and its own doc comment says the casing "must not drift
    /// from the backend serde derive", yet nothing pinned it. `ShareProgress` is
    /// `#[serde(rename_all = "camelCase")]`; this pins the keys. AUDIT gap H5.
    #[test]
    fn share_progress_pins_wire_shape() {
        use hcfs_client::client::share::{SharePhase, ShareProgress};
        use std::collections::BTreeSet;

        let update = ShareProgress {
            phase: SharePhase::Uploading,
            bytes_done: 10,
            bytes_total: 20,
        };
        let json = serde_json::to_value(update).expect("serialize ShareProgress");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["bytesDone", "bytesTotal", "phase"].into_iter().map(String::from).collect();
        assert_eq!(
            keys, expected,
            "ShareProgress wire keys drifted — FE shares.ts reads bytesDone/bytesTotal/phase"
        );
    }

    /// The `SharePhase` variant strings drive the FE share-progress bar's label
    /// (`shares.ts::SharePhase = "encrypting" | "uploading" | "finalizing"`). A
    /// rename in hcfs would break the bar silently. `#[serde(rename_all =
    /// "lowercase")]`, pinned here. AUDIT gap H5.
    #[test]
    fn share_phase_pins_wire_strings() {
        use hcfs_client::client::share::SharePhase;

        let cases = [
            (SharePhase::Encrypting, "encrypting"),
            (SharePhase::Uploading, "uploading"),
            (SharePhase::Finalizing, "finalizing"),
        ];
        for (phase, wire) in cases {
            let json = serde_json::to_value(phase).expect("serialize SharePhase");
            assert_eq!(
                json,
                serde_json::Value::String(wire.to_string()),
                "SharePhase wire string drifted (expected {wire})"
            );
        }
    }

    /// Extract the `{ ... }` body of the first fn whose declaration contains
    /// `sig`, by brace matching. Same static-invariant style as `sync::folders`
    /// uses for teardown ordering — the reshare ordering is impractical to
    /// exercise end-to-end (real account client + server) in a unit test.
    fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
        let sig_idx = src.find(sig).expect("fn declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        &src[body_start..=body_end]
    }

    /// `hcfs_list_shares` must build every row's URL through
    /// `build_share_url_for`, which dispatches on the stored `ShareSecret`
    /// variant — never through the raw `build_share_url`, which takes a key
    /// and can only ever produce a password-free `#k=` link.
    ///
    /// This is a source-text pin because the failure it guards is invisible
    /// to a type check: `build_share_url` still exists and still compiles
    /// here, it just silently hands out a public link for a
    /// password-protected share. That was the original defect — the Shares
    /// page offered a Copy button that bypassed the password — and a
    /// well-meaning "simplification" back to the direct call would
    /// reintroduce it with no test failing.
    #[test]
    fn list_shares_never_builds_a_url_from_a_raw_key() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shares/commands.rs")).expect("read commands.rs");
        let body = fn_body(&src, "pub async fn hcfs_list_shares(");
        assert!(
            body.contains("build_share_url_for("),
            "hcfs_list_shares must rebuild URLs via build_share_url_for so a private \
             share can only ever yield its #p= link",
        );
        // `build_share_url_for(` contains `build_share_url` as a prefix, so
        // strip the correct calls before looking for a bare one.
        let without_correct_calls = body.replace("build_share_url_for(", "");
        assert!(
            !without_correct_calls.contains("build_share_url("),
            "hcfs_list_shares must NOT call build_share_url directly — that takes a raw \
             key and would emit a password-free #k= link for a password-protected share",
        );
    }

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

    // ─── Boundary parsing ──────────────────────────────────────────────────

    #[test]
    fn parse_ttl_accepts_exactly_the_server_presets() {
        use hcfs_client::client::share::ShareTtl;
        assert_eq!(parse_ttl("24h").expect("24h"), ShareTtl::Hours24);
        assert_eq!(parse_ttl("7d").expect("7d"), ShareTtl::Days7);
        assert_eq!(parse_ttl("30d").expect("30d"), ShareTtl::Days30);
        assert_eq!(parse_ttl("never").expect("never"), ShareTtl::Never);
    }

    /// A typo must be a typed rejection, never a silent default. Falling back
    /// to `never` would leave a permanent link the user never asked for;
    /// falling back to `24h` would silently shorten one they did.
    #[test]
    fn parse_ttl_rejects_anything_else() {
        for bad in ["", "48h", "1d", "forever", "NEVER", " 24h ", "0"] {
            let err = parse_ttl(bad).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} → {err:?}");
        }
    }

    #[test]
    fn share_choice_parses_public_without_a_password() {
        let choice = ShareChoice::parse("public", None).expect("public");
        assert!(matches!(choice, ShareChoice::Public));
        assert_eq!(choice.password(), None);
    }

    /// A password sent alongside "public" is dropped rather than honoured:
    /// the user chose a public link, and silently protecting it would produce
    /// a link nobody can open.
    #[test]
    fn share_choice_ignores_a_password_on_the_public_branch() {
        let choice = ShareChoice::parse("public", Some("correct horse battery".into())).expect("public");
        assert_eq!(choice.password(), None);
        assert_eq!(choice.into_password(), None);
    }

    #[test]
    fn share_choice_generates_a_password_when_none_is_supplied() {
        let choice = ShareChoice::parse("private", None).expect("private");
        let password = choice.password().expect("private must carry a password").to_owned();
        assert!(
            validate_share_password(&password).is_ok(),
            "a generated password must satisfy our own rule, got {password:?}",
        );
        // Two draws must differ, or every private share would share one password.
        let other = ShareChoice::parse("private", None).expect("private");
        assert_ne!(Some(password.as_str()), other.password());
    }

    #[test]
    fn share_choice_keeps_a_caller_supplied_password() {
        let choice = ShareChoice::parse("private", Some("correct horse battery".into())).expect("private");
        assert_eq!(choice.password(), Some("correct horse battery"));
    }

    /// Password strength is decided in Rust, not by the frontend — an IPC
    /// caller that skips the UI must hit the same floor.
    #[test]
    fn share_choice_rejects_a_weak_supplied_password() {
        for weak in ["", "a", "short", "1234567"] {
            let err = ShareChoice::parse("private", Some(weak.into())).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{weak:?} → {err:?}");
        }
    }

    #[test]
    fn share_choice_rejects_an_unknown_visibility() {
        for bad in ["", "Public", "PRIVATE", "anyone", "protected", " public "] {
            let err = ShareChoice::parse(bad, None).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} → {err:?}");
        }
    }

    // ─── Folder-share mint helpers ─────────────────────────────────────────

    #[test]
    fn folder_share_path_prefix_trims_and_accepts_drive_relative_paths() {
        assert_eq!(folder_share_path_prefix("").expect("root"), "");
        assert_eq!(folder_share_path_prefix("photos").expect("flat"), "photos");
        assert_eq!(folder_share_path_prefix("trips/photos").expect("nested"), "trips/photos");
        // A stray separator must not change WHICH folder is shared, and "/"
        // alone collapses to the whole-drive prefix rather than being refused
        // as an absolute path.
        assert_eq!(folder_share_path_prefix("/photos/").expect("trimmed"), "photos");
        assert_eq!(folder_share_path_prefix("/").expect("bare slash"), "");
    }

    /// The wire must never see a path that could name anything outside the
    /// drive — same refusal set as `resolve_inside_sync_root`, minus the disk.
    #[test]
    fn folder_share_path_prefix_rejects_escaping_components() {
        for bad in ["..", "../outside", "a/../b", "./a"] {
            let err = folder_share_path_prefix(bad).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} → {err:?}");
        }
    }

    /// Last path segment for a nested folder, the drive label at root — the
    /// console mint's `displayName` rule, mirrored so the recipient page
    /// titles itself the same regardless of which client minted the link.
    #[test]
    fn folder_share_display_name_mirrors_the_console_choice() {
        assert_eq!(folder_share_display_name("Drive", ""), "Drive");
        assert_eq!(folder_share_display_name("Drive", "photos"), "photos");
        assert_eq!(folder_share_display_name("Drive", "trips/photos"), "photos");
    }

    /// `folder_not_found` is the one create failure the user can fix (sync
    /// the drive first), so it must surface as showable Validation text; the
    /// indistinct transport failures stay `Hcfs`.
    #[test]
    fn folder_share_errors_map_onto_the_app_taxonomy() {
        use hcfs_client::client::folder_share::FolderShareError;

        let err = map_folder_share_error(FolderShareError::FolderNotRegistered);
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");

        let err = map_folder_share_error(FolderShareError::NotFound);
        assert!(matches!(err, AppError::Hcfs(_)), "got {err:?}");

        let err = map_folder_share_error(FolderShareError::MissingFolderHash);
        assert!(matches!(err, AppError::Hcfs(_)), "got {err:?}");
    }

    // ─── Folder-share listing resolution ───────────────────────────────────

    fn mk_folder_row(token_hash: &str, path_prefix: &str) -> FolderShareListItem {
        FolderShareListItem {
            token_hash: token_hash.to_string(),
            folder_hash: "abcdef0123456789".to_string(),
            path_prefix: path_prefix.to_string(),
            display_name: "Photos".to_string(),
            created_at: Utc::now(),
            expires_at: None,
            revoked_at: None,
        }
    }

    /// Wire pin for the listing row the FE consumes: exactly the server
    /// fields camelCased plus the three resolution fields. The shares
    /// page and the (folderHash, pathPrefix) badge identity read these keys.
    #[test]
    fn folder_share_summary_pins_wire_shape() {
        use std::collections::BTreeSet;

        let summary = FolderShareSummary {
            token_hash: "ab".repeat(32),
            folder_hash: "abcdef0123456789".to_string(),
            path_prefix: "photos".to_string(),
            display_name: "Photos".to_string(),
            created_at: Utc::now().to_rfc3339(),
            expires_at: None,
            revoked_at: None,
            resolvable: true,
            share_token: Some("tok".to_string()),
            share_url: Some("https://x.io/share/folder/tok#k=AA".to_string()),
            is_private: Some(false),
        };
        let json = serde_json::to_value(&summary).expect("serialize FolderShareSummary");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = [
            "tokenHash",
            "folderHash",
            "pathPrefix",
            "displayName",
            "createdAt",
            "expiresAt",
            "revokedAt",
            "resolvable",
            "shareToken",
            "shareUrl",
            "isPrivate",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(keys, expected, "FolderShareSummary wire keys drifted — FE shares.ts reads these");
    }

    /// The resolution rules in one place: a hash with a stored token
    /// resolves (token + URL + privateness from the secret), a foreign
    /// hash comes back view-only, and a private secret can only ever
    /// rebuild its `#p=` link.
    #[test]
    fn resolve_folder_share_rows_joins_rows_to_stored_tokens() {
        use hcfs_client::client::folder_share::build_folder_share_url;

        let public_key = [7u8; 32];
        let secrets: HashMap<String, (String, ShareSecret)> = [
            (
                folder_share_token_hash("tok-pub"),
                ("tok-pub".to_string(), ShareSecret::Public(public_key)),
            ),
            (
                folder_share_token_hash("tok-priv"),
                ("tok-priv".to_string(), ShareSecret::Private(vec![2u8; 89])),
            ),
        ]
        .into_iter()
        .collect();

        let rows = vec![
            mk_folder_row(&folder_share_token_hash("tok-pub"), "photos"),
            mk_folder_row(&folder_share_token_hash("tok-priv"), ""),
            mk_folder_row(&folder_share_token_hash("minted-on-another-device"), "docs"),
        ];
        let out = resolve_folder_share_rows(rows, &secrets, "https://console.example.com");
        assert_eq!(out.len(), 3);

        let public = &out[0];
        assert!(public.resolvable);
        assert_eq!(public.share_token.as_deref(), Some("tok-pub"));
        assert_eq!(
            public.share_url.as_deref(),
            Some(build_folder_share_url("https://console.example.com", "tok-pub", &public_key).as_str()),
        );
        assert_eq!(public.is_private, Some(false));
        assert_eq!(public.path_prefix, "photos");

        let private = &out[1];
        assert!(private.resolvable);
        assert_eq!(private.is_private, Some(true));
        let url = private.share_url.as_deref().expect("private row rebuilds a URL");
        assert!(url.contains("#p="), "private secret must yield its #p= link: {url}");
        assert!(!url.contains("#k="), "private secret must never yield a #k= link: {url}");

        let foreign = &out[2];
        assert!(!foreign.resolvable, "a hash with no stored token is view-only");
        assert_eq!(foreign.share_token, None);
        assert_eq!(foreign.share_url, None);
        // Protection is unknown without the secret — `None`, never a
        // fabricated `false` that would label a protected share "public".
        assert_eq!(foreign.is_private, None);
        assert_eq!(foreign.folder_hash, "abcdef0123456789", "identity fields survive for the badge");
        assert_eq!(foreign.path_prefix, "docs");
    }

    /// Dead rows pass through with their timestamps intact — the listing
    /// retains revoked/expired rows until the server reaper sweeps them,
    /// and the FE renders the dead state from `revokedAt`/`expiresAt`.
    #[test]
    fn resolve_folder_share_rows_keeps_dead_state_timestamps() {
        let now = Utc::now();
        let mut row = mk_folder_row(&folder_share_token_hash("tok"), "photos");
        row.expires_at = Some(now);
        row.revoked_at = Some(now);
        let out = resolve_folder_share_rows(vec![row], &HashMap::new(), "https://x.io");
        assert_eq!(out[0].expires_at.as_deref(), Some(now.to_rfc3339().as_str()));
        assert_eq!(out[0].revoked_at.as_deref(), Some(now.to_rfc3339().as_str()));
    }

    /// End-to-end over the real keystore: a token minted into a temp
    /// `SqliteShareKeystore` must come back keyed by exactly the blake3
    /// hex the server's listing would carry for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn folder_share_secrets_by_hash_resolves_a_minted_token() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use std::str::FromStr;

        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");

        let keystore = SqliteShareKeystore::new(pool);
        let secret = ShareSecret::Public([9u8; 32]);
        keystore.put("minted-token", &secret).expect("put");

        let by_hash = folder_share_secrets_by_hash(&keystore).expect("scan");
        let (token, stored) = by_hash.get(&folder_share_token_hash("minted-token")).expect("hash must match");
        assert_eq!(token, "minted-token");
        assert_eq!(stored, &secret);
    }

    /// Same source-text pin as `list_shares_never_builds_a_url_from_a_raw_key`,
    /// for the folder listing's URL rebuild: `resolve_folder_share_rows` must
    /// go through `build_folder_share_url_for` (variant dispatch), never the
    /// raw-key `build_folder_share_url`, which can only emit a `#k=` link.
    #[test]
    fn folder_listing_never_builds_a_url_from_a_raw_key() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shares/commands.rs")).expect("read commands.rs");
        let body = fn_body(&src, "fn resolve_folder_share_rows(");
        assert!(
            body.contains("build_folder_share_url_for("),
            "resolve_folder_share_rows must rebuild URLs via build_folder_share_url_for so a \
             password-protected folder share can only ever yield its #p= link",
        );
        let without_correct_calls = body.replace("build_folder_share_url_for(", "");
        assert!(
            !without_correct_calls.contains("build_folder_share_url("),
            "resolve_folder_share_rows must NOT call build_folder_share_url directly — that takes \
             a raw key and would emit a password-free #k= link for a password-protected share",
        );
    }
}
