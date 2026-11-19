//! The wire types of hcfs-server's Drive Trash routes
//! (`/v1/trash/{ss58_address}/{folder_hash}/...`), and the sentence a person
//! reads for each refusal.
//!
//! Defined here rather than imported: the pinned hcfs-shared has no Trash
//! types yet, and the server routes are still a drafted contract. Every
//! field name the desktop sends or reads lives in this one file, so when the
//! server lands only this file (and its tests) needs to follow it. The
//! tests at the bottom pin the JSON both sides exchange.

use hcfs_shared::network::SingleRename;
use hcfs_shared::revision_id::RevisionId;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

/// Most file ids one `POST .../files` carries (as `/delete_files`).
pub const MAX_TRASH_FILES: usize = 1_000;
/// Most items one `POST .../delete` carries.
pub const MAX_DELETE_ITEMS: usize = 100;
/// Most renames one "keep both" restore call carries; a larger item is
/// restored across calls, one batch of renames each.
pub const MAX_RESTORE_RENAMES: usize = 2_000;
/// Largest page the listing serves.
pub const LIST_PAGE: u32 = 200;
/// Days an item stays in Trash when the server names none.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// The days an item stays in Trash before the server deletes it forever:
/// what the server said (`trash_retention_days`), else 30. The server
/// purges; the desktop only says when.
pub fn retention_days(server: Option<u32>) -> u32 {
    server.filter(|d| *d > 0).unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// `POST /v1/trash/{ss58}/{folder_hash}/files`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashFilesRequest {
    /// 64-hex `path_hash` file ids, spelled as `/delete_files` spells them.
    pub file_ids: Vec<String>,
    /// Per file id, the revision the caller means to trash. A file that has
    /// moved on since it was listed stays put and answers `conflict`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision_ids: Option<BTreeMap<String, RevisionId>>,
    /// Groups the files into one folder item (with its empty folders), so a
    /// folder comes back whole from Trash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    /// Continues the folder item an earlier batch started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}

/// One file the server answered for, trashed or already gone.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashedFile {
    pub file_id: String,
    /// `trashed` or `already_deleted`.
    pub status: String,
    /// The Trash item this file became, when it is its own item.
    #[serde(default)]
    pub item_id: Option<String>,
}

/// One file the server kept, and why.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashFileError {
    pub file_id: String,
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// The `Success` of `POST .../files`. Mirrors `/delete_files`: a 200 with a
/// per-file answer, even when some files were kept.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashFilesResult {
    #[serde(default, alias = "deleted")]
    pub trashed: Vec<TrashedFile>,
    #[serde(default)]
    pub errors: Vec<TrashFileError>,
    /// The folder item, when the request carried `folder_path`.
    #[serde(default)]
    pub item_id: Option<String>,
}

/// `file` or `folder`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashItemKind {
    File,
    Folder,
}

/// One row of `GET .../`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashItem {
    pub item_id: String,
    pub kind: TrashItemKind,
    /// The original path in the drive. Stored in plaintext on the server, as
    /// in `file_records`; absent on rows from clients that never sent it.
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    /// The sealed path, for a file row with no plaintext path.
    #[serde(default)]
    pub encrypted_path: Option<Vec<u8>>,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub recording_count: u64,
    /// Unix seconds.
    #[serde(deserialize_with = "unix_seconds")]
    pub trashed_at: i64,
    /// Unix seconds: when the server deletes the item forever
    /// (`trashed_at` plus the retention). Absent on a server that predates
    /// it; the webview then counts from `trashed_at`.
    #[serde(default, deserialize_with = "optional_unix_seconds")]
    pub purge_at: Option<i64>,
    #[serde(default)]
    pub trashed_by: Option<String>,
    /// A live item holds the original path now, so restore in place clashes.
    #[serde(default)]
    pub name_taken: bool,
}

/// The `Success` of `GET .../`: newest first, keyset paged.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashListPage {
    #[serde(default)]
    pub items: Vec<TrashItem>,
    #[serde(default)]
    pub has_more: bool,
    /// The retention, at the top level or in the drive `totals`.
    #[serde(default)]
    pub trash_retention_days: Option<u32>,
    #[serde(default)]
    pub totals: Option<TrashTotals>,
}

/// The drive totals beside a listing page; only the retention is read.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TrashTotals {
    #[serde(default)]
    pub trash_retention_days: Option<u32>,
}

/// Where the next page starts: the last row of this one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListCursor {
    pub after_trashed_at: i64,
    pub after_item_id: String,
}

impl TrashListPage {
    /// The retention this page names, if any.
    pub fn retention_days(&self) -> Option<u32> {
        self.trash_retention_days
            .or_else(|| self.totals.as_ref().and_then(|t| t.trash_retention_days))
    }

    pub fn next_cursor(&self) -> Option<ListCursor> {
        if !self.has_more {
            return None;
        }
        self.items.last().map(|last| ListCursor {
            after_trashed_at: last.trashed_at,
            after_item_id: last.item_id.clone(),
        })
    }
}

/// The `Success` of `GET .../items/{item_id}/files`: the fields `/browse`
/// returns, paged by offset.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TrashItemFilesPage {
    #[serde(default)]
    pub files: Vec<hcfs_shared::network::RemoteFileEntry>,
    #[serde(default)]
    pub has_more: bool,
}

/// What restore does when the original path is taken.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OnConflict {
    /// The item is restored whole or not at all, and answers `name_taken`.
    #[default]
    Fail,
    /// Restore the rest of the item, leave the clashing files in Trash.
    Skip,
}

/// "Keep both": the item's files under new paths the client planned and
/// sealed, signed as `/rename_files` signs (hcfs-shared's signing text).
/// An item larger than one batch is restored across calls, each carrying
/// the next batch of its files; the item stays in Trash until its last.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RestoreRename {
    /// The item's own new path ("Trip (1)", "a (1).txt"), so its empty
    /// folders follow its files.
    pub new_path: String,
    pub renames: Vec<SingleRename>,
    /// 64 bytes, a JSON byte array as `/rename_files` sends it.
    pub signature: Vec<u8>,
    pub signing_key: [u8; 32],
}

/// `POST .../restore`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RestoreRequest {
    pub item_ids: Vec<String>,
    #[serde(default)]
    pub on_conflict: OnConflict,
    /// Only with exactly one item: restore these of its files under new
    /// names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<RestoreRename>,
}

/// One item's answer to a restore.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct RestoredItem {
    pub item_id: String,
    /// `restored`, `name_taken` or `not_found` (and `partial` for a skip
    /// that left clashing files behind).
    pub status: String,
}

/// The `Success` of `POST .../restore`. `more`: a large item is restored
/// across calls; asking again with the same body continues it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct RestoreResult {
    #[serde(default)]
    pub items: Vec<RestoredItem>,
    #[serde(default)]
    pub more: bool,
    /// Files this call put back, for the progress line.
    #[serde(default)]
    pub files_restored: u64,
}

/// The `Success` of `POST .../delete` and `POST .../empty`. Both hide the
/// items at once; `more`: ask again with the same body to finish.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct DeleteItemsResult {
    #[serde(default)]
    pub more: bool,
    #[serde(default)]
    pub items_deleted: u64,
}

/// `POST .../delete`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct DeleteItemsRequest {
    pub item_ids: Vec<String>,
}

/// A path hash as `/delete_files` spells a file id.
pub fn file_id(path_hash: &[u8; 32]) -> String {
    hex::encode(path_hash)
}

/// A timestamp as unix seconds, from a number or an RFC 3339 string.
fn unix_seconds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stamp {
        Seconds(i64),
        Text(String),
    }
    match Stamp::deserialize(deserializer)? {
        Stamp::Seconds(s) => Ok(s),
        Stamp::Text(t) => chrono::DateTime::parse_from_rfc3339(&t)
            .map(|d| d.timestamp())
            .map_err(serde::de::Error::custom),
    }
}

/// [`unix_seconds`] for a field that may be absent or null.
fn optional_unix_seconds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    struct Wrapped(#[serde(deserialize_with = "unix_seconds")] i64);
    Ok(Option::<Wrapped>::deserialize(deserializer)?.map(|w| w.0))
}

/// A refusal from any Trash route, or a failure to reach one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrashRefusal {
    /// The HTTP status; 0 when no answer arrived.
    pub status: u16,
    /// The server's `error` code, when the body named one.
    pub code: Option<String>,
}

impl TrashRefusal {
    pub fn no_answer() -> Self {
        Self::default()
    }

    /// The route is not mounted: the server has Trash switched off.
    pub fn is_unavailable(&self) -> bool {
        self.status == 404 && self.code.is_none()
    }

    pub fn is_retryable(&self) -> bool {
        self.status == 0 || self.status == 429 || self.status >= 500
    }

    /// Read a refusal body: the `{"Error": {...}}` envelope or a flat
    /// `{error, message}`. An unmounted route answers a bare 404.
    pub fn from_body(status: u16, body: &str) -> Self {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        let inner = value.get("Error").unwrap_or(&value);
        let code = inner.get("error").and_then(serde_json::Value::as_str).map(str::to_string);
        Self { status, code }
    }

    /// The sentence the person reads. The server's message is for
    /// developers, and a transport error's text is not for anyone.
    pub fn sentence(&self) -> String {
        let reason = match self.code.as_deref().unwrap_or("") {
            "out_of_scope" | "forbidden" | "unauthorized" | "wrong_drive" => "You can't change Trash in this drive.",
            "not_owner" | "manager_required" => "Only the drive's owner or a manager can delete items forever.",
            "grant_root" => "You can't move the folder you were given access to into Trash.",
            "too_many_files" | "too_many_items" => "That's too many items at once. Try fewer.",
            "item_not_found" | "not_found" => "That item is no longer in Trash.",
            "name_taken" => "An item with this name is already there.",
            "invalid_new_path" => "That name can't be used here.",
            "upload_in_progress" => "Files in this folder are still uploading. Try again when they finish.",
            "account_suspended" | "account_read_only" | "service_account_forbidden" => "This drive can't take changes right now.",
            "drive_not_registered" => "This drive no longer exists.",
            _ => match self.status {
                0 => "Hippius didn't answer.",
                401 | 403 => "You can't change Trash in this drive.",
                404 => "Trash isn't available yet.",
                429 => "Too many requests right now. Try again in a moment.",
                _ => "Hippius couldn't finish that.",
            },
        };
        reason.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trash_request_carries_only_what_it_sets() {
        let bare = TrashFilesRequest {
            file_ids: vec![file_id(&[0xab; 32])],
            ..Default::default()
        };
        let json = serde_json::to_value(&bare).unwrap();
        assert_eq!(json, serde_json::json!({ "file_ids": ["ab".repeat(32)] }));

        let mut expected = BTreeMap::new();
        expected.insert("ab".repeat(32), RevisionId::from_bytes([7u8; 32]));
        let grouped = TrashFilesRequest {
            file_ids: vec!["ab".repeat(32)],
            expected_revision_ids: Some(expected),
            folder_path: Some("Projects/Q4".into()),
            item_id: Some("item-1".into()),
        };
        let json = serde_json::to_value(&grouped).unwrap();
        assert_eq!(json["folder_path"], "Projects/Q4");
        assert_eq!(json["item_id"], "item-1");
        assert_eq!(json["expected_revision_ids"]["ab".repeat(32)][0], 7);
    }

    #[test]
    fn a_trash_answer_reads_trashed_or_the_delete_spelling() {
        let answer: TrashFilesResult = serde_json::from_value(serde_json::json!({
            "trashed": [{ "file_id": "aa", "status": "trashed", "item_id": "i1" }],
            "errors": [{ "file_id": "bb", "code": "conflict", "message": "x" }]
        }))
        .unwrap();
        assert_eq!(answer.trashed[0].item_id.as_deref(), Some("i1"));
        assert_eq!(answer.errors[0].code, "conflict");

        let delete_shaped: TrashFilesResult = serde_json::from_value(
            serde_json::json!({ "deleted": [{ "file_id": "aa", "status": "already_deleted" }], "errors": [], "item_id": "f1" }),
        )
        .unwrap();
        assert_eq!(delete_shaped.trashed[0].status, "already_deleted");
        assert_eq!(delete_shaped.item_id.as_deref(), Some("f1"));
    }

    #[test]
    fn a_listing_reads_seconds_or_dates_and_pages_by_its_last_row() {
        let page: TrashListPage = serde_json::from_value(serde_json::json!({
            "items": [
                { "item_id": "a", "kind": "folder", "relative_path": "Legal/Q4 contracts", "file_count": 3, "total_bytes": 24,
                  "trashed_at": 1_700_000_000, "purge_at": 1_702_592_000, "name_taken": false },
                { "item_id": "b", "kind": "file", "encrypted_path": [1, 2, 3], "trashed_at": "2026-11-18T10:00:00Z",
                  "purge_at": "2026-12-18T10:00:00Z", "trashed_by": "5Member", "name_taken": true, "unknown_field": 1 }
            ],
            "has_more": true,
            "totals": { "trash_files": 4, "trash_retention_days": 30 }
        }))
        .unwrap();
        assert_eq!(page.items[0].kind, TrashItemKind::Folder);
        assert_eq!(page.items[1].trashed_at, 1_794_996_000);
        assert!(page.items[1].name_taken);
        assert_eq!(page.items[0].purge_at, Some(1_702_592_000));
        assert_eq!(page.items[1].purge_at, Some(1_797_588_000));
        assert_eq!(page.retention_days(), Some(30));
        assert_eq!(
            page.next_cursor(),
            Some(ListCursor {
                after_trashed_at: 1_794_996_000,
                after_item_id: "b".into()
            })
        );
        let last = TrashListPage { has_more: false, ..page };
        assert_eq!(last.next_cursor(), None);
    }

    #[test]
    fn purge_at_and_the_retention_may_be_absent() {
        let page: TrashListPage = serde_json::from_value(serde_json::json!({
            "items": [
                { "item_id": "a", "kind": "file", "trashed_at": 1_700_000_000 },
                { "item_id": "b", "kind": "file", "trashed_at": 1_700_000_000, "purge_at": null }
            ],
            "trash_retention_days": 14
        }))
        .unwrap();
        assert_eq!(page.items[0].purge_at, None);
        assert_eq!(page.items[1].purge_at, None);
        assert_eq!(page.retention_days(), Some(14));
        assert_eq!(TrashListPage::default().retention_days(), None);

        assert_eq!(retention_days(Some(14)), 14);
        assert_eq!(retention_days(None), 30);
        assert_eq!(retention_days(Some(0)), 30, "a zero retention is not a rule anyone can read");
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        let row = serde_json::json!({ "item_id": "a", "kind": "drive", "trashed_at": 1 });
        assert!(serde_json::from_value::<TrashItem>(row).is_err());
    }

    #[test]
    fn a_restore_sends_the_conflict_rule_and_an_optional_rename() {
        let plain = RestoreRequest {
            item_ids: vec!["a".into()],
            on_conflict: OnConflict::Fail,
            rename: None,
        };
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "item_ids": ["a"], "on_conflict": "fail" })
        );
        let renamed = RestoreRequest {
            item_ids: vec!["a".into()],
            on_conflict: OnConflict::Fail,
            rename: Some(RestoreRename {
                new_path: "a (1).txt".into(),
                renames: vec![SingleRename {
                    old_path_hash: [1; 32],
                    new_path_hash: [2; 32],
                    new_encrypted_path: vec![3],
                    new_file_name: Some("a (1).txt".into()),
                    new_relative_path: Some("a (1).txt".into()),
                    base_revision_id: RevisionId::from_bytes([4; 32]),
                }],
                signature: vec![5; 64],
                signing_key: [6; 32],
            }),
        };
        let json = serde_json::to_value(&renamed).unwrap();
        assert_eq!(json["rename"]["signature"].as_array().map(Vec::len), Some(64));
        assert_eq!(json["rename"]["renames"][0]["new_relative_path"], "a (1).txt");

        let answer: RestoreResult =
            serde_json::from_value(serde_json::json!({ "items": [{ "item_id": "a", "status": "name_taken" }], "more": false })).unwrap();
        assert_eq!(answer.items[0].status, "name_taken");
    }

    #[test]
    fn refusals_read_every_body_shape_and_never_leak_a_code() {
        let enveloped = TrashRefusal::from_body(403, r#"{ "Error": { "error": "manager_required", "message": "x" } }"#);
        assert_eq!(enveloped.code.as_deref(), Some("manager_required"));
        assert!(enveloped.sentence().contains("owner"));

        let bare = TrashRefusal::from_body(404, "");
        assert!(bare.is_unavailable());
        assert_eq!(bare.sentence(), "Trash isn't available yet.");

        let missing_item = TrashRefusal::from_body(404, r#"{ "error": "item_not_found" }"#);
        assert!(!missing_item.is_unavailable(), "a named 404 is an answer, not a switched-off route");

        for code in [
            "out_of_scope",
            "grant_root",
            "too_many_files",
            "name_taken",
            "account_read_only",
            "drive_not_registered",
        ] {
            let sentence = TrashRefusal {
                status: 409,
                code: Some(code.into()),
            }
            .sentence();
            assert!(!sentence.contains('_'), "{code} leaks a code: {sentence}");
            assert!(sentence.ends_with('.'), "{code}: {sentence}");
        }
        assert!(TrashRefusal::no_answer().is_retryable());
        assert!(!TrashRefusal { status: 409, code: None }.is_retryable());
    }
}
