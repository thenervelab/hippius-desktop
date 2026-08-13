//! Register this device's master-mnemonic identity as a read-only recovery
//! principal on hcfs-server.
//!
//! An OAuth account's files live under the custodial login SS58, but the
//! self-custodied master mnemonic derives a *different* sr25519 identity. This
//! command binds that mnemonic identity to the login namespace so the
//! backed-up phrase can later recover the files even without OAuth access — the
//! desktop counterpart to hcfs-server's recovery-binding endpoints (see the
//! companion ADRs `docs/plans/2026-06-22-oauth-mnemonic-file-recovery-binding.md`
//! and hcfs `docs/plans/2026-06-22-recovery-bindings.md`).
//!
//! Flow (all under the active OAuth bearer): request a single-use challenge for
//! the recovery SS58, prove possession by signing the domain-separated
//! challenge with the mnemonic-derived key, then submit the binding. The
//! private key is derived locally, used to sign, and dropped here — it never
//! leaves the device.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use subxt_signer::sr25519::Keypair;
use tauri::{Emitter, Manager};
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::app_state::AppState;
use crate::auth::service::{challenge_response, derive_keys};
use crate::console_access::{HcfsServerCtx, HttpOutcome, get_json, post_json, post_json_discard};
use crate::error::{AppError, Result};
use crate::sync::config::build_hcfs_config;
use crate::sync::mnemonic::get_mnemonic_for_account;
use hcfs_client::drive::keys::folder_hash;
use hcfs_client::drive::remote::{RemoteFileAccess, derive_encryption_key, download_remote_file, list_remote_files};

/// Domain-separation tag prepended to a challenge before signing. Binds the
/// signature to *this* protocol so it cannot be replayed against another
/// Hippius surface that signs raw nonces.
///
/// CROSS-REPO INVARIANT: must match `RECOVERY_BINDING_DOMAIN` in hcfs-server
/// `recovery_crypto.rs` byte-for-byte, or every bind is rejected as
/// `bad_signature`. The `signature_verifies_under_sr25519` test guards the
/// signing half against drift.
const RECOVERY_BINDING_DOMAIN: &[u8] = b"hippius-recovery-binding:";

/// The challenge half of the server response. `expires_at` is display-only and
/// ignored here (serde drops unknown fields), so it is not modeled.
#[derive(Debug, Deserialize)]
struct ChallengeResp {
    challenge: String,
}

/// The exact bytes the recovery key signs: the domain tag followed by the raw
/// challenge string. One definition, shared by the signer and its test, so the
/// construction cannot diverge between them.
fn build_binding_message(challenge: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(RECOVERY_BINDING_DOMAIN.len() + challenge.len());
    message.extend_from_slice(RECOVERY_BINDING_DOMAIN);
    message.extend_from_slice(challenge.as_bytes());
    message
}

/// Sign the domain-separated challenge and hex-encode the raw 64-byte sr25519
/// signature (the form hcfs-server's bind endpoint hex-decodes). sr25519 signing
/// is randomized, so the output differs per call but always verifies.
fn sign_binding(keypair: &Keypair, challenge: &str) -> String {
    hex::encode(keypair.sign(&build_binding_message(challenge)).0)
}

/// Register the active account's master-mnemonic identity as a read-only
/// recovery principal on hcfs-server. Internal core — recovery is **default-on**
/// (no user action), driven by [`spawn_default_recovery_binding`].
///
/// Requires an authenticated session (the bind is owner-authenticated) and a
/// resolvable master mnemonic. Idempotent server-side: re-binding the same pair
/// refreshes the row. The server feature (`HCFS_FEATURE_RECOVERY_BINDING`) must
/// be enabled, or the challenge request surfaces the endpoint's 404.
///
/// # Errors
///
/// - [`AppError::Crypto`] if the mnemonic cannot derive the sr25519 keypair.
/// - [`AppError::Api`] if the server rejects the challenge or bind (e.g.
///   `bad_signature`, feature disabled), via the shared HTTP error mapping.
/// - Propagates session/mnemonic-resolution errors from [`get_mnemonic_for_account`].
pub(crate) async fn bind_recovery_identity_core(state: &tauri::State<'_, AppState>) -> Result<()> {
    let account_id = state.current_account_id()?;
    let ctx = HcfsServerCtx::resolve(state).await?;

    // Derive the recovery identity locally. The keypair holds the secret only
    // for the lifetime of this function; the mnemonic is `Zeroizing` and wiped
    // on drop.
    let mnemonic = get_mnemonic_for_account(state, &account_id).await?;
    let (keypair, recovery_ss58, _eth_signer, _eth_address) = derive_keys(&mnemonic).map_err(AppError::Crypto)?;

    let challenge: ChallengeResp = post_json(
        &ctx,
        "/v1/recovery-binding/challenge",
        &serde_json::json!({ "recovery_ss58": recovery_ss58 }),
    )
    .await?;

    let signature = sign_binding(&keypair, &challenge.challenge);
    post_json_discard(
        &ctx,
        "/v1/recovery-binding",
        &serde_json::json!({
            "recovery_ss58": recovery_ss58,
            "challenge": challenge.challenge,
            "signature": signature,
        }),
    )
    .await?;

    info!(recovery = %recovery_ss58, "Recovery identity bound for active account");
    Ok(())
}

/// Ensure the active account's recovery binding exists — best-effort and
/// **default-on**, spawned from the sync-init funnel so every account registers
/// its mnemonic as a recovery principal with no user action and no UI.
///
/// Guarded to one *successful* bind per account per process session
/// (`AppState.recovery_bound`): a failure is logged and naturally retried on the
/// next sync init, while a success suppresses the redundant re-bind that every
/// later init/resume cycle would otherwise issue. Never surfaces an error —
/// recovery being momentarily unregistered is a silent, self-healing degradation,
/// not something to interrupt sync for.
pub fn spawn_default_recovery_binding(app: tauri::AppHandle) {
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(account_id) = state.current_account_id() else {
            return;
        };
        // Skip if already bound this session (or the lock is poisoned — then a
        // restart retries; better than spinning on a poisoned mutex).
        if state.recovery_bound.lock().map_or(true, |bound| bound.contains(&account_id)) {
            return;
        }
        match bind_recovery_identity_core(&state).await {
            Ok(()) => {
                if let Ok(mut bound) = state.recovery_bound.lock() {
                    bound.insert(account_id);
                }
            }
            Err(e) => warn!(error = %e, "Default recovery binding failed; will retry on next sync init"),
        }
    });
}

/// One namespace a recovery identity may restore, as returned to the frontend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableAccount {
    /// SS58 of the OAuth account whose files this mnemonic can recover.
    pub owner_address: String,
    /// Access level the binding grants (`"read"` today).
    pub scope: String,
}

/// Server response for `GET /v1/recovery-bindings/owned-namespaces`. Field
/// names mirror hcfs-server's `OwnedNamespace`/`OwnedNamespacesResponse`.
#[derive(Debug, Deserialize)]
struct ServerOwnedNamespace {
    owner_ss58: String,
    scope: String,
}

#[derive(Debug, Deserialize)]
struct OwnedNamespacesResp {
    namespaces: Vec<ServerOwnedNamespace>,
}

/// Map server rows to the frontend shape. Pure (no I/O) so the field mapping is
/// unit-testable and a future field swap is caught by a test rather than in UI.
fn to_recoverable(namespaces: Vec<ServerOwnedNamespace>) -> Vec<RecoverableAccount> {
    namespaces
        .into_iter()
        .map(|n| RecoverableAccount {
            owner_address: n.owner_ss58,
            scope: n.scope,
        })
        .collect()
}

/// List the OAuth accounts a backed-up mnemonic can recover, by authenticating
/// as the mnemonic-derived identity and querying its recovery bindings.
///
/// This deliberately mints a one-shot bearer via [`challenge_response`] instead
/// of `login_with_mnemonic`: the user is *recovering another account*, not
/// signing in as the recovery identity, so the active session must be left
/// untouched. The pasted mnemonic is held in [`Zeroizing`] and never logged.
///
/// # Errors
///
/// - [`AppError::Crypto`] if the phrase is not a valid mnemonic.
/// - Auth failure (challenge/verify) surfaces via `From<String>` for [`AppError`].
/// - [`AppError::Hcfs`] if no hcfs region is reachable.
/// - [`AppError::Other`] if the server's recovery-binding feature is disabled
///   (the endpoint 404s).
#[tauri::command]
pub async fn list_recoverable_accounts(state: tauri::State<'_, AppState>, mnemonic: String) -> Result<Vec<RecoverableAccount>> {
    let mnemonic = Zeroizing::new(mnemonic);
    // Only the public address + eth signer are needed to mint the bearer; the
    // sr25519 keypair (`.0`) is not used for discovery, so it is not bound.
    let (_keypair, recovery_ss58, eth_signer, eth_address) = derive_keys(&mnemonic).map_err(AppError::Crypto)?;

    // Mint a bearer scoped to the recovery identity. No referral code; we never
    // want a recovery probe to create a referral relationship.
    let (token, _user, _username, _is_new, _expiry) = challenge_response(&state.api_client, &eth_signer, &eth_address, &recovery_ss58, None).await?;

    let base_url = hcfs_client::client::pick_fastest(&state.api_client)
        .await
        .map_err(|e| AppError::Hcfs(e.to_string()))?;

    // A recovery-scoped context: same plumbing as the session ctx, but the
    // bearer/ss58 are the recovery identity's, NOT the active session's — the
    // one place we intentionally bypass HcfsServerCtx::resolve's
    // ss58 == account_id assertion.
    let ctx = HcfsServerCtx {
        client: state.api_client.clone(),
        base_url,
        bearer: token,
        ss58: recovery_ss58,
    };

    let namespaces = match get_json::<OwnedNamespacesResp>(&ctx, "/v1/recovery-bindings/owned-namespaces").await? {
        HttpOutcome::Ok(resp) => resp.namespaces,
        HttpOutcome::NotFound => {
            return Err(AppError::Other(
                "Recovery is not available on this server (the recovery-binding feature is disabled).".into(),
            ));
        }
    };

    info!(count = namespaces.len(), "Listed recoverable accounts for pasted mnemonic");
    Ok(to_recoverable(namespaces))
}

/// Outcome of a recovery pull. Best-effort: a failed file or folder is counted
/// and its reason recorded, not fatal, so one bad entry never aborts the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    /// Folders enumerated for the owner namespace.
    pub folders: u32,
    /// Files downloaded + decrypted to disk.
    pub files_recovered: u32,
    /// Files that failed to list or download.
    pub files_failed: u32,
    /// Total decrypted bytes written.
    pub bytes: u64,
    /// Human-readable reasons, capped at [`MAX_ERRORS`] so a pathological
    /// namespace cannot return an unbounded payload.
    pub errors: Vec<String>,
    /// True when the pull stopped early because `cancel_account_recovery` was
    /// called — distinguishes a user cancel from a clean finish so the UI can
    /// say "cancelled (partial)" rather than "complete".
    pub cancelled: bool,
}

/// Live progress for the recovery pull, emitted as `recovery_progress` after
/// each file so the UI can show a determinate bar. `files_total` is the sum of
/// the folders' server-reported file counts (an estimate; the authoritative
/// outcome is the returned [`RecoverySummary`]).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryProgress {
    files_done: u32,
    files_total: u64,
    bytes: u64,
    label: String,
    file: String,
}

/// Borrowed context shared across the folder loop, so per-folder/per-file
/// helpers stay within the positional-parameter budget. All references outlive
/// the loop in [`recover_account_files`].
struct RecoveryRun<'a> {
    client: &'a hcfs_client::client::HcfsClient,
    master: &'a str,
    owner: &'a str,
    dest_root: &'a Path,
    app: &'a tauri::AppHandle,
    cancel: &'a std::sync::atomic::AtomicBool,
    files_total: u64,
}

/// Cap on retained error strings (the count fields stay exact regardless).
const MAX_ERRORS: usize = 50;

impl RecoverySummary {
    fn record_error(&mut self, message: String) {
        self.files_failed += 1;
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(message);
        }
    }
}

/// Lexically join `root / parts...`, admitting ONLY normal path components.
///
/// The label and per-file relative path originate from the server, so they are
/// untrusted: a `..`, an absolute segment, or a Windows prefix could escape the
/// destination. We build the path component-by-component, skip `.`, and reject
/// anything else, then assert containment as defense in depth. Returns `None`
/// for any escaping or non-relative input — the caller skips that entry. Pure
/// and filesystem-free (the target does not exist yet), so it is unit- and
/// property-testable.
fn safe_join(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for part in parts {
        for component in Path::new(part).components() {
            match component {
                Component::Normal(segment) => out.push(segment),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            }
        }
    }
    out.starts_with(root).then_some(out)
}

/// Build an hcfs client authenticated as the recovery identity but scoped to the
/// OWNER's namespace. The config `folder_hash` is a placeholder: the stateless
/// remote helpers carry the real per-folder hash in [`RemoteFileAccess`], and
/// `list_remote_folders` keys off the base address, so this value is never read.
fn build_recovery_client(state: &AppState, base_url: &str, bearer: &str, owner: &str) -> Result<hcfs_client::client::HcfsClient> {
    let _ = state; // reserved for a future shared-client cache; keeps the call-site shape stable
    let config = build_hcfs_config(base_url, bearer, owner, &folder_hash("recovery-placeholder"));
    hcfs_client::client::HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create recovery HCFS client: {e}")))
}

/// Reject a recovery destination that is empty, contains `..`, is the
/// filesystem root, or is the user's home directory itself — recovered files
/// must land in a chosen SUBfolder, not be sprayed across `/` or `$HOME`
/// (audit RB-3). Per-file paths within the root are guarded by [`safe_join`].
///
/// # Errors
///
/// [`AppError::Validation`] for an empty / `..` / root / home destination.
fn validate_recovery_destination(dest: &Path) -> Result<()> {
    if dest.as_os_str().is_empty() {
        return Err(AppError::Validation("Recovery destination is empty".into()));
    }
    if dest.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Validation("Recovery destination must not contain '..'".into()));
    }
    if dest == Path::new("/") {
        return Err(AppError::Validation("Recovery destination cannot be the filesystem root".into()));
    }
    if dirs::home_dir().is_some_and(|home| dest == home) {
        return Err(AppError::Validation(
            "Choose a subfolder, not your home directory, as the recovery destination".into(),
        ));
    }
    Ok(())
}

/// Download and decrypt every file the recovery identity can read from
/// `owner_address` into `destination_dir`, laid out as `<dest>/<label>/<rel>`.
///
/// Authenticates as the pasted mnemonic's identity (a one-shot bearer, the
/// session is untouched), enumerates the owner's folders, derives each folder
/// key from the master mnemonic, and pulls every file. Best-effort: per-file and
/// per-folder failures are tallied in the returned [`RecoverySummary`] rather
/// than aborting; only setup failures (auth, region, folder enumeration) error.
///
/// # Errors
///
/// - [`AppError::Crypto`] for an invalid mnemonic.
/// - auth failure via `From<String>`; [`AppError::Hcfs`] for region/client/
///   folder-enumeration failure; [`AppError::Io`] if the destination cannot be
///   created.
#[tauri::command]
pub async fn recover_account_files(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    mnemonic: String,
    owner_address: String,
    destination_dir: String,
) -> Result<RecoverySummary> {
    // Reject a second concurrent recovery so the shared cancel flag stays
    // unambiguous (audit RB-4). The RAII guard clears the in-progress flag on
    // every exit path (success, error, or `?`-propagation).
    if state
        .recovery_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::Other("A recovery is already in progress.".into()));
    }
    struct InProgressGuard<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for InProgressGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _in_progress = InProgressGuard(&state.recovery_in_progress);

    // Recovered files must land in a chosen SUBfolder, never sprayed across `/`
    // or `$HOME` itself (audit RB-3). Per-file paths are containment-guarded by
    // `safe_join` within this root.
    let dest_root = PathBuf::from(&destination_dir);
    validate_recovery_destination(&dest_root)?;

    // Clear any stale cancel request from a prior run before we start.
    state.recovery_cancel.store(false, Ordering::SeqCst);

    let mnemonic = Zeroizing::new(mnemonic);
    let (_keypair, recovery_ss58, eth_signer, eth_address) = derive_keys(&mnemonic).map_err(AppError::Crypto)?;

    let (token, _user, _username, _is_new, _expiry) = challenge_response(&state.api_client, &eth_signer, &eth_address, &recovery_ss58, None).await?;
    let base_url = hcfs_client::client::pick_fastest(&state.api_client)
        .await
        .map_err(|e| AppError::Hcfs(e.to_string()))?;

    tokio::fs::create_dir_all(&dest_root)
        .await
        .map_err(|e| AppError::Other(format!("Could not create recovery destination '{destination_dir}': {e}")))?;

    let client = build_recovery_client(state.inner(), &base_url, &token, &owner_address)?;
    let folders = client
        .list_remote_folders(&owner_address)
        .await
        .map_err(|e| AppError::Hcfs(format!("Failed to list folders for recovery: {e}")))?;

    let run = RecoveryRun {
        client: &client,
        master: &mnemonic,
        owner: &owner_address,
        dest_root: &dest_root,
        app: &app,
        cancel: &state.recovery_cancel,
        // Server-reported per-folder counts give the user a determinate bar.
        files_total: folders.iter().map(|f| f.file_count).sum(),
    };

    let mut summary = RecoverySummary {
        folders: folders.len() as u32,
        ..Default::default()
    };
    for folder in &folders {
        // Honor a cancel between folders as well as between files.
        if run.cancel.load(Ordering::SeqCst) {
            summary.cancelled = true;
            break;
        }
        if !recover_one_folder(&run, &folder.label, &folder.folder_hash, &mut summary).await {
            summary.cancelled = true;
            break;
        }
    }

    info!(
        owner = %owner_address,
        folders = summary.folders,
        recovered = summary.files_recovered,
        failed = summary.files_failed,
        cancelled = summary.cancelled,
        "Account recovery pull finished"
    );
    Ok(summary)
}

/// Pull one folder's files into `dest_root/<label>`. Mutates `summary`. Returns
/// `false` if a cancel was observed mid-folder (the caller stops); `true`
/// otherwise. Never returns an error — a folder whose key cannot derive or
/// whose listing fails is recorded and skipped so the remaining folders still
/// recover.
async fn recover_one_folder(run: &RecoveryRun<'_>, label: &str, fhash: &str, summary: &mut RecoverySummary) -> bool {
    let key = match derive_encryption_key(run.master, label) {
        Ok(k) => k,
        Err(e) => {
            summary.record_error(format!("folder '{label}': key derivation failed: {e}"));
            return true;
        }
    };
    let access = RemoteFileAccess {
        client: run.client,
        ss58_address: run.owner,
        folder_hash: fhash,
        encryption_key: &key,
    };
    let files = match list_remote_files(&access).await {
        Ok(files) => files,
        Err(e) => {
            summary.record_error(format!("folder '{label}': listing failed: {e}"));
            return true;
        }
    };
    for file in &files {
        if run.cancel.load(Ordering::SeqCst) {
            return false;
        }
        let Some(dest) = safe_join(run.dest_root, &[label, &file.path]) else {
            summary.record_error(format!("folder '{label}': skipped file with unsafe path '{}'", file.path));
            continue;
        };
        if let Some(parent) = dest.parent()
            && let Err(e) = tokio::fs::create_dir_all(parent).await
        {
            summary.record_error(format!("folder '{label}': could not create '{}': {e}", parent.display()));
            continue;
        }
        match download_remote_file(&access, &file.file_id, &dest, Some(|_: u64, _: u64| {})).await {
            Ok(bytes) => {
                summary.files_recovered += 1;
                summary.bytes += bytes;
            }
            Err(e) => {
                warn!(label = %label, file = %file.path, "Recovery download failed: {e}");
                summary.record_error(format!("folder '{label}': '{}' failed: {e}", file.path));
            }
        }
        // Progress after each attempt (success or recorded failure), so the bar
        // advances monotonically toward files_total. Emit failures are ignored —
        // a dropped progress tick must never abort the recovery.
        let _ = run.app.emit(
            "recovery_progress",
            RecoveryProgress {
                files_done: summary.files_recovered + summary.files_failed,
                files_total: run.files_total,
                bytes: summary.bytes,
                label: label.to_string(),
                file: file.path.clone(),
            },
        );
    }
    true
}

/// Request that an in-flight [`recover_account_files`] stop after the current
/// file. Sets the shared flag the pull loop polls; idempotent and safe to call
/// when no recovery is running (the next run clears it at entry).
#[tauri::command]
pub fn cancel_account_recovery(state: tauri::State<'_, AppState>) -> Result<()> {
    state.recovery_cancel.store(true, Ordering::SeqCst);
    info!("Account recovery cancellation requested");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // A valid 12-word BIP-39 phrase (the well-known all-"test"/junk vector).
    // Only used to derive a throwaway key for crypto round-trips.
    const TEST_MNEMONIC: &str = "test test test test test test test test test test test junk";

    #[test]
    fn binding_message_is_domain_tag_then_challenge() {
        // KAT: the exact bytes hcfs-server reconstructs. A drift in either the
        // tag or the concatenation order breaks every bind, so pin it.
        assert_eq!(build_binding_message("abc"), b"hippius-recovery-binding:abc".to_vec());
        assert_eq!(build_binding_message(""), b"hippius-recovery-binding:".to_vec());
    }

    #[test]
    fn recovery_address_is_deterministic_for_a_mnemonic() {
        // The recovery SS58 is what the server stores and what the recover flow
        // later authenticates as; it must be stable across calls. (The
        // signature, by contrast, is randomized — see the next test.)
        let a = derive_keys(TEST_MNEMONIC).unwrap().1;
        let b = derive_keys(TEST_MNEMONIC).unwrap().1;
        assert_eq!(a, b);
        assert!(a.starts_with('5'), "generic-prefix-42 SS58 starts with 5, got {a}");
    }

    #[test]
    fn signature_verifies_under_sr25519_over_the_domain_separated_challenge() {
        // The cross-repo drift guard: our client signature must verify exactly
        // as hcfs-server verifies it — same key, same domain-separated message.
        // sr25519 (schnorrkel) signatures are randomized, so we assert
        // verification, never byte-equality.
        let keypair = derive_keys(TEST_MNEMONIC).unwrap().0;
        let challenge = "deadbeefcafe";

        let sig_bytes = hex::decode(sign_binding(&keypair, challenge)).expect("hex");
        let sig = subxt_signer::sr25519::Signature(sig_bytes.try_into().expect("64-byte signature"));
        let message = build_binding_message(challenge);

        assert!(
            subxt_signer::sr25519::verify(&sig, &message, &keypair.public_key()),
            "client signature must verify under sr25519 over the domain-separated challenge"
        );

        // Challenge-bound: the same signature must NOT verify over a different
        // challenge, or the proof-of-possession would be replayable.
        let other = build_binding_message("0000");
        assert!(!subxt_signer::sr25519::verify(&sig, &other, &keypair.public_key()));
    }

    #[test]
    fn to_recoverable_preserves_rows_and_maps_owner_field() {
        // Guards against silently swapping owner_ss58/scope when the FE shape
        // diverges from the server shape.
        let rows = vec![
            ServerOwnedNamespace {
                owner_ss58: "5Owner1".into(),
                scope: "read".into(),
            },
            ServerOwnedNamespace {
                owner_ss58: "5Owner2".into(),
                scope: "read".into(),
            },
        ];
        let mapped = to_recoverable(rows);
        assert_eq!(
            mapped,
            vec![
                RecoverableAccount {
                    owner_address: "5Owner1".into(),
                    scope: "read".into()
                },
                RecoverableAccount {
                    owner_address: "5Owner2".into(),
                    scope: "read".into()
                },
            ]
        );
        assert!(to_recoverable(vec![]).is_empty());
    }

    #[test]
    fn validate_recovery_destination_rejects_dangerous_targets() {
        // Empty, root, and `..` are refused (audit RB-3); a normal subfolder is ok.
        assert!(validate_recovery_destination(Path::new("")).is_err());
        assert!(validate_recovery_destination(Path::new("/")).is_err());
        assert!(validate_recovery_destination(Path::new("/tmp/../etc")).is_err());
        if let Some(home) = dirs::home_dir() {
            assert!(validate_recovery_destination(&home).is_err(), "home dir must be rejected");
        }
        assert!(validate_recovery_destination(Path::new("/tmp/hippius-recovery-2026")).is_ok());
    }

    #[test]
    fn safe_join_builds_nested_paths_from_normal_components() {
        let root = Path::new("/tmp/recovery");
        assert_eq!(
            safe_join(root, &["Photos", "summer/beach.jpg"]),
            Some(PathBuf::from("/tmp/recovery/Photos/summer/beach.jpg"))
        );
        // A "." component is skipped, not rejected.
        assert_eq!(safe_join(root, &["./Docs", "a.txt"]), Some(PathBuf::from("/tmp/recovery/Docs/a.txt")));
        // Empty parts contribute nothing.
        assert_eq!(safe_join(root, &["", "file"]), Some(PathBuf::from("/tmp/recovery/file")));
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute_segments() {
        let root = Path::new("/tmp/recovery");
        // `..` in either the label or the file path must escape-guard to None.
        assert_eq!(safe_join(root, &["..", "etc/passwd"]), None);
        assert_eq!(safe_join(root, &["Photos", "../../etc/passwd"]), None);
        // An absolute file path must not replace the root (the Path::join footgun).
        assert_eq!(safe_join(root, &["Photos", "/etc/passwd"]), None);
    }

    proptest! {
        /// The security invariant, over arbitrary server-supplied label + rel
        /// path: safe_join either rejects the entry or yields a path strictly
        /// under the destination root — it can never escape.
        #[test]
        fn safe_join_never_escapes_root(label in ".*", rel in ".*") {
            let root = Path::new("/tmp/recovery-root");
            if let Some(joined) = safe_join(root, &[&label, &rel]) {
                prop_assert!(joined.starts_with(root), "safe_join escaped root: {joined:?}");
            }
        }
    }
}
