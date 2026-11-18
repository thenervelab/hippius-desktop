//! What a move between drives carries, decided before anything is sent.
//!
//! Pure: the listings come in, the copies and folders go out. This is where
//! a move is either whole or wrong (a folder missing a file is a folder the
//! commit refuses), so it is the part tested without a server.

use super::wire::{MAX_COMMIT_FOLDERS, MAX_DRIVE_MOVE_FILES, MoveFolder};
use crate::sync::files::move_entries::{
    Claimed, ClashChoice, Decision, Existing, MoveItem, MoveItemResult, basename_of, decide, join_path, normalize_drive_path, target_name,
};
use crate::sync::remote_rename::{RemoteEntry, RemoteFolderTree};
use std::collections::HashMap;

/// What one selected item is on the source drive, as the server lists it.
#[derive(Debug, Clone)]
pub enum ItemSource {
    File(RemoteEntry),
    Folder(RemoteFolderTree),
    /// Not on the server (deleted, or never uploaded).
    Missing,
}

/// One file's copy: the source row it replaces and its path in the
/// destination drive (both wire paths).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedCopy {
    pub source: RemoteEntryKey,
    pub dest_path: String,
}

/// The parts of a source row a copy needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntryKey {
    pub path: String,
    pub path_hash: [u8; 32],
    pub revision_id: [u8; 32],
    pub salted_hash: [u8; 32],
    pub size_bytes: u64,
}

impl From<&RemoteEntry> for RemoteEntryKey {
    fn from(e: &RemoteEntry) -> Self {
        Self {
            path: e.path.clone(),
            path_hash: e.path_hash,
            revision_id: e.revision_id,
            salted_hash: e.salted_hash,
            size_bytes: e.size_bytes,
        }
    }
}

/// An item that will move, and where it lands in the view's terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Going {
    pub index: usize,
    pub new_view_path: String,
}

/// The whole move.
#[derive(Debug, Default)]
pub struct MovePlan {
    /// Items that do not move, with their result already decided.
    pub settled: Vec<(usize, MoveItemResult)>,
    pub going: Vec<Going>,
    pub copies: Vec<PlannedCopy>,
    pub folders: Vec<MoveFolder>,
}

impl MovePlan {
    /// Whether an item still waits for the user's answer to a name clash.
    pub fn has_clashes(&self) -> bool {
        self.settled
            .iter()
            .any(|(_, r)| r.status == crate::sync::files::move_entries::MoveStatus::Clash)
    }

    pub fn total_bytes(&self) -> u64 {
        self.copies.iter().map(|c| c.source.size_bytes).sum()
    }

    /// The caps the server enforces, checked before anything is copied: a
    /// folder moves whole in one commit, so a move past them cannot be
    /// split without moving part of a folder, and is refused up front.
    pub fn over_caps(&self) -> Option<String> {
        if self.copies.len() > MAX_DRIVE_MOVE_FILES {
            return Some(format!(
                "That's {} files, and up to 2,000 can move to another drive at once. Move fewer at a time.",
                self.copies.len()
            ));
        }
        if self.folders.len() > MAX_COMMIT_FOLDERS {
            return Some("Up to 100 folders can move to another drive at once. Move fewer at a time.".into());
        }
        if self.copies.is_empty() && !self.folders.is_empty() {
            return Some("Empty folders can't move to another drive yet. Create the folder there instead.".into());
        }
        None
    }
}

/// Re-prefix `path` from `old` to `new`, or `None` when it is outside
/// `old`. The child test is `old` plus a separator: `Trip` must not take
/// `Trip Photos` with it.
fn reprefix(path: &str, old: &str, new: &str) -> Option<String> {
    if path == old {
        return Some(new.to_string());
    }
    path.strip_prefix(&format!("{old}/")).map(|rest| format!("{new}/{rest}"))
}

/// Decide every item against the destination listing.
///
/// `sources[i]` is what `items[i]` is on the source drive, its paths in
/// wire form; `source_root` and `dest_root` are the wire paths the view's
/// paths are relative to (a folder grant's folder, or empty).
/// `dest_listed` holds the names already in the destination folder,
/// lowercased, since a synced destination may sit on a disk that ignores
/// case.
///
/// Replace is not offered: the commit refuses an occupied target, so a
/// replace could not be part of the one atomic step, and a move that
/// deleted the file it was replacing and then failed would lose it.
pub(crate) fn plan_move(
    items: &[MoveItem],
    sources: &[ItemSource],
    source_root: &str,
    dest_root: &str,
    destination: &str,
    dest_listed: &HashMap<String, Existing>,
) -> MovePlan {
    let mut plan = MovePlan::default();
    let mut claimed = Claimed::default();
    let rooted = |root: &str, rel: &str| join_path(root.trim_matches('/'), rel);
    let dest_folder_wire = rooted(dest_root, destination);

    for (index, (item, source)) in items.iter().zip(sources).enumerate() {
        let rel = match normalize_drive_path(&item.path) {
            Ok(rel) if !rel.is_empty() => rel,
            Ok(_) => {
                plan.settled
                    .push((index, MoveItemResult::failed(item, "The drive itself can't be moved")));
                continue;
            }
            Err(e) => {
                plan.settled.push((index, MoveItemResult::failed(item, e.to_string())));
                continue;
            }
        };
        let name = match target_name(item, &rel) {
            Ok(name) => name,
            Err(e) => {
                plan.settled.push((index, MoveItemResult::failed(item, e.to_string())));
                continue;
            }
        };
        let is_folder = matches!(source, ItemSource::Folder(_));
        if matches!(source, ItemSource::Missing) {
            plan.settled
                .push((index, MoveItemResult::failed(item, "It's no longer here. Refresh and try again")));
            continue;
        }

        let existing = if claimed.has(&name) {
            Some(Existing::Folder)
        } else {
            dest_listed.get(&name.to_lowercase()).copied()
        };
        let taken = |c: &str| claimed.has(c) || dest_listed.contains_key(&c.to_lowercase());
        let choice = match item.on_clash {
            ClashChoice::Replace => ClashChoice::Ask,
            other => other,
        };
        let final_name = match decide(&name, is_folder, choice, existing, taken) {
            Decision::Go { name, .. } => name,
            Decision::Skip => {
                plan.settled.push((index, MoveItemResult::skipped(item)));
                continue;
            }
            Decision::Clash { is_folder } => {
                plan.settled.push((index, MoveItemResult::clash(item, is_folder)));
                continue;
            }
            Decision::Fail(message) => {
                plan.settled.push((index, MoveItemResult::failed(item, message)));
                continue;
            }
        };
        claimed.claim(&final_name);

        let old_wire = rooted(source_root, &rel);
        let new_wire = join_path(&dest_folder_wire, &final_name);
        match source {
            ItemSource::File(entry) => plan.copies.push(PlannedCopy {
                source: entry.into(),
                dest_path: new_wire,
            }),
            ItemSource::Folder(tree) => {
                let copies: Option<Vec<PlannedCopy>> = tree
                    .files
                    .iter()
                    .map(|entry| {
                        reprefix(&entry.path, &old_wire, &new_wire).map(|dest_path| PlannedCopy {
                            source: entry.into(),
                            dest_path,
                        })
                    })
                    .collect();
                // The walk only descends into the folder; a row outside it is
                // a listing that does not match what was asked for.
                let Some(copies) = copies else {
                    claimed.release(&final_name);
                    plan.settled.push((
                        index,
                        MoveItemResult::failed(item, "This folder changed while it was being read. Try again"),
                    ));
                    continue;
                };
                plan.copies.extend(copies);
                plan.folders.push(MoveFolder {
                    from: old_wire,
                    to: new_wire,
                });
            }
            ItemSource::Missing => unreachable!("handled above"),
        }
        plan.going.push(Going {
            index,
            new_view_path: join_path(destination, &final_name),
        });
    }
    plan
}

/// The name a listed entry is known by in its folder, lowercased.
pub fn listed_name(path: &str) -> String {
    basename_of(path.trim_end_matches('/')).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::files::move_entries::MoveStatus;

    fn entry(path: &str, seed: u8) -> RemoteEntry {
        RemoteEntry {
            path: path.into(),
            path_hash: [seed; 32],
            revision_id: [seed; 32],
            salted_hash: [seed; 32],
            size_bytes: 10,
        }
    }

    fn item(path: &str, is_folder: bool, on_clash: ClashChoice) -> MoveItem {
        MoveItem {
            path: path.into(),
            is_folder,
            name: None,
            on_clash,
        }
    }

    #[test]
    fn a_folder_moves_whole_under_its_new_name() {
        let tree = RemoteFolderTree {
            directory_paths: vec!["Trip".into(), "Trip/Day 1".into()],
            files: vec![entry("Trip/a.jpg", 1), entry("Trip/Day 1/b.jpg", 2)],
        };
        let plan = plan_move(
            &[item("Trip", true, ClashChoice::Ask)],
            &[ItemSource::Folder(tree)],
            "",
            "",
            "Albums",
            &HashMap::new(),
        );
        assert!(plan.settled.is_empty());
        assert_eq!(
            plan.folders,
            vec![MoveFolder {
                from: "Trip".into(),
                to: "Albums/Trip".into()
            }]
        );
        let dests: Vec<&str> = plan.copies.iter().map(|c| c.dest_path.as_str()).collect();
        assert_eq!(dests, ["Albums/Trip/a.jpg", "Albums/Trip/Day 1/b.jpg"]);
        assert_eq!(plan.going[0].new_view_path, "Albums/Trip");
    }

    #[test]
    fn a_taken_name_asks_then_keeps_both_or_skips_and_never_replaces() {
        let listed = HashMap::from([("a.txt".to_string(), Existing::File)]);
        let src = || vec![ItemSource::File(entry("a.txt", 1))];

        let ask = plan_move(&[item("a.txt", false, ClashChoice::Ask)], &src(), "", "", "", &listed);
        assert!(ask.has_clashes());
        assert!(ask.copies.is_empty(), "nothing is copied while a clash waits");

        let replace = plan_move(&[item("a.txt", false, ClashChoice::Replace)], &src(), "", "", "", &listed);
        assert!(replace.has_clashes(), "Replace is not offered between drives: it asks again");

        let keep = plan_move(&[item("a.txt", false, ClashChoice::KeepBoth)], &src(), "", "", "", &listed);
        assert_eq!(keep.copies[0].dest_path, "a (1).txt");

        let skip = plan_move(&[item("a.txt", false, ClashChoice::Skip)], &src(), "", "", "", &listed);
        assert_eq!(skip.settled[0].1.status, MoveStatus::Skipped);
        assert!(skip.copies.is_empty());
    }

    #[test]
    fn a_clash_ignores_case_and_two_items_cannot_share_a_name() {
        let listed = HashMap::from([("report.pdf".to_string(), Existing::File)]);
        let plan = plan_move(
            &[item("A/Report.PDF", false, ClashChoice::Ask)],
            &[ItemSource::File(entry("A/Report.PDF", 1))],
            "",
            "",
            "",
            &listed,
        );
        assert!(plan.has_clashes());

        let two = plan_move(
            &[
                item("A/x.txt", false, ClashChoice::KeepBoth),
                item("B/x.txt", false, ClashChoice::KeepBoth),
            ],
            &[ItemSource::File(entry("A/x.txt", 1)), ItemSource::File(entry("B/x.txt", 2))],
            "",
            "",
            "",
            &HashMap::new(),
        );
        let dests: Vec<&str> = two.copies.iter().map(|c| c.dest_path.as_str()).collect();
        assert_eq!(dests, ["x.txt", "x (1).txt"]);
    }

    #[test]
    fn a_grant_root_prefixes_both_sides() {
        let plan = plan_move(
            &[item("a.txt", false, ClashChoice::Ask)],
            &[ItemSource::File(entry("Team/a.txt", 1))],
            "Team",
            "",
            "Inbox",
            &HashMap::new(),
        );
        assert_eq!(plan.copies[0].dest_path, "Inbox/a.txt");
        assert_eq!(plan.copies[0].source.path, "Team/a.txt");
    }

    #[test]
    fn a_missing_item_fails_alone() {
        let plan = plan_move(
            &[item("gone.txt", false, ClashChoice::Ask), item("here.txt", false, ClashChoice::Ask)],
            &[ItemSource::Missing, ItemSource::File(entry("here.txt", 2))],
            "",
            "",
            "",
            &HashMap::new(),
        );
        assert_eq!(plan.settled[0].1.status, MoveStatus::Failed);
        assert_eq!(plan.copies.len(), 1);
    }

    #[test]
    fn a_folder_listing_with_a_stray_row_is_refused_rather_than_moved_in_part() {
        let tree = RemoteFolderTree {
            directory_paths: vec!["Trip".into()],
            files: vec![entry("Trip/a.jpg", 1), entry("Trip Photos/b.jpg", 2)],
        };
        let plan = plan_move(
            &[item("Trip", true, ClashChoice::Ask)],
            &[ItemSource::Folder(tree)],
            "",
            "",
            "",
            &HashMap::new(),
        );
        assert_eq!(plan.settled[0].1.status, MoveStatus::Failed);
        assert!(plan.copies.is_empty());
        assert!(plan.folders.is_empty());
    }

    #[test]
    fn caps_are_refused_up_front_in_words() {
        let mut plan = MovePlan::default();
        assert_eq!(plan.over_caps(), None);
        plan.folders.push(MoveFolder {
            from: "a".into(),
            to: "b".into(),
        });
        assert!(plan.over_caps().unwrap().starts_with("Empty folders"));
        plan.copies = (0..=MAX_DRIVE_MOVE_FILES)
            .map(|i| PlannedCopy {
                source: (&entry(&format!("a/{i}"), 1)).into(),
                dest_path: format!("b/{i}"),
            })
            .collect();
        assert!(plan.over_caps().unwrap().contains("2,000"));
        plan.copies.truncate(MAX_DRIVE_MOVE_FILES);
        assert_eq!(plan.over_caps(), None);
        plan.folders = (0..=MAX_COMMIT_FOLDERS)
            .map(|i| MoveFolder {
                from: format!("a{i}"),
                to: format!("b{i}"),
            })
            .collect();
        assert!(plan.over_caps().unwrap().contains("100 folders"));
    }
}
