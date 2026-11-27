//! The Drive Trash contract as the desktop reads it, and the sentence a
//! person reads for each refusal.
//!
//! The routes, their bodies and their answers are hcfs-shared's
//! (`hcfs_shared::network::trash`), called through hcfs-client's typed
//! `HcfsClient` methods, so a pin bump that changes a field fails to
//! compile here instead of sending the wrong JSON. What stays desktop-side
//! is reading a refusal (status and code) into a sentence: the server's
//! message is for developers.

pub use hcfs_shared::network::{
    ListTrashResult, MAX_TRASH_FILE_IDS, MAX_TRASH_ITEM_IDS, RestoreConflict, TRASH_LIST_MAX_LIMIT, TrashItem, TrashItemKind, TrashItemState,
    TrashRestoreMode,
};

use hcfs_client::client::folder_rename::FolderRenameError;
use hcfs_client::sync::SyncError;

/// Days an item stays in Trash when nothing says otherwise. Only a
/// fallback for a capabilities answer that names none: every listing
/// carries the server's own number.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// The days an item stays in Trash before the server deletes it forever:
/// what the server said (`trash_retention_days`), else 30. The server
/// purges; the desktop only says when.
pub fn retention_days(server: Option<u32>) -> u32 {
    server.filter(|d| *d > 0).unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// A path hash as the Trash routes spell a file id.
pub fn file_id(path_hash: &[u8; 32]) -> String {
    hex::encode(path_hash)
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

    pub fn coded(status: u16, code: &str) -> Self {
        Self {
            status,
            code: Some(code.to_string()),
        }
    }

    /// The route is not mounted: the server has Trash switched off.
    pub fn is_unavailable(&self) -> bool {
        self.status == 404 && self.code.is_none()
    }

    pub fn is(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }

    /// Read hcfs-client's error: a server refusal keeps its status and
    /// code; anything else (transport, an unreadable answer) is no answer.
    pub fn from_sync(error: &SyncError) -> Self {
        match error {
            SyncError::Http { status, code, .. } => Self {
                status: *status,
                code: code.clone(),
            },
            other => {
                tracing::debug!(error = %other, "trash: no answer");
                Self::no_answer()
            }
        }
    }

    /// Read a keep-both restore's error the same way.
    pub fn from_restore(error: &FolderRenameError) -> Self {
        match error {
            FolderRenameError::Refused { status, code, .. } => Self::coded(*status, code),
            FolderRenameError::Changed { code, .. } => Self::coded(409, code),
            FolderRenameError::TooLarge { .. } => Self::coded(413, "batch_too_large"),
            FolderRenameError::Sync(e) | FolderRenameError::NoAnswer(e) => Self::from_sync(e),
            other => {
                tracing::debug!(error = %other, "trash: keep both could not be planned");
                Self::coded(400, "unplannable")
            }
        }
    }

    pub fn is_retryable(&self) -> bool {
        self.status == 0 || self.status == 429 || self.status >= 500
    }

    /// The sentence the person reads. The server's message is for
    /// developers, and a transport error's text is not for anyone.
    pub fn sentence(&self) -> String {
        let reason = match self.code.as_deref().unwrap_or("") {
            "forbidden" | "unauthorized" | "out_of_scope" => "You can't change Trash in this drive.",
            "manager_required" | "not_owner" => "Only the drive's owner or a manager can delete items forever.",
            "grant_root" => "You can't move the folder you were given access to into Trash.",
            "batch_too_large" => "That's too many items at once. Try fewer.",
            "item_not_found" => "That item is no longer in Trash.",
            "item_purging" => "That item is being deleted forever.",
            "item_state" => "That item is still being moved. Try again in a moment.",
            "name_conflict" | "target_exists" => "An item with this name is already there.",
            "restore_mode_mismatch" => "That item is already being restored another way. Finish that restore first.",
            "rename_mismatch" => "That item changed while it was being restored. Try again.",
            "invalid_new_path" | "invalid_path" => "That name can't be used here.",
            "no_stored_path" | "paths_unregistered" | "unplannable" => {
                "Some files in it were uploaded by an older app, so it can only be restored where it was."
            }
            "account_suspended" | "account_read_only" | "service_account_forbidden" => "This drive can't take changes right now.",
            "invalid_folder_hash" | "drive_not_registered" => "This drive has no Trash.",
            _ => match self.status {
                0 => "Hippius didn't answer. Try again.",
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
    fn the_retention_is_the_servers_and_30_only_when_absent() {
        assert_eq!(retention_days(Some(14)), 14);
        assert_eq!(retention_days(None), 30);
        assert_eq!(retention_days(Some(0)), 30, "a zero retention is not a rule anyone can read");
    }

    #[test]
    fn refusals_read_hcfs_client_errors_and_never_leak_a_code() {
        let refused = TrashRefusal::from_sync(&SyncError::Http {
            status: 403,
            code: Some("forbidden".into()),
            message: "x".into(),
        });
        assert_eq!(refused, TrashRefusal::coded(403, "forbidden"));
        assert_eq!(refused.sentence(), "You can't change Trash in this drive.");

        let off = TrashRefusal::from_sync(&SyncError::Http {
            status: 404,
            code: None,
            message: "Not Found".into(),
        });
        assert!(off.is_unavailable());
        assert_eq!(off.sentence(), "Trash isn't available yet.");
        assert!(
            !TrashRefusal::coded(404, "item_not_found").is_unavailable(),
            "a named 404 is an answer, not a switched-off route"
        );

        let transport = TrashRefusal::from_sync(&SyncError::Network("reset".into()));
        assert_eq!(transport, TrashRefusal::no_answer());
        assert!(transport.is_retryable());

        let kept = TrashRefusal::from_restore(&FolderRenameError::Refused {
            status: 409,
            code: "target_exists".into(),
            message: "x".into(),
        });
        assert!(kept.is("target_exists"));

        for code in [
            "forbidden",
            "grant_root",
            "batch_too_large",
            "item_not_found",
            "item_purging",
            "item_state",
            "name_conflict",
            "target_exists",
            "restore_mode_mismatch",
            "rename_mismatch",
            "no_stored_path",
            "account_read_only",
            "invalid_folder_hash",
            "something_new",
        ] {
            let sentence = TrashRefusal::coded(409, code).sentence();
            assert!(!sentence.contains('_'), "{code} leaks a code: {sentence}");
            assert!(sentence.ends_with('.'), "{code}: {sentence}");
        }
    }
}
