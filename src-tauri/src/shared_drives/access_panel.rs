//! The Manage access side panel's data, folded in Rust (`list_access_panel`).
//!
//! The panel is one scrolling list grouped as People, Pending invites and
//! Links. Everything it shows is decided here so the webview only draws:
//!
//! - who is in it: the owner, whole-drive members (on a folder panel too:
//!   they can open every folder), and folder
//!   holders. A drive panel lists EVERY holder on the drive, tagged with the
//!   folder they hold; a folder panel lists the holders of a grant at or above
//!   the folder (nearest grant wins, as in the Share dialog's fold). Only the
//!   owner and managers are sent folder grants by the server.
//! - emailed invitations still waiting: every live one on a drive panel
//!   (folder ones carry their folder), exactly that folder's on a folder panel.
//! - links: link invites (not emailed) split into active and ended, with the
//!   state, usage and expiry worked out here from the server's row and the
//!   clock, never in TypeScript.
//! - `links_locked`: some active link has a sealed copy that cannot be opened
//!   because the drive key is not available in this session. The panel then
//!   asks for the unlock password instead of showing a broken field.
//! - what the viewer is here (`your_role`, and `can_manage`: the owner or a
//!   Manager, decided by `commands::manages_drive`), so the header and footer
//!   never guess from a second listing.
//! - roles as this client shows them: Viewer, Editor or Manager; anything
//!   else the server returns reads as a Viewer (`drive_role_from_wire`).
//!
//! Pure: the command fetches, opens sealed links, and hands the rows here.

use std::cmp::Reverse;

use chrono::{DateTime, Utc};
use hcfs_shared::network::{DriveGrantHolderEntry, DriveMembersResponse};
use serde::Serialize;

use super::commands::{DriveInviteInfo, drive_role_from_wire, manages_drive, present_email, present_text as present};
use super::folder_grant_path::prefix_covers;
use super::folder_roles::grant_role;

/// An expiry further out than this is the server's "never expires" sentinel
/// (a 100-year lifetime), not a date anyone should be shown.
const NEVER_EXPIRES_AFTER_SECS: i64 = 50 * 365 * 24 * 60 * 60;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPanel {
    pub owner_ss58: String,
    pub owner_is_you: bool,
    /// This account's role here: `owner`, its member role, or the role of the
    /// folder grant it holds. `None` when the listings do not say.
    pub your_role: Option<String>,
    /// The drive's owner or a whole-drive Manager: may invite, change roles,
    /// remove and see links. Everyone else reads the people list and may
    /// leave.
    pub can_manage: bool,
    /// Whole-drive members, this account first, then the most recently
    /// joined. A folder panel lists them too, since the whole drive includes
    /// the folder.
    pub members: Vec<AccessPanelMember>,
    /// Folder holders, this account first. See the module doc for which.
    pub folder_holders: Vec<AccessPanelHolder>,
    /// Emailed invitations still waiting, newest first.
    pub pending_invites: Vec<AccessPanelInvite>,
    /// Link invites that still work, most recently created first.
    pub links: Vec<AccessPanelLink>,
    /// Link invites that no longer work (expired, used up or revoked), most
    /// recently created first.
    pub inactive_links: Vec<AccessPanelLink>,
    /// Active links exist that only the unlock password can show.
    pub links_locked: bool,
    /// People with whole-drive access (a folder panel says they can open it).
    pub drive_member_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPanelMember {
    pub member_ss58: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
    /// RFC 3339 join time, for the row's "Joined" line when there is no email.
    pub created_at: String,
    /// This account: its own role is not changeable here (a member leaves).
    pub is_you: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPanelHolder {
    pub member_ss58: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_email: Option<String>,
    pub is_you: bool,
    /// `reader` or `writer`, of the grant named by `path_prefix`.
    pub role: String,
    /// The folder the row is tagged with: on a folder panel the grant that
    /// covers it (the folder itself or one around it), on a drive panel the
    /// first of their folders.
    pub path_prefix: String,
    /// Every folder they hold on this drive, sorted. Change folders edits
    /// this list, and Remove takes all of it away.
    pub folders: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPanelInvite {
    #[serde(flatten)]
    pub invite: DriveInviteInfo,
    /// Seconds until it expires, from now; `None` for an unreadable date.
    pub expires_in_secs: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Active,
    Revoked,
    Expired,
    UsedUp,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPanelLink {
    pub invite_id: String,
    /// `reader`, `writer` or `manager`.
    pub role: String,
    /// The folder of a folder link; absent for a whole-drive link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    /// Who made it. Empty when the server has no provenance for it.
    pub minted_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minted_by_name: Option<String>,
    pub minted_by_you: bool,
    pub use_count: u32,
    pub max_uses: u32,
    /// One use only: the row says whether it was used rather than a count.
    pub single_use: bool,
    /// `use_count / max_uses` as a whole percent, 0 to 100.
    pub usage_percent: u8,
    pub status: LinkStatus,
    pub expires_at: String,
    /// The server's 100-year lifetime: the row says "Never expires".
    pub never_expires: bool,
    /// Seconds left on an active, expiring link; `None` otherwise.
    pub expires_in_secs: Option<i64>,
    /// The full link, when its sealed copy opened here. A capability: copy it,
    /// never log it. The panel shows it with the key after `#` hidden.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_url: Option<String>,
    /// A sealed copy exists: the row has a link field, filled from
    /// `invite_url` or drawn locked.
    pub link_available: bool,
}

/// Where a folder-scoped row belongs. A drive panel shows every row; a folder
/// panel only the rows for exactly that folder.
fn in_panel(folder: Option<&str>, path: Option<&str>) -> bool {
    let path = path.map(|p| p.trim_matches('/')).filter(|p| !p.is_empty());
    match folder {
        None => true,
        Some(f) => path == Some(f),
    }
}

/// Sort key for "newest first": a later time sorts earlier, and a time that
/// does not parse sorts after every one that does (stable among themselves).
fn newest_first(created_at: &str) -> Reverse<Option<DateTime<Utc>>> {
    Reverse(DateTime::parse_from_rfc3339(created_at).ok().map(|t| t.with_timezone(&Utc)))
}

fn seconds_until(expires_at: &str, now: DateTime<Utc>) -> Option<i64> {
    DateTime::parse_from_rfc3339(expires_at)
        .ok()
        .map(|t| (t.with_timezone(&Utc) - now).num_seconds())
}

/// Why a link does or does not work. Revoked first: it is what somebody did,
/// and it should not read as "expired" because time also passed. A link the
/// server calls invalid for a reason it did not give reads as expired.
pub(crate) fn link_status(invite: &DriveInviteInfo, now: DateTime<Utc>) -> LinkStatus {
    if invite.revoked {
        return LinkStatus::Revoked;
    }
    if seconds_until(&invite.expires_at, now).is_some_and(|s| s <= 0) {
        return LinkStatus::Expired;
    }
    if invite.max_uses > 0 && invite.use_count >= invite.max_uses {
        return LinkStatus::UsedUp;
    }
    if !invite.valid {
        return LinkStatus::Expired;
    }
    LinkStatus::Active
}

fn panel_link(invite: DriveInviteInfo, account_id: &str, now: DateTime<Utc>) -> AccessPanelLink {
    let status = link_status(&invite, now);
    let left = seconds_until(&invite.expires_at, now);
    let never_expires = left.is_some_and(|s| s > NEVER_EXPIRES_AFTER_SECS);
    let usage_percent = if invite.max_uses == 0 {
        0
    } else {
        (u64::from(invite.use_count) * 100 / u64::from(invite.max_uses)).min(100) as u8
    };
    let active = status == LinkStatus::Active;
    AccessPanelLink {
        minted_by_you: !invite.minted_by.is_empty() && invite.minted_by == account_id,
        single_use: invite.max_uses <= 1,
        usage_percent,
        status,
        never_expires,
        expires_in_secs: if active && !never_expires { left.map(|s| s.max(0)) } else { None },
        // A dead link's field would offer to copy something that no longer works.
        link_available: active && invite.link_available,
        invite_url: if active { invite.invite_url } else { None },
        invite_id: invite.invite_id,
        role: drive_role_from_wire(&invite.role),
        path_prefix: invite.path_prefix.filter(|p| !p.trim_matches('/').is_empty()),
        minted_by: invite.minted_by,
        minted_by_name: invite.minted_by_name,
        use_count: invite.use_count,
        max_uses: invite.max_uses,
        expires_at: invite.expires_at,
    }
}

/// A name or email from any of a holder's grants: the server may send it on
/// one row and not another, and the row should name them either way.
/// `keep` is [`present`] for a name and [`present_email`] for an email, so a
/// placeholder on one grant does not stop a real address on another.
fn first_present(
    grants: &[DriveGrantHolderEntry],
    ss58: &str,
    field: impl Fn(&DriveGrantHolderEntry) -> &Option<String>,
    keep: fn(Option<String>) -> Option<String>,
) -> Option<String> {
    grants.iter().filter(|g| g.member_ss58 == ss58).find_map(|g| keep(field(g).clone()))
}

/// Folder holders, one row each, this account first. See the module doc.
fn fold_holders(account_id: &str, folder: Option<&str>, grants: &[DriveGrantHolderEntry]) -> Vec<AccessPanelHolder> {
    let folders_of = |ss58: &str| -> Vec<String> {
        let mut held: Vec<String> = grants.iter().filter(|g| g.member_ss58 == ss58).map(|g| g.path_prefix.clone()).collect();
        held.sort();
        held.dedup();
        held
    };

    let mut folder_holders: Vec<AccessPanelHolder> = Vec::new();
    for grant in grants {
        let covers = match folder {
            None => true,
            Some(f) => prefix_covers(&grant.path_prefix, f),
        };
        if !covers {
            continue;
        }
        let row = AccessPanelHolder {
            member_ss58: grant.member_ss58.clone(),
            member_name: first_present(grants, &grant.member_ss58, |g| &g.member_name, present),
            member_email: first_present(grants, &grant.member_ss58, |g| &g.member_email, present_email),
            is_you: grant.member_ss58 == account_id,
            role: grant_role(Some(&grant.role)),
            path_prefix: grant.path_prefix.clone(),
            folders: folders_of(&grant.member_ss58),
        };
        match folder_holders.iter_mut().find(|h| h.member_ss58 == row.member_ss58) {
            // A folder panel: the nearer of two covering grants describes them.
            // A drive panel: the row is tagged with their first folder.
            Some(existing) => {
                let better = match folder {
                    Some(_) => row.path_prefix.len() > existing.path_prefix.len(),
                    None => row.path_prefix < existing.path_prefix,
                };
                if better {
                    existing.role = row.role;
                    existing.path_prefix = row.path_prefix;
                }
            }
            None => folder_holders.push(row),
        }
    }
    folder_holders.sort_by_key(|h| !h.is_you);
    folder_holders
}

/// Emailed invitations still waiting, then link invites split into working
/// and ended, each kept only when it belongs to this panel.
fn split_invites(
    account_id: &str,
    folder: Option<&str>,
    mut invites: Vec<DriveInviteInfo>,
    now: DateTime<Utc>,
) -> (Vec<AccessPanelInvite>, Vec<AccessPanelLink>, Vec<AccessPanelLink>) {
    // Newest first in every group: the panel draws the first few rows of each,
    // and the invitation or link just made is the one being looked for.
    invites.sort_by_key(|i| newest_first(&i.created_at));
    let mut pending_invites = Vec::new();
    let mut links = Vec::new();
    let mut inactive_links = Vec::new();
    for invite in invites {
        if !in_panel(folder, invite.path_prefix.as_deref()) {
            continue;
        }
        if invite.email_status.is_some() {
            if invite.valid && !invite.revoked {
                let expires_in_secs = seconds_until(&invite.expires_at, now);
                let invite = DriveInviteInfo {
                    role: drive_role_from_wire(&invite.role),
                    ..invite
                };
                pending_invites.push(AccessPanelInvite { invite, expires_in_secs });
            }
            continue;
        }
        let link = panel_link(invite, account_id, now);
        if link.status == LinkStatus::Active {
            links.push(link);
        } else {
            inactive_links.push(link);
        }
    }
    (pending_invites, links, inactive_links)
}

/// Fold the member listing and the (already opened, normalised) invite
/// listing into the panel. `folder` is the drive-relative folder, `None` for
/// the whole drive. `key_unavailable`: the drive key could not be read in
/// this session, so sealed links stay closed until the user unlocks.
pub(crate) fn fold_access_panel(
    account_id: &str,
    owner_ss58: &str,
    folder: Option<&str>,
    listing: DriveMembersResponse,
    invites: Vec<DriveInviteInfo>,
    key_unavailable: bool,
    now: DateTime<Utc>,
) -> AccessPanel {
    let owner_is_you = owner_ss58 == account_id;
    let drive_member_count = listing.members.len();

    let your_member_role = listing
        .members
        .iter()
        .find(|m| m.member_ss58 == account_id)
        .map(|m| drive_role_from_wire(&m.role));

    let mut members: Vec<AccessPanelMember> = listing
        .members
        .into_iter()
        .map(|m| AccessPanelMember {
            is_you: m.member_ss58 == account_id,
            member_ss58: m.member_ss58,
            role: drive_role_from_wire(&m.role),
            member_name: present(m.member_name),
            member_email: present_email(m.member_email),
            created_at: m.created_at,
        })
        .collect();
    // This account first, then the most recently joined: the panel draws the
    // first few people, and the newest are the ones being checked on. Stable,
    // so equal or unreadable join times keep the server's order.
    members.sort_by_key(|m| (!m.is_you, newest_first(&m.created_at)));

    let folder_holders = fold_holders(account_id, folder, &listing.folder_grants);

    let your_role = if owner_is_you {
        Some("owner".to_string())
    } else if let Some(role) = your_member_role.clone() {
        Some(role)
    } else {
        folder_holders.iter().find(|h| h.is_you).map(|h| h.role.clone())
    };
    // The owner, or a whole-drive Manager (the one rule, `manages_drive`). A
    // folder grant never opens the controls: Manager is not a folder role.
    let can_manage = manages_drive(!owner_is_you, your_member_role.as_deref());

    let (pending_invites, links, inactive_links) = split_invites(account_id, folder, invites, now);
    let links_locked = key_unavailable && links.iter().any(|l| l.link_available && l.invite_url.is_none());

    AccessPanel {
        owner_ss58: owner_ss58.to_string(),
        owner_is_you,
        your_role,
        can_manage,
        members,
        folder_holders,
        pending_invites,
        links,
        inactive_links,
        links_locked,
        drive_member_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z").unwrap().with_timezone(&Utc)
    }

    fn listing() -> DriveMembersResponse {
        serde_json::from_value(serde_json::json!({
            "members": [
                {"member_ss58": "5Ann", "role": "writer", "created_at": "t", "member_name": " Ann "},
                {"member_ss58": "5Me", "role": "manager", "created_at": "t"},
            ],
            "folder_grants": [
                {"member_ss58": "5Bo", "path_prefix": "Work", "role": "reader", "created_at": "t"},
                {"member_ss58": "5Bo", "path_prefix": "Clients", "role": "reader", "created_at": "t", "member_name": "Bo"},
                {"member_ss58": "5Bo", "path_prefix": "Clients/ACME", "role": "writer", "created_at": "t"},
                {"member_ss58": "5Cy", "path_prefix": "Clients/ACME Photos", "role": "writer", "created_at": "t"},
            ],
        }))
        .expect("listing")
    }

    fn invite(id: &str, extra: serde_json::Value) -> DriveInviteInfo {
        let mut base = serde_json::json!({
            "invite_id": id, "role": "writer", "minted_by": "5Me", "expires_at": "2026-09-29T12:00:00Z",
            "max_uses": 50, "use_count": 12, "revoked": false, "valid": true, "created_at": "t",
        });
        for (k, v) in extra.as_object().expect("object") {
            base[k.as_str()] = v.clone();
        }
        let mut parsed: DriveInviteInfo = serde_json::from_value(base).expect("invite");
        // What the command attaches after opening the sealed copy.
        parsed.link_available = true;
        parsed
    }

    #[test]
    fn a_drive_panel_lists_members_and_every_holder_tagged_with_a_folder() {
        let panel = fold_access_panel("5Me", "5Owner", None, listing(), Vec::new(), false, now());
        assert!(!panel.owner_is_you);
        assert_eq!(panel.your_role.as_deref(), Some("manager"));
        assert!(panel.can_manage, "a whole-drive Manager manages somebody else's drive");
        let people: Vec<&str> = panel.members.iter().map(|m| m.member_ss58.as_str()).collect();
        assert_eq!(people, ["5Me", "5Ann"], "you first, then the server's order");
        assert_eq!(panel.members[1].member_name.as_deref(), Some("Ann"));

        let holders: Vec<(&str, &str, &str, usize)> = panel
            .folder_holders
            .iter()
            .map(|h| (h.member_ss58.as_str(), h.path_prefix.as_str(), h.role.as_str(), h.folders.len()))
            .collect();
        assert_eq!(holders, [("5Bo", "Clients", "reader", 3), ("5Cy", "Clients/ACME Photos", "writer", 1)]);
        assert_eq!(panel.folder_holders[0].folders, ["Clients", "Clients/ACME", "Work"]);
        assert_eq!(
            panel.folder_holders[0].member_name.as_deref(),
            Some("Bo"),
            "a name on any grant names them"
        );
    }

    #[test]
    fn a_placeholder_email_never_reaches_a_member_or_holder_row() {
        let listing: DriveMembersResponse = serde_json::from_value(serde_json::json!({
            "members": [
                {"member_ss58": "5Ann", "role": "writer", "created_at": "t", "member_email": "user_abc@hippius.local"},
                {"member_ss58": "5Eve", "role": "reader", "created_at": "t", "member_email": " eve@example.com "},
            ],
            "folder_grants": [
                {"member_ss58": "5Bo", "path_prefix": "Work", "role": "reader", "created_at": "t", "member_email": "USER_BO@Hippius.Local"},
                {"member_ss58": "5Bo", "path_prefix": "Clients", "role": "reader", "created_at": "t", "member_email": "bo@example.com"},
                {"member_ss58": "5Cy", "path_prefix": "Photos", "role": "writer", "created_at": "t", "member_email": "user_cy@hippius.local"},
            ],
        }))
        .expect("listing");
        let panel = fold_access_panel("5Owner", "5Owner", None, listing, Vec::new(), false, now());
        let email = |ss58: &str| panel.members.iter().find(|m| m.member_ss58 == ss58).and_then(|m| m.member_email.clone());
        assert_eq!(
            email("5Ann"),
            None,
            "a placeholder is absent, so the row falls back to the name or address"
        );
        assert_eq!(email("5Eve").as_deref(), Some("eve@example.com"), "a real address is kept, trimmed");
        let holder = |ss58: &str| {
            panel
                .folder_holders
                .iter()
                .find(|h| h.member_ss58 == ss58)
                .and_then(|h| h.member_email.clone())
        };
        assert_eq!(
            holder("5Bo").as_deref(),
            Some("bo@example.com"),
            "a placeholder on one grant does not hide a real one on another"
        );
        assert_eq!(holder("5Cy"), None);
    }

    #[test]
    fn a_folder_panel_lists_holders_at_or_above_it_by_the_nearest_grant() {
        let panel = fold_access_panel("5Owner", "5Owner", Some("Clients/ACME"), listing(), Vec::new(), false, now());
        assert_eq!(panel.your_role.as_deref(), Some("owner"));
        let whole_drive: Vec<&str> = panel.members.iter().map(|m| m.member_ss58.as_str()).collect();
        assert_eq!(whole_drive, ["5Ann", "5Me"], "whole-drive members can open the folder too");
        assert_eq!(panel.drive_member_count, 2);
        let holders: Vec<(&str, &str, &str)> = panel
            .folder_holders
            .iter()
            .map(|h| (h.member_ss58.as_str(), h.path_prefix.as_str(), h.role.as_str()))
            .collect();
        // "ACME Photos" is a sibling, not the folder.
        assert_eq!(holders, [("5Bo", "Clients/ACME", "writer")]);
    }

    #[test]
    fn a_holder_viewing_a_folder_is_told_their_role_and_cannot_manage() {
        let panel = fold_access_panel("5Bo", "5Owner", Some("Clients/ACME"), listing(), Vec::new(), false, now());
        assert_eq!(panel.your_role.as_deref(), Some("writer"));
        assert!(!panel.can_manage);
        assert!(panel.folder_holders[0].is_you);
    }

    /// The owner and a whole-drive Manager manage. An Editor, a Viewer, a
    /// folder holder (even a writer one) and a stranger only read.
    #[test]
    fn only_the_owner_or_a_manager_can_manage() {
        for viewer in ["5Ann", "5Bo", "5Cy", "5Stranger"] {
            for folder in [None, Some("Clients/ACME")] {
                let panel = fold_access_panel(viewer, "5Owner", folder, listing(), Vec::new(), false, now());
                assert!(!panel.can_manage, "{viewer} on {folder:?} must not manage");
            }
        }
        for folder in [None, Some("Clients/ACME")] {
            assert!(fold_access_panel("5Me", "5Owner", folder, listing(), Vec::new(), false, now()).can_manage);
            assert!(fold_access_panel("5Owner", "5Owner", folder, listing(), Vec::new(), false, now()).can_manage);
        }
    }

    /// An unknown member role reads as a Viewer and never opens the controls.
    #[test]
    fn an_unknown_member_role_reads_as_a_viewer() {
        let listing: DriveMembersResponse = serde_json::from_value(serde_json::json!({
            "members": [{"member_ss58": "5Me", "role": "admin", "created_at": "t"}],
        }))
        .expect("listing");
        let panel = fold_access_panel("5Me", "5Owner", None, listing, Vec::new(), false, now());
        assert_eq!(panel.your_role.as_deref(), Some("reader"));
        assert_eq!(panel.members[0].role, "reader");
        assert!(!panel.can_manage);
    }

    #[test]
    fn links_are_split_into_working_and_ended_with_reasons() {
        let invites = vec![
            invite("live", serde_json::json!({})),
            invite("revoked", serde_json::json!({"revoked": true, "valid": false})),
            invite("expired", serde_json::json!({"expires_at": "2026-09-01T00:00:00Z", "valid": false})),
            invite("used-up", serde_json::json!({"max_uses": 1, "use_count": 1, "valid": false})),
            invite("mail", serde_json::json!({"email_status": "sent", "recipient_email": "a@b.c"})),
        ];
        let panel = fold_access_panel("5Me", "5Owner", None, listing(), invites, false, now());
        let active: Vec<&str> = panel.links.iter().map(|l| l.invite_id.as_str()).collect();
        assert_eq!(active, ["live"]);
        let ended: Vec<(&str, LinkStatus)> = panel.inactive_links.iter().map(|l| (l.invite_id.as_str(), l.status)).collect();
        assert_eq!(
            ended,
            [
                ("revoked", LinkStatus::Revoked),
                ("expired", LinkStatus::Expired),
                ("used-up", LinkStatus::UsedUp)
            ]
        );
        assert!(panel.inactive_links.iter().all(|l| !l.link_available && l.invite_url.is_none()));
        let pending: Vec<&str> = panel.pending_invites.iter().map(|p| p.invite.invite_id.as_str()).collect();
        assert_eq!(pending, ["mail"], "an emailed invite is pending, never a link");
    }

    /// The panel draws the first few rows of each group, so each group comes
    /// newest first: you, then the most recently joined; the newest
    /// invitation; the most recently made link. An unreadable time goes last.
    #[test]
    fn every_group_comes_newest_first() {
        let listing: DriveMembersResponse = serde_json::from_value(serde_json::json!({
            "members": [
                {"member_ss58": "5Old", "role": "reader", "created_at": "2026-01-01T00:00:00Z"},
                {"member_ss58": "5Odd", "role": "reader", "created_at": "t"},
                {"member_ss58": "5New", "role": "reader", "created_at": "2026-09-01T00:00:00Z"},
                {"member_ss58": "5Me", "role": "reader", "created_at": "2025-01-01T00:00:00Z"},
                {"member_ss58": "5Mid", "role": "reader", "created_at": "2026-05-01T00:00:00Z"},
            ],
            "folder_grants": [],
        }))
        .expect("listing");
        let invites = vec![
            invite("link-old", serde_json::json!({"created_at": "2026-09-01T00:00:00Z"})),
            invite("link-new", serde_json::json!({"created_at": "2026-09-20T00:00:00Z"})),
            invite(
                "mail-old",
                serde_json::json!({"email_status": "sent", "created_at": "2026-09-02T00:00:00Z"}),
            ),
            invite(
                "mail-new",
                serde_json::json!({"email_status": "sent", "created_at": "2026-09-22T00:00:00Z"}),
            ),
            invite("ended-old", serde_json::json!({"revoked": true, "created_at": "2026-08-01T00:00:00Z"})),
            invite("ended-new", serde_json::json!({"revoked": true, "created_at": "2026-08-09T00:00:00Z"})),
        ];
        let panel = fold_access_panel("5Me", "5Owner", None, listing, invites, false, now());
        let people: Vec<&str> = panel.members.iter().map(|m| m.member_ss58.as_str()).collect();
        assert_eq!(people, ["5Me", "5New", "5Mid", "5Old", "5Odd"]);
        let pending: Vec<&str> = panel.pending_invites.iter().map(|p| p.invite.invite_id.as_str()).collect();
        assert_eq!(pending, ["mail-new", "mail-old"]);
        let links: Vec<&str> = panel.links.iter().map(|l| l.invite_id.as_str()).collect();
        assert_eq!(links, ["link-new", "link-old"]);
        let ended: Vec<&str> = panel.inactive_links.iter().map(|l| l.invite_id.as_str()).collect();
        assert_eq!(ended, ["ended-new", "ended-old"]);
    }

    #[test]
    fn a_link_row_carries_usage_expiry_and_its_maker() {
        let invites = vec![
            invite("live", serde_json::json!({})),
            invite(
                "forever",
                serde_json::json!({"expires_at": "2126-09-12T12:00:00Z", "minted_by": "5Sara", "minted_by_name": "Sara"}),
            ),
            invite("once", serde_json::json!({"max_uses": 1, "use_count": 0, "role": "manager"})),
        ];
        let panel = fold_access_panel("5Me", "5Owner", None, listing(), invites, false, now());
        let live = &panel.links[0];
        assert_eq!((live.usage_percent, live.single_use, live.minted_by_you), (24, false, true));
        assert_eq!(live.expires_in_secs, Some(5 * 24 * 3600));
        assert!(!live.never_expires);
        let forever = &panel.links[1];
        assert!(forever.never_expires && forever.expires_in_secs.is_none() && !forever.minted_by_you);
        let once = &panel.links[2];
        assert!(once.single_use);
        assert_eq!(once.usage_percent, 0);
        assert_eq!(once.role, "manager", "a Manager link reads as Manager");
    }

    #[test]
    fn a_folder_panel_shows_only_that_folders_links_and_invites() {
        let invites = vec![
            invite("drive-link", serde_json::json!({})),
            invite(
                "folder-link",
                serde_json::json!({"path_prefix": "Clients/ACME", "max_uses": 1, "use_count": 0}),
            ),
            invite("other-link", serde_json::json!({"path_prefix": "Work"})),
            invite(
                "folder-mail",
                serde_json::json!({"path_prefix": "/Clients/ACME/", "email_status": "sent"}),
            ),
        ];
        let folder = fold_access_panel("5Owner", "5Owner", Some("Clients/ACME"), listing(), invites, false, now());
        let links: Vec<&str> = folder.links.iter().map(|l| l.invite_id.as_str()).collect();
        assert_eq!(links, ["folder-link"]);
        assert_eq!(folder.pending_invites.len(), 1);

        let invites = vec![
            invite("drive-link", serde_json::json!({})),
            invite("folder-link", serde_json::json!({"path_prefix": "Clients/ACME"})),
        ];
        let drive = fold_access_panel("5Owner", "5Owner", None, listing(), invites, false, now());
        let tagged: Vec<Option<&str>> = drive.links.iter().map(|l| l.path_prefix.as_deref()).collect();
        assert_eq!(tagged, [None, Some("Clients/ACME")], "a drive panel keeps folder links, tagged");
    }

    #[test]
    fn links_are_locked_only_when_the_key_is_missing_and_a_sealed_link_is_closed() {
        let closed = || vec![invite("live", serde_json::json!({}))];
        assert!(fold_access_panel("5Me", "5Owner", None, listing(), closed(), true, now()).links_locked);
        assert!(!fold_access_panel("5Me", "5Owner", None, listing(), closed(), false, now()).links_locked);
        let mut open = closed();
        open[0].invite_url = Some("https://console.hippius.com/invite/t#k=x".into());
        assert!(!fold_access_panel("5Me", "5Owner", None, listing(), open, true, now()).links_locked);
    }

    /// The FE reads the panel by these keys (`AccessPanel` in `sharedDrives.ts`).
    #[test]
    fn access_panel_wire_keys_are_pinned() {
        let mut live = invite("live", serde_json::json!({"minted_by_name": "Me"}));
        live.invite_url = Some("https://console.hippius.com/invite/t#k=x".into());
        let invites = vec![
            live,
            invite(
                "mail",
                serde_json::json!({"email_status": "awaiting_seal", "recipient_email": "a@b.c", "max_uses": 1, "use_count": 0}),
            ),
        ];
        let panel = fold_access_panel("5Owner", "5Owner", Some("Work"), listing(), invites, false, now());
        let json = serde_json::to_value(&panel).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "ownerSs58": "5Owner",
                "ownerIsYou": true,
                "yourRole": "owner",
                "canManage": true,
                "members": [
                    {"memberSs58": "5Ann", "role": "writer", "memberName": "Ann", "createdAt": "t", "isYou": false},
                    {"memberSs58": "5Me", "role": "manager", "createdAt": "t", "isYou": false},
                ],
                "folderHolders": [{
                    "memberSs58": "5Bo", "memberName": "Bo", "isYou": false, "role": "reader",
                    "pathPrefix": "Work", "folders": ["Clients", "Clients/ACME", "Work"],
                }],
                "pendingInvites": [],
                "links": [],
                "inactiveLinks": [],
                "linksLocked": false,
                "driveMemberCount": 2,
            })
        );

        let drive = fold_access_panel(
            "5Me",
            "5Owner",
            None,
            listing(),
            vec![
                {
                    let mut l = invite("live", serde_json::json!({"minted_by_name": "Me"}));
                    l.invite_url = Some("https://console.hippius.com/invite/t#k=x".into());
                    l
                },
                invite("mail", serde_json::json!({"email_status": "awaiting_seal", "recipient_email": "a@b.c"})),
            ],
            false,
            now(),
        );
        assert_eq!(
            serde_json::to_value(&drive.links[0]).expect("serialize"),
            serde_json::json!({
                "inviteId": "live", "role": "writer", "mintedBy": "5Me", "mintedByName": "Me", "mintedByYou": true,
                "useCount": 12, "maxUses": 50, "singleUse": false, "usagePercent": 24, "status": "active",
                "expiresAt": "2026-09-29T12:00:00Z", "neverExpires": false, "expiresInSecs": 432_000,
                "inviteUrl": "https://console.hippius.com/invite/t#k=x", "linkAvailable": true,
            })
        );
        let pending = serde_json::to_value(&drive.pending_invites[0]).expect("serialize");
        assert_eq!(pending["inviteId"], "mail");
        assert_eq!(pending["emailStatus"], "awaiting_seal");
        assert_eq!(pending["recipientEmail"], "a@b.c");
        assert_eq!(pending["expiresInSecs"], 432_000);
        assert!(pending.get("sealedToken").is_none(), "no ciphertext on the wire");
        assert_eq!(serde_json::to_value(LinkStatus::UsedUp).expect("serialize"), serde_json::json!("used_up"));
    }
}
