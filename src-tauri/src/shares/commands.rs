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
use crate::shares::SqliteShareKeystore;
use crate::shares::capabilities::fetch_capabilities;
use crate::shares::client::build_account_client;
use crate::shares::history::{self, HistoryEntry};
use crate::shares::origin;
use chrono::Utc;
use hcfs_client::client::share::{
    ShareOptions, ShareProgress, ShareProgressFn, ShareSecret, ShareSummary as UpstreamShareSummary, ShareTtl,
    build_share_url_for, generate_share_password, validate_share_password,
};
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tracing::{debug, info, warn};

/// Default (production) console origin used to build the recipient URL.
/// `console.hippius.com` serves the share recipient page in `hippius-console`.
const DEFAULT_CONSOLE_BASE_URL: &str = "https://console.hippius.com";

/// The console origin to embed in minted share links, honoring the
/// `HIPPIUS_CONSOLE_BASE_URL` env override (dev/test only) over the production
/// default. Mirrors the app's other `HIPPIUS_*_URL` overrides (see
/// `api/client.rs`, `auth/service.rs`): a plain desktop build points at prod,
/// while a build launched with `HIPPIUS_CONSOLE_BASE_URL=https://console.hippicode.com`
/// mints links at a staging console — e.g. to exercise the `#p=` private-share
/// recipient page before it ships to prod.
fn console_base_url() -> String {
    resolve_console_base_url(std::env::var("HIPPIUS_CONSOLE_BASE_URL").ok())
}

/// Pure resolver for [`console_base_url`], split out so the env-independent
/// logic is unit-testable without mutating process env under the parallel test
/// runner (env writes are process-global and racy). A blank/whitespace override
/// falls back to the default, and any trailing `/` is trimmed so callers can
/// join `/share/<token>` without doubling the separator.
fn resolve_console_base_url(override_value: Option<String>) -> String {
    override_value
        // Strip leading whitespace, and any trailing run of whitespace-OR-`/`, in
        // ONE pass, so the result's last char is neither — which makes the
        // normalization idempotent. The two-step `.trim().trim_end_matches('/')`
        // was NOT idempotent: removing a trailing slash can re-expose trailing
        // whitespace (e.g. "x\u{b}/" → "x\u{b}"), which a second pass would then
        // trim (proptest `resolve_console_base_url_is_idempotent`).
        .map(|value| value.trim_start().trim_end_matches(|c: char| c.is_whitespace() || c == '/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CONSOLE_BASE_URL.to_string())
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
                        validate_share_password(&supplied)
                            .map_err(|e| AppError::Validation(e.to_string()))?;
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
    serde_json::from_value(serde_json::Value::String(ttl.to_owned()))
        .map_err(|_| AppError::Validation(format!("Unknown share expiry: {ttl}")))
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
#[cfg(target_os = "macos")]
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

/// Stream an already-resolved local plaintext file through the share engine.
///
/// Shared by the two Finder paths that have no synced-folder identity — an
/// outside file and a folder zipped to a temp archive. No reshare-origin row is
/// recorded (there is no `(folder_label, relative_path)` to reshare from). The
/// caller has already run the capability + eligibility gates. `progress` streams
/// the encrypt/upload bar to the confirm modal when `Some`.
///
/// The `(path, name, type, ttl, choice)` tuple travels together through both
/// callers, so it is bundled rather than spread across the signature — the
/// zip path in particular derives its `filename` from the directory name, not
/// from `local_path` (which points at a temp archive), so the two must be
/// passed as one coherent description of what is being shared.
#[cfg(target_os = "macos")]
struct LocalShareRequest<'a> {
    /// Bytes to upload. For the zip path this is a temp archive, not the
    /// thing the user clicked.
    local_path: &'a Path,
    /// Name the recipient sees — `<dir>.zip` for the zip path.
    filename: &'a str,
    mime_type: &'a str,
    ttl: ShareTtl,
    choice: ShareChoice,
}

#[cfg(target_os = "macos")]
async fn share_local_file(
    state: &AppState,
    account_id: &str,
    request: LocalShareRequest<'_>,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    let LocalShareRequest {
        local_path,
        filename,
        mime_type,
        ttl,
        choice,
    } = request;
    let pool = state.pool()?;
    let metadata = tokio::fs::metadata(local_path).await?;
    if !metadata.is_file() {
        return Err(AppError::Validation("Cannot share a directory".into()));
    }
    let plaintext_size = metadata.len();

    info!(filename, plaintext_size, mime_type, "Creating share from local file");

    let client = build_account_client(pool, account_id).await?;
    let mut reader = tokio::fs::File::open(local_path).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let result = client
        .create_share(
            &mut reader,
            plaintext_size,
            &ShareOptions {
                filename,
                mime_type,
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

/// Mint a public share for a file that is NOT inside a synced folder by reading
/// its bytes directly ("upload & share"). The byte stream is uploaded to the
/// same encrypted-share storage as a synced file; only the reshare-origin
/// sidecar is skipped. Entry point for the macOS Finder dispatcher.
#[cfg(target_os = "macos")]
pub(crate) async fn share_external_file(state: &AppState, account_id: &str, abs_path: &Path, ttl: ShareTtl, choice: ShareChoice, progress: Option<ShareProgressFn>) -> Result<ShareLink> {
    require_shares_supported(state, account_id).await?;
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, 0).await?;

    let filename = abs_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Validation("File has no usable name".into()))?;
    let mime_type = mime_guess::from_path(abs_path).first_or_octet_stream().essence_str().to_owned();

    share_local_file(
        state,
        account_id,
        LocalShareRequest {
            local_path: abs_path,
            filename,
            mime_type: &mime_type,
            ttl,
            choice,
        },
        progress,
    )
    .await
}

/// Mint a public share for a folder by packing it into one `application/zip`
/// blob and sharing that. The share engine shares one byte stream, so a folder
/// has no first-class representation — the recipient downloads `<name>.zip`.
/// Used for both in-drive and outside folders. Entry point for the macOS Finder
/// dispatcher.
///
/// KNOWN LIMITATION: there is no size/entry/time cap on the zip — a click on a
/// very large tree fills the temp disk and starts an unbounded upload. A
/// follow-up should bound it (max bytes/entries) before the walk. The
/// eligibility gate is a positive-balance floor, not a byte budget.
#[cfg(target_os = "macos")]
pub(crate) async fn share_directory_as_zip(
    state: &AppState,
    account_id: &str,
    dir_path: &Path,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    require_shares_supported(state, account_id).await?;
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, 0).await?;

    let dir_name = dir_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Validation("Folder has no usable name".into()))?;
    let zip_filename = format!("{dir_name}.zip");

    // Pack on a blocking thread: the zip crate and `std::fs` are synchronous,
    // and a large folder would otherwise stall the async runtime. The temp file
    // is moved back out and lives in this frame across the upload await below;
    // its `Drop` unlinks the archive only after `create_share` has streamed it.
    let src = dir_path.to_path_buf();
    let temp = tokio::task::spawn_blocking(move || crate::shares::zip_dir::zip_directory_to_temp(&src))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e)))??;

    share_local_file(
        state,
        account_id,
        LocalShareRequest {
            local_path: temp.path(),
            filename: &zip_filename,
            mime_type: "application/zip",
            ttl,
            choice,
        },
        progress,
    )
    .await
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
pub async fn hcfs_update_share_expiry(
    state: tauri::State<'_, AppState>,
    share_token: String,
    ttl: String,
) -> Result<Option<String>> {
    let account_id = state.current_account_id()?;
    let ttl = parse_ttl(&ttl)?;

    require_shares_supported(&state, &account_id).await?;

    let pool = state.pool()?;
    let client = build_account_client(pool, &account_id).await?;
    let expires_at = client
        .update_share_expiry(&share_token, ttl)
        .await
        .map_err(|e| {
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
        fn resolve_console_base_url_is_idempotent(raw in ".*") {
            let once = resolve_console_base_url(Some(raw));
            let twice = resolve_console_base_url(Some(once.clone()));
            prop_assert_eq!(once, twice);
        }
    }

    #[test]
    fn console_base_url_defaults_when_override_absent_or_blank() {
        assert_eq!(resolve_console_base_url(None), DEFAULT_CONSOLE_BASE_URL);
        // A set-but-empty / whitespace-only env value is a no-op, not a broken base.
        assert_eq!(resolve_console_base_url(Some(String::new())), DEFAULT_CONSOLE_BASE_URL);
        assert_eq!(resolve_console_base_url(Some("   ".into())), DEFAULT_CONSOLE_BASE_URL);
        // A value that is only slashes trims to empty → still the default.
        assert_eq!(resolve_console_base_url(Some("/".into())), DEFAULT_CONSOLE_BASE_URL);
    }

    #[test]
    fn console_base_url_uses_override_and_normalizes_it() {
        assert_eq!(
            resolve_console_base_url(Some("https://console.hippicode.com".into())),
            "https://console.hippicode.com"
        );
        // Surrounding whitespace and trailing slashes are stripped so callers can
        // append `/share/<token>` without doubling the separator.
        assert_eq!(
            resolve_console_base_url(Some("  https://console.hippicode.com///  ".into())),
            "https://console.hippicode.com"
        );
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
}
