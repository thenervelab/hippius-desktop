//! Rename a file inside a Drive folder that is NOT synced on this computer.
//!
//! The sync engine renames by observing a local move and reconciling; a
//! folder the user is only browsing has no local copy to move, so the
//! rename has to be stated to the server directly.
//!
//! `POST /rename_files` re-keys the record without moving the ciphertext:
//! the content is untouched, only its path identity changes. That is why a
//! rename must carry a `base_revision_id` — the server rejects one built
//! against a revision that has since moved on, which is what stops a
//! rename issued from a stale listing from silently clobbering a newer
//! change made elsewhere.

use ed25519_dalek::Signer;
use hcfs_shared::network::{BatchRenameRequest, SingleRename};
use sqlx::sqlite::SqlitePool;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

use super::remote_upload::{signing_key_for_folder, wire_relative_path};

/// How many state rows to ask for per page while locating a file.
const STATE_PAGE: u32 = 500;

/// Pages to walk before giving up.
///
/// The revision lookup is a linear scan of the folder's state, so a very
/// large folder would otherwise let one rename issue an unbounded number
/// of requests. Refusing with a clear error beats hanging: the rename is
/// still possible from a device that syncs the folder.
const MAX_STATE_PAGES: u32 = 40;

/// The current revision of the file at `path_hash`, straight from the
/// server.
///
/// Read fresh rather than carried on the browse listing on purpose: the
/// listing may be minutes old, and a `base_revision_id` is precisely the
/// claim "I am changing the version I last saw". Sourcing it from stale
/// data would defeat the check it exists to make.
async fn current_revision_id(client: &hcfs_client::client::HcfsClient, ss58: &str, folder_hash: &str, path_hash: &[u8; 32]) -> Result<[u8; 32]> {
    let mut offset = 0u32;
    for _ in 0..MAX_STATE_PAGES {
        let page = client
            .get_state(ss58, folder_hash, offset, STATE_PAGE, None)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not read the folder's current state: {e}")))?;

        if let Some(found) = page.files.iter().find(|f| &f.path_hash == path_hash) {
            return Ok(found.revision_id);
        }
        if !page.has_more {
            return Err(AppError::NotFound(
                "That file is no longer in this folder — refresh and try again.".into(),
            ));
        }
        offset = offset.saturating_add(page.files.len().max(1) as u32);
    }
    Err(AppError::Validation(
        "This folder is too large to rename in from a device that does not sync it.".into(),
    ))
}

/// What to rename, and where.
///
/// A struct rather than eight positional parameters: `old_name` and
/// `new_name` are the same type and adjacent, which is a swap waiting to
/// happen, and swapping them here renames the file to itself and then
/// fails to find the original.
pub struct RemoteRename<'a> {
    pub account_id: &'a str,
    pub label: &'a str,
    /// Folder-relative path of the containing folder; empty for its root.
    pub parent_path: &'a str,
    pub old_name: &'a str,
    pub new_name: &'a str,
    pub identity: &'a DriveIdentity,
}

/// Rename one file in a folder this device does not sync.
pub async fn rename_in_remote_folder(state: &AppState, pool: &SqlitePool, req: RemoteRename<'_>) -> Result<()> {
    let RemoteRename {
        account_id,
        label,
        parent_path,
        old_name,
        new_name,
        identity,
    } = req;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::Validation("A file needs a name.".into()));
    }
    // The name is hashed and sealed into the path, so a separator here
    // would move the file rather than rename it — a different operation
    // with different permissions, arriving through the rename dialog.
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(AppError::Validation("A file name cannot contain a slash.".into()));
    }
    if new_name == old_name {
        return Ok(());
    }

    let mnemonic = super::remote::session_mnemonic(state)?;
    let encryption_key = super::remote::encryption_key_for_label(pool, account_id, label, &mnemonic, identity).await?;
    let signing_key = signing_key_for_folder(&mnemonic, label)?;

    let old_relative = wire_relative_path(parent_path, old_name);
    let new_relative = wire_relative_path(parent_path, new_name);
    let old_path_hash = hcfs_client::crypto::compute_path_hash(&old_relative);
    let new_path_hash = hcfs_client::crypto::compute_path_hash(&new_relative);
    let new_encrypted_path = hcfs_client::crypto::encrypt_small(new_relative.as_bytes(), &encryption_key)
        .map_err(|e| AppError::Crypto(format!("Failed to seal the new path: {e}")))?;

    let folder_hash = hcfs_client::drive::keys::folder_hash(label);
    let client = super::remote::build_client(pool, account_id, identity).await?;
    let base_revision_id = current_revision_id(&client, account_id, &folder_hash, &old_path_hash).await?;

    let renames = vec![SingleRename {
        old_path_hash,
        new_path_hash,
        new_encrypted_path,
        new_file_name: Some(new_name.to_string()),
        new_relative_path: Some(new_relative),
        base_revision_id,
    }];

    // The signing text is generated by hcfs-shared, which the server uses
    // to verify — deriving our own would be a second definition of the
    // payload, and the two would diverge on the first field added.
    let signature = signing_key.sign(BatchRenameRequest::generate_signing_text(&renames).as_bytes());

    let request = BatchRenameRequest {
        ss58_address: account_id.to_string(),
        folder_hash,
        renames,
        signature: signature.to_bytes(),
        signing_key: signing_key.verifying_key().to_bytes(),
    };

    client
        .rename_files(&request)
        .await
        .map_err(|e| AppError::Hcfs(format!("Rename failed: {e}")))?;
    Ok(())
}

/// One file under the folder being renamed, with its path in plaintext.
#[derive(Debug, Clone)]
pub struct RemoteEntry {
    /// Drive-relative, `/`-separated, no leading or trailing slash.
    pub path: String,
    pub path_hash: [u8; 32],
    pub revision_id: [u8; 32],
}

/// A folder subtree as the server holds it: the FILES beneath it, and the
/// registered directory rows at and below it.
///
/// The two halves live in different tables and move by different calls,
/// which is the whole reason this type exists rather than one flat list.
/// `/browse` UNIONs them for display, so a client that moves only one half
/// leaves the other showing.
#[derive(Debug, Clone, Default)]
pub struct RemoteFolderTree {
    /// Old paths of every registered directory at or below the folder,
    /// the folder itself first.
    pub directory_paths: Vec<String>,
    pub files: Vec<RemoteEntry>,
}

/// One file's move, decided before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedRename {
    pub old_path_hash: [u8; 32],
    pub new_path: String,
    pub base_revision_id: [u8; 32],
}

/// Everything a folder rename has to do, in the three parts it takes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FolderRenamePlan {
    /// `/rename_files` operations, one per file under the folder.
    pub files: Vec<PlannedRename>,
    /// Directory rows to `register_folder_entries` at the new prefix.
    pub new_directory_paths: Vec<String>,
    /// Directory rows to `unregister_folder_entries` at the old prefix.
    pub old_directory_paths: Vec<String>,
}

/// Re-prefix one path, or `None` when it is not inside the folder.
///
/// The child test is `old_prefix` plus a separator, never a bare
/// `starts_with`: `Trip` must not match `Trip Photos`.
fn replace_path_prefix(path: &str, old_prefix: &str, new_prefix: &str) -> Option<String> {
    if path == old_prefix {
        return Some(new_prefix.to_string());
    }
    path.strip_prefix(&format!("{old_prefix}/")).map(|rest| format!("{new_prefix}/{rest}"))
}

/// Turn a folder subtree into the calls that move it.
///
/// Pure, and separated from the network for that reason: this is where the
/// rename is either complete or silently leaves half the folder behind,
/// and it is the only part testable without a server.
///
/// **A folder is two things on the server and both have to move.** Its
/// files live in the files table and move with `/rename_files`; its
/// directory rows live in `folder_entries` and cannot be renamed at all —
/// they are registered at the new paths and unregistered at the old ones.
/// Moving only the files is what leaves the original folder on screen,
/// now empty, beside the renamed one. Mirrors the console's
/// `renameHcfsEntry`.
pub fn plan_folder_rename(tree: &RemoteFolderTree, old_prefix: &str, new_prefix: &str) -> Result<FolderRenamePlan> {
    let mut files = Vec::with_capacity(tree.files.len());
    for entry in &tree.files {
        let Some(new_path) = replace_path_prefix(&entry.path, old_prefix, new_prefix) else {
            // The tree walk only descends into the folder, so anything
            // outside it is a server response that does not match what was
            // asked for — renaming it would move a file the user never
            // selected.
            return Err(AppError::Validation(format!(
                "\"{}\" is not inside the folder being renamed.",
                entry.path
            )));
        };
        files.push(PlannedRename {
            old_path_hash: entry.path_hash,
            new_path,
            base_revision_id: entry.revision_id,
        });
    }

    let mut new_directory_paths = Vec::with_capacity(tree.directory_paths.len());
    for path in &tree.directory_paths {
        let Some(moved) = replace_path_prefix(path, old_prefix, new_prefix) else {
            return Err(AppError::Validation(format!("\"{path}\" is not inside the folder being renamed.")));
        };
        new_directory_paths.push(moved);
    }

    if files.is_empty() && new_directory_paths.is_empty() {
        return Err(AppError::NotFound(
            "That folder is no longer in this drive — refresh and try again.".into(),
        ));
    }

    Ok(FolderRenamePlan {
        files,
        new_directory_paths,
        old_directory_paths: tree.directory_paths.clone(),
    })
}

/// Whether `new_name` is free in the directory the folder lives in.
///
/// Checked against the PARENT listing rather than the whole drive: that is
/// the only place a clash can happen, and it is one request instead of a
/// full scan. Mirrors the console's `assertDestinationAvailable`.
fn assert_destination_available(folders: &[String], files: &[String], old_path: &str, new_path: &str) -> Result<()> {
    let taken = folders.iter().chain(files.iter()).any(|p| p == new_path && p != old_path);
    if taken {
        return Err(AppError::Validation("An item with this name already exists in this folder.".into()));
    }
    Ok(())
}

/// Every page of one directory level.
async fn browse_directory(
    client: &hcfs_client::client::HcfsClient,
    ss58: &str,
    folder_hash: &str,
    path: &str,
) -> Result<(Vec<String>, Vec<hcfs_shared::network::RemoteFileEntry>)> {
    let mut folder_names = Vec::new();
    let mut files = Vec::new();
    let mut offset = 0u32;

    for _ in 0..MAX_BROWSE_PAGES {
        let page = client
            .browse(ss58, folder_hash, path, offset, BROWSE_PAGE)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not read the folder: {e}")))?;

        let returned = page.folders.len() + page.files.len();
        folder_names.extend(page.folders.into_iter().map(|f| f.name));
        files.extend(page.files);

        if !page.has_more || returned == 0 {
            return Ok((folder_names, files));
        }
        offset = page.offset.saturating_add(returned as u32);
    }

    Err(AppError::Validation(
        "This folder is too large to rename from a device that does not sync it.".into(),
    ))
}

/// Walk the folder and everything under it.
///
/// Iterative rather than recursive: an async recursion needs boxing at
/// every level, and a drive is untrusted input — an explicit stack cannot
/// blow the real one.
async fn collect_folder_tree(
    client: &hcfs_client::client::HcfsClient,
    ss58: &str,
    folder_hash: &str,
    root: &str,
    encryption_key: &[u8; 32],
) -> Result<RemoteFolderTree> {
    let mut tree = RemoteFolderTree::default();
    let mut pending = vec![root.to_string()];

    while let Some(path) = pending.pop() {
        if tree.directory_paths.len() >= MAX_TREE_DIRECTORIES {
            return Err(AppError::Validation(
                "This folder has too many subfolders to rename from a device that does not sync it.".into(),
            ));
        }
        let (folder_names, files) = browse_directory(client, ss58, folder_hash, &path).await?;
        tree.directory_paths.push(path.clone());

        for file in files {
            let resolved = file.relative_path.as_deref().map(str::to_string).filter(|p| !p.is_empty()).or_else(|| {
                if file.encrypted_path.is_empty() {
                    return None;
                }
                hcfs_client::crypto::decrypt_small(&file.encrypted_path, encryption_key)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
            });
            // Refusing beats a partial move: a file left behind under the
            // old path is one the user can no longer find, and nothing
            // would report it — the rename would look like it worked.
            let Some(resolved) = resolved else {
                return Err(AppError::Validation(
                    "An item in this folder has no readable path yet, so the folder was not renamed. \
                     Let it finish syncing, or rename it from a device that syncs this drive."
                        .into(),
                ));
            };
            tree.files.push(RemoteEntry {
                path: resolved.replace('\\', "/").trim_matches('/').to_string(),
                path_hash: file.path_hash,
                revision_id: file.revision_id,
            });
        }

        for name in folder_names {
            pending.push(wire_relative_path(&path, &name));
        }
    }

    Ok(tree)
}

/// Files per `/rename_files` call.
///
/// The server caps a batch at 10 000, but the batches are chunked well
/// below that to match the console and to keep one request small. Chunks
/// are NOT atomic with each other: a failure part-way leaves some files
/// moved. That is recoverable — renaming the same folder again re-plans
/// from the current state and moves the remainder — where refusing to
/// rename a large folder at all is not.
const RENAME_BATCH: usize = 500;
/// Directory rows per `register`/`unregister_folder_entries` call.
const FOLDER_ENTRY_BATCH: usize = 500;
/// Pages per directory level, and directories per tree.
const BROWSE_PAGE: u32 = 500;
const MAX_BROWSE_PAGES: u32 = 200;
const MAX_TREE_DIRECTORIES: usize = 5_000;

/// Rename a FOLDER in a drive this device does not sync.
///
/// A folder is not a record: `/browse` shows it by UNIONing the file
/// aggregate with the `folder_entries` rows. So the rename is three
/// things, in this order:
///
///  1. every file under it moves, in `/rename_files` batches;
///  2. the directory rows are registered at the new paths;
///  3. the directory rows at the old paths are unregistered.
///
/// Register-before-unregister on purpose: a failure between the two leaves
/// the folder visible under BOTH names, which the user can see and fix,
/// where the reverse order would make it vanish.
pub async fn rename_folder_in_remote_folder(state: &AppState, pool: &SqlitePool, req: RemoteRename<'_>) -> Result<usize> {
    let RemoteRename {
        account_id,
        label,
        parent_path,
        old_name,
        new_name,
        identity,
    } = req;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::Validation("A folder needs a name.".into()));
    }
    // The name becomes one path segment. A separator would move the folder
    // rather than rename it, and `.`/`..` would name somewhere else again.
    if new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".." {
        return Err(AppError::Validation("A folder name cannot contain a slash.".into()));
    }
    if new_name == old_name {
        return Ok(0);
    }

    let mnemonic = super::remote::session_mnemonic(state)?;
    let encryption_key = super::remote::encryption_key_for_label(pool, account_id, label, &mnemonic, identity).await?;
    let signing_key = signing_key_for_folder(&mnemonic, label)?;

    let old_prefix = wire_relative_path(parent_path, old_name);
    let new_prefix = wire_relative_path(parent_path, new_name);

    let folder_hash = hcfs_client::drive::keys::folder_hash(label);
    let client = super::remote::build_client(pool, account_id, identity).await?;

    // The destination has to be free before anything moves.
    let (sibling_folders, sibling_files) = browse_directory(&client, account_id, &folder_hash, parent_path).await?;
    let sibling_folder_paths: Vec<String> = sibling_folders.iter().map(|n| wire_relative_path(parent_path, n)).collect();
    let sibling_file_paths: Vec<String> = sibling_files.iter().filter_map(|f| f.relative_path.clone()).collect();
    assert_destination_available(&sibling_folder_paths, &sibling_file_paths, &old_prefix, &new_prefix)?;

    let tree = collect_folder_tree(&client, account_id, &folder_hash, &old_prefix, &encryption_key).await?;
    let plan = plan_folder_rename(&tree, &old_prefix, &new_prefix)?;

    let mut moved = 0usize;
    for batch in plan.files.chunks(RENAME_BATCH) {
        let mut renames = Vec::with_capacity(batch.len());
        for item in batch {
            let new_encrypted_path = hcfs_client::crypto::encrypt_small(item.new_path.as_bytes(), &encryption_key)
                .map_err(|e| AppError::Crypto(format!("Failed to seal the new path: {e}")))?;
            renames.push(SingleRename {
                old_path_hash: item.old_path_hash,
                new_path_hash: hcfs_client::crypto::compute_path_hash(&item.new_path),
                new_encrypted_path,
                new_file_name: item.new_path.rsplit('/').next().map(str::to_string),
                new_relative_path: Some(item.new_path.clone()),
                base_revision_id: item.base_revision_id,
            });
        }

        // The signing text is generated by hcfs-shared, which the server
        // uses to verify — deriving our own would be a second definition.
        let signature = signing_key.sign(BatchRenameRequest::generate_signing_text(&renames).as_bytes());
        let request = BatchRenameRequest {
            ss58_address: account_id.to_string(),
            folder_hash: folder_hash.clone(),
            renames,
            signature: signature.to_bytes(),
            signing_key: signing_key.verifying_key().to_bytes(),
        };
        client
            .rename_files(&request)
            .await
            .map_err(|e| AppError::Hcfs(format!("Rename failed after moving {moved} item(s): {e}")))?;
        moved += batch.len();
    }

    // The half `/rename_files` cannot do. Without it the original folder
    // stays on screen, now empty, beside the renamed one.
    for batch in plan.new_directory_paths.chunks(FOLDER_ENTRY_BATCH) {
        client
            .register_folder_entries(&identity.wire_ss58, &identity.wire_folder_hash, batch)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not create the renamed folder: {e}")))?;
    }
    for batch in plan.old_directory_paths.chunks(FOLDER_ENTRY_BATCH) {
        client
            .unregister_folder_entries(&identity.wire_ss58, &identity.wire_folder_hash, batch)
            .await
            .map_err(|e| AppError::Hcfs(format!("The folder was renamed but the old one could not be removed: {e}")))?;
    }

    Ok(moved)
}

/// Create a folder inside a Drive folder this device does not sync.
///
/// A local drive gets a folder by making the directory and letting the
/// engine register it; a browsed folder has no directory to make, so the
/// entity is registered with the server directly.
///
/// `register_folder_entries` is the right call for this and says so: it
/// touches no sync state — no FileTree, no path_index, no scan or stage —
/// and the server validates the paths. Nothing here needs a local root.
#[tauri::command]
pub async fn create_remote_folder(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    parent_path: Option<String>,
    name: String,
) -> Result<String> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    create_remote_folder_inner(pool, &account_id, parent_path.as_deref().unwrap_or_default(), &name, &identity).await
}

/// The body of {@link create_remote_folder}, without the Tauri state.
///
/// Split out so the live lane can register a folder the way the app does,
/// rather than reaching for `register_folder_entries` itself — a test that
/// builds its own request stops testing the one the app sends.
pub async fn create_remote_folder_inner(
    pool: &SqlitePool,
    account_id: &str,
    parent_path: &str,
    name: &str,
    identity: &DriveIdentity,
) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("A folder needs a name.".into()));
    }
    // The name becomes one path segment, so a separator here would create
    // a nested tree rather than the folder the user asked for, and `..`
    // would name somewhere outside the drive entirely.
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(AppError::Validation("A folder name cannot contain a slash.".into()));
    }

    let relative_path = super::remote_upload::wire_relative_path(parent_path, name);
    let client = super::remote::build_client(pool, account_id, identity).await?;
    client
        .register_folder_entries(&identity.wire_ss58, &identity.wire_folder_hash, std::slice::from_ref(&relative_path))
        .await
        .map_err(|e| AppError::Hcfs(format!("Could not create the folder: {e}")))?;
    Ok(relative_path)
}

/// Rename a file in a folder that is not synced on this computer.
#[tauri::command]
pub async fn rename_remote_file(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    parent_path: Option<String>,
    old_name: String,
    new_name: String,
) -> Result<()> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    rename_in_remote_folder(
        state.inner(),
        pool,
        RemoteRename {
            account_id: &account_id,
            label: &label,
            parent_path: &parent_path.unwrap_or_default(),
            old_name: &old_name,
            new_name: &new_name,
            identity: &identity,
        },
    )
    .await
}

/// Rename a folder in a drive that is not synced on this computer.
///
/// Separate command from `rename_remote_file` because it is a different
/// operation, not a variant of one: a file is a record, a folder is a
/// prefix over many. Returns how many records moved.
#[tauri::command]
pub async fn rename_remote_folder(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    parent_path: Option<String>,
    old_name: String,
    new_name: String,
) -> Result<usize> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    rename_folder_in_remote_folder(
        state.inner(),
        pool,
        RemoteRename {
            account_id: &account_id,
            label: &label,
            parent_path: &parent_path.unwrap_or_default(),
            old_name: &old_name,
            new_name: &new_name,
            identity: &identity,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, seed: u8) -> RemoteEntry {
        RemoteEntry {
            path: path.to_string(),
            path_hash: [seed; 32],
            revision_id: [seed.wrapping_add(100); 32],
        }
    }

    fn tree(dirs: &[&str], files: &[RemoteEntry]) -> RemoteFolderTree {
        RemoteFolderTree {
            directory_paths: dirs.iter().map(|d| (*d).to_string()).collect(),
            files: files.to_vec(),
        }
    }

    fn new_paths(plan: &FolderRenamePlan) -> Vec<&str> {
        plan.files.iter().map(|f| f.new_path.as_str()).collect()
    }

    /// Every file under the folder moves. Renaming the folder alone left
    /// them all behind under the old prefix.
    #[test]
    fn moves_every_file_under_the_folder() {
        let t = tree(&["Trip", "Trip/nested"], &[file("Trip/a.txt", 1), file("Trip/nested/b.txt", 2)]);
        let plan = plan_folder_rename(&t, "Trip", "Holiday").expect("plan");
        assert_eq!(new_paths(&plan), vec!["Holiday/a.txt", "Holiday/nested/b.txt"]);
    }

    /// THE bug the user saw. A folder's directory rows live in
    /// `folder_entries`, a different table that `/rename_files` cannot
    /// touch — so they are registered at the new paths and unregistered at
    /// the old. Moving only the files leaves the original folder on
    /// screen, now empty, beside the renamed one.
    #[test]
    fn moves_the_directory_rows_as_well_as_the_files() {
        let t = tree(&["Trip", "Trip/nested"], &[file("Trip/a.txt", 1)]);
        let plan = plan_folder_rename(&t, "Trip", "Holiday").expect("plan");
        assert_eq!(plan.new_directory_paths, vec!["Holiday", "Holiday/nested"]);
        assert_eq!(plan.old_directory_paths, vec!["Trip", "Trip/nested"]);
    }

    /// An empty folder has no files at all, and is exactly the case that
    /// exists ONLY as directory rows. It must still rename.
    #[test]
    fn renames_a_folder_that_holds_no_files() {
        let t = tree(&["Trip"], &[]);
        let plan = plan_folder_rename(&t, "Trip", "Holiday").expect("plan");
        assert!(plan.files.is_empty());
        assert_eq!(plan.new_directory_paths, vec!["Holiday"]);
        assert_eq!(plan.old_directory_paths, vec!["Trip"]);
    }

    /// A bare `starts_with` would drag the sibling along, renaming files
    /// the user never selected. The walk should never hand these over, so
    /// being handed one is a server response that does not match the ask.
    #[test]
    fn refuses_a_path_that_is_only_a_name_prefix_of_the_folder() {
        let t = tree(&["Trip"], &[file("Trip Photos/b.txt", 2)]);
        let err = plan_folder_rename(&t, "Trip", "Holiday").expect_err("must refuse");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    /// Nested folders rename in place: only the named segment changes.
    #[test]
    fn renames_a_nested_folder_without_touching_its_parent() {
        let t = tree(&["Trips/2024"], &[file("Trips/2024/a.txt", 1)]);
        let plan = plan_folder_rename(&t, "Trips/2024", "Trips/Archive").expect("plan");
        assert_eq!(new_paths(&plan), vec!["Trips/Archive/a.txt"]);
        assert_eq!(plan.new_directory_paths, vec!["Trips/Archive"]);
    }

    /// A folder with neither files nor directory rows is not silently a
    /// no-op: the caller asked to rename something that is not there.
    #[test]
    fn reports_a_folder_that_is_not_in_the_drive() {
        let err = plan_folder_rename(&tree(&[], &[]), "Trip", "Holiday").expect_err("must refuse");
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }

    /// Each file carries its OWN base revision. Reusing one for every
    /// child is what the stale-listing guard exists to catch, and the
    /// server would reject the batch.
    #[test]
    fn carries_each_files_own_base_revision() {
        let t = tree(&["Trip"], &[file("Trip/a.txt", 1), file("Trip/b.txt", 2)]);
        let plan = plan_folder_rename(&t, "Trip", "Holiday").expect("plan");
        assert_eq!(plan.files[0].base_revision_id, [101u8; 32]);
        assert_eq!(plan.files[1].base_revision_id, [102u8; 32]);
        assert_eq!(plan.files[0].old_path_hash, [1u8; 32]);
        assert_eq!(plan.files[1].old_path_hash, [2u8; 32]);
    }

    /// The separator is what tells a child from a lookalike sibling.
    #[test]
    fn re_prefixes_only_true_children() {
        assert_eq!(replace_path_prefix("Trip", "Trip", "Holiday").as_deref(), Some("Holiday"));
        assert_eq!(replace_path_prefix("Trip/a.txt", "Trip", "Holiday").as_deref(), Some("Holiday/a.txt"));
        assert_eq!(replace_path_prefix("Trip Photos/b.txt", "Trip", "Holiday"), None);
        assert_eq!(replace_path_prefix("Trips/c.txt", "Trip", "Holiday"), None);
    }

    /// The destination must be free before anything moves — otherwise the
    /// two folders merge silently.
    #[test]
    fn refuses_a_name_already_taken_in_the_parent() {
        let folders = vec!["Trip".to_string(), "Holiday".to_string()];
        let err = assert_destination_available(&folders, &[], "Trip", "Holiday").expect_err("must refuse");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    /// A file of that name counts too: browse UNIONs both, so the user
    /// would see two rows with one name.
    #[test]
    fn refuses_a_name_taken_by_a_file() {
        let files = vec!["Holiday".to_string()];
        assert!(assert_destination_available(&[], &files, "Trip", "Holiday").is_err());
    }

    #[test]
    fn allows_a_free_name() {
        let folders = vec!["Trip".to_string(), "Other".to_string()];
        assert!(assert_destination_available(&folders, &[], "Trip", "Holiday").is_ok());
    }
}
