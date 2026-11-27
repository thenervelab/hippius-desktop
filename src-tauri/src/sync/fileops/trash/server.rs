//! The server half of Move to Trash, shared by a drive synced here and a
//! drive browsed from the server: find each row on Hippius by its path,
//! then send the rows to Trash through `run`'s loops.
//!
//! A drive synced here adds the local half around this (the sync lock and
//! the hold, in `mod.rs`); a drive browsed from the server has no local
//! copy, so this is all of it. Both go through the same calls, the same
//! folder-item ids and the same resume journal, so there is one copy of
//! the loops.

use super::hold;
use super::run::{self, FileToTrash};
use crate::error::Result;
use crate::sync::drive_move::entry_path;
use crate::sync::files::move_entries::{basename_of, join_path, parent_of};
use crate::sync::remote_rename::{RemoteFolderTree, browse_directory, collect_folder_tree};
use hcfs_client::client::HcfsClient;
use hcfs_shared::network::RemoteFileEntry;
use std::collections::HashMap;
use std::path::Path;
use tracing::warn;

/// A drive's server side, as Trash reaches it.
pub struct ServerDrive<'a> {
    pub client: &'a HcfsClient,
    pub ss58: &'a str,
    pub folder_hash: &'a str,
    /// The wire path the drive's rows are relative to: a folder grant's
    /// folder (`identity::rooted_path`), else empty for the drive's top.
    pub wire_root: &'a str,
    /// Opens a listed row's sealed path when the server holds no plaintext.
    pub key: &'a hcfs_crypto::FileKey,
}

impl ServerDrive<'_> {
    /// A row's path as the server names it.
    pub fn wire_path(&self, rel: &str) -> String {
        join_path(self.wire_root.trim_matches('/'), rel)
    }
}

/// What Hippius holds at a row's path.
#[derive(Debug)]
pub enum OnServer {
    Folder(RemoteFolderTree),
    /// Boxed: a listed row is far larger than the other two.
    File(Box<RemoteFileEntry>),
    Missing,
}

impl OnServer {
    /// The live files to trash and their total size.
    pub fn files(&self) -> (Vec<FileToTrash>, u64) {
        match self {
            OnServer::Folder(tree) => (
                tree.files
                    .iter()
                    .map(|f| FileToTrash {
                        path_hash: f.path_hash,
                        revision_id: f.revision_id,
                    })
                    .collect(),
                tree.files.iter().map(|f| f.size_bytes).sum(),
            ),
            OnServer::File(entry) => (
                vec![FileToTrash {
                    path_hash: entry.path_hash,
                    revision_id: entry.revision_id,
                }],
                entry.size_bytes,
            ),
            OnServer::Missing => (Vec::new(), 0),
        }
    }
}

/// Parent folders already listed in this run, so rows that share a folder
/// read it once.
#[derive(Default)]
pub struct Listings(HashMap<String, (Vec<String>, Vec<RemoteFileEntry>)>);

/// Look a row up on Hippius by its drive-relative path. `known_folder`:
/// its local copy is a folder, so its tree is read without listing its
/// parent. Otherwise the parent's listing says which it is: a subfolder of
/// that name, a file at that path, or nothing.
pub async fn find(drive: &ServerDrive<'_>, listings: &mut Listings, rel: &str, known_folder: bool) -> Result<OnServer> {
    let wire = drive.wire_path(rel);
    if !known_folder {
        let parent = parent_of(&wire).to_string();
        if !listings.0.contains_key(&parent) {
            let listed = browse_directory(drive.client, drive.ss58, drive.folder_hash, &parent).await?;
            listings.0.insert(parent.clone(), listed);
        }
        let (folders, files) = &listings.0[&parent];
        if let Some(entry) = files.iter().find(|entry| entry_path(entry, drive.key).as_deref() == Some(wire.as_str())) {
            return Ok(OnServer::File(Box::new(entry.clone())));
        }
        let name = basename_of(&wire);
        if !folders.iter().any(|folder| basename_of(folder) == name) {
            return Ok(OnServer::Missing);
        }
    }
    let tree = collect_folder_tree(drive.client, drive.ss58, drive.folder_hash, &wire, drive.key).await?;
    Ok(OnServer::Folder(tree))
}

/// One row to send to Trash.
pub struct ToSend {
    /// Drive-relative path.
    pub rel: String,
    pub is_dir: bool,
    /// Every live file under it (the file itself for a file).
    pub files: Vec<FileToTrash>,
}

/// What the server did with one row: the Trash items it became (none when
/// the server named none), or the sentence for why it stayed.
pub type Sent = std::result::Result<Vec<String>, String>;

/// Send rows to Trash. Loose files go in one batched run, each its own
/// item; each folder is one item under an id picked here and recorded in
/// `journal` (the drive's folder here, or this computer's journal for a
/// drive browsed from the server) before the first call, so trashing the
/// folder again after a stop continues the same item. `progress` gets the
/// files done so far. The answers are in the order of `rows`.
pub async fn send(drive: &ServerDrive<'_>, journal: &Path, rows: &[ToSend], progress: impl Fn(u64)) -> Vec<Sent> {
    let mut answers: Vec<Option<Sent>> = rows.iter().map(|_| None).collect();
    let mut done = 0u64;

    let loose: Vec<usize> = (0..rows.len()).filter(|&i| !rows[i].is_dir).collect();
    if !loose.is_empty() {
        let batch: Vec<FileToTrash> = loose.iter().flat_map(|&i| rows[i].files.clone()).collect();
        let base = done;
        let sent = run::trash_files(drive.client, drive.ss58, drive.folder_hash, &batch, |n| progress(base + n)).await;
        done += batch.len() as u64;
        match sent {
            Ok(outcome) => {
                let kept: HashMap<&str, &str> = outcome.kept.iter().map(|(id, code)| (id.as_str(), code.as_str())).collect();
                for &i in &loose {
                    let Some(first) = rows[i].files.first() else {
                        answers[i] = Some(Err(kept_sentence(&rows[i].rel, "")));
                        continue;
                    };
                    let id = super::wire::file_id(&first.path_hash);
                    answers[i] = Some(match kept.get(id.as_str()) {
                        Some(code) => Err(kept_sentence(&rows[i].rel, code)),
                        None => Ok(outcome.item_of_file.get(&id).cloned().into_iter().collect()),
                    });
                }
            }
            Err(r) => {
                for &i in &loose {
                    answers[i] = Some(Err(r.sentence()));
                }
            }
        }
    }

    for (i, row) in rows.iter().enumerate().filter(|(_, row)| row.is_dir) {
        let wire = drive.wire_path(&row.rel);
        // The journal is keyed by the server path, which names the folder
        // the same whatever label it was reached under.
        let item_id = hold::resumed_item(journal, &wire).unwrap_or_else(run::new_item_id);
        let remember = |item: &str| {
            if let Err(e) = hold::remember_item(journal, &wire, item) {
                warn!(error = %e, "Move to Trash: the resume journal could not be written");
            }
        };
        remember(&item_id);
        let base = done;
        let sent = run::trash_folder(drive.client, drive.ss58, drive.folder_hash, &wire, &row.files, &item_id, remember, |n| {
            progress(base + n);
        })
        .await;
        done += row.files.len().max(1) as u64;
        answers[i] = Some(match sent {
            Ok(outcome) => {
                hold::forget_item(journal, &wire);
                match outcome.kept.first() {
                    // Part of the folder stayed live: on a drive synced here
                    // the engine removes what was trashed and keeps the rest.
                    Some((_, code)) => Err(kept_sentence(&row.rel, code)),
                    None => Ok(outcome.folder_item.into_iter().collect()),
                }
            }
            Err(r) => {
                // The item is gone (restored or deleted forever elsewhere):
                // nothing to continue. Otherwise the journal keeps it, and
                // trashing the folder again resumes it.
                if r.is("item_not_found") {
                    hold::forget_item(journal, &wire);
                }
                Err(r.sentence())
            }
        });
    }
    answers
        .into_iter()
        .map(|a| a.unwrap_or_else(|| Err("Hippius couldn't move it to Trash.".into())))
        .collect()
}

/// Why the server kept a file, in words.
pub fn kept_sentence(rel: &str, code: &str) -> String {
    let name = basename_of(rel);
    match code {
        "conflict" => format!("\"{name}\" changed on another device, so it was kept."),
        _ => format!("Hippius couldn't move \"{name}\" to Trash."),
    }
}
