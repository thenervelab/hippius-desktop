//! Move files and folders from one drive to another.
//!
//! Every drive has its own key and the server holds none, so a move is never
//! metadata only: each file is decrypted, encrypted again under the
//! destination drive's key and uploaded as a copy staged on a server-side
//! move (`POST /v1/drive_moves`), and one commit then makes every copy a
//! file of the destination and removes every source, or changes nothing.
//! Cancel and every failure abort the move, so nothing changes.
//!
//! Either drive may be synced to a folder on this computer. The plaintext of
//! a synced source is read from its own file (no download), and once the
//! commit lands the synced folders are brought in line without a second
//! transfer; see `local` and `docs/plans/2026-11-13-move-between-drives.md`.
//!
//! The routes are behind the server's `drive_moves` capability; the picker
//! that starts a move is hidden until it is on, and the command refuses
//! without it.

pub mod api;
pub mod copy;
pub mod local;
pub mod plan;
pub mod wire;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::files::move_entries::{Existing, MoveItem, MoveItemResult, basename_of, join_path, normalize_drive_path, parent_of};
use crate::sync::identity::{DriveIdentity, rooted_path, shared_drive_browse_identity};
use crate::sync::remote_rename::{RemoteEntry, RemoteFolderTree, browse_directory, collect_folder_tree};
use crate::sync::remote_upload::{RemoteUploadProgress, UploadBatch};
use api::MoveApi;
use copy::{CHANGED_WHILE_MOVING, Sealed, StageError, StageRequest};
use hcfs_crypto::FileKey;
use local::{FileStamp, LocalFile};
use plan::{ItemSource, MovePlan, PlannedCopy, plan_move};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{info, warn};
use wire::{CommitDriveMoveRequest, CommitDriveMoveResult, CreateDriveMoveRequest, DriveRef, MoveFolder, MoveRefusal};

/// How long a move waits for a synced drive's running sync cycle before it
/// commits without bringing that drive's folder in line itself (the
/// engines then do it, by download and delete).
const DRIVE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_mins(1);

/// The cancel flags of the moves running now, by the id the webview gave.
#[derive(Default)]
pub struct DriveMoveJobs(std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DriveMoveJobs {
    fn register(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut jobs) = self.0.lock() {
            jobs.insert(job_id.to_string(), flag.clone());
        }
        flag
    }

    fn finish(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.lock() {
            jobs.remove(job_id);
        }
    }

    /// Ask a running move to stop. False when no such move is running.
    pub fn cancel(&self, job_id: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).map(|flag| flag.store(true, Ordering::SeqCst)))
            .is_some()
    }
}

/// A drive the person can move things into.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveDestination {
    /// The label every drive-scoped IPC takes (a `shared:` browse label for
    /// a shared drive not synced here).
    pub label: String,
    pub name: String,
    /// Not synced on this computer: listed from the server.
    pub remote: bool,
    /// The local folder of a synced drive, for the picker's listing.
    pub sync_path: Option<String>,
    /// Somebody else's drive, shared with this account.
    pub shared: bool,
}

/// One move, as the webview asks for it.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveMoveRequest {
    /// Names this move for `cancel_drive_move`.
    pub job_id: String,
    pub source_label: String,
    pub dest_label: String,
    /// Destination folder, relative to the destination drive; empty for its
    /// top level.
    pub destination: String,
    pub items: Vec<MoveItem>,
    /// The person has seen and accepted [`DriveMoveOutcome::confirm`].
    #[serde(default)]
    pub confirm_sharing: bool,
    /// Check only: answer the clashes and the confirmation, or `ready`,
    /// and move nothing. Lets the webview ask everything it must ask before
    /// the long part starts.
    #[serde(default)]
    pub preflight: bool,
    /// What the destination drive is called, for the widget's rows (a
    /// shared drive's label is its wire identity, not a name).
    #[serde(default)]
    pub dest_name: Option<String>,
}

/// What a move did, or what it needs before it can start.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriveMoveOutcome {
    pub results: Vec<MoveItemResult>,
    /// Set when a moved folder is shared: the sentence to confirm before
    /// moving it. Nothing was moved; send again with `confirm_sharing`.
    pub confirm: Option<String>,
    /// What the commit turned off, for the success message.
    pub revoked: Option<String>,
    /// The person cancelled. Nothing was moved.
    pub cancelled: bool,
    /// A preflight found nothing to ask: the move can start.
    pub ready: bool,
}

/// The drives this account can move things into: its own, and drives shared
/// with it as an Editor or Manager (a Viewer cannot write, and a folder
/// grant is a folder, not a drive).
#[tauri::command]
pub async fn list_move_destinations(
    state: tauri::State<'_, AppState>,
    account_id: String,
    current_label: Option<String>,
) -> Result<Vec<MoveDestination>> {
    let account_id = state.require_session_account(&account_id)?;
    let mut drives = list_move_destinations_inner(&state, &account_id).await?;
    // The drive the move starts from is not a destination, under whatever
    // label it is listed (a shared drive synced here and browsed has two).
    if let Some(current) = current_label {
        let pool = state.pool()?;
        let here = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &current).await?;
        let mut kept = Vec::with_capacity(drives.len());
        for drive in drives {
            let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &drive.label).await?;
            if identity.wire_ss58 != here.wire_ss58 || identity.wire_folder_hash != here.wire_folder_hash {
                kept.push(drive);
            }
        }
        drives = kept;
    }
    Ok(drives)
}

async fn list_move_destinations_inner(state: &AppState, account_id: &str) -> Result<Vec<MoveDestination>> {
    let pool = state.pool()?;
    let rows = crate::sync::folders::get_all_sync_paths_or_warn(pool, account_id, "list_move_destinations").await;
    let mut own = Vec::new();
    let mut member_rows: HashMap<(String, String), String> = HashMap::new();
    for row in &rows {
        if row.label == "migration" {
            continue;
        }
        let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, &row.label).await?;
        if identity.is_member {
            member_rows.insert((identity.wire_ss58, identity.wire_folder_hash), row.label.clone());
        } else {
            own.push(MoveDestination {
                label: row.label.clone(),
                name: row.label.clone(),
                remote: false,
                sync_path: Some(row.path.clone()),
                shared: false,
            });
        }
    }
    match crate::sync::folders::list_remote_folders_internal(pool, account_id).await {
        Ok(remote) => {
            for folder in remote {
                if !rows.iter().any(|r| r.label == folder.label) && folder.label != "migration" {
                    own.push(MoveDestination {
                        label: folder.label.clone(),
                        name: folder.label,
                        remote: true,
                        sync_path: None,
                        shared: false,
                    });
                }
            }
        }
        Err(e) => warn!(error = %e, "Move destinations: the server's drive list could not be read"),
    }
    own.sort_by_key(|d| d.name.to_lowercase());

    let mut shared = Vec::new();
    if let Ok(ctx) = crate::shared_drives::commands::api_ctx_for(state).await {
        match crate::shared_drives::commands::http_list_memberships(&state.api_client, ctx.base_url(), ctx.bearer()).await {
            Ok(resp) => {
                for m in resp.memberships {
                    let role = crate::shared_drives::commands::drive_role_from_wire(&m.role);
                    if m.frozen || !matches!(role.as_str(), "writer" | "manager") {
                        continue;
                    }
                    let local = member_rows.get(&(m.owner_ss58.clone(), m.folder_hash.clone()));
                    let sync_path = local.and_then(|label| rows.iter().find(|r| &r.label == label)).map(|r| r.path.clone());
                    shared.push(MoveDestination {
                        label: local.cloned().unwrap_or_else(|| format!("shared:{}~{}", m.owner_ss58, m.folder_hash)),
                        name: m.display_label,
                        remote: local.is_none(),
                        sync_path,
                        shared: true,
                    });
                }
            }
            Err(e) => tracing::debug!(error = %e, "Move destinations: no shared drives listed"),
        }
    }
    shared.sort_by_key(|d| d.name.to_lowercase());
    own.extend(shared);
    Ok(own)
}

/// Stop a running move. Its commit has not happened yet, or this returns
/// after it did; either way the move ends whole or not at all.
#[tauri::command]
pub async fn cancel_drive_move(state: tauri::State<'_, AppState>, job_id: String) -> Result<bool> {
    Ok(state.drive_moves.cancel(&job_id))
}

/// Move items from one drive to another.
///
/// Returns early, having changed nothing, when an item's name is taken in
/// the destination (`results` holds the clashes) or a moved folder is
/// shared and the person has not confirmed (`confirm`). Otherwise runs the
/// whole move and returns once it has committed, failed or been cancelled.
#[tauri::command]
pub async fn move_between_drives(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    account_id: String,
    request: DriveMoveRequest,
) -> Result<DriveMoveOutcome> {
    let account_id = state.require_session_account(&account_id)?;
    let cancel = state.drive_moves.register(&request.job_id);
    let outcome = move_between_drives_inner(&state, Some(app), &account_id, &request, &cancel).await;
    state.drive_moves.finish(&request.job_id);
    outcome
}

/// [`move_between_drives`] for the live lane, which has an `AppState` but
/// no Tauri runtime: no progress rows, and a cancel flag nobody sets.
pub async fn move_between_drives_for_tests(state: &AppState, account_id: &str, request: &DriveMoveRequest) -> Result<DriveMoveOutcome> {
    let cancel = Arc::new(AtomicBool::new(false));
    move_between_drives_inner(state, None, account_id, request, &cancel).await
}

/// One drive of a move, resolved once.
struct Side {
    label: String,
    identity: DriveIdentity,
    /// The local folder, when this drive is synced here.
    root: Option<PathBuf>,
    /// The wire path the view's paths are relative to.
    wire_root: String,
    key: FileKey,
    client: hcfs_client::client::HcfsClient,
}

async fn resolve_side(state: &AppState, account_id: &str, label: &str, mnemonic: &str) -> Result<(Side, crate::sync::remote::DriveKeyMaterial)> {
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, label).await?;
    let root = if shared_drive_browse_identity(label).is_some() {
        None
    } else {
        crate::sync::folders::get_all_sync_paths_or_warn(pool, account_id, "move_between_drives")
            .await
            .into_iter()
            .find(|row| row.label == label)
            .map(|row| PathBuf::from(row.path))
    };
    let keys = crate::sync::remote::drive_key_material_for_label(state, account_id, label, mnemonic, &identity).await?;
    let key = keys.encryption_key()?;
    let client = crate::sync::remote::build_client(pool, account_id, &identity).await?;
    Ok((
        Side {
            label: label.to_string(),
            wire_root: rooted_path(label, ""),
            identity,
            root,
            key,
            client,
        },
        keys,
    ))
}

/// The plaintext path a listed row names, as `collect_folder_tree` reads it.
fn entry_path(file: &hcfs_shared::network::RemoteFileEntry, key: &FileKey) -> Option<String> {
    file.relative_path
        .as_deref()
        .map(str::to_string)
        .filter(|p| !p.is_empty())
        .or_else(|| {
            hcfs_crypto::decrypt_small(&file.encrypted_path, key)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
        })
        .map(|p| p.replace('\\', "/").trim_matches('/').to_string())
}

/// What each item is on the source drive.
async fn read_sources(side: &Side, items: &[MoveItem]) -> Result<Vec<ItemSource>> {
    let mut parents: HashMap<String, Vec<hcfs_shared::network::RemoteFileEntry>> = HashMap::new();
    let mut sources = Vec::with_capacity(items.len());
    for item in items {
        let Ok(rel) = normalize_drive_path(&item.path) else {
            sources.push(ItemSource::Missing);
            continue;
        };
        let wire = join_path(side.wire_root.trim_matches('/'), &rel);
        if item.is_folder {
            let tree: RemoteFolderTree =
                collect_folder_tree(&side.client, &side.identity.wire_ss58, &side.identity.wire_folder_hash, &wire, &side.key).await?;
            sources.push(ItemSource::Folder(tree));
            continue;
        }
        let parent = parent_of(&wire).to_string();
        if !parents.contains_key(&parent) {
            let (_, files) = browse_directory(&side.client, &side.identity.wire_ss58, &side.identity.wire_folder_hash, &parent).await?;
            parents.insert(parent.clone(), files);
        }
        let found = parents[&parent].iter().find_map(|file| {
            (entry_path(file, &side.key).as_deref() == Some(wire.as_str())).then(|| RemoteEntry {
                path: wire.clone(),
                path_hash: file.path_hash,
                revision_id: file.revision_id,
                salted_hash: *file.salted_hash.as_bytes(),
                size_bytes: file.size_bytes,
            })
        });
        sources.push(found.map_or(ItemSource::Missing, ItemSource::File));
    }
    Ok(sources)
}

/// The names already in the destination folder, lowercased: the server's
/// listing, plus what is on disk when the drive is synced here (a file not
/// uploaded yet still takes its name).
async fn read_destination(side: &Side, destination: &str) -> Result<HashMap<String, Existing>> {
    let wire = join_path(side.wire_root.trim_matches('/'), destination);
    let (folders, files) = browse_directory(&side.client, &side.identity.wire_ss58, &side.identity.wire_folder_hash, &wire).await?;
    let mut listed: HashMap<String, Existing> = folders.into_iter().map(|n| (n.to_lowercase(), Existing::Folder)).collect();
    for file in files {
        if let Some(path) = entry_path(&file, &side.key).or(file.file_name.clone()) {
            listed.entry(plan::listed_name(&path)).or_insert(Existing::File);
        }
    }
    if let Some(root) = &side.root
        && let Ok(entries) = std::fs::read_dir(root.join(destination))
    {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let kind = if entry.file_type().is_ok_and(|t| t.is_dir()) {
                Existing::Folder
            } else {
                Existing::File
            };
            listed.entry(name).or_insert(kind);
        }
    }
    Ok(listed)
}

/// A folder of a synced source must hold nothing the server does not: a
/// file not uploaded yet would stay behind, alone, in a folder the person
/// saw move. Hidden and excluded files never upload, so they do not count.
fn unsettled_folder(root: &Path, folder_wire: &str, tree: &RemoteFolderTree) -> bool {
    let known: std::collections::HashSet<&str> = tree.files.iter().map(|f| f.path.as_str()).collect();
    let rules = hcfs_client::drive::ExcludeRules::load(&root.join(".hippius"));
    let mut stack = vec![PathBuf::from(folder_wire)];
    while let Some(rel) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&rel)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if crate::sync::files::pathops::is_engine_hidden_name(&name) {
                continue;
            }
            let Some(name) = name.to_str() else { continue };
            let child = rel.join(name);
            let Ok(kind) = entry.file_type() else { continue };
            if rules.is_excluded(&child, kind.is_dir()) || kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(child);
            } else if !known.contains(child.to_string_lossy().replace('\\', "/").as_str()) {
                return true;
            }
        }
    }
    false
}

/// The sentence confirming what moving these folders turns off, or `None`
/// when nobody else reaches them. Best effort: a listing this account may
/// not read counts as nothing, and the commit refuses (`folder_shared`)
/// whoever may not revoke others' access anyway.
async fn sharing_notice(state: &AppState, account_id: &str, source: &Side, folders: &[MoveFolder]) -> Option<String> {
    let under = |path: &str| {
        let path = path.trim_matches('/');
        folders.iter().any(|f| path == f.from || path.starts_with(&format!("{}/", f.from)))
    };
    let mut people = std::collections::BTreeSet::new();
    let mut invites = 0usize;
    if let Ok(ctx) = crate::shared_drives::commands::api_ctx_for(state).await {
        let owner = crate::shared_drives::commands::member_owner(&source.identity);
        let hash = &source.identity.wire_folder_hash;
        let (members, open) = tokio::join!(
            crate::shared_drives::commands::http_list_members(&state.api_client, ctx.base_url(), ctx.bearer(), hash, owner),
            crate::shared_drives::commands::http_list_invites(&state.api_client, ctx.base_url(), ctx.bearer(), hash, owner),
        );
        if let Ok(members) = members {
            people.extend(members.folder_grants.into_iter().filter(|g| under(&g.path_prefix)).map(|g| g.member_ss58));
        }
        if let Ok(list) = open {
            let now = chrono::Utc::now();
            invites = list
                .iter()
                .filter(|i| crate::shared_drives::access_panel::invite_is_open(i, now))
                .filter(|i| i.path_prefix.as_deref().is_some_and(|p| !p.trim_matches('/').is_empty() && under(p)))
                .count();
        }
    }
    let mut links = 0usize;
    if let Ok(pool) = state.pool()
        && let Ok(client) = crate::shares::client::build_account_client(pool, account_id).await
        && let Ok(rows) = client.list_folder_shares().await
    {
        links = rows
            .iter()
            .filter(|r| r.folder_hash == source.identity.wire_folder_hash && r.revoked_at.is_none() && under(&r.path_prefix))
            .count();
    }
    compose_sharing_notice(folders.len(), links, people.len(), invites)
}

/// "Moving it turns off its share link and removes access for 2 people."
pub(crate) fn compose_sharing_notice(folders: usize, links: usize, people: usize, invites: usize) -> Option<String> {
    let its = if folders == 1 { "its" } else { "their" };
    let mut parts = Vec::new();
    if links > 0 {
        parts.push(if links == 1 {
            format!("turns off {its} share link")
        } else {
            format!("turns off {its} {links} share links")
        });
    }
    if people > 0 {
        parts.push(if people == 1 {
            "removes access for 1 person".to_string()
        } else {
            format!("removes access for {people} people")
        });
    }
    if invites > 0 {
        parts.push(format!("cancels {its} open {}", if invites == 1 { "invite" } else { "invites" }));
    }
    if parts.is_empty() {
        return None;
    }
    let what = if folders == 1 { "it" } else { "them" };
    Some(format!("Moving {what} to another drive {}.", wire::join_clauses(&parts)))
}

/// Where a copy's plaintext comes from.
#[derive(Clone, Debug)]
pub enum Plaintext {
    /// The source drive's own file on this computer.
    Local(PathBuf),
    /// Downloaded (and verified against the source row) before sealing.
    Download,
}

/// Fetches a source file's plaintext into a path, verified against its row.
pub trait PlaintextFetcher: Send + Sync {
    fn fetch<'a>(
        &'a self,
        source: &'a plan::RemoteEntryKey,
        to: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>>;
}

/// Downloads through the source drive's client, checked against the row's
/// salted hash and revision as every one-off download is.
struct ClientFetcher<'a> {
    side: &'a Side,
}

impl PlaintextFetcher for ClientFetcher<'_> {
    fn fetch<'a>(
        &'a self,
        source: &'a plan::RemoteEntryKey,
        to: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let access = hcfs_client::drive::remote::RemoteFileAccess {
                client: &self.side.client,
                ss58_address: &self.side.identity.wire_ss58,
                folder_hash: &self.side.identity.wire_folder_hash,
                encryption_key: &self.side.key,
            };
            let expected = hcfs_client::drive::remote::ExpectedContent {
                salted_hash: hcfs_shared::salted_hash::SaltedHash::from_bytes(source.salted_hash),
                size_bytes: source.size_bytes,
                revision_id: source.revision_id,
            };
            hcfs_client::drive::remote::download_remote_file_expecting(&access, &hex::encode(source.path_hash), expected, to, None::<fn(u64, u64)>)
                .await
                .map(|_| ())
                .map_err(|e| {
                    tracing::debug!(error = %e, "drive move: source download failed");
                    AppError::Validation("Hippius couldn't read a file to move.".into())
                })
        })
    }
}

/// A copy's job: what it is and where its bytes come from.
pub struct CopyJob {
    pub copy: PlannedCopy,
    pub plaintext: Plaintext,
}

/// Progress of one copy, as the move reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyEvent {
    Encrypting,
    Sent(u64),
    Staged,
}

/// Everything staging needs, none of it from `AppState`, so the mock-server
/// tests run the real flow.
pub struct Staging<'a> {
    pub api: &'a MoveApi,
    pub source: &'a DriveIdentity,
    pub dest: &'a DriveIdentity,
    pub dest_key: &'a FileKey,
    pub dest_signing_key: &'a ed25519_dalek::SigningKey,
    pub jobs: &'a [CopyJob],
    pub fetcher: Option<&'a dyn PlaintextFetcher>,
    /// A private folder for ciphertexts and downloaded plaintexts.
    pub scratch: &'a Path,
    pub cancel: &'a Arc<AtomicBool>,
    pub progress: &'a (dyn Fn(usize, CopyEvent) + Send + Sync),
}

/// A move whose copies are all staged, waiting for its commit.
#[derive(Debug)]
pub struct StagedMove {
    pub move_id: String,
    /// One per job, in order: what the local side needs after the commit.
    pub locals: Vec<LocalFile>,
}

/// Why a move stopped. Every variant before the commit leaves nothing
/// changed (the move is aborted).
#[derive(Debug)]
pub enum MoveFailure {
    Cancelled,
    Refused(MoveRefusal),
    Changed,
    Local(AppError),
    /// The commit was sent and no answer came: it may have landed.
    Unconfirmed,
}

impl MoveFailure {
    /// What the person reads.
    pub fn sentence(&self) -> String {
        match self {
            Self::Cancelled => "The move was cancelled. Nothing was moved.".into(),
            Self::Refused(r) => format!("{} Nothing was moved.", r.sentence()),
            Self::Changed => format!("{CHANGED_WHILE_MOVING} Nothing was moved. Try again when it has synced."),
            Self::Local(AppError::Validation(sentence)) => format!("{sentence} Nothing was moved."),
            Self::Local(_) => "Hippius couldn't read a file to move. Nothing was moved.".into(),
            Self::Unconfirmed => "Hippius didn't confirm the move. Check both drives before trying again.".into(),
        }
    }
}

/// Open the move and stage a copy of every job. Aborts the move on any
/// failure and on cancel, so a failure here leaves both drives as they were.
pub async fn stage_all(s: &Staging<'_>) -> std::result::Result<StagedMove, MoveFailure> {
    if s.cancel.load(Ordering::SeqCst) {
        return Err(MoveFailure::Cancelled);
    }
    let opened = s
        .api
        .open(&CreateDriveMoveRequest {
            source: DriveRef {
                ss58_address: s.source.wire_ss58.clone(),
                folder_hash: s.source.wire_folder_hash.clone(),
            },
            dest: DriveRef {
                ss58_address: s.dest.wire_ss58.clone(),
                folder_hash: s.dest.wire_folder_hash.clone(),
            },
        })
        .await
        .map_err(MoveFailure::Refused)?;
    let move_id = opened.move_id;

    match stage_copies(s, &move_id).await {
        Ok(locals) => Ok(StagedMove { move_id, locals }),
        Err(failure) => {
            abort_quietly(s.api, &move_id).await;
            Err(failure)
        }
    }
}

async fn abort_quietly(api: &MoveApi, move_id: &str) {
    if let Err(e) = api.abort(move_id).await {
        // Expiry frees it within a day; the person is told nothing moved,
        // which is true either way.
        warn!(status = e.status, code = ?e.code, "drive move: abort was not confirmed");
    }
}

async fn stage_copies(s: &Staging<'_>, move_id: &str) -> std::result::Result<Vec<LocalFile>, MoveFailure> {
    let mut locals = Vec::with_capacity(s.jobs.len());
    for (index, job) in s.jobs.iter().enumerate() {
        if s.cancel.load(Ordering::SeqCst) {
            return Err(MoveFailure::Cancelled);
        }
        (s.progress)(index, CopyEvent::Encrypting);
        let (plaintext, source_stamp, downloaded) = match &job.plaintext {
            Plaintext::Local(path) => (path.clone(), FileStamp::of(path), None),
            Plaintext::Download => {
                let fetcher = s.fetcher.ok_or(MoveFailure::Local(AppError::Other("no fetcher".into())))?;
                let to = s.scratch.join(format!("plain-{index}"));
                fetcher.fetch(&job.copy.source, &to).await.map_err(MoveFailure::Local)?;
                (to.clone(), None, Some(to))
            }
        };
        let ciphertext = s.scratch.join(format!("cipher-{index}"));
        let sealed: Sealed = {
            let (plaintext, ciphertext, key) = (plaintext.clone(), ciphertext.clone(), s.dest_key.clone());
            let (source_salt, dest_salt) = (s.source.wire_ss58.clone(), s.dest.wire_ss58.clone());
            tokio::task::spawn_blocking(move || copy::seal(&plaintext, &ciphertext, &key, &source_salt, &dest_salt))
                .await
                .map_err(|e| MoveFailure::Local(AppError::Other(e.to_string())))?
                .map_err(|e| match e {
                    AppError::Validation(_) => MoveFailure::Changed,
                    other => MoveFailure::Local(other),
                })?
        };
        // The bytes must be the revision the commit names: a local file that
        // differs from it has changes that have not synced (or are older).
        if sealed.source_salted != job.copy.source.salted_hash {
            let _ = std::fs::remove_file(&ciphertext);
            return Err(MoveFailure::Changed);
        }
        let staged = copy::stage(
            StageRequest {
                api: s.api,
                move_id,
                dest: s.dest,
                key: s.dest_key,
                signing_key: s.dest_signing_key,
                ciphertext: &ciphertext,
                sealed: &sealed,
                dest_path: &job.copy.dest_path,
                source_path_hash: job.copy.source.path_hash,
                expected_revision_id: job.copy.source.revision_id,
                cancel: s.cancel,
            },
            |sent| (s.progress)(index, CopyEvent::Sent(sent)),
        )
        .await;
        let _ = std::fs::remove_file(&ciphertext);
        match staged {
            Ok(()) => (s.progress)(index, CopyEvent::Staged),
            Err(StageError::Cancelled) => return Err(MoveFailure::Cancelled),
            Err(StageError::Refused(r)) => return Err(MoveFailure::Refused(r)),
            Err(StageError::Local(e)) => return Err(MoveFailure::Local(e)),
        }
        locals.push(LocalFile {
            source: match &job.plaintext {
                Plaintext::Local(_) => source_stamp.map(|stamp| (job.copy.source.path.clone(), stamp)),
                Plaintext::Download => None,
            },
            downloaded,
            dest_rel: job.copy.dest_path.clone(),
        });
    }
    if s.cancel.load(Ordering::SeqCst) {
        return Err(MoveFailure::Cancelled);
    }
    Ok(locals)
}

/// Commit a staged move. A refusal aborts it (nothing changed); a commit
/// that got no answer is NOT aborted, since it may have landed.
pub async fn commit_staged(
    api: &MoveApi,
    move_id: &str,
    jobs: &[CopyJob],
    folders: &[MoveFolder],
) -> std::result::Result<CommitDriveMoveResult, MoveFailure> {
    let request = CommitDriveMoveRequest {
        files: jobs.iter().map(|j| j.copy.source.path_hash).collect(),
        folders: folders.to_vec(),
    };
    match api.commit(move_id, &request).await {
        Ok(result) => Ok(result),
        // No answer, or one that names no refusal (a proxy's 502, an
        // unreadable 200): the commit may have landed. A refusal the server
        // names changed nothing, whatever its status.
        Err(refusal) if refusal.code.is_none() && (refusal.status == 0 || refusal.status >= 500 || (200..300).contains(&refusal.status)) => {
            Err(MoveFailure::Unconfirmed)
        }
        Err(refusal) => {
            abort_quietly(api, move_id).await;
            Err(MoveFailure::Refused(refusal))
        }
    }
}

/// Deletes a folder (and everything in it) when dropped.
struct ScratchDir(PathBuf);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The widget rows of one move: one per file, labelled with the
/// destination drive, on the remote-upload feed the sync widget already
/// shows.
struct Rows {
    batch: Option<UploadBatch>,
    label: String,
    files: Vec<(String, u64)>,
}

impl Rows {
    fn emit(&self, index: usize, status: &str, sent: u64, error: Option<String>) {
        let (Some(batch), Some((path, total))) = (&self.batch, self.files.get(index)) else {
            return;
        };
        batch.emit(RemoteUploadProgress {
            batch_id: batch.id(),
            path: path.clone(),
            file_name: basename_of(path).to_string(),
            label: self.label.clone(),
            bytes_transferred: sent,
            total_bytes: *total,
            status: status.to_string(),
            error,
        });
    }

    fn all(&self, status: &str, error: Option<&str>) {
        for (index, (_, total)) in self.files.iter().enumerate() {
            let sent = if status == "completed" { *total } else { 0 };
            self.emit(index, status, sent, error.map(str::to_string));
        }
    }
}

/// A synced drive's sync lock, held while the move commits and brings its
/// folder in line.
enum DriveLock {
    /// No sync loop runs for it (paused, or not started): nothing to wait for.
    Idle,
    Held(tokio::sync::OwnedMutexGuard<hcfs_client::engine::manager::DriveManager>),
    /// A cycle held it past [`DRIVE_LOCK_WAIT`].
    Busy,
}

async fn lock_drive(state: &AppState, label: &str) -> DriveLock {
    let Some(manager) = state.sync.drive_manager(label).await else {
        return DriveLock::Idle;
    };
    match tokio::time::timeout(DRIVE_LOCK_WAIT, manager.lock_owned()).await {
        Ok(guard) => DriveLock::Held(guard),
        Err(_) => DriveLock::Busy,
    }
}

async fn move_between_drives_inner(
    state: &AppState,
    app: Option<tauri::AppHandle>,
    account_id: &str,
    request: &DriveMoveRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<DriveMoveOutcome> {
    match prepare(state, account_id, request).await? {
        Prepared::Answer(outcome) => Ok(outcome),
        Prepared::Go(ready) => execute(state, app, account_id, request, cancel, *ready).await,
    }
}

/// A move checked and planned, ready to copy.
struct Ready {
    source: Side,
    dest: Side,
    dest_keys: crate::sync::remote::DriveKeyMaterial,
    plan: MovePlan,
}

enum Prepared {
    /// Answered without moving anything: clashes, a confirmation, a
    /// preflight's `ready`, or nothing to move.
    Answer(DriveMoveOutcome),
    Go(Box<Ready>),
}

/// Everything before the first byte is copied: both drives resolved, the
/// items read, the destination listed and planned against, and every check
/// that can refuse the move made.
async fn prepare(state: &AppState, account_id: &str, request: &DriveMoveRequest) -> Result<Prepared> {
    if request.items.is_empty() {
        return Ok(Prepared::Answer(DriveMoveOutcome::default()));
    }
    if request.items.len() > 10_000 {
        return Err(AppError::Validation("Move at most 10000 items at a time".into()));
    }
    let caps = crate::shares::capabilities::fetch_capabilities(state, account_id).await?;
    if !caps.drive_moves {
        return Err(AppError::Validation("Moving between drives isn't available yet.".into()));
    }
    let destination = normalize_drive_path(&request.destination)?;
    let mnemonic = crate::sync::remote::session_mnemonic(state)?;
    let (source, _) = resolve_side(state, account_id, &request.source_label, &mnemonic).await?;
    let (dest, dest_keys) = resolve_side(state, account_id, &request.dest_label, &mnemonic).await?;
    drop(mnemonic);
    if source.identity.wire_ss58 == dest.identity.wire_ss58 && source.identity.wire_folder_hash == dest.identity.wire_folder_hash {
        return Err(AppError::Validation("That's the drive it's already in.".into()));
    }
    if crate::sync::identity::folder_grant_browse(&dest.label).is_some() {
        return Err(AppError::Validation("Pick a whole drive to move into.".into()));
    }

    let sources = read_sources(&source, &request.items).await?;
    let listed = read_destination(&dest, &destination).await?;
    let plan: MovePlan = plan_move(&request.items, &sources, &source.wire_root, &dest.wire_root, &destination, &listed);

    let mut outcome = DriveMoveOutcome::default();
    if plan.has_clashes() || plan.copies.is_empty() {
        if !plan.has_clashes()
            && let Some(refusal) = plan.over_caps()
        {
            return Err(AppError::Validation(refusal));
        }
        outcome.results = plan.settled.into_iter().map(|(_, r)| r).collect();
        return Ok(Prepared::Answer(outcome));
    }
    if let Some(refusal) = plan.over_caps() {
        return Err(AppError::Validation(refusal));
    }
    if let Some(root) = &source.root {
        for (item, src) in request.items.iter().zip(&sources) {
            if let ItemSource::Folder(tree) = src
                && let Ok(rel) = normalize_drive_path(&item.path)
                && plan.folders.iter().any(|f| f.from == rel)
                && unsettled_folder(root, &rel, tree)
            {
                return Err(AppError::Validation(format!(
                    "\"{}\" has changes that are still syncing. Try again when sync finishes.",
                    basename_of(&rel)
                )));
            }
        }
    }
    if !request.confirm_sharing
        && !plan.folders.is_empty()
        && let Some(notice) = sharing_notice(state, account_id, &source, &plan.folders).await
    {
        outcome.confirm = Some(notice);
        return Ok(Prepared::Answer(outcome));
    }

    // A move is an upload into the destination: gated the way every Drive
    // write is, on the destination owner's room, never on credits.
    crate::billing::eligibility::require_eligible_for_drive(
        state,
        account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FileUpload,
        plan.total_bytes(),
        Some(&dest.identity),
    )
    .await?;
    if request.preflight {
        outcome.ready = true;
        return Ok(Prepared::Answer(outcome));
    }
    Ok(Prepared::Go(Box::new(Ready {
        source,
        dest,
        dest_keys,
        plan,
    })))
}

/// The copies, the commit, and the local side.
async fn execute(
    state: &AppState,
    app: Option<tauri::AppHandle>,
    account_id: &str,
    request: &DriveMoveRequest,
    cancel: &Arc<AtomicBool>,
    ready: Ready,
) -> Result<DriveMoveOutcome> {
    let Ready {
        source,
        dest,
        dest_keys,
        plan,
    } = ready;
    let jobs: Vec<CopyJob> = plan
        .copies
        .iter()
        .map(|copy| {
            // A synced source's own file, read in place: the seal checks its
            // bytes are the revision the commit names.
            let local = source
                .root
                .as_ref()
                .filter(|_| crate::sync::identity::folder_grant_browse(&source.label).is_none())
                .map(|root| root.join(&copy.source.path))
                .filter(|path| path.symlink_metadata().is_ok_and(|m| m.is_file()));
            CopyJob {
                copy: copy.clone(),
                plaintext: local.map_or(Plaintext::Download, Plaintext::Local),
            }
        })
        .collect();

    let rows = Rows {
        batch: app.map(UploadBatch::new),
        label: request.dest_name.clone().unwrap_or_else(|| request.dest_label.clone()),
        files: jobs.iter().map(|j| (j.copy.dest_path.clone(), j.copy.source.size_bytes)).collect(),
    };
    rows.all("pending", None);

    let scratch = ScratchDir(crate::sync::remote::preview_cache_root_dir()?.join(format!("move-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&scratch.0)?;
    let api = move_api(state, state.pool()?, account_id).await?;
    let signing_key = dest_keys.signing_key()?;
    let progress = |index: usize, event: CopyEvent| match event {
        CopyEvent::Encrypting => rows.emit(index, "encrypting", 0, None),
        CopyEvent::Sent(sent) => rows.emit(index, "inProgress", sent, None),
        CopyEvent::Staged => rows.emit(index, "inProgress", rows.files[index].1, None),
    };
    let fetcher = ClientFetcher { side: &source };
    let staging = Staging {
        api: &api,
        source: &source.identity,
        dest: &dest.identity,
        dest_key: &dest.key,
        dest_signing_key: &signing_key,
        jobs: &jobs,
        fetcher: Some(&fetcher),
        scratch: &scratch.0,
        cancel,
        progress: &progress,
    };
    info!(files = jobs.len(), folders = plan.folders.len(), "Moving between drives");
    let staged = match stage_all(&staging).await {
        Ok(staged) => staged,
        Err(failure) => return finish_failed(&rows, failure),
    };

    // Hold the synced drives' sync locks across the commit and the local
    // side, so no cycle plans against a folder that is half way there.
    let mut locks = Vec::new();
    let mut labels: Vec<&str> = [(&source.root, source.label.as_str()), (&dest.root, dest.label.as_str())]
        .into_iter()
        .filter(|(root, _)| root.is_some())
        .map(|(_, label)| label)
        .collect();
    labels.sort_unstable();
    for label in labels {
        locks.push((label.to_string(), lock_drive(state, label).await));
    }

    let committed = match commit_staged(&api, &staged.move_id, &jobs, &plan.folders).await {
        Ok(result) => result,
        Err(failure) => return finish_failed(&rows, failure),
    };
    rows.all("completed", None);
    if source.root.is_some() || dest.root.is_some() {
        bring_in_line(&source, &dest, &locks, staged.locals, &plan.folders).await;
        drop(locks);
        let _ = hcfs_client::engine::runner::trigger_sync(&state.sync).await;
    }

    let mut results: Vec<(usize, MoveItemResult)> = plan.settled;
    results.extend(
        plan.going
            .iter()
            .map(|g| (g.index, MoveItemResult::moved(&request.items[g.index], g.new_view_path.clone(), false))),
    );
    results.sort_by_key(|(index, _)| *index);
    Ok(DriveMoveOutcome {
        results: results.into_iter().map(|(_, r)| r).collect(),
        revoked: committed.revoked.notice(),
        ..DriveMoveOutcome::default()
    })
}

/// After the commit, with the synced drives' locks held: do on disk what
/// their engines would do (see `local`). Skipped whole when a running cycle
/// held a lock past the wait: the engines then do it, by download and delete.
async fn bring_in_line(source: &Side, dest: &Side, locks: &[(String, DriveLock)], locals: Vec<LocalFile>, folders: &[MoveFolder]) {
    if locks.iter().any(|(_, lock)| matches!(lock, DriveLock::Busy)) {
        info!("Drive move: a sync cycle was running; the engines will bring the folders in line");
        return;
    }
    let (source_root, dest_root) = (source.root.clone(), dest.root.clone());
    let folders: Vec<String> = folders.iter().map(|f| f.from.clone()).collect();
    let report = tokio::task::spawn_blocking(move || local::place_after_commit(source_root.as_deref(), dest_root.as_deref(), &locals, &folders))
        .await
        .unwrap_or_default();
    info!(
        placed = report.placed,
        removed = report.removed,
        left = report.left,
        "Drive move: local folders brought in line"
    );
    crate::sync::files::invalidate_dir_stats_after_cycle(1, 0);
    // A move that emptied a synced drive on the server would otherwise ask
    // "Drive empty on Hippius?" on its next cycle; the person just did it.
    if source.root.is_some()
        && let Some((_, DriveLock::Held(manager))) = locks.iter().find(|(label, _)| label == &source.label)
        && let Ok(page) = source
            .client
            .get_state(&source.identity.wire_ss58, &source.identity.wire_folder_hash, 0, 1, None)
            .await
        && page.files.is_empty()
        && !page.has_more
        && let Err(e) = manager.confirm_empty_remote()
    {
        warn!(error = %e, "Drive move: could not record that the source drive was emptied on purpose");
    }
}

/// Settle the widget rows and turn a failure into the command's answer: a
/// cancel is an outcome, everything else an error in Rust's words.
fn finish_failed(rows: &Rows, failure: MoveFailure) -> Result<DriveMoveOutcome> {
    if let MoveFailure::Cancelled = failure {
        rows.all("cancelled", None);
        return Ok(DriveMoveOutcome {
            cancelled: true,
            ..DriveMoveOutcome::default()
        });
    }
    let sentence = failure.sentence();
    warn!(failure = ?failure, "Drive move did not complete");
    rows.all("error", Some(&sentence));
    Err(AppError::Validation(sentence))
}

/// The move's HTTP context: one concrete base URL for every call of it.
async fn move_api(state: &AppState, pool: &sqlx::SqlitePool, account_id: &str) -> Result<MoveApi> {
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let bearer = crate::auth::tokens::get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    Ok(MoveApi {
        http: state.api_client.clone(),
        base_url: crate::sync::region::resolve_base_url(&server_url).to_string(),
        bearer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sharing_notice_names_what_is_turned_off() {
        assert_eq!(compose_sharing_notice(1, 0, 0, 0), None);
        assert_eq!(
            compose_sharing_notice(1, 1, 2, 0).as_deref(),
            Some("Moving it to another drive turns off its share link and removes access for 2 people.")
        );
        assert_eq!(
            compose_sharing_notice(2, 3, 1, 1).as_deref(),
            Some("Moving them to another drive turns off their 3 share links, removes access for 1 person and cancels their open invite.")
        );
    }

    #[test]
    fn cancel_reaches_only_a_running_move() {
        let jobs = DriveMoveJobs::default();
        assert!(!jobs.cancel("nope"));
        let flag = jobs.register("a");
        assert!(jobs.cancel("a"));
        assert!(flag.load(Ordering::SeqCst));
        jobs.finish("a");
        assert!(!jobs.cancel("a"));
    }

    #[test]
    fn a_local_source_with_unsynced_files_is_unsettled() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("F/sub")).unwrap();
        std::fs::write(root.path().join("F/a.txt"), "a").unwrap();
        std::fs::write(root.path().join("F/.DS_Store"), "x").unwrap();
        let tree = RemoteFolderTree {
            directory_paths: vec!["F".into()],
            files: vec![RemoteEntry {
                path: "F/a.txt".into(),
                path_hash: [0; 32],
                revision_id: [0; 32],
                salted_hash: [0; 32],
                size_bytes: 1,
            }],
        };
        assert!(!unsettled_folder(root.path(), "F", &tree), "hidden files never upload");
        std::fs::write(root.path().join("F/sub/new.txt"), "n").unwrap();
        assert!(unsettled_folder(root.path(), "F", &tree));
        std::fs::create_dir_all(root.path().join(".hippius")).unwrap();
        std::fs::write(root.path().join(".hippius/exclude"), "new.txt\n").unwrap();
        assert!(!unsettled_folder(root.path(), "F", &tree), "an excluded file never uploads");
    }
}
