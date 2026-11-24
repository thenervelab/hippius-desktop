//! Starred: star and unstar files, folders and whole drives (hcfs-server
//! favorites), and list everything the account starred.
//!
//! A star is per account and lives on the server. It names a file by its
//! `path_hash`, a folder by its path from the drive root, and a drive by the
//! empty path, always in the drive OWNER's namespace (`owner_ss58` +
//! `folder_hash`), so a star in somebody's shared drive is addressed with
//! their address, not this account's. A folder grant's "drive" is its
//! granted folder.
//!
//! The webview names an item the way its row knows it (a label plus a file
//! id or a path relative to what the label shows); [`resolve_target`] turns
//! that into the server's terms, and every answer carries the item's key
//! ([`wire::star_key`]), the string the webview keys its star state by.
//!
//! `list_starred` reads every page of `GET /favorites` and places each item
//! for the Starred page ([`place`]): which drive it is in, what that drive is
//! called, and which label and folder the Drive page opens it with.

pub mod api;
pub mod wire;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::{DriveIdentity, folder_grant_browse, resolve_drive_identity_or_own, rooted_path};
use api::{FavoritesApi, Listing};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{info, warn};
use wire::{FavoritesPage, StarItem, failure_sentence, is_folder_hash, normalize_file_id, normalize_path, star_key};

/// Stars sent at once by `set_stars`.
const BATCH_CONCURRENCY: usize = 4;

/// What one star names, as the webview says it.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StarKind {
    File,
    Folder,
    Drive,
}

/// One item to star or unstar, named the way its row knows it.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StarTarget {
    pub kind: StarKind,
    /// For the error sentence.
    pub name: String,
    /// The label the row was listed under (a drive label, or a `shared:` /
    /// `grant:` browse label). Unused when the identity is given.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub owner_ss58: Option<String>,
    #[serde(default)]
    pub folder_hash: Option<String>,
    #[serde(default)]
    pub file_id: Option<String>,
    /// A folder: relative to what `label` shows, or to the drive root when
    /// the identity is given.
    #[serde(default)]
    pub path: Option<String>,
}

/// A target in the server's terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStar {
    pub owner: String,
    pub folder_hash: String,
    pub item: StarItem,
}

impl ResolvedStar {
    pub fn key(&self) -> String {
        star_key(&self.owner, &self.folder_hash, &self.item)
    }
}

/// One item's star after the call.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarResult {
    pub key: String,
    pub favorite: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarFailure {
    pub name: String,
    pub key: Option<String>,
    pub error: String,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarBatchResult {
    pub done: Vec<StarResult>,
    pub failed: Vec<StarFailure>,
    /// At least one item was refused because the account holds 1,000 stars.
    pub full: bool,
}

/// What a label resolves to, for the webview's star keys.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarScope {
    pub owner_ss58: String,
    pub folder_hash: String,
    /// The granted folder of a `grant:` label, else "".
    pub root_path: String,
}

/// Turn a webview target into the server's terms. `Err` holds nothing: the
/// caller words the failure, since it knows whether this was a star or an
/// unstar.
///
/// The identity comes from the target when it names both halves (the
/// Starred page's rows), else from the label, through the same lenient
/// resolver the Drive page browses with (a `shared:`/`grant:` label carries
/// its owner, a synced member drive's row names its owner, anything else is
/// this account's own drive). A path is made drive-root relative with
/// [`rooted_path`], so a folder in a granted folder is named by its full
/// path, and a grant's "drive" is the granted folder itself.
pub fn resolve_with<F>(target: &StarTarget, identity_of: F) -> Option<ResolvedStar>
where
    F: FnOnce(&str) -> Option<DriveIdentity>,
{
    let explicit = match (non_blank(target.owner_ss58.as_ref()), non_blank(target.folder_hash.as_ref())) {
        (Some(owner), Some(hash)) => Some((owner.to_string(), hash.to_string())),
        (None, None) => None,
        // Half an identity would fall back to this account's namespace.
        _ => return None,
    };
    let (owner, folder_hash, label) = if let Some((owner, hash)) = explicit {
        (owner, hash, None)
    } else {
        let label = non_blank(target.label.as_ref())?;
        let identity = identity_of(label)?;
        (identity.wire_ss58, identity.wire_folder_hash, Some(label))
    };
    if owner.is_empty() || owner.contains('/') || !is_folder_hash(&folder_hash) {
        return None;
    }
    let rooted = |rel: &str| -> Option<String> {
        let rel = normalize_path(rel)?;
        normalize_path(&match label {
            Some(label) => rooted_path(label, &rel),
            None => rel,
        })
    };
    let item = match target.kind {
        StarKind::File => StarItem::File(normalize_file_id(target.file_id.as_deref()?)?),
        StarKind::Folder => {
            let path = rooted(target.path.as_deref().unwrap_or(""))?;
            // An empty folder path would be the drive: refuse rather than
            // star something the row did not show.
            if path.is_empty() {
                return None;
            }
            StarItem::Path(path)
        }
        StarKind::Drive => StarItem::Path(rooted("")?),
    };
    Some(ResolvedStar { owner, folder_hash, item })
}

fn non_blank(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).map(str::trim).filter(|v| !v.is_empty())
}

/// [`resolve_with`] against this account's drives.
async fn resolve_target(state: &AppState, account_id: &str, target: &StarTarget) -> Option<ResolvedStar> {
    let label = non_blank(target.label.as_ref()).map(str::to_string);
    let identity = match (
        &label,
        non_blank(target.owner_ss58.as_ref()).is_some() || non_blank(target.folder_hash.as_ref()).is_some(),
    ) {
        (Some(label), false) => {
            let pool = state.pool().ok()?;
            resolve_drive_identity_or_own(pool, account_id, label).await.ok()
        }
        _ => None,
    };
    resolve_with(target, move |_| identity)
}

/// The favorites calls' HTTP context: the HCFS server the Drive page browses.
async fn favorites_api(state: &AppState, account_id: &str) -> Result<FavoritesApi> {
    let pool = state.pool()?;
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let bearer = crate::auth::tokens::get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    Ok(FavoritesApi {
        http: state.api_client.clone(),
        base_url: crate::sync::region::resolve_base_url(&server_url).to_string(),
        bearer,
    })
}

/// Star one resolved item, words the failure.
pub async fn set_one(api: &FavoritesApi, resolved: &ResolvedStar, name: &str, favorite: bool) -> std::result::Result<StarResult, (String, bool)> {
    match api.set(&resolved.owner, &resolved.folder_hash, &resolved.item, favorite).await {
        Ok(now) => Ok(StarResult {
            key: resolved.key(),
            favorite: now,
        }),
        Err(refusal) => {
            warn!(status = refusal.status, code = ?refusal.code, favorite, "Starred: the server refused a star");
            Err((failure_sentence(Some(&refusal), name, favorite), favorite && refusal.is_full()))
        }
    }
}

/// Star (`favorite: true`) or unstar one item.
///
/// # Errors
///
/// `Validation` with the sentence to show: the 1,000-star cap, or
/// "Couldn't star "name". Try again." for anything else.
#[tauri::command]
pub async fn set_star(state: tauri::State<'_, AppState>, account_id: String, target: StarTarget, favorite: bool) -> Result<StarResult> {
    let account_id = state.require_session_account(&account_id)?;
    let Some(resolved) = resolve_target(&state, &account_id, &target).await else {
        return Err(AppError::Validation(failure_sentence(None, &target.name, favorite)));
    };
    let api = favorites_api(&state, &account_id).await?;
    set_one(&api, &resolved, &target.name, favorite)
        .await
        .map_err(|(sentence, _)| AppError::Validation(sentence))
}

/// Star or unstar many items, [`BATCH_CONCURRENCY`] at a time, one answer.
#[tauri::command]
pub async fn set_stars(state: tauri::State<'_, AppState>, account_id: String, targets: Vec<StarTarget>, favorite: bool) -> Result<StarBatchResult> {
    let account_id = state.require_session_account(&account_id)?;
    let api = favorites_api(&state, &account_id).await?;
    let mut resolved = Vec::with_capacity(targets.len());
    for target in &targets {
        resolved.push(resolve_target(&state, &account_id, target).await);
    }
    let result = set_many(&api, &targets, &resolved, favorite).await;
    info!(
        done = result.done.len(),
        failed = result.failed.len(),
        favorite,
        "Starred: batch finished"
    );
    Ok(result)
}

/// The batch half of [`set_stars`], for the mock-server tests.
pub async fn set_many(api: &FavoritesApi, targets: &[StarTarget], resolved: &[Option<ResolvedStar>], favorite: bool) -> StarBatchResult {
    // Owned tasks behind a fair semaphore rather than a borrowing stream:
    // a `buffered` stream of borrowing closures is not provably `Send` for
    // every lifetime, which a command's future must be.
    let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(BATCH_CONCURRENCY));
    let handles: Vec<_> = targets
        .iter()
        .zip(resolved)
        .map(|(target, resolved)| {
            let (api, gate, name, resolved) = (api.clone(), gate.clone(), target.name.clone(), resolved.clone());
            tokio::spawn(async move {
                let _permit = gate.acquire_owned().await.ok();
                match resolved {
                    Some(r) => set_one(&api, &r, &name, favorite).await,
                    None => Err((failure_sentence(None, &name, favorite), false)),
                }
            })
        })
        .collect();
    let mut answers = Vec::with_capacity(handles.len());
    for (index, handle) in handles.into_iter().enumerate() {
        let answer = handle
            .await
            .unwrap_or_else(|_| Err((failure_sentence(None, &targets[index].name, favorite), false)));
        answers.push((index, answer));
    }
    let mut result = StarBatchResult::default();
    for (index, answer) in answers {
        match answer {
            Ok(done) => result.done.push(done),
            Err((error, full)) => {
                result.full |= full;
                result.failed.push(StarFailure {
                    name: targets[index].name.clone(),
                    key: resolved[index].as_ref().map(ResolvedStar::key),
                    error,
                });
            }
        }
    }
    result
}

/// The drive identity behind each label the webview has on screen, for its
/// star keys. A label that does not resolve is left out.
#[tauri::command]
pub async fn star_scopes(state: tauri::State<'_, AppState>, account_id: String, labels: Vec<String>) -> Result<HashMap<String, StarScope>> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let mut scopes = HashMap::new();
    for label in labels {
        if label.trim().is_empty() || scopes.contains_key(&label) {
            continue;
        }
        let identity = match folder_grant_browse(&label) {
            Some((identity, _)) => Some(identity),
            None => resolve_drive_identity_or_own(pool, &account_id, &label).await.ok(),
        };
        if let Some(identity) = identity {
            scopes.insert(
                label.clone(),
                StarScope {
                    owner_ss58: identity.wire_ss58,
                    folder_hash: identity.wire_folder_hash,
                    root_path: rooted_path(&label, ""),
                },
            );
        }
    }
    Ok(scopes)
}

// ---------------------------------------------------------------------------
// The Starred list
// ---------------------------------------------------------------------------

/// What the Starred page needs about one item.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarredItem {
    pub key: String,
    /// `drive`, `folder` or `file`.
    pub kind: &'static str,
    pub owner_ss58: String,
    pub folder_hash: String,
    pub name: String,
    /// Drive-root relative: "" for a drive, a folder's path, a file's path
    /// ("" for a file with none).
    pub path: String,
    pub file_id: Option<String>,
    pub size: Option<u64>,
    /// Unix seconds; `None` when the server has no date.
    pub created_at: Option<i64>,
    pub file_count: Option<u64>,
    pub is_own: bool,
    pub drive_name: String,
    /// "Drive" or "Drive / A / B". Empty for a drive.
    pub location: String,
    pub open_label: String,
    pub open_remote: bool,
    pub open_name: Option<String>,
    /// Relative to `open_label`'s root: a folder's own path, a file's parent
    /// folder, "" for a drive. `None` when there is no folder to open.
    pub open_path: Option<String>,
    pub uploaded_by: Option<String>,
    pub uploaded_by_name: Option<String>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StarredListing {
    pub available: bool,
    pub items: Vec<StarredItem>,
}

/// What this account's drives are called and how the Drive page opens them.
#[derive(Debug, Default, Clone)]
pub struct DriveDirectory {
    pub account_id: String,
    /// Own drives by folder hash: label, and whether it is synced here.
    pub own: HashMap<String, (String, bool)>,
    /// Whole drives shared with this account, by `(owner, folder_hash)`:
    /// the owner's label and the local label when it is synced here.
    pub shared: HashMap<(String, String), (String, Option<String>)>,
    /// Folder grants: owner, folder hash, granted folder, drive label.
    pub grants: Vec<(String, String, String, String)>,
}

/// Where one item of the Starred list lives, for showing and opening it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub drive_name: String,
    pub open_label: String,
    pub open_remote: bool,
    pub open_name: Option<String>,
    /// The folder `open_label` is rooted at (a grant's folder), else "".
    pub root: String,
    pub is_own: bool,
}

/// Place an item at drive-root path `path` of `(owner, folder_hash)`.
/// `drive_label` is the label the listing itself gave, when it gave one (a
/// starred drive's entry).
pub fn place(dir: &DriveDirectory, owner: &str, folder_hash: &str, path: &str, drive_label: Option<&str>) -> Placement {
    let fallback_name = drive_label.filter(|l| !l.is_empty()).unwrap_or(folder_hash).to_string();
    if owner == dir.account_id {
        let (label, synced) = dir.own.get(folder_hash).cloned().unwrap_or((fallback_name, false));
        return Placement {
            drive_name: label.clone(),
            open_label: label,
            open_remote: !synced,
            open_name: None,
            root: String::new(),
            is_own: true,
        };
    }
    if let Some((name, local)) = dir.shared.get(&(owner.to_string(), folder_hash.to_string())) {
        return match local {
            Some(local) => Placement {
                drive_name: name.clone(),
                open_label: local.clone(),
                open_remote: false,
                open_name: None,
                root: String::new(),
                is_own: false,
            },
            None => Placement {
                drive_name: name.clone(),
                open_label: shared_browse_label(owner, folder_hash),
                open_remote: true,
                open_name: Some(name.clone()),
                root: String::new(),
                is_own: false,
            },
        };
    }
    // A folder grant that covers the item; the deepest one wins.
    let grant = dir
        .grants
        .iter()
        .filter(|(o, h, prefix, _)| o == owner && h == folder_hash && is_within(path, prefix))
        .max_by_key(|(_, _, prefix, _)| prefix.len());
    if let Some((_, _, prefix, drive_name)) = grant {
        return Placement {
            drive_name: drive_name.clone(),
            open_label: format!("grant:{owner}~{folder_hash}~{}", hex::encode(prefix.as_bytes())),
            open_remote: true,
            open_name: Some(basename(prefix).to_string()),
            root: prefix.clone(),
            is_own: false,
        };
    }
    Placement {
        drive_name: fallback_name.clone(),
        open_label: shared_browse_label(owner, folder_hash),
        open_remote: true,
        open_name: Some(fallback_name),
        root: String::new(),
        is_own: false,
    }
}

/// The browse label of a shared drive not synced here; mirrors
/// `makeSharedDriveLabel` and `identity::shared_drive_browse_identity`.
fn shared_browse_label(owner: &str, folder_hash: &str) -> String {
    format!("shared:{owner}~{folder_hash}")
}

fn is_within(path: &str, prefix: &str) -> bool {
    path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}

/// `path` relative to `root`, or `None` when it is outside.
fn relative_to<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    if root.is_empty() {
        return Some(path);
    }
    if path == root {
        return Some("");
    }
    path.strip_prefix(root).and_then(|rest| rest.strip_prefix('/'))
}

/// "Drive / A / B" for the folders above an item.
fn location(drive_name: &str, parent_path: &str) -> String {
    if parent_path.is_empty() {
        return drive_name.to_string();
    }
    let mut out = drive_name.to_string();
    for part in parent_path.split('/').filter(|p| !p.is_empty()) {
        out.push_str(" / ");
        out.push_str(part);
    }
    out
}

/// Every page's items, placed: drives, then folders, then files, each in
/// the server's order, with no item twice.
pub fn build_items(dir: &DriveDirectory, pages: &[FavoritesPage]) -> Vec<StarredItem> {
    let mut drives = Vec::new();
    let mut folders = Vec::new();
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let positive = |t: Option<i64>| t.filter(|t| *t > 0);
    for page in pages {
        for d in &page.drives {
            let key = star_key(&d.owner_ss58, &d.folder_hash, &StarItem::Path(String::new()));
            if !seen.insert(key.clone()) {
                continue;
            }
            let at = place(dir, &d.owner_ss58, &d.folder_hash, "", Some(&d.label));
            drives.push(StarredItem {
                key,
                kind: "drive",
                owner_ss58: d.owner_ss58.clone(),
                folder_hash: d.folder_hash.clone(),
                name: at.drive_name.clone(),
                path: String::new(),
                file_id: None,
                size: Some(d.total_bytes),
                created_at: positive(d.created_at),
                file_count: Some(d.file_count),
                is_own: at.is_own,
                drive_name: at.drive_name,
                location: String::new(),
                open_label: at.open_label,
                open_remote: at.open_remote,
                open_name: at.open_name,
                open_path: Some(String::new()),
                uploaded_by: None,
                uploaded_by_name: None,
            });
        }
        for f in &page.folders {
            let Some(path) = normalize_path(&f.path).filter(|p| !p.is_empty()) else {
                continue;
            };
            let key = star_key(&f.owner_ss58, &f.folder_hash, &StarItem::Path(path.clone()));
            if !seen.insert(key.clone()) {
                continue;
            }
            let at = place(dir, &f.owner_ss58, &f.folder_hash, &path, None);
            let name = if f.name.trim().is_empty() {
                basename(&path).to_string()
            } else {
                f.name.clone()
            };
            folders.push(StarredItem {
                key,
                kind: "folder",
                owner_ss58: f.owner_ss58.clone(),
                folder_hash: f.folder_hash.clone(),
                name,
                location: location(&at.drive_name, parent(&path)),
                open_path: relative_to(&path, &at.root).map(str::to_string),
                path,
                file_id: None,
                size: Some(f.total_bytes),
                created_at: positive(f.created_at),
                file_count: Some(f.file_count),
                is_own: at.is_own,
                drive_name: at.drive_name,
                open_label: at.open_label,
                open_remote: at.open_remote,
                open_name: at.open_name,
                uploaded_by: None,
                uploaded_by_name: None,
            });
        }
        for f in &page.files {
            let Some(id) = f.id() else {
                continue;
            };
            let key = star_key(&f.owner_ss58, &f.folder_hash, &StarItem::File(id.clone()));
            if !seen.insert(key.clone()) {
                continue;
            }
            files.push(file_item(dir, f, id, key));
        }
    }
    drives.extend(folders);
    drives.extend(files);
    drives
}

/// A starred file as the Starred page shows it.
fn file_item(dir: &DriveDirectory, f: &wire::FavoriteFile, id: String, key: String) -> StarredItem {
    let path = f.relative_path.as_deref().and_then(normalize_path).unwrap_or_default();
    let at = place(dir, &f.owner_ss58, &f.folder_hash, &path, None);
    let name = f
        .file_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| (!path.is_empty()).then(|| basename(&path).to_string()))
        .unwrap_or_else(|| id.clone());
    // A file with no path has no folder to open; nor has one outside the
    // grant it is listed through.
    let open_path = (!path.is_empty())
        .then(|| relative_to(parent(&path), &at.root).map(str::to_string))
        .flatten();
    StarredItem {
        key,
        kind: "file",
        owner_ss58: f.owner_ss58.clone(),
        folder_hash: f.folder_hash.clone(),
        name,
        location: location(&at.drive_name, parent(&path)),
        path,
        file_id: Some(id),
        size: Some(f.size_bytes),
        created_at: Some(f.created_at).filter(|t| *t > 0),
        file_count: None,
        is_own: at.is_own,
        drive_name: at.drive_name,
        open_label: at.open_label,
        open_remote: at.open_remote,
        open_name: at.open_name,
        open_path,
        uploaded_by: f.uploaded_by.clone().filter(|s| !s.is_empty()),
        uploaded_by_name: f.uploaded_by_name.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    }
}

/// What this account's drives are called, best effort: a part that cannot
/// be read leaves its drives named by the listing (or their hash).
async fn drive_directory(state: &AppState, account_id: &str) -> DriveDirectory {
    let mut dir = DriveDirectory {
        account_id: account_id.to_string(),
        ..DriveDirectory::default()
    };
    let Ok(pool) = state.pool() else {
        return dir;
    };
    let rows = crate::sync::folders::get_all_sync_paths_or_warn(pool, account_id, "list_starred").await;
    let mut member_rows: HashMap<(String, String), String> = HashMap::new();
    for row in &rows {
        match crate::sync::identity::lookup_drive_identity(pool, account_id, &row.label).await {
            Ok(Some(identity)) if identity.is_member => {
                member_rows.insert((identity.wire_ss58, identity.wire_folder_hash), row.label.clone());
            }
            Ok(Some(identity)) => {
                dir.own.insert(identity.wire_folder_hash, (row.label.clone(), true));
            }
            _ => {}
        }
    }
    match crate::sync::folders::list_remote_folders_internal(pool, account_id).await {
        Ok(remote) => {
            for folder in remote {
                dir.own.entry(folder.folder_hash).or_insert((folder.label, false));
            }
        }
        Err(e) => warn!(error = %e, "Starred: the server's drive list could not be read"),
    }
    if let Ok(ctx) = crate::shared_drives::commands::api_ctx_for(state).await {
        match crate::shared_drives::commands::http_list_memberships(&state.api_client, ctx.base_url(), ctx.bearer()).await {
            Ok(resp) => {
                for m in resp.memberships {
                    let local = member_rows.get(&(m.owner_ss58.clone(), m.folder_hash.clone())).cloned();
                    dir.shared.insert((m.owner_ss58, m.folder_hash), (m.display_label, local));
                }
                for g in resp.folder_grants {
                    if let Ok(prefix) = crate::shared_drives::folder_grant_path::folder_grant_path_prefix(&g.path_prefix) {
                        dir.grants.push((g.owner_ss58, g.folder_hash, prefix, g.display_label));
                    }
                }
            }
            Err(e) => tracing::debug!(error = %e, "Starred: no shared drives listed"),
        }
    }
    dir
}

/// Everything this account starred, placed for the Starred page, which sorts
/// and searches the whole list itself until the server can search it
/// (hcfs#1452).
///
/// # Errors
///
/// `Validation("Couldn't load Starred.")` when the server cannot be read; an
/// older server's `404` is `available: false` instead.
#[tauri::command]
pub async fn list_starred(state: tauri::State<'_, AppState>, account_id: String) -> Result<StarredListing> {
    let account_id = state.require_session_account(&account_id)?;
    let api = favorites_api(&state, &account_id).await?;
    let pages = match api.list_all(&account_id).await {
        Ok(Listing::Pages(pages)) => pages,
        Ok(Listing::Unavailable) => return Ok(StarredListing::default()),
        Err(refusal) => {
            warn!(status = refusal.status, code = ?refusal.code, "Starred: the list could not be read");
            return Err(AppError::Validation("Couldn't load Starred.".into()));
        }
    };
    let dir = drive_directory(&state, &account_id).await;
    let items = build_items(&dir, &pages);
    Ok(StarredListing { available: true, items })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "5Me";
    const OTHER: &str = "5Other";
    const HASH: &str = "0123456789abcdef";
    const HASH2: &str = "fedcba9876543210";

    fn target(kind: StarKind) -> StarTarget {
        StarTarget {
            kind,
            name: "x".into(),
            label: None,
            owner_ss58: None,
            folder_hash: None,
            file_id: None,
            path: None,
        }
    }

    fn own(label: &str) -> Option<DriveIdentity> {
        let _ = label;
        Some(DriveIdentity::own(ME, HASH))
    }

    #[test]
    fn a_row_resolves_by_its_label_and_a_grant_label_roots_the_path() {
        let id = "AB".repeat(32);
        let file = StarTarget {
            label: Some("Docs".into()),
            file_id: Some(id),
            ..target(StarKind::File)
        };
        let r = resolve_with(&file, own).expect("resolves");
        assert_eq!(r.key(), format!("{ME}|{HASH}|f:{}", "ab".repeat(32)));

        let folder = StarTarget {
            label: Some("Docs".into()),
            path: Some("/Work/2026/".into()),
            ..target(StarKind::Folder)
        };
        assert_eq!(resolve_with(&folder, own).unwrap().item, StarItem::Path("Work/2026".into()));

        let drive = StarTarget {
            label: Some("Docs".into()),
            ..target(StarKind::Drive)
        };
        assert_eq!(resolve_with(&drive, own).unwrap().key(), format!("{ME}|{HASH}|drive"));

        // A folder grant: the label carries the owner and the granted folder.
        let grant = format!("grant:{OTHER}~{HASH2}~{}", hex::encode("Team/Q1"));
        let identity = crate::sync::identity::shared_drive_browse_identity(&grant);
        let in_grant = StarTarget {
            label: Some(grant.clone()),
            path: Some("Notes".into()),
            ..target(StarKind::Folder)
        };
        let r = resolve_with(&in_grant, |_| identity.clone()).unwrap();
        assert_eq!((r.owner.as_str(), r.folder_hash.as_str()), (OTHER, HASH2));
        assert_eq!(r.item, StarItem::Path("Team/Q1/Notes".into()));
        let grant_drive = StarTarget {
            label: Some(grant),
            ..target(StarKind::Drive)
        };
        let r = resolve_with(&grant_drive, |_| identity.clone()).unwrap();
        assert_eq!(r.key(), format!("{OTHER}|{HASH2}|d:Team/Q1"), "a grant's drive is its granted folder");
    }

    #[test]
    fn an_explicit_identity_wins_and_half_of_one_is_refused() {
        let explicit = StarTarget {
            owner_ss58: Some(OTHER.into()),
            folder_hash: Some(HASH2.into()),
            path: Some("A/B".into()),
            label: Some("ignored".into()),
            ..target(StarKind::Folder)
        };
        let r = resolve_with(&explicit, |_| panic!("the label must not be resolved")).unwrap();
        assert_eq!(r.key(), format!("{OTHER}|{HASH2}|d:A/B"));
        let half = StarTarget {
            owner_ss58: Some(OTHER.into()),
            label: Some("Docs".into()),
            ..target(StarKind::Drive)
        };
        assert_eq!(resolve_with(&half, own), None);
    }

    #[test]
    fn what_cannot_be_named_is_refused() {
        let no_id = StarTarget {
            label: Some("Docs".into()),
            file_id: Some("abc".into()),
            ..target(StarKind::File)
        };
        assert_eq!(resolve_with(&no_id, own), None);
        let empty_folder = StarTarget {
            label: Some("Docs".into()),
            path: Some("/".into()),
            ..target(StarKind::Folder)
        };
        assert_eq!(resolve_with(&empty_folder, own), None, "a folder with no path is not the drive");
        let climbing = StarTarget {
            label: Some("Docs".into()),
            path: Some("../x".into()),
            ..target(StarKind::Folder)
        };
        assert_eq!(resolve_with(&climbing, own), None);
        let no_label = target(StarKind::Drive);
        assert_eq!(resolve_with(&no_label, own), None);
        let bad_hash = StarTarget {
            owner_ss58: Some(OTHER.into()),
            folder_hash: Some("nothex".into()),
            ..target(StarKind::Drive)
        };
        assert_eq!(resolve_with(&bad_hash, own), None);
    }

    fn directory() -> DriveDirectory {
        let mut dir = DriveDirectory {
            account_id: ME.into(),
            ..DriveDirectory::default()
        };
        dir.own.insert(HASH.into(), ("Docs".into(), true));
        dir.own.insert("1111111111111111".into(), ("Photos".into(), false));
        dir.shared.insert((OTHER.into(), HASH2.into()), ("Team drive".into(), None));
        dir.shared.insert(
            (OTHER.into(), "2222222222222222".into()),
            ("Synced team".into(), Some("Synced team (2)".into())),
        );
        dir.grants
            .push(("5Third".into(), "3333333333333333".into(), "Clients/Acme".into(), "Client work".into()));
        dir
    }

    #[test]
    fn items_are_placed_in_the_drive_the_drive_page_opens() {
        let dir = directory();
        let p = place(&dir, ME, HASH, "A", None);
        assert_eq!((p.open_label.as_str(), p.open_remote, p.is_own), ("Docs", false, true));
        let p = place(&dir, ME, "1111111111111111", "", None);
        assert_eq!((p.open_label.as_str(), p.open_remote), ("Photos", true));
        let p = place(&dir, OTHER, HASH2, "", None);
        assert_eq!(p.open_label, format!("shared:{OTHER}~{HASH2}"));
        assert_eq!(p.open_name.as_deref(), Some("Team drive"));
        assert!(!p.is_own);
        let p = place(&dir, OTHER, "2222222222222222", "", None);
        assert_eq!((p.open_label.as_str(), p.open_remote), ("Synced team (2)", false));
        let p = place(&dir, "5Third", "3333333333333333", "Clients/Acme/Q1", None);
        assert_eq!(p.open_label, format!("grant:5Third~3333333333333333~{}", hex::encode("Clients/Acme")));
        assert_eq!((p.root.as_str(), p.open_name.as_deref()), ("Clients/Acme", Some("Acme")));
        // A lookalike sibling of the grant is not inside it.
        let p = place(&dir, "5Third", "3333333333333333", "Clients/AcmeCo", None);
        assert_eq!(p.root, "");
    }

    #[test]
    fn the_list_is_drives_then_folders_then_files_with_locations_and_open_paths() {
        let page: FavoritesPage = serde_json::from_value(serde_json::json!({
            "files": [
                { "owner_ss58": ME, "folder_hash": HASH, "file_id": "aa".repeat(32), "file_name": "x.pdf",
                  "relative_path": "Work/Q1/x.pdf", "size_bytes": 3, "created_at": 7 },
                { "owner_ss58": ME, "folder_hash": HASH, "file_id": "bb".repeat(32), "file_name": "loose.pdf",
                  "relative_path": null, "size_bytes": 4, "created_at": 0 },
                { "owner_ss58": "5Third", "folder_hash": "3333333333333333", "file_id": "cc".repeat(32),
                  "file_name": "brief.doc", "relative_path": "Clients/Acme/brief.doc", "size_bytes": 1, "created_at": 9 }
            ],
            "folders": [{ "owner_ss58": OTHER, "folder_hash": HASH2, "path": "Plans/2026", "name": "2026",
                          "file_count": 2, "total_bytes": 9, "created_at": 0 }],
            "drives": [{ "owner_ss58": ME, "folder_hash": HASH, "label": "Docs", "total_bytes": 10, "file_count": 3, "created_at": 5 }],
            "has_more": false
        }))
        .unwrap();
        let items = build_items(&directory(), &[page]);
        let kinds: Vec<_> = items.iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec!["drive", "folder", "file", "file", "file"]);
        assert_eq!(items[0].open_path.as_deref(), Some(""));
        assert_eq!(items[0].location, "");
        let folder = &items[1];
        assert_eq!(folder.location, "Team drive / Plans");
        assert_eq!(folder.open_path.as_deref(), Some("Plans/2026"));
        assert_eq!(folder.created_at, None, "0 is the server's no-date");
        let file = &items[2];
        assert_eq!(file.location, "Docs / Work / Q1");
        assert_eq!(file.open_path.as_deref(), Some("Work/Q1"));
        assert!(file.is_own);
        let loose = &items[3];
        assert_eq!((loose.location.as_str(), loose.open_path.clone()), ("Docs", None));
        let granted = &items[4];
        assert_eq!(granted.open_path.as_deref(), Some(""), "the grant's folder is the label's root");
        assert_eq!(granted.location, "Client work / Clients / Acme");
    }

    #[test]
    fn an_item_on_two_pages_is_listed_once() {
        let page = || -> FavoritesPage {
            serde_json::from_value(serde_json::json!({
                "folders": [{ "owner_ss58": ME, "folder_hash": HASH, "path": "A" }]
            }))
            .unwrap()
        };
        assert_eq!(build_items(&directory(), &[page(), page()]).len(), 1);
    }
}
