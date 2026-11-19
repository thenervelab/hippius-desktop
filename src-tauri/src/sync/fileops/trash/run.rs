//! The loops that carry a Trash operation of any size through the server's
//! per-call batches: trash by file id, restore, delete forever and empty.
//!
//! There is no size limit. A folder of a million files is a thousand
//! batches of trash (or two hundred steps of restore), each reported to the
//! caller's progress callback. Every step is safe to repeat, so a loop
//! stopped part way (the app quit, the network went) is resumed by running
//! it again: a file already in Trash answers `already_deleted`, a folder
//! item continues under the `item_id` its first batch got (kept in the
//! journal, see `hold`), and a restore or empty answers `more` until done.
//!
//! No Tauri types here: `tests/trash_server_mock.rs` drives these loops
//! against a stand-in server.

use super::api::TrashApi;
use super::wire::{
    MAX_DELETE_ITEMS, MAX_RESTORE_RENAMES, MAX_TRASH_FILES, OnConflict, RestoreRename, RestoreRequest, TrashFilesRequest, TrashRefusal, file_id,
};
use hcfs_shared::network::{BatchRenameRequest, SingleRename};
use hcfs_shared::revision_id::RevisionId;
use std::collections::{BTreeMap, HashMap};

/// A server answer the loops never stop for on their own: the server
/// keeps answering `more` while work remains. Guards a server that never
/// stops saying `more` from spinning the app forever.
const MAX_STEPS_WITHOUT_PROGRESS: u32 = 20;

/// One live file to trash: its id and the revision that was listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileToTrash {
    pub path_hash: [u8; 32],
    pub revision_id: RevisionId,
}

/// What a trash run did, by file id.
#[derive(Debug, Default)]
pub struct TrashOutcome {
    /// Files now in Trash (or already gone, which is the same to the user).
    pub trashed: usize,
    /// Files the server kept, with its code (`conflict`: changed since it
    /// was listed).
    pub kept: Vec<(String, String)>,
    /// The Trash item of each trashed file that is its own item.
    pub item_of_file: HashMap<String, String>,
    /// The folder item, for a folder run.
    pub folder_item: Option<String>,
}

/// Trash `files` in batches. With `folder`, they become ONE folder item:
/// `folder.1` continues an item an earlier run started, and `on_item`
/// hears the item id as soon as the first batch names it, before the next
/// batch is sent, so a stop part way can resume into it. A folder with no
/// files (only empty folders) still sends one batch, which makes its item.
pub async fn trash_in_batches(
    api: &TrashApi,
    ss58: &str,
    folder_hash: &str,
    files: &[FileToTrash],
    folder: Option<(&str, Option<String>)>,
    mut on_item: impl FnMut(&str),
    mut progress: impl FnMut(usize),
) -> Result<TrashOutcome, TrashRefusal> {
    let mut outcome = TrashOutcome {
        folder_item: folder.as_ref().and_then(|(_, item)| item.clone()),
        ..TrashOutcome::default()
    };
    let mut batches: Vec<&[FileToTrash]> = files.chunks(MAX_TRASH_FILES).collect();
    if batches.is_empty() && folder.is_some() {
        batches.push(&[]);
    }
    let mut done = 0usize;
    for batch in batches {
        let ids: Vec<String> = batch.iter().map(|f| file_id(&f.path_hash)).collect();
        let expected: BTreeMap<String, RevisionId> = batch.iter().zip(&ids).map(|(f, id)| (id.clone(), f.revision_id)).collect();
        let request = TrashFilesRequest {
            file_ids: ids,
            expected_revision_ids: (!expected.is_empty()).then_some(expected),
            folder_path: folder.as_ref().map(|(path, _)| path.to_string()),
            item_id: outcome.folder_item.clone(),
        };
        let answer = api.trash_files(ss58, folder_hash, &request).await?;
        if folder.is_some()
            && let Some(item) = answer.item_id.clone()
        {
            if outcome.folder_item.as_deref() != Some(item.as_str()) {
                on_item(&item);
            }
            outcome.folder_item = Some(item);
        }
        for file in answer.trashed {
            if let Some(item) = file.item_id {
                outcome.item_of_file.insert(file.file_id.clone(), item);
            }
            outcome.trashed += 1;
        }
        outcome.kept.extend(answer.errors.into_iter().map(|e| (e.file_id, e.code)));
        done += batch.len();
        progress(done);
    }
    Ok(outcome)
}

/// Restore `item_ids` in place, asking again while the server says `more`.
/// Returns each item's last status.
pub async fn restore_in_place(
    api: &TrashApi,
    ss58: &str,
    folder_hash: &str,
    item_ids: &[String],
    mut progress: impl FnMut(u64),
) -> Result<HashMap<String, String>, TrashRefusal> {
    let request = RestoreRequest {
        item_ids: item_ids.to_vec(),
        on_conflict: OnConflict::Fail,
        rename: None,
    };
    let mut statuses = HashMap::new();
    let mut restored = 0u64;
    let mut idle = 0u32;
    loop {
        let answer = api.restore(ss58, folder_hash, &request).await?;
        for item in answer.items {
            statuses.insert(item.item_id, item.status);
        }
        restored += answer.files_restored;
        progress(restored);
        idle = if answer.files_restored == 0 { idle + 1 } else { 0 };
        if !answer.more || idle >= MAX_STEPS_WITHOUT_PROGRESS {
            return Ok(statuses);
        }
    }
}

/// "Keep both": restore one item under new paths, a batch of renames per
/// call. Returns the item's last status.
#[allow(clippy::too_many_arguments)]
pub async fn restore_renamed(
    api: &TrashApi,
    ss58: &str,
    folder_hash: &str,
    item_id: &str,
    new_path: &str,
    renames: &[SingleRename],
    signing_key: &ed25519_dalek::SigningKey,
    mut progress: impl FnMut(u64),
) -> Result<String, TrashRefusal> {
    use ed25519_dalek::Signer;
    let mut status = "restored".to_string();
    let mut restored = 0u64;
    // An item of empty folders has no files to rename, and still needs one
    // call to come back under its new name.
    let chunks: Vec<&[SingleRename]> = if renames.is_empty() {
        vec![&[]]
    } else {
        renames.chunks(MAX_RESTORE_RENAMES).collect()
    };
    for chunk in chunks {
        let signature = signing_key.sign(BatchRenameRequest::generate_signing_text(chunk).as_bytes());
        let request = RestoreRequest {
            item_ids: vec![item_id.to_string()],
            on_conflict: OnConflict::Fail,
            rename: Some(RestoreRename {
                new_path: new_path.to_string(),
                renames: chunk.to_vec(),
                signature: signature.to_bytes().to_vec(),
                signing_key: signing_key.verifying_key().to_bytes(),
            }),
        };
        let mut idle = 0u32;
        loop {
            let answer = api.restore(ss58, folder_hash, &request).await?;
            if let Some(item) = answer.items.into_iter().find(|i| i.item_id == item_id) {
                status = item.status;
            }
            restored += answer.files_restored;
            progress(restored);
            if status != "restored" {
                return Ok(status);
            }
            idle = if answer.files_restored == 0 { idle + 1 } else { 0 };
            if !answer.more || idle >= MAX_STEPS_WITHOUT_PROGRESS {
                break;
            }
        }
    }
    Ok(status)
}

/// Plan "keep both" for one item: each file's path under `old_prefix`
/// moves under `new_prefix` (for a file item the two are its whole path),
/// sealed with the drive key. A file outside the prefix is refused: the
/// listing did not match what was asked.
pub fn plan_restore_renames(
    files: &[(String, [u8; 32], RevisionId)],
    old_prefix: &str,
    new_prefix: &str,
    key: &hcfs_crypto::FileKey,
) -> Result<Vec<SingleRename>, String> {
    let mut renames = Vec::with_capacity(files.len());
    for (path, path_hash, revision_id) in files {
        let Some(new_path) = crate::sync::remote_rename::replace_path_prefix(path, old_prefix, new_prefix) else {
            return Err(format!("\"{path}\" is not inside the item being restored."));
        };
        let sealed = hcfs_crypto::encrypt_small(new_path.as_bytes(), key).map_err(|e| format!("Could not seal the new path: {e}"))?;
        renames.push(SingleRename {
            old_path_hash: *path_hash,
            new_path_hash: hcfs_crypto::compute_path_hash(&new_path),
            new_encrypted_path: sealed,
            new_file_name: new_path.rsplit('/').next().map(str::to_string),
            new_relative_path: Some(new_path),
            base_revision_id: *revision_id,
        });
    }
    Ok(renames)
}

/// Delete items forever, [`MAX_DELETE_ITEMS`] per call, each asked again
/// while the server says `more`.
pub async fn delete_forever_in_batches(
    api: &TrashApi,
    ss58: &str,
    folder_hash: &str,
    item_ids: &[String],
    mut progress: impl FnMut(usize),
) -> Result<(), TrashRefusal> {
    let mut done = 0;
    for chunk in item_ids.chunks(MAX_DELETE_ITEMS) {
        let mut steps = 0u32;
        loop {
            steps += 1;
            let answer = api.delete_forever(ss58, folder_hash, chunk).await?;
            if !answer.more || steps >= MAX_STEPS_WITHOUT_PROGRESS {
                break;
            }
        }
        done += chunk.len();
        progress(done);
    }
    Ok(())
}

/// Empty one drive's Trash, asking again while the server says `more`.
pub async fn empty_until_done(api: &TrashApi, ss58: &str, folder_hash: &str) -> Result<u64, TrashRefusal> {
    let mut deleted = 0u64;
    let mut idle = 0u32;
    loop {
        let answer = api.empty(ss58, folder_hash).await?;
        deleted += answer.items_deleted;
        idle = if answer.items_deleted == 0 { idle + 1 } else { 0 };
        if !answer.more || idle >= MAX_STEPS_WITHOUT_PROGRESS {
            return Ok(deleted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_both_moves_every_file_under_the_new_name_and_seals_it() {
        let key = hcfs_crypto::FileKey::from_bytes([9; 32]);
        let files = vec![
            ("Trip/a.jpg".to_string(), [1; 32], RevisionId::from_bytes([2; 32])),
            ("Trip/day1/b.jpg".to_string(), [3; 32], RevisionId::from_bytes([4; 32])),
        ];
        let renames = plan_restore_renames(&files, "Trip", "Trip (1)", &key).unwrap();
        assert_eq!(renames[0].new_relative_path.as_deref(), Some("Trip (1)/a.jpg"));
        assert_eq!(renames[1].new_relative_path.as_deref(), Some("Trip (1)/day1/b.jpg"));
        assert_eq!(renames[1].new_file_name.as_deref(), Some("b.jpg"));
        assert_eq!(renames[1].new_path_hash, hcfs_crypto::compute_path_hash("Trip (1)/day1/b.jpg"));
        assert_eq!(
            renames[0].base_revision_id,
            RevisionId::from_bytes([2; 32]),
            "the trashed revision is what comes back"
        );
        let opened = hcfs_crypto::decrypt_small(&renames[0].new_encrypted_path, &key).unwrap();
        assert_eq!(opened, b"Trip (1)/a.jpg");

        let single = plan_restore_renames(
            &[("a.txt".to_string(), [1; 32], RevisionId::from_bytes([2; 32]))],
            "a.txt",
            "a (1).txt",
            &key,
        )
        .unwrap();
        assert_eq!(single[0].new_relative_path.as_deref(), Some("a (1).txt"));
    }

    #[test]
    fn keep_both_refuses_a_file_outside_the_item() {
        let key = hcfs_crypto::FileKey::from_bytes([9; 32]);
        let files = vec![("Trip Photos/a.jpg".to_string(), [1; 32], RevisionId::from_bytes([2; 32]))];
        assert!(
            plan_restore_renames(&files, "Trip", "Trip (1)", &key).is_err(),
            "a sibling sharing the prefix is not inside it"
        );
    }
}
