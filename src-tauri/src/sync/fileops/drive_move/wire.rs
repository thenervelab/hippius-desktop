//! The wire types of hcfs-server's `/v1/drive_moves` routes, and the
//! sentence a person reads for each refusal.
//!
//! Defined here rather than imported: the pinned hcfs-shared predates the
//! routes. Every shape follows `docs/public/api/drive-moves.md` and
//! `hcfs-shared/src/network/drive_moves.rs` on hcfs main, and the tests at
//! the bottom pin the JSON both sides send, so a bump to an hcfs rev that
//! carries the types can swap these out and keep the tests.

use hcfs_shared::network::CreateSessionRequest;
use serde::{Deserialize, Serialize};

/// Most files one move carries (`MAX_DRIVE_MOVE_FILES` on the server). A
/// commit rewrites every file it moves in one transaction, so the server
/// refuses more, and a folder must move whole in ONE commit.
pub const MAX_DRIVE_MOVE_FILES: usize = 2_000;

/// Most folders one commit moves whole (`MAX_COMMIT_FOLDERS`).
pub const MAX_COMMIT_FOLDERS: usize = 100;

/// One drive, by its owner and folder hash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DriveRef {
    pub ss58_address: String,
    pub folder_hash: String,
}

/// `POST /v1/drive_moves`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateDriveMoveRequest {
    pub source: DriveRef,
    pub dest: DriveRef,
}

/// The `Success` of `POST /v1/drive_moves`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CreateDriveMoveResult {
    pub move_id: String,
    /// Unix seconds; the hourly sweep aborts the move after it.
    pub expires_at: i64,
}

/// `POST /v1/drive_moves/{move_id}/sessions`: an ordinary session create
/// for the copy in the destination, plus the source file it replaces.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageMoveSessionRequest {
    pub session: CreateSessionRequest,
    pub source_path_hash: [u8; 32],
    /// The source revision whose bytes were read and encrypted again. The
    /// commit refuses the move if the source has moved on since.
    pub expected_revision_id: [u8; 32],
}

/// The `Success` of a session create (the ordinary one's answer).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StagedSession {
    pub session_id: String,
    #[serde(default)]
    pub expires_at: i64,
}

/// A folder a commit carries whole.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MoveFolder {
    pub from: String,
    pub to: String,
}

/// `POST /v1/drive_moves/{move_id}/commit`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitDriveMoveRequest {
    /// Every source `path_hash` the move carries, each once: exactly the
    /// staged copies, or the commit refuses (`move_incomplete`).
    pub files: Vec<[u8; 32]>,
    #[serde(default)]
    pub folders: Vec<MoveFolder>,
}

/// One file a commit moved.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommittedFile {
    pub source_path_hash: [u8; 32],
    pub dest_path_hash: [u8; 32],
    pub revision_id: [u8; 32],
}

/// A folder grant a commit removed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RevokedGrant {
    pub member_ss58: String,
    pub path_prefix: String,
}

/// What a commit turned off under the moved folders.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct MoveRevoked {
    #[serde(default)]
    pub folder_grants: Vec<RevokedGrant>,
    #[serde(default)]
    pub folder_links: Vec<String>,
    #[serde(default)]
    pub invites: Vec<String>,
    #[serde(default)]
    pub backups_moved: Vec<String>,
    #[serde(default)]
    pub backups_removed: Vec<String>,
}

impl MoveRevoked {
    /// What the success message adds, or `None` when nothing was turned
    /// off. A backup that followed its folder keeps working, so it is not
    /// news; one that was removed is, since its phone must be set up again.
    pub fn notice(&self) -> Option<String> {
        let people = {
            let mut members: Vec<&str> = self.folder_grants.iter().map(|g| g.member_ss58.as_str()).collect();
            members.sort_unstable();
            members.dedup();
            members.len()
        };
        let links = self.folder_links.len();
        let mut parts = Vec::new();
        if links > 0 {
            parts.push(if links == 1 {
                "its share link was turned off".to_string()
            } else {
                format!("its {links} share links were turned off")
            });
        }
        if people > 0 {
            parts.push(if people == 1 {
                "1 person lost access".to_string()
            } else {
                format!("{people} people lost access")
            });
        }
        if !self.invites.is_empty() {
            parts.push(if self.invites.len() == 1 {
                "an open invite was cancelled".to_string()
            } else {
                "open invites were cancelled".to_string()
            });
        }
        if !self.backups_removed.is_empty() {
            parts.push("a phone backup into it was stopped".to_string());
        }
        if parts.is_empty() {
            return None;
        }
        let mut sentence = join_clauses(&parts);
        if let Some(first) = sentence.get_mut(..1) {
            first.make_ascii_uppercase();
        }
        sentence.push('.');
        Some(sentence)
    }
}

/// "a", "a and b", "a, b and c".
pub(crate) fn join_clauses(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// The `Success` of a commit; a repeated commit answers the same.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitDriveMoveResult {
    pub files: Vec<CommittedFile>,
    #[serde(default)]
    pub revoked: MoveRevoked,
}

/// A refusal from any drive-move route, or a failure to reach one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MoveRefusal {
    /// The HTTP status; 0 when no answer arrived.
    pub status: u16,
    /// The server's `error` code, when the body named one.
    pub code: Option<String>,
    /// The files a `revision_mismatch` or `target_exists` names.
    pub path_hashes: Vec<[u8; 32]>,
}

impl MoveRefusal {
    /// No answer arrived (a transport failure or an unreadable body).
    pub fn no_answer() -> Self {
        Self::default()
    }

    /// Whether asking again may get a different answer: no answer, a 5xx, a
    /// 429. A 4xx is the server's decision.
    pub fn is_retryable(&self) -> bool {
        self.status == 0 || self.status == 429 || self.status >= 500
    }

    fn code(&self) -> &str {
        self.code.as_deref().unwrap_or("")
    }

    /// Read a refusal body. Most are the `{"Error": {...}}` envelope; the
    /// write gates, quota and billing answers are flat `{error, message}`;
    /// a session create can answer a `{"Conflict": {...}}`. An unmounted
    /// route (the feature is off) answers a bare 404 with no body.
    pub fn from_body(status: u16, body: &str) -> Self {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        let inner = value.get("Error").or_else(|| value.get("Conflict")).unwrap_or(&value);
        let code = inner
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| value.get("Conflict").map(|_| "conflict".to_string()));
        let path_hashes = inner
            .get("path_hashes")
            .and_then(|v| serde_json::from_value::<Vec<[u8; 32]>>(v.clone()).ok())
            .unwrap_or_default();
        Self { status, code, path_hashes }
    }

    /// The sentence the person reads. Rust owns it: the server's message is
    /// for developers, and a transport error's text is not for anyone.
    pub fn sentence(&self) -> String {
        let code = self.code();
        let reason = match code {
            "same_drive" => "That's the drive it's already in.",
            "too_many_files" => "That's more than 2,000 files. Move fewer at a time.",
            "invalid_new_path" => "Some paths would be too long in that folder. Pick a folder nearer the top.",
            "out_of_scope" => "You don't have access to that folder.",
            "folder_shared" => "This folder is shared with other people, so only the drive's owner or a manager can move it to another drive.",
            "recording_limit_reached" => "The destination's plan has no room for more recordings.",
            "recording_too_long" => "A recording is longer than the destination's plan allows.",
            "move_not_found" | "move_closed" | "move_aborted" | "move_expired" => "The move was stopped before it finished.",
            "move_incomplete" => "Not every file was copied.",
            "revision_mismatch" | "folder_changed" => "Some files changed while they were being moved.",
            "target_exists" | "already_staged" | "session_exists" => "An item with this name is already in that folder.",
            "target_shared" => "That folder is shared on its own, so items can't move into it. Pick another folder.",
            "paths_unregistered" => "Some files in this folder can't be moved from this device yet.",
            "upload_in_progress" => "Files in this folder are still uploading. Try again when they finish.",
            "drive_not_registered" => "One of these drives no longer exists.",
            "billing_unavailable" | "billing_parse_error" => "Hippius couldn't check the destination's plan. Try again in a moment.",
            "drive_quota_exceeded" | "zero_balance" | "insufficient_balance" => "There isn't enough storage left in the destination drive.",
            "session_limit" => "Too many uploads are running into that drive right now. Try again in a moment.",
            "account_suspended" | "account_read_only" | "service_account_forbidden" => "One of these drives can't take changes right now.",
            "forbidden" | "unauthorized" | "wrong_drive" => "You can't move items between these drives.",
            _ => match self.status {
                0 => "Hippius didn't answer.",
                401 | 403 => "You can't move items between these drives.",
                402 => "There isn't enough storage left in the destination drive.",
                404 => "Moving between drives isn't available yet.",
                413 => "That's more than 2,000 files. Move fewer at a time.",
                429 => "Too many uploads are running into that drive right now. Try again in a moment.",
                _ => "Hippius couldn't finish the move.",
            },
        };
        reason.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bodies `docs/public/api/drive-moves.md` documents, sent and read
    /// exactly as the server writes them.
    #[test]
    fn requests_serialize_as_the_doc_shows() {
        let open = CreateDriveMoveRequest {
            source: DriveRef {
                ss58_address: "5Owner".into(),
                folder_hash: "0123456789abcdef".into(),
            },
            dest: DriveRef {
                ss58_address: "5Owner".into(),
                folder_hash: "fedcba9876543210".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            serde_json::json!({
                "source": { "ss58_address": "5Owner", "folder_hash": "0123456789abcdef" },
                "dest": { "ss58_address": "5Owner", "folder_hash": "fedcba9876543210" }
            })
        );

        let commit = CommitDriveMoveRequest {
            files: vec![[1; 32]],
            folders: vec![MoveFolder {
                from: "Projects/Q3".into(),
                to: "Shared/Q3".into(),
            }],
        };
        let json = serde_json::to_value(&commit).unwrap();
        assert_eq!(json["files"][0].as_array().map(Vec::len), Some(32), "a path hash is a 32-number array");
        assert_eq!(json["folders"][0], serde_json::json!({ "from": "Projects/Q3", "to": "Shared/Q3" }));
    }

    #[test]
    fn a_staged_session_carries_the_source_beside_an_ordinary_create() {
        let request = StageMoveSessionRequest {
            session: CreateSessionRequest {
                manifest: hcfs_shared::network::Manifest::default(),
                chunk_count: 3,
                chunk_size: 4_194_304,
                ciphertext_size: 10_485_792,
            },
            source_path_hash: [7; 32],
            expected_revision_id: [9; 32],
        };
        let json = serde_json::to_value(&request).unwrap();
        let keys: std::collections::BTreeSet<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["expected_revision_id", "session", "source_path_hash"].into_iter().collect());
        assert_eq!(json["session"]["chunk_count"], 3);
        assert_eq!(json["session"]["ciphertext_size"], 10_485_792);
        assert!(json["session"]["manifest"].is_object());
        assert_eq!(json["expected_revision_id"][0], 9);
        assert_eq!(
            json["session"]["manifest"]["base_revision_id"],
            serde_json::Value::Null,
            "a copy creates its path and sends no base"
        );
    }

    #[test]
    fn answers_parse_as_the_doc_shows() {
        let open: hcfs_shared::network::NetworkResponse<CreateDriveMoveResult> =
            serde_json::from_str(r#"{ "Success": { "move_id": "00112233445566778899aabbccddeeff", "expires_at": 1713225600 } }"#).unwrap();
        let hcfs_shared::network::NetworkResponse::Success(open) = open else {
            panic!("success")
        };
        assert_eq!(open.expires_at, 1_713_225_600);

        let hash: Vec<u8> = vec![3; 32];
        let body = serde_json::json!({ "Success": {
            "files": [{ "source_path_hash": hash, "dest_path_hash": hash, "revision_id": hash }],
            "revoked": {
                "folder_grants": [{ "member_ss58": "5Member", "path_prefix": "Projects/Q3" }],
                "folder_links": ["abc"],
                "invites": ["inv"],
                "backups_moved": [],
                "backups_removed": ["b1"]
            }
        }});
        let commit: hcfs_shared::network::NetworkResponse<CommitDriveMoveResult> = serde_json::from_value(body).unwrap();
        let hcfs_shared::network::NetworkResponse::Success(commit) = commit else {
            panic!("success")
        };
        assert_eq!(commit.files[0].dest_path_hash, [3; 32]);
        assert_eq!(commit.revoked.folder_grants[0].path_prefix, "Projects/Q3");
        assert_eq!(commit.revoked.backups_removed, vec!["b1".to_string()]);

        // A move of files alone may omit `revoked`.
        let bare: CommitDriveMoveResult = serde_json::from_value(serde_json::json!({ "files": [] })).unwrap();
        assert_eq!(bare.revoked, MoveRevoked::default());
    }

    #[test]
    fn refusals_read_every_body_shape() {
        let enveloped = MoveRefusal::from_body(
            409,
            &serde_json::json!({ "Error": { "error": "revision_mismatch", "message": "x", "path_hashes": [vec![5u8; 32]] } }).to_string(),
        );
        assert_eq!(enveloped.code.as_deref(), Some("revision_mismatch"));
        assert_eq!(enveloped.path_hashes, vec![[5; 32]]);

        let flat = MoveRefusal::from_body(403, r#"{ "error": "recording_limit_reached", "message": "x", "limit": 25 }"#);
        assert_eq!(flat.code.as_deref(), Some("recording_limit_reached"));

        let conflict = MoveRefusal::from_body(409, r#"{ "Conflict": { "current_revision_id": [], "current_revision_seq": 0 } }"#);
        assert_eq!(conflict.code.as_deref(), Some("conflict"));

        let bare = MoveRefusal::from_body(404, "");
        assert_eq!(bare.code, None);
        assert_eq!(bare.sentence(), "Moving between drives isn't available yet.");
    }

    /// Every code the routes document reads as a sentence of our own, never
    /// the server's text and never a code.
    #[test]
    fn every_documented_code_has_its_own_sentence() {
        let generic = MoveRefusal {
            status: 500,
            ..MoveRefusal::default()
        }
        .sentence();
        for code in [
            "same_drive",
            "too_many_files",
            "invalid_new_path",
            "out_of_scope",
            "folder_shared",
            "recording_limit_reached",
            "move_not_found",
            "move_closed",
            "move_aborted",
            "move_expired",
            "move_incomplete",
            "revision_mismatch",
            "folder_changed",
            "target_exists",
            "already_staged",
            "target_shared",
            "paths_unregistered",
            "upload_in_progress",
            "drive_not_registered",
            "billing_unavailable",
            "drive_quota_exceeded",
            "session_limit",
            "account_read_only",
            "forbidden",
        ] {
            let sentence = MoveRefusal {
                status: 409,
                code: Some(code.into()),
                path_hashes: Vec::new(),
            }
            .sentence();
            assert_ne!(sentence, generic, "{code} falls through to the generic sentence");
            assert!(!sentence.contains('_'), "{code} leaks a code: {sentence}");
            assert!(sentence.ends_with('.'), "{code}: {sentence}");
        }
    }

    #[test]
    fn only_no_answer_5xx_and_429_are_retried() {
        assert!(MoveRefusal::no_answer().is_retryable());
        assert!(
            MoveRefusal {
                status: 503,
                ..Default::default()
            }
            .is_retryable()
        );
        assert!(
            MoveRefusal {
                status: 429,
                ..Default::default()
            }
            .is_retryable()
        );
        assert!(
            !MoveRefusal {
                status: 409,
                ..Default::default()
            }
            .is_retryable()
        );
        assert!(
            !MoveRefusal {
                status: 404,
                ..Default::default()
            }
            .is_retryable()
        );
    }

    #[test]
    fn the_revoked_notice_says_what_was_turned_off() {
        assert_eq!(MoveRevoked::default().notice(), None);
        let only_followed = MoveRevoked {
            backups_moved: vec!["b".into()],
            ..Default::default()
        };
        assert_eq!(only_followed.notice(), None, "a backup that followed its folder still works");

        let grant = |who: &str| RevokedGrant {
            member_ss58: who.into(),
            path_prefix: "A".into(),
        };
        let revoked = MoveRevoked {
            folder_grants: vec![grant("5A"), grant("5B"), grant("5A")],
            folder_links: vec!["l".into()],
            ..Default::default()
        };
        assert_eq!(
            revoked.notice().as_deref(),
            Some("Its share link was turned off and 2 people lost access.")
        );
    }
}
