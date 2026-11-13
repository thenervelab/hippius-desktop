//! Move files and folders inside a drive that is NOT synced on this
//! computer.
//!
//! There is no local copy to move, so the move is stated to the server:
//!
//! - a FOLDER moves with `POST /rename_folder`, one atomic step that also
//!   carries its folder rows, links and grants. A folder over the route's
//!   limit falls back to the `/rename_files` batches a remote folder rename
//!   uses, which are not atomic;
//! - FILES move with `/rename_files` to a path in the new folder.
//!
//! Every file rename carries a `base_revision_id` read fresh from the
//! server, never from the listing the user is looking at, for the reason
//! `remote_rename` gives.

use std::collections::{HashMap, HashSet};

use ed25519_dalek::Signer;
use hcfs_client::client::folder_rename::{self, FolderRenameError};
use hcfs_shared::network::{BatchRenameRequest, RenameFolderRequest, SingleRename};
use sqlx::sqlite::SqlitePool;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::files::move_entries::{
    Claimed, Decision, Existing, MoveItem, MoveItemResult, basename_of, decide, join_path, move_problem, normalize_drive_path, target_name,
};
use crate::sync::identity::{DriveIdentity, rooted_path};

use super::remote_rename::{browse_directory, move_folder_by_batches, refused_renames};

/// State rows per page while reading the files' current revisions.
const STATE_PAGE: u32 = 500;
/// Pages to read before giving up, as `remote_rename` does.
const MAX_STATE_PAGES: u32 = 40;
/// Files per `/rename_files` call, as `remote_rename` does.
const RENAME_BATCH: usize = 500;

/// One name at the destination as the server lists it.
#[derive(Clone, Copy, Debug)]
enum Listed {
    Folder,
    File { path_hash: [u8; 32], revision_id: [u8; 32] },
}

impl Listed {
    fn kind(self) -> Existing {
        match self {
            Self::Folder => Existing::Folder,
            Self::File { .. } => Existing::File,
        }
    }
}

/// A file's move, decided and waiting for its batch.
struct PlannedFile {
    index: usize,
    old_wire: String,
    new_wire: String,
    new_view_path: String,
    replace: Option<([u8; 32], [u8; 32])>,
}

/// A server refusal of a folder move, in words for the user.
///
/// The codes are the server's (`/rename_folder`); anything unknown keeps
/// the server's own message rather than guessing.
pub(crate) fn folder_move_message(error: &FolderRenameError) -> String {
    match error {
        FolderRenameError::InvalidPrefix(msg) if msg.contains("inside itself") => crate::sync::files::move_entries::INSIDE_ITSELF.to_string(),
        FolderRenameError::Changed { .. } => "The folder changed while it was being moved. Try again".into(),
        FolderRenameError::NoAnswer(_) => "The server did not answer. Check where the folder is before trying again".into(),
        FolderRenameError::TooLarge { .. } => "This folder is too large to move in one step".into(),
        FolderRenameError::Refused { code, message, .. } => refusal_message(code).map_or_else(|| message.clone(), str::to_string),
        other => other.to_string(),
    }
}

fn refusal_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "target_exists" => "An item with this name is already there",
        "target_shared" => "That folder is shared on its own, so this can't move into it",
        "grant_overlap" => "This would put one shared folder inside another",
        "revision_mismatch" | "folder_changed" => "The folder changed while it was being moved. Try again",
        "upload_in_progress" => "Files in this folder are still uploading. Try again when they finish",
        "paths_unregistered" | "unreliable_path" => "Some files in this folder can't be moved from this device yet",
        "out_of_scope" => "You don't have access to that folder",
        "grant_root" => "A shared folder can't be moved by the people it is shared with",
        "not_found" => "It's no longer there. Refresh and try again",
        _ => return None,
    })
}

/// The current revision of each file in `wanted`, straight from the server.
async fn current_revisions(
    client: &hcfs_client::client::HcfsClient,
    ss58: &str,
    folder_hash: &str,
    wanted: &HashSet<[u8; 32]>,
) -> Result<HashMap<[u8; 32], [u8; 32]>> {
    let mut found = HashMap::with_capacity(wanted.len());
    let mut offset = 0u32;
    for _ in 0..MAX_STATE_PAGES {
        if found.len() == wanted.len() {
            return Ok(found);
        }
        let page = client
            .get_state(ss58, folder_hash, offset, STATE_PAGE, None)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not read the drive's current state: {e}")))?;
        for file in &page.files {
            if wanted.contains(&file.path_hash) {
                found.insert(file.path_hash, file.revision_id);
            }
        }
        if !page.has_more {
            return Ok(found);
        }
        offset = offset.saturating_add(page.files.len().max(1) as u32);
    }
    Err(AppError::Validation(
        "This drive is too large to move files in from a device that does not sync it".into(),
    ))
}

/// An item's checks and clash choice against the destination listing:
/// its normalized path, the name it takes, whether it replaces, and what
/// is there now; or its final result when it does not move.
fn decide_item(
    item: &MoveItem,
    destination: &str,
    listed: &HashMap<String, Listed>,
    claimed: &Claimed,
) -> std::result::Result<(String, String, bool, Option<Listed>), MoveItemResult> {
    let rel = match normalize_drive_path(&item.path) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err(MoveItemResult::failed(item, "The drive itself can't be moved")),
        Err(e) => return Err(MoveItemResult::failed(item, e.to_string())),
    };
    let name = target_name(item, &rel).map_err(|e| MoveItemResult::failed(item, e.to_string()))?;
    if let Some(problem) = move_problem(&rel, item.is_folder, &name, destination) {
        return Err(MoveItemResult::failed(item, problem));
    }
    // A name an earlier item of this request took counts as a folder, so
    // nothing can choose to replace it.
    let existing = if claimed.has(&name) {
        Some(Listed::Folder)
    } else {
        listed.get(&name).copied()
    };
    let taken = |c: &str| claimed.has(c) || listed.contains_key(c);
    match decide(&name, item.is_folder, item.on_clash, existing.map(Listed::kind), taken) {
        Decision::Go { name, replace } => Ok((rel, name, replace, existing)),
        Decision::Skip => Err(MoveItemResult::skipped(item)),
        Decision::Clash { is_folder } => Err(MoveItemResult::clash(item, is_folder)),
        Decision::Fail(message) => Err(MoveItemResult::failed(item, message)),
    }
}

/// Move `items` into `destination` in a drive this device does not sync.
///
/// Paths are relative to what the user is looking at (a folder grant's
/// folder, for a grant label) and are rooted here, in one place.
pub async fn move_in_remote_drive(
    state: &AppState,
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    destination: &str,
    items: &[MoveItem],
) -> Result<Vec<MoveItemResult>> {
    let destination = normalize_drive_path(destination)?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, account_id, label).await?;
    let mnemonic = super::remote::session_mnemonic(state)?;
    // ONE source for both keys (see `DriveKeyMaterial`).
    let keys = super::remote::drive_key_material_for_label(state, account_id, label, &mnemonic, &identity).await?;
    let encryption_key = keys.encryption_key()?;
    let signing_key = keys.signing_key()?;
    let client = super::remote::build_client(pool, account_id, &identity).await?;

    let dest_wire = rooted_path(label, &destination);
    let listed = list_destination(&client, &identity, &dest_wire).await?;

    let mut results: Vec<Option<MoveItemResult>> = vec![None; items.len()];
    let mut claimed = Claimed::default();
    let mut files = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let (rel, final_name, replace, existing) = match decide_item(item, &destination, &listed, &claimed) {
            Ok(go) => go,
            Err(result) => {
                results[index] = Some(result);
                continue;
            }
        };
        claimed.claim(&final_name);

        let old_wire = rooted_path(label, &rel);
        let new_wire = join_path(&dest_wire, &final_name);
        let new_view_path = join_path(&destination, &final_name);

        if item.is_folder {
            let outcome = move_folder(&client, &identity, &encryption_key, &signing_key, &old_wire, &new_wire).await;
            results[index] = Some(match outcome {
                Ok(()) => MoveItemResult::moved(item, new_view_path, false),
                Err(message) => MoveItemResult::failed(item, message),
            });
            continue;
        }

        let replace = match (replace, existing) {
            (true, Some(Listed::File { path_hash, revision_id })) => Some((path_hash, revision_id)),
            (true, _) => {
                results[index] = Some(MoveItemResult::failed(item, crate::sync::files::move_entries::NO_FOLDER_REPLACE));
                continue;
            }
            (false, _) => None,
        };
        files.push(PlannedFile {
            index,
            old_wire,
            new_wire,
            new_view_path,
            replace,
        });
    }

    if !files.is_empty() {
        let outcomes = move_files(&client, &identity, &encryption_key, &signing_key, &files).await;
        for (planned, outcome) in files.iter().zip(outcomes) {
            let item = &items[planned.index];
            results[planned.index] = Some(match outcome {
                Ok(()) => MoveItemResult::moved(item, planned.new_view_path.clone(), planned.replace.is_some()),
                Err(message) => MoveItemResult::failed(item, message),
            });
        }
    }

    Ok(results
        .into_iter()
        .zip(items)
        .map(|(result, item)| result.unwrap_or_else(|| MoveItemResult::failed(item, "Not moved")))
        .collect())
}

/// Every name in the destination folder, and whether it is a folder.
async fn list_destination(client: &hcfs_client::client::HcfsClient, identity: &DriveIdentity, dest_wire: &str) -> Result<HashMap<String, Listed>> {
    let (folder_names, files) = browse_directory(client, &identity.wire_ss58, &identity.wire_folder_hash, dest_wire).await?;
    let mut listed: HashMap<String, Listed> = folder_names.into_iter().map(|n| (n, Listed::Folder)).collect();
    for file in files {
        let name = file
            .relative_path
            .as_deref()
            .map(|p| basename_of(p.trim_end_matches('/')).to_string())
            .or(file.file_name.clone());
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            listed.entry(name).or_insert(Listed::File {
                path_hash: file.path_hash,
                revision_id: file.revision_id,
            });
        }
    }
    Ok(listed)
}

/// Move one folder, falling back to batches when it is too large for one
/// atomic request. The error is already in words for the user.
async fn move_folder(
    client: &hcfs_client::client::HcfsClient,
    identity: &DriveIdentity,
    encryption_key: &hcfs_crypto::FileKey,
    signing_key: &ed25519_dalek::SigningKey,
    old_wire: &str,
    new_wire: &str,
) -> std::result::Result<(), String> {
    match rename_folder_atomically(client, identity, encryption_key, signing_key, old_wire, new_wire).await {
        Ok(()) => Ok(()),
        Err(e) if e.needs_batches() => move_folder_by_batches(client, identity, encryption_key, signing_key, old_wire, new_wire)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => Err(folder_move_message(&e)),
    }
}

/// `POST /rename_folder` from a fresh listing, listed again when the
/// folder changes under it (three tries in all), and once more after
/// registering stored paths the server reports missing.
///
/// The same loop as hcfs-client's `rename_remote_folder`, which takes its
/// own ed25519 major's key type; the request is signed here with this
/// crate's. Ed25519 signatures are deterministic, so both sign the same
/// bytes the same way, and the text comes from hcfs-shared either way.
async fn rename_folder_atomically(
    client: &hcfs_client::client::HcfsClient,
    identity: &DriveIdentity,
    encryption_key: &hcfs_crypto::FileKey,
    signing_key: &ed25519_dalek::SigningKey,
    old_wire: &str,
    new_wire: &str,
) -> std::result::Result<(), FolderRenameError> {
    const MAX_ATTEMPTS: usize = 3;
    folder_rename::validate_prefixes(old_wire, new_wire)?;
    let mut attempt = 1;
    let mut backfilled = false;
    loop {
        let listed = client
            .list_folder_files(&identity.wire_ss58, &identity.wire_folder_hash, old_wire)
            .await?;
        let files = folder_rename::plan_folder_rename(&listed, old_wire, new_wire, encryption_key)?;
        let text = RenameFolderRequest::generate_signing_text(old_wire, new_wire, &files);
        let request = RenameFolderRequest {
            ss58_address: identity.wire_ss58.clone(),
            folder_hash: identity.wire_folder_hash.clone(),
            old_prefix: old_wire.to_string(),
            new_prefix: new_wire.to_string(),
            files,
            signature: signing_key.sign(text.as_bytes()).to_bytes(),
            signing_key: signing_key.verifying_key().to_bytes(),
        };
        match client.rename_folder(&request).await {
            Ok(_) => return Ok(()),
            Err(e) if e.needs_path_backfill() && !backfilled => {
                client
                    .register_missing_paths(&identity.wire_ss58, &identity.wire_folder_hash, encryption_key)
                    .await?;
                backfilled = true;
            }
            Err(e) if e.is_retryable() && attempt < MAX_ATTEMPTS => attempt += 1,
            Err(e) => return Err(e),
        }
    }
}

/// Move files with `/rename_files`, replacing where the user chose to.
/// One outcome per planned file, in order.
async fn move_files(
    client: &hcfs_client::client::HcfsClient,
    identity: &DriveIdentity,
    encryption_key: &hcfs_crypto::FileKey,
    signing_key: &ed25519_dalek::SigningKey,
    files: &[PlannedFile],
) -> Vec<std::result::Result<(), String>> {
    let wanted: HashSet<[u8; 32]> = files.iter().map(|f| hcfs_crypto::compute_path_hash(&f.old_wire)).collect();
    let revisions = match current_revisions(client, &identity.wire_ss58, &identity.wire_folder_hash, &wanted).await {
        Ok(revisions) => revisions,
        Err(e) => return files.iter().map(|_| Err(e.to_string())).collect(),
    };

    let mut outcomes: Vec<std::result::Result<(), String>> = vec![Ok(()); files.len()];
    let mut ready = Vec::with_capacity(files.len());
    for (i, file) in files.iter().enumerate() {
        let old_path_hash = hcfs_crypto::compute_path_hash(&file.old_wire);
        let Some(base_revision_id) = revisions.get(&old_path_hash).copied() else {
            outcomes[i] = Err("It's no longer there. Refresh and try again".into());
            continue;
        };
        // Replace is the one place a move deletes anything, and only on the
        // user's explicit choice: the file that is there goes first, and
        // only at the revision the destination listing showed, so a newer
        // upload from another device is never deleted in its place.
        if let Some((dest_hash, dest_revision)) = file.replace
            && let Err(e) = client
                .delete_if_revision(
                    &identity.wire_ss58,
                    &identity.wire_folder_hash,
                    &hex::encode(dest_hash),
                    Some(dest_revision),
                )
                .await
        {
            outcomes[i] = Err(format!("Could not replace the file that is there: {e}"));
            continue;
        }
        let new_encrypted_path = match hcfs_crypto::encrypt_small(file.new_wire.as_bytes(), encryption_key) {
            Ok(sealed) => sealed,
            Err(e) => {
                outcomes[i] = Err(format!("Failed to seal the new path: {e}"));
                continue;
            }
        };
        ready.push((
            i,
            SingleRename {
                old_path_hash,
                new_path_hash: hcfs_crypto::compute_path_hash(&file.new_wire),
                new_encrypted_path,
                new_file_name: Some(basename_of(&file.new_wire).to_string()),
                new_relative_path: Some(file.new_wire.clone()),
                base_revision_id,
            },
        ));
    }

    for batch in ready.chunks(RENAME_BATCH) {
        let renames: Vec<SingleRename> = batch.iter().map(|(_, r)| r.clone()).collect();
        // The signing text is generated by hcfs-shared, which the server
        // uses to verify; deriving our own would be a second definition.
        let signature = signing_key.sign(BatchRenameRequest::generate_signing_text(&renames).as_bytes());
        let request = BatchRenameRequest {
            // The drive's OWNER, not the caller: the server looks the files
            // up under this account, so a member's own address found none of
            // them and every entry came back refused.
            ss58_address: identity.wire_ss58.clone(),
            folder_hash: identity.wire_folder_hash.clone(),
            renames,
            signature: signature.to_bytes(),
            signing_key: signing_key.verifying_key().to_bytes(),
        };
        match client.rename_files(&request).await {
            // `200` lists refused entries in `failures`; each is a failed move.
            Ok(result) => {
                let refused = refused_renames(&result);
                for (i, rename) in batch {
                    if let Some(reason) = refused.get(&rename.old_path_hash) {
                        outcomes[*i] = Err(reason.clone());
                    }
                }
            }
            Err(e) => {
                let message = format!("Move failed: {e}");
                for (i, _) in batch {
                    outcomes[*i] = Err(message.clone());
                }
            }
        }
    }
    outcomes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::files::move_entries::{ClashChoice, INSIDE_ITSELF, keep_both_name};

    fn refused(code: &str) -> FolderRenameError {
        FolderRenameError::Refused {
            status: 409,
            code: code.into(),
            message: "server text".into(),
        }
    }

    #[test]
    fn known_refusals_read_as_sentences_and_unknown_ones_keep_the_server_text() {
        assert_eq!(folder_move_message(&refused("target_exists")), "An item with this name is already there");
        assert_eq!(folder_move_message(&refused("out_of_scope")), "You don't have access to that folder");
        assert_eq!(folder_move_message(&refused("something_new")), "server text");
    }

    #[test]
    fn a_folder_into_itself_reads_the_same_as_the_local_refusal() {
        let e = FolderRenameError::InvalidPrefix("a folder cannot be moved inside itself".into());
        assert_eq!(folder_move_message(&e), INSIDE_ITSELF);
    }

    #[test]
    fn a_change_mid_move_asks_for_a_retry() {
        let e = FolderRenameError::Changed {
            code: "folder_changed".into(),
            message: "x".into(),
        };
        assert!(folder_move_message(&e).contains("Try again"));
    }

    #[test]
    fn every_retryable_code_has_a_sentence() {
        for code in hcfs_client::client::folder_rename::RETRYABLE_CODES {
            assert!(refusal_message(code).is_some(), "{code} needs a message");
        }
    }

    #[test]
    fn clash_choice_defaults_to_asking() {
        assert_eq!(ClashChoice::default(), ClashChoice::Ask);
        // A replace in a browsed drive also never replaces a folder.
        assert_eq!(
            decide("a", false, ClashChoice::Replace, Some(Listed::Folder.kind()), |_| false),
            Decision::Fail(crate::sync::files::move_entries::NO_FOLDER_REPLACE)
        );
        assert!(keep_both_name("a.txt", false, |_| false).is_some());
    }
}
