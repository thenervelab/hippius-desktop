//! Folder collaboration with roles: Viewer, Editor and Manager on ONE folder
//! of a drive, instead of today's read-only folder grants.
//!
//! # Assumed until HCFS publishes folder roles
//!
//! The server side is agreed but NOT published. Everything below is built
//! against this assumed contract, kept in this one module so the day the real
//! API lands there is one place to reconcile. Every desktop surface that
//! depends on it is gated on the `FOLDER_ROLES_ENABLED` lane flag (staging
//! only) AND on the capability in (1); with either off the desktop behaves
//! exactly as before (reader-only, single-use folder invites).
//!
//! 1. **Capability.** `GET /v1/capabilities` carries `folder_grant_roles:
//!    bool` beside `folder_grants`. Absent or false means reader-only grants.
//! 2. **Folder invite mint.** `POST /v1/drive-invites` accepts
//!    `{ folder_hash, path_prefix, role: reader|writer|manager,
//!    expires_in_secs?, max_uses?, owner_ss58? }` and echoes `path_prefix`.
//!    The desktop keeps the folder lifetime cap of 30 days, sends one use
//!    unless the caller asks for more, and caps a Manager folder invite like
//!    a Manager drive invite (one use, 24 hours).
//! 3. **Email folder invite.** `POST /v1/drive-invites/email` accepts
//!    `path_prefix` with role `reader|writer` (a Manager is a link only, as
//!    for whole drives). Approving one seals the folder's DERIVED file key,
//!    the same bytes a folder link's `#k=` carries.
//! 4. **Listings carry the role.** `GET /v1/drive-memberships`
//!    `folder_grants[]` entries carry `role`; a missing or empty role reads
//!    as `reader`. `GET /v1/drives/{fh}/members` `folder_grants[]` entries
//!    carry `member_name`, `member_email`, `path_prefix` and `role`.
//! 5. **Change a holder's role.** `PATCH /v1/drives/{fh}/grants/{member_ss58}`
//!    with `{ role }`, plus `?owner=` when delegated. Changing folders stays
//!    `PUT /v1/drives/{fh}/grants/{member_ss58}` `{ path_prefixes }`, and
//!    removing stays `DELETE /v1/drives/{fh}/members/{member_ss58}`.
//! 6. **Holders write like members.** A grant holder uploads, creates
//!    folders, renames and shares by link through the same routes as a drive
//!    member, naming the owner, and the server confines them to the granted
//!    folder. A folder Manager mints folder invites and manages holders at or
//!    below their own grant.
//! 7. **The holder's key.** A grant blob opens (like a membership grant) to
//!    the folder's DERIVED file key, not the drive's mnemonic entropy. That
//!    key encrypts files and paths and, being the same `seed[..32]` bytes the
//!    drive's phrase yields, also signs manifests.
//!
//! Joining a folder stays in the console: the desktop opens the console's
//! invite URL. Syncing a granted folder to disk is out of scope; holders
//! browse it remotely, rooted at the grant.

use crate::error::{AppError, Result};
use crate::shares::capabilities::ServerCapabilities;

use super::commands::{MANAGER_INVITE_MAX_SECS, MANAGER_INVITE_MAX_USES, WIRE_ROLES};
use super::folder_grant_path::{FOLDER_INVITE_MAX_SECS, FOLDER_INVITE_MAX_USES, apply_folder_invite_policy, folder_grant_path_prefix};

/// Whether this server speaks folder roles (assumption 1). Folder roles need
/// folder grants underneath them; a server claiming one without the other is
/// read as not supporting roles.
pub fn folder_roles_supported(caps: &ServerCapabilities) -> bool {
    caps.folder_grants && caps.folder_grant_roles
}

/// The role a grant row names, read defensively (assumption 4): missing or
/// blank is `reader`, and an unknown word degrades to `reader` too, never to
/// management. Kept in step with `parseDriveRole` on the FE.
pub fn grant_role(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(role) if WIRE_ROLES.contains(&role) => role.to_string(),
        _ => "reader".to_string(),
    }
}

/// Resolve what a folder invite is minted as.
///
/// Without folder roles this is exactly the old policy: reader, one use, at
/// most thirty days, whatever the caller asked for. With them (assumption 2)
/// the role is the caller's (default `reader`), one use unless they ask for
/// more, still at most thirty days, and a Manager invite is capped like a
/// Manager drive invite.
pub fn resolve_folder_invite_policy(roles: bool, role: Option<String>, expires_in_secs: u64, max_uses: Option<u32>) -> Result<(u64, u32, String)> {
    if !roles {
        let (secs, uses, role) = apply_folder_invite_policy(expires_in_secs);
        return Ok((secs, uses, role.to_string()));
    }
    let role = role.unwrap_or_else(|| "reader".to_string());
    if !WIRE_ROLES.contains(&role.as_str()) {
        return Err(AppError::Validation(format!(
            "Unknown folder role: {role}. Expected one of reader, writer, manager."
        )));
    }
    let secs = expires_in_secs.min(FOLDER_INVITE_MAX_SECS);
    let uses = max_uses.unwrap_or(FOLDER_INVITE_MAX_USES).max(1);
    let (secs, uses) = if role == "manager" {
        (secs.min(MANAGER_INVITE_MAX_SECS), uses.min(MANAGER_INVITE_MAX_USES))
    } else {
        (secs, uses)
    };
    Ok((secs, uses, role))
}

/// Gate and normalise a folder email invite (assumption 3). Refused by name
/// on a server without folder roles, where the route would 400 the field.
pub fn require_folder_email_invites(caps: &ServerCapabilities, raw_path_prefix: &str) -> Result<String> {
    if !folder_roles_supported(caps) {
        return Err(AppError::Validation("Inviting to a folder by email needs a newer server.".into()));
    }
    folder_grant_path_prefix(raw_path_prefix)
}

/// Validate a role change for a folder grant holder.
pub fn validate_grant_role_change(caps: &ServerCapabilities, role: &str) -> Result<()> {
    if !folder_roles_supported(caps) {
        return Err(AppError::Validation("Changing folder roles needs a newer server.".into()));
    }
    if !WIRE_ROLES.contains(&role) {
        return Err(AppError::Validation(format!(
            "Unknown folder role: {role}. Expected one of reader, writer, manager."
        )));
    }
    Ok(())
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

/// `PATCH /v1/drives/{folder_hash}/grants/{member_ss58}` with `{ role }`
/// (assumption 5). `owner` is `Some` when a delegated manager calls.
pub async fn http_change_folder_grant_role(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    member_ss58: &str,
    role: &str,
    owner: Option<&str>,
) -> Result<()> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1/drives/{}/grants/{}",
        base_url.trim_end_matches('/'),
        folder_hash,
        member_ss58
    ))
    .map_err(|e| AppError::Hcfs(format!("invalid grant-role URL: {e}")))?;
    if let Some(owner) = owner {
        url.query_pairs_mut().append_pair("owner", owner);
    }
    let resp = http
        .patch(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&serde_json::json!({ "role": role }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("change-grant-role request failed: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(super::commands::classify_error_status(status, &body));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(folder_grants: bool, roles: bool) -> ServerCapabilities {
        ServerCapabilities {
            folder_grants,
            folder_grant_roles: roles,
            ..ServerCapabilities::default()
        }
    }

    #[test]
    fn roles_need_folder_grants_underneath() {
        assert!(folder_roles_supported(&caps(true, true)));
        assert!(!folder_roles_supported(&caps(true, false)));
        assert!(!folder_roles_supported(&caps(false, true)));
    }

    #[test]
    fn a_grant_role_degrades_to_reader() {
        assert_eq!(grant_role(Some("writer")), "writer");
        assert_eq!(grant_role(Some("manager")), "manager");
        assert_eq!(grant_role(None), "reader");
        assert_eq!(grant_role(Some("  ")), "reader");
        assert_eq!(grant_role(Some("owner")), "reader", "never management by accident");
    }

    #[test]
    fn without_roles_a_folder_invite_is_exactly_what_it_was() {
        // Whatever the caller asks for, today's server gets reader / 1 / <=30d.
        let (secs, uses, role) = resolve_folder_invite_policy(false, Some("manager".into()), 100 * 365 * 86_400, Some(50)).unwrap();
        assert_eq!((secs, uses, role.as_str()), (FOLDER_INVITE_MAX_SECS, 1, "reader"));
    }

    #[test]
    fn with_roles_the_caller_picks_within_the_caps() {
        let (secs, uses, role) = resolve_folder_invite_policy(true, Some("writer".into()), 3600, None).unwrap();
        assert_eq!((secs, uses, role.as_str()), (3600, 1, "writer"), "single use unless asked");
        let (_, uses, _) = resolve_folder_invite_policy(true, Some("reader".into()), 3600, Some(5)).unwrap();
        assert_eq!(uses, 5);
        let (secs, _, _) = resolve_folder_invite_policy(true, None, 100 * 365 * 86_400, None).unwrap();
        assert_eq!(secs, FOLDER_INVITE_MAX_SECS, "folder invites never outlive 30 days");
        let (secs, uses, role) = resolve_folder_invite_policy(true, Some("manager".into()), 7 * 86_400, Some(9)).unwrap();
        assert_eq!((secs, uses, role.as_str()), (MANAGER_INVITE_MAX_SECS, 1, "manager"));
        assert!(resolve_folder_invite_policy(true, Some("admin".into()), 3600, None).is_err());
        let (_, uses, _) = resolve_folder_invite_policy(true, None, 3600, Some(0)).unwrap();
        assert_eq!(uses, 1, "zero uses is never sent");
    }

    #[test]
    fn folder_email_invites_need_roles_and_a_folder() {
        assert!(require_folder_email_invites(&caps(true, false), "Clients").is_err());
        assert_eq!(require_folder_email_invites(&caps(true, true), "/Clients/ACME/").unwrap(), "Clients/ACME");
        assert!(require_folder_email_invites(&caps(true, true), "").is_err(), "never the whole drive");
    }

    #[test]
    fn a_role_change_needs_roles_and_a_known_role() {
        assert!(validate_grant_role_change(&caps(true, false), "writer").is_err());
        assert!(validate_grant_role_change(&caps(true, true), "writer").is_ok());
        assert!(validate_grant_role_change(&caps(true, true), "owner").is_err());
    }

    #[test]
    fn missing_grant_roles_read_as_reader_and_nothing_else_moves() {
        let body = r#"{"memberships":[{"role":"writer"}],"folder_grants":[{"path_prefix":"a"},{"path_prefix":"b","role":""},{"path_prefix":"c","role":"manager"},{"path_prefix":"d","role":null}]}"#;
        let fixed: serde_json::Value = serde_json::from_str(&default_missing_grant_roles(body)).unwrap();
        let roles: Vec<&str> = fixed["folder_grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["reader", "reader", "manager", "reader"]);
        assert_eq!(fixed["memberships"][0]["role"], "writer", "whole-drive rows are untouched");

        let untouched = r#"{"memberships":[]}"#;
        assert_eq!(default_missing_grant_roles(untouched), untouched);
        assert_eq!(default_missing_grant_roles("not json"), "not json");
    }
}
