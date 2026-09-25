//! Folder collaboration: Viewer or Editor on ONE folder of a drive.
//!
//! # Follows HCFS PR #475 (merged). The hcfs pin is hcfs main `4d4dd3d`,
//! which includes that merge. #477 does not change the client.
//!
//! Everything below mirrors that PR's API. It is kept in this one module so
//! the day it merges (or changes) there is one place to reconcile. Every
//! desktop surface that depends on it is behind the `FOLDER_ROLES_ENABLED`
//! lane flag (staging only). Inside the flag nothing is hidden on a server
//! capability: the request is sent and a refusal becomes a "coming soon"
//! message, so each piece lights up on its own when the server turns it on.
//!
//! 1. **Capabilities.** `GET /v1/capabilities` carries `folder_grants` (folder
//!    invites at all) and `folder_grant_writes` (Editor folder invites). The
//!    desktop reads `folder_grant_writes` as a HINT only. It does require the
//!    `folder_grants` KEY to be present before sending any folder request
//!    (`ServerCapabilities::folder_grants_known`): a server that predates
//!    folder invites ignores `path_prefix` and would mint, or mail, a
//!    whole-drive invite instead.
//! 2. **Folder invite mint.** `POST /v1/drive-invites` with `path_prefix`.
//!    Always single use (`max_uses` other than 1 is a 400), expiry capped at
//!    30 days (default 7). `role` is `reader` or `writer`; `manager` is never
//!    a folder role (400). Refusals, all `400 bad_request` and told apart only
//!    by message, which is matched EXACTLY in Rust, never on the frontend:
//!    - "folder invites are not enabled": folder grants off.
//!    - "writer folder invites are not enabled": Editor while writes are off
//!      (a server without #475 says "a folder invite is always a reader
//!      invite" instead).
//!    - "a folder invite is a reader or writer invite", "a folder invite is
//!      single-use" and "expires_in_secs exceeds the folder invite maximum of
//!      30 days": requests the desktop never sends (its plan refuses them
//!      first), mapped to a worded `Validation` so a drifted caller still reads
//!      a sentence rather than a raw server string.
//!
//!    The response echoes `path_prefix`; a mint without the echo is revoked
//!    and refused (it would be a whole-drive invite).
//! 3. **Email folder invite.** `POST /v1/drive-invites/email` with
//!    `path_prefix` is still refused ("folder invites cannot be mailed yet;
//!    mint a link instead"). The desktop sends it anyway, behind (1), so it
//!    works without a desktop change once the server accepts it.
//! 4. **Listings carry the role.** `folder_grants[]` rows carry `role`; a
//!    missing, blank or unknown role (`manager` included) reads as `reader`.
//! 5. **No role change for a holder.** There is no route to change a folder
//!    holder's role. Changing their folders is
//!    `PUT /v1/drives/{fh}/grants/{member_ss58}` `{ path_prefixes, role? }`:
//!    a folder they already hold keeps its role, and `role` (`reader` when
//!    omitted, `writer` refused with "writer folder grants are not enabled"
//!    while writes are off) applies only to folders the call ADDS. It answers
//!    `{ member_ss58, path_prefixes, roles }`, `roles` in the prefixes' order.
//!    Removing stays `DELETE /v1/drives/{fh}/members/{member}`. To change
//!    someone's access to a folder they hold: remove them and invite them again.
//! 6. **What a writer holder may do**, strictly inside the folder: upload
//!    (single-shot and chunked), delete, rename, register and unregister
//!    directories, `POST /can_upload`, and mint a public folder link at or
//!    under the folder. Nothing else (`register_relative_paths` included).
//!    Only the owner or a full drive Manager mints folder invites. All of it
//!    only while `folder_grant_writes` is on: a stored writer grant cannot
//!    write once the flag is off, so the desktop offers write controls on a
//!    grant only when both hold (`grant_can_write`).
//! 7. **The holder's key.** A grant blob opens to the folder's DERIVED file
//!    key (the same `seed[..32]` bytes the drive's phrase yields), never the
//!    drive's mnemonic entropy.
//!
//! #475 also changes `hcfs-client`'s sync flow: a download lands at the
//! decrypted path when it hashes to the file id, else at the server's
//! `relative_path` when that does, so a writer who seals a misleading path
//! cannot place a file outside what the server recorded.
//!
//! Joining a folder stays in the console: the desktop opens the console's
//! invite URL. Syncing a granted folder to disk is out of scope; holders
//! browse it remotely, rooted at the grant.

use crate::error::{AppError, NotReadyKind, Result};
use crate::shares::capabilities::ServerCapabilities;

use super::folder_grant_path::{FOLDER_INVITE_MAX_SECS, FOLDER_INVITE_MAX_USES, folder_grant_path_prefix};

/// The roles a folder may be shared with: Viewer and Editor. `manager` is not
/// a folder role (#475 refuses it). Kept in step with `FOLDER_ROLES` on the FE.
pub const FOLDER_ROLES: [&str; 2] = ["reader", "writer"];

/// Refuse any folder request to a server that does not know folder invites
/// (assumption 1). Such a server ignores `path_prefix`, so the request would
/// become a whole-drive invite; the user is told it is coming soon instead.
pub fn require_server_knows_folder_invites(caps: &ServerCapabilities) -> Result<()> {
    if caps.folder_grants_known {
        Ok(())
    } else {
        Err(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable))
    }
}

/// The role a grant row names, read defensively (assumption 4): missing,
/// blank or unknown is `reader`, and `manager` is too, never management.
/// Kept in step with `parseDriveRole` on the FE.
pub fn grant_role(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(role) if FOLDER_ROLES.contains(&role) => role.to_string(),
        _ => "reader".to_string(),
    }
}

/// Whether a folder grant lets its holder change files: an Editor grant, on
/// a server with `folder_grant_writes` on, and not frozen. The server refuses
/// a writer grant's writes while the flag is off, so write controls on it
/// would only ever fail.
pub fn grant_can_write(role: &str, writes_on: bool, frozen: bool) -> bool {
    role == "writer" && writes_on && !frozen
}

/// A validated folder role: `reader` when omitted, `reader` or `writer`
/// otherwise. A Manager folder invite is refused by name rather than sent.
pub fn resolve_folder_role(role: Option<String>) -> Result<String> {
    let role = role.unwrap_or_else(|| "reader".to_string());
    if FOLDER_ROLES.contains(&role.as_str()) {
        Ok(role)
    } else {
        Err(AppError::Validation(FOLDER_ROLE_ONLY.into()))
    }
}

/// What a folder invite is minted as (assumption 2).
#[derive(Debug, PartialEq, Eq)]
pub struct FolderInvitePlan {
    /// Drive-relative, never empty: an empty prefix would be the whole drive.
    pub path_prefix: String,
    pub role: String,
    pub expires_in_secs: u64,
    /// Always 1.
    pub max_uses: u32,
}

/// Plan a folder invite from the view-relative path the user picked.
///
/// `rooted_path` is the drive-relative path (already rooted at a grant when
/// browsing one). An empty or illegal path is refused BEFORE any request, so
/// a folder invite can never go out without a folder.
pub fn plan_folder_invite(rooted_path: &str, role: Option<String>, expires_in_secs: u64) -> Result<FolderInvitePlan> {
    let path_prefix = folder_grant_path_prefix(rooted_path)?;
    let role = resolve_folder_role(role)?;
    Ok(FolderInvitePlan {
        path_prefix,
        role,
        expires_in_secs: expires_in_secs.min(FOLDER_INVITE_MAX_SECS),
        max_uses: FOLDER_INVITE_MAX_USES,
    })
}

/// Fill a missing or blank `role` on every `folder_grants[]` entry of a
/// listing body with `reader` before it is parsed (assumption 4).
///
/// The shared hcfs types require the field, so a server that ever omitted it
/// would fail the whole listing, whole-drive memberships included. Normalising
/// the JSON keeps one lenient rule in one place instead of a second set of
/// wire types.
pub fn default_missing_grant_roles(body: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_string();
    };
    let mut changed = false;
    if let Some(grants) = value.get_mut("folder_grants").and_then(|g| g.as_array_mut()) {
        for grant in grants {
            let Some(obj) = grant.as_object_mut() else { continue };
            // Anything but a non-blank string (absent, null, a number) is
            // "not stated", which reads as a Viewer.
            let needs_default = !matches!(obj.get("role"), Some(serde_json::Value::String(s)) if !s.trim().is_empty());
            if needs_default {
                obj.insert("role".into(), serde_json::Value::String("reader".into()));
                changed = true;
            }
        }
    }
    if changed { value.to_string() } else { body.to_string() }
}

/// Map a refused FOLDER invite mint (assumption 2). The server words these
/// as `400 bad_request` with a message, so the message is matched exactly
/// here, once, and the frontend dispatches on the structured kind.
pub fn classify_folder_invite_refusal(status: reqwest::StatusCode, body: &str) -> Option<AppError> {
    if status.as_u16() != 400 {
        return None;
    }
    let envelope = bad_request_message(body)?;
    match envelope.as_str() {
        "folder invites are not enabled" => Some(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable)),
        "writer folder invites are not enabled" | "a folder invite is always a reader invite" => {
            Some(AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable))
        }
        "a folder invite is a reader or writer invite" => Some(AppError::Validation(FOLDER_ROLE_ONLY.into())),
        "a folder invite is single-use" => Some(AppError::Validation(
            "A folder invite works once, for one person. Create another link for the next person.".into(),
        )),
        "expires_in_secs exceeds the folder invite maximum of 30 days" => {
            Some(AppError::Validation("A folder invite can last at most 30 days.".into()))
        }
        _ => None,
    }
}

/// Map a refused folder-grant replace (`PUT /v1/drives/{fh}/grants/{member}`).
/// Same exact-message rule as the mint: folder grants off reads as "sharing a
/// folder is coming soon", an Editor folder while writes are off as "Editor
/// for a folder is coming soon".
pub fn classify_folder_grant_refusal(status: reqwest::StatusCode, body: &str) -> Option<AppError> {
    if status.as_u16() != 400 {
        return None;
    }
    match bad_request_message(body)?.as_str() {
        "folder grants are not enabled" => Some(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable)),
        "writer folder grants are not enabled" => Some(AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable)),
        "a folder grant is a reader or writer grant" => Some(AppError::Validation(FOLDER_ROLE_ONLY.into())),
        _ => None,
    }
}

/// The one sentence for "Manager (or anything else) is not a folder role".
const FOLDER_ROLE_ONLY: &str = "A folder can be shared with Viewer or Editor access only.";

/// Map a refused folder EMAIL invite (assumption 3).
pub fn classify_folder_email_refusal(status: reqwest::StatusCode, body: &str) -> Option<AppError> {
    if status.as_u16() != 400 {
        return None;
    }
    match bad_request_message(body)?.as_str() {
        "folder invites cannot be mailed yet; mint a link instead" => Some(AppError::NotReady(NotReadyKind::FolderEmailInvitesUnavailable)),
        _ => None,
    }
}

/// The message of a `{"error":"bad_request","message":...}` body.
fn bad_request_message(body: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Envelope {
        error: String,
        message: String,
    }
    let env: Envelope = serde_json::from_str(body).ok()?;
    (env.error == "bad_request").then_some(env.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    fn body(message: &str) -> String {
        serde_json::json!({ "error": "bad_request", "message": message }).to_string()
    }

    #[test]
    fn a_folder_request_needs_a_server_that_knows_folder_invites() {
        let old = ServerCapabilities::default();
        assert!(matches!(
            require_server_knows_folder_invites(&old),
            Err(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable))
        ));
        let off = ServerCapabilities {
            folder_grants_known: true,
            ..ServerCapabilities::default()
        };
        assert!(
            require_server_knows_folder_invites(&off).is_ok(),
            "off is refused BY the server, which is safe"
        );
    }

    #[test]
    fn a_grant_role_degrades_to_reader() {
        assert_eq!(grant_role(Some("writer")), "writer");
        assert_eq!(grant_role(Some("reader")), "reader");
        assert_eq!(grant_role(Some("manager")), "reader", "manager is not a folder role");
        assert_eq!(grant_role(None), "reader");
        assert_eq!(grant_role(Some("  ")), "reader");
        assert_eq!(grant_role(Some("owner")), "reader", "never management by accident");
    }

    #[test]
    fn a_folder_invite_is_viewer_or_editor_single_use_and_at_most_thirty_days() {
        let plan = plan_folder_invite("/Clients/ACME/", Some("writer".into()), 3600).unwrap();
        assert_eq!(
            plan,
            FolderInvitePlan {
                path_prefix: "Clients/ACME".into(),
                role: "writer".into(),
                expires_in_secs: 3600,
                max_uses: 1,
            }
        );
        let plan = plan_folder_invite("Clients", None, 100 * 365 * 86_400).unwrap();
        assert_eq!(plan.role, "reader", "Viewer unless asked");
        assert_eq!(plan.expires_in_secs, FOLDER_INVITE_MAX_SECS, "folder invites never outlive 30 days");
        assert!(
            plan_folder_invite("Clients", Some("manager".into()), 3600).is_err(),
            "manager is refused, not narrowed"
        );
        assert!(plan_folder_invite("Clients", Some("admin".into()), 3600).is_err());
    }

    /// The guard that keeps a folder share from ever becoming a whole-drive
    /// invite: no folder, no request.
    #[test]
    fn a_folder_invite_without_a_folder_is_refused_before_any_request() {
        for path in ["", "/", "//", "a/../b", "./a"] {
            assert!(plan_folder_invite(path, None, 3600).is_err(), "{path:?} must not become a drive invite");
        }
    }

    #[test]
    fn folder_invite_refusals_map_by_exact_message() {
        let bad = StatusCode::BAD_REQUEST;
        assert!(matches!(
            classify_folder_invite_refusal(bad, &body("folder invites are not enabled")),
            Some(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable))
        ));
        for msg in ["writer folder invites are not enabled", "a folder invite is always a reader invite"] {
            assert!(matches!(
                classify_folder_invite_refusal(bad, &body(msg)),
                Some(AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable))
            ));
        }
        // What the desktop never sends still reads as a sentence, not a raw
        // server string, and never as a "coming soon".
        for msg in [
            "a folder invite is a reader or writer invite",
            "a folder invite is single-use",
            "expires_in_secs exceeds the folder invite maximum of 30 days",
        ] {
            assert!(
                matches!(classify_folder_invite_refusal(bad, &body(msg)), Some(AppError::Validation(_))),
                "{msg}"
            );
        }
        // Anything else falls through to the generic mapping.
        assert!(classify_folder_invite_refusal(bad, &body("path_prefix must be a valid drive-relative folder path")).is_none());
        assert!(
            classify_folder_invite_refusal(bad, &body("folder invites are not enabled yet")).is_none(),
            "exact, not substring"
        );
        assert!(classify_folder_invite_refusal(StatusCode::FORBIDDEN, &body("folder invites are not enabled")).is_none());
        let other_slug = serde_json::json!({"error":"forbidden","message":"folder invites are not enabled"}).to_string();
        assert!(classify_folder_invite_refusal(bad, &other_slug).is_none());
    }

    #[test]
    fn a_refused_folder_email_maps_to_coming_soon() {
        assert!(matches!(
            classify_folder_email_refusal(StatusCode::BAD_REQUEST, &body("folder invites cannot be mailed yet; mint a link instead")),
            Some(AppError::NotReady(NotReadyKind::FolderEmailInvitesUnavailable))
        ));
        assert!(classify_folder_email_refusal(StatusCode::BAD_REQUEST, &body("email is invalid")).is_none());
    }

    #[test]
    fn folder_grant_replace_refusals_map_by_exact_message() {
        let bad = StatusCode::BAD_REQUEST;
        assert!(matches!(
            classify_folder_grant_refusal(bad, &body("writer folder grants are not enabled")),
            Some(AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable))
        ));
        assert!(matches!(
            classify_folder_grant_refusal(bad, &body("folder grants are not enabled")),
            Some(AppError::NotReady(NotReadyKind::FolderInvitesUnavailable))
        ));
        assert!(matches!(
            classify_folder_grant_refusal(bad, &body("a folder grant is a reader or writer grant")),
            Some(AppError::Validation(_))
        ));
        assert!(classify_folder_grant_refusal(bad, &body("writer folder grants are not enabled yet")).is_none());
        assert!(classify_folder_grant_refusal(StatusCode::NOT_FOUND, &body("writer folder grants are not enabled")).is_none());
    }

    #[test]
    fn a_grant_writes_only_as_an_editor_with_writes_on_and_not_frozen() {
        assert!(grant_can_write("writer", true, false));
        assert!(
            !grant_can_write("writer", false, false),
            "the server refuses a writer grant's writes while off"
        );
        assert!(!grant_can_write("writer", true, true), "a frozen owner takes no uploads");
        assert!(!grant_can_write("reader", true, false));
    }

    #[test]
    fn missing_grant_roles_read_as_reader_and_nothing_else_moves() {
        let body = r#"{"memberships":[{"role":"writer"}],"folder_grants":[{"path_prefix":"a"},{"path_prefix":"b","role":""},{"path_prefix":"c","role":"writer"},{"path_prefix":"d","role":null}]}"#;
        let fixed: serde_json::Value = serde_json::from_str(&default_missing_grant_roles(body)).unwrap();
        let roles: Vec<&str> = fixed["folder_grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["reader", "reader", "writer", "reader"]);
        assert_eq!(fixed["memberships"][0]["role"], "writer", "whole-drive rows are untouched");

        let untouched = r#"{"memberships":[]}"#;
        assert_eq!(default_missing_grant_roles(untouched), untouched);
        assert_eq!(default_missing_grant_roles("not json"), "not json");
    }
}
