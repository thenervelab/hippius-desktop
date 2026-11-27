//! The loops that carry a Trash operation of any size through the server's
//! per-call batches: trash by file id, list, restore in place or as a copy,
//! delete forever and empty.
//!
//! Every call is hcfs-client's (`HcfsClient::trash_files`, `restore_trash`,
//! `restore_trash_as`, ...), so the bodies are hcfs-shared's own types. What
//! the loops add is the contract around the calls, which the server leaves
//! to its clients:
//!
//! - **A folder is one item under an id this computer picks.** The id is
//!   minted before the first call and recorded by the caller (`on_item`)
//!   before that call is sent, then sent on every call of the group, so a
//!   lost answer leaves nothing to guess: the same call, or trashing the
//!   folder again, continues the same item. Every call but the last says
//!   `more: true`; once an answer named the item, every later call says
//!   `continue_item: true`. A closing call that answers `more` (the empty
//!   folders took more than one call) is sent again until it does not.
//! - **`more` means "the same request again".** Restore and Empty are asked
//!   again until they answer `more: false`; a restore still `checking` a
//!   large item for conflicts moves nothing and is asked again too.
//! - **Keep both is hcfs-client's planner** (`restore_trash_as`): it lists
//!   the item's files, gives each the new id in the hash form its device
//!   used, seals the new path, signs the server's restore text and sends
//!   the item a batch at a time.
//!
//! No Tauri types here: `tests/trash_server_mock.rs` drives these loops
//! against a stand-in server.

use super::wire::{MAX_TRASH_FILE_IDS, MAX_TRASH_ITEM_IDS, RestoreConflict, TRASH_LIST_MAX_LIMIT, TrashItem, TrashRefusal, file_id};
use hcfs_client::client::HcfsClient;
use hcfs_client::client::trash::{RestoreTrashOutcome, TrashRestoreTarget};
use hcfs_shared::network::{ListTrashQuery, TrashFilesRequest};
use hcfs_shared::revision_id::RevisionId;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Answers in a row that move nothing before a loop stops: guards a server
/// that never stops saying `more` from spinning the app forever. A restore
/// that is `checking` is exempt, since checking moves nothing by design.
const MAX_IDLE_STEPS: u32 = 20;

/// Closing calls one folder gets. Each moves up to the server's batch of
/// empty folders (5,000), so this is room for millions of them.
const MAX_CLOSING_CALLS: u32 = 1_000;

/// Listing pages one drive gets (200 items each).
const MAX_LIST_PAGES: u32 = 10_000;

/// A new folder item id: 32 lowercase hex, the form the server mints.
pub fn new_item_id() -> String {
    hcfs_client::client::trash::new_trash_item_id()
}

/// One live file to trash: its id and the revision that was listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileToTrash {
    pub path_hash: [u8; 32],
    pub revision_id: RevisionId,
}

/// What a trash run did, by file id.
#[derive(Debug, Default)]
pub struct TrashOutcome {
    /// Files this run moved into Trash.
    pub trashed: u64,
    /// Files the server kept, with its code (`conflict`: changed since it
    /// was listed).
    pub kept: Vec<(String, String)>,
    /// The Trash item of each loose file.
    pub item_of_file: HashMap<String, String>,
    /// The folder item, once an answer named it (a folder of nothing at
    /// all makes none).
    pub folder_item: Option<String>,
}

fn expected(batch: &[FileToTrash]) -> (Vec<String>, BTreeMap<String, RevisionId>) {
    let ids: Vec<String> = batch.iter().map(|f| file_id(&f.path_hash)).collect();
    let expected = batch.iter().zip(&ids).map(|(f, id)| (id.clone(), f.revision_id)).collect();
    (ids, expected)
}

/// Trash loose files, each its own item, [`MAX_TRASH_FILE_IDS`] per call.
/// Every id carries the revision that was listed, so a file that changed
/// on another device stays (`conflict`), and the call is safe to resend.
pub async fn trash_files(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    files: &[FileToTrash],
    mut progress: impl FnMut(u64),
) -> Result<TrashOutcome, TrashRefusal> {
    let mut outcome = TrashOutcome::default();
    let mut done = 0u64;
    for batch in files.chunks(MAX_TRASH_FILE_IDS) {
        let (ids, expected) = expected(batch);
        let request = TrashFilesRequest {
            file_ids: ids,
            expected_revision_ids: Some(expected),
            ..TrashFilesRequest::default()
        };
        let answer = client
            .trash_files(ss58, folder_hash, &request)
            .await
            .map_err(|e| TrashRefusal::from_sync(&e))?;
        outcome.trashed += answer.files_trashed;
        for file in answer.trashed {
            if let Some(item) = file.item_id {
                outcome.item_of_file.insert(file.file_id, item);
            }
        }
        outcome.kept.extend(answer.errors.into_iter().map(|e| (e.file_id, e.code)));
        done += batch.len() as u64;
        progress(done);
    }
    Ok(outcome)
}

/// Trash a folder as ONE item: `files` (every file under it, any number)
/// in batches, then its empty folders on the closing call.
///
/// `item_id` is the item's id, picked by the caller ([`new_item_id`], or
/// the one an unfinished earlier run recorded) and recorded before this
/// runs. If the server says that id names an item that already closed
/// (`item_state`: an earlier run finished but was never told), a fresh id
/// is picked, handed to `on_new_item` to record, and the run starts over;
/// the files the closed item holds answer `already_deleted`.
#[allow(clippy::too_many_arguments)]
pub async fn trash_folder(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    folder_path: &str,
    files: &[FileToTrash],
    item_id: &str,
    mut on_new_item: impl FnMut(&str),
    mut progress: impl FnMut(u64),
) -> Result<TrashOutcome, TrashRefusal> {
    let mut item_id = item_id.to_string();
    let mut fresh_tried = false;
    loop {
        match trash_folder_once(client, ss58, folder_hash, folder_path, files, &item_id, &mut progress).await {
            Err(refusal) if refusal.is("item_state") && !fresh_tried => {
                fresh_tried = true;
                item_id = new_item_id();
                on_new_item(&item_id);
            }
            other => return other,
        }
    }
}

async fn trash_folder_once(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    folder_path: &str,
    files: &[FileToTrash],
    item_id: &str,
    progress: &mut impl FnMut(u64),
) -> Result<TrashOutcome, TrashRefusal> {
    let mut outcome = TrashOutcome::default();
    // A folder of only empty folders still sends one (closing) call, which
    // moves them.
    let mut batches: Vec<&[FileToTrash]> = files.chunks(MAX_TRASH_FILE_IDS).collect();
    if batches.is_empty() {
        batches.push(&[]);
    }
    let last = batches.len() - 1;
    let mut named = false;
    let mut done = 0u64;
    let mut more_to_close = false;
    for (index, batch) in batches.into_iter().enumerate() {
        let (ids, expected) = expected(batch);
        let request = TrashFilesRequest {
            file_ids: ids,
            expected_revision_ids: (!expected.is_empty()).then_some(expected),
            // The per-file successes are not needed: the item is the answer.
            quiet: true,
            folder_path: Some(folder_path.to_string()),
            item_id: Some(item_id.to_string()),
            more: index != last,
            continue_item: named,
        };
        let answer = client
            .trash_files(ss58, folder_hash, &request)
            .await
            .map_err(|e| TrashRefusal::from_sync(&e))?;
        if answer.item_id.is_some() {
            named = true;
        }
        outcome.trashed += answer.files_trashed;
        outcome.kept.extend(answer.errors.into_iter().map(|e| (e.file_id, e.code)));
        done += batch.len() as u64;
        progress(done);
        more_to_close = index == last && answer.more;
    }
    let mut closing = 0;
    while more_to_close {
        closing += 1;
        if closing > MAX_CLOSING_CALLS {
            return Err(TrashRefusal::no_answer());
        }
        let request = TrashFilesRequest {
            folder_path: Some(folder_path.to_string()),
            item_id: Some(item_id.to_string()),
            continue_item: named,
            ..TrashFilesRequest::default()
        };
        let answer = client
            .trash_files(ss58, folder_hash, &request)
            .await
            .map_err(|e| TrashRefusal::from_sync(&e))?;
        if answer.item_id.is_some() {
            named = true;
        }
        more_to_close = answer.more;
    }
    outcome.folder_item = named.then(|| item_id.to_string());
    Ok(outcome)
}

/// Every item in one drive's Trash, newest first, and the retention the
/// listing names. Pages on the server's own cursor, which a folder-grant
/// holder needs: its page can be empty and still have more.
pub async fn list_all(client: &HcfsClient, ss58: &str, folder_hash: &str) -> Result<(Vec<TrashItem>, u32), TrashRefusal> {
    let mut items = Vec::new();
    let mut query = ListTrashQuery {
        limit: Some(TRASH_LIST_MAX_LIMIT),
        ..ListTrashQuery::default()
    };
    let mut retention = super::wire::DEFAULT_RETENTION_DAYS;
    for _ in 0..MAX_LIST_PAGES {
        let page = client
            .list_trash(ss58, folder_hash, &query)
            .await
            .map_err(|e| TrashRefusal::from_sync(&e))?;
        retention = super::wire::retention_days(Some(page.trash_retention_days));
        items.extend(page.items);
        match (page.has_more, page.next_after_trashed_at, page.next_after_item_id) {
            (true, Some(at), Some(id)) => {
                query.after_trashed_at = Some(at);
                query.after_item_id = Some(id);
            }
            _ => break,
        }
    }
    Ok((items, retention))
}

/// How an in-place restore of some items went.
#[derive(Debug, Default)]
pub struct RestoreAnswer {
    /// Items now wholly out of Trash.
    pub restored: HashSet<String>,
    /// Items left alone because live files hold their paths (`fail`).
    pub clashed: HashSet<String>,
    /// Items the server no longer has (restored or deleted elsewhere).
    pub missing: HashSet<String>,
    /// Files `skip` left in Trash because their path was taken.
    pub skipped_files: Vec<String>,
}

/// Restore `item_ids` in place, [`MAX_TRASH_ITEM_IDS`] per request, asking
/// each request again while the server says `more`.
///
/// With `fail`, a request that meets a live file answers `name_conflict`
/// for ONE item and restores nothing in that call: that item is set aside
/// as clashed and the rest are asked again, so one taken name never holds
/// the others back.
pub async fn restore_in_place(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    item_ids: &[String],
    on_conflict: RestoreConflict,
    mut progress: impl FnMut(u64),
) -> Result<RestoreAnswer, TrashRefusal> {
    let mut answer = RestoreAnswer::default();
    let mut files = 0u64;
    for chunk in item_ids.chunks(MAX_TRASH_ITEM_IDS) {
        let mut pending: Vec<String> = chunk.to_vec();
        let mut idle = 0u32;
        while !pending.is_empty() {
            match client.restore_trash(ss58, folder_hash, &pending, on_conflict).await {
                Ok(RestoreTrashOutcome::Restored(result)) => {
                    let moved = result.files_restored + result.entries_restored;
                    files += result.files_restored;
                    progress(files);
                    answer.restored.extend(result.items_restored.iter().cloned());
                    answer.skipped_files.extend(result.skipped);
                    if !result.more {
                        break;
                    }
                    let checking = result.phase.as_deref() == Some("checking");
                    idle = if moved > 0 || checking || !result.items_restored.is_empty() {
                        0
                    } else {
                        idle + 1
                    };
                    if idle >= MAX_IDLE_STEPS {
                        return Err(TrashRefusal::no_answer());
                    }
                }
                Ok(RestoreTrashOutcome::NameConflict { conflict, .. }) => {
                    if !pending.contains(&conflict.item_id) {
                        // A conflict naming no item asked for: nothing to set
                        // aside, so asking again would loop.
                        return Err(TrashRefusal::coded(409, "name_conflict"));
                    }
                    pending.retain(|id| id != &conflict.item_id);
                    answer.clashed.insert(conflict.item_id);
                }
                Ok(_) => return Err(TrashRefusal::no_answer()),
                Err(e) => {
                    let refusal = TrashRefusal::from_sync(&e);
                    if refusal.is("item_not_found") {
                        // None of the items asked for exists any more.
                        for id in pending.drain(..) {
                            if !answer.restored.contains(&id) {
                                answer.missing.insert(id);
                            }
                        }
                        break;
                    }
                    return Err(refusal);
                }
            }
        }
    }
    Ok(answer)
}

/// What a keep-both restore did.
#[derive(Debug, PartialEq, Eq)]
pub enum KeepBoth {
    /// The whole item is back under the new path.
    Restored { files: u64 },
    /// Something live holds the new path (or a planned new id) now; the
    /// item is untouched apart from batches an earlier call committed.
    NameTaken,
}

/// Keep both: restore one item under `new_path`, beside whatever holds its
/// old path now. hcfs-client plans, seals, signs and sends it to the end.
#[allow(clippy::too_many_arguments)]
pub async fn restore_as(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    item_id: &str,
    item_path: &str,
    new_path: &str,
    key: &hcfs_crypto::FileKey,
    signing_key: &ed25519_dalek_v3::SigningKey,
) -> Result<KeepBoth, TrashRefusal> {
    let target = TrashRestoreTarget {
        ss58_address: ss58,
        folder_hash,
        item_id,
        item_path,
        new_path,
    };
    match client.restore_trash_as(target, key, signing_key).await {
        Ok(RestoreTrashOutcome::Restored(total)) => Ok(KeepBoth::Restored { files: total.files_restored }),
        Ok(RestoreTrashOutcome::NameConflict { .. }) => Ok(KeepBoth::NameTaken),
        Ok(_) => Err(TrashRefusal::no_answer()),
        Err(e) => {
            let refusal = TrashRefusal::from_restore(&e);
            if refusal.is("target_exists") {
                return Ok(KeepBoth::NameTaken);
            }
            Err(refusal)
        }
    }
}

/// Delete items forever, [`MAX_TRASH_ITEM_IDS`] per call. Returns how many
/// the server marked.
pub async fn delete_forever(
    client: &HcfsClient,
    ss58: &str,
    folder_hash: &str,
    item_ids: &[String],
    mut progress: impl FnMut(u64),
) -> Result<u64, TrashRefusal> {
    let mut marked = 0u64;
    let mut done = 0u64;
    for chunk in item_ids.chunks(MAX_TRASH_ITEM_IDS) {
        let answer = client
            .delete_trash_forever(ss58, folder_hash, chunk)
            .await
            .map_err(|e| TrashRefusal::from_sync(&e))?;
        marked += answer.items_marked;
        done += chunk.len() as u64;
        progress(done);
    }
    Ok(marked)
}

/// Empty one drive's Trash, asking again while the server says `more`.
/// Returns how many items the answers marked (a resent call can undercount:
/// hcfs-client's `empty_trash` explains why).
pub async fn empty(client: &HcfsClient, ss58: &str, folder_hash: &str) -> Result<u64, TrashRefusal> {
    let mut marked = 0u64;
    let mut idle = 0u32;
    loop {
        let answer = client.empty_trash(ss58, folder_hash).await.map_err(|e| TrashRefusal::from_sync(&e))?;
        marked += answer.items_marked;
        if !answer.more {
            return Ok(marked);
        }
        idle = if answer.items_marked == 0 { idle + 1 } else { 0 };
        if idle >= MAX_IDLE_STEPS {
            return Err(TrashRefusal::no_answer());
        }
    }
}
