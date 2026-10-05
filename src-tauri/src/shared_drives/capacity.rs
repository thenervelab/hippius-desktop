//! Whether a shared drive has room for one more person.
//!
//! One drive holds at most as many people as its OWNER's plan includes
//! (Plus 3, Max 8, Scale 20), plus any seats bought for that drive.
//! hcfs-server enforces it when an invite is ACCEPTED, so without this the
//! owner only learns the drive is full when the person they invited is
//! turned away. The Share dialog reads the verdict from here
//! (`ShareAccess::capacity`) and warns before anything is sent; it never
//! counts people or knows a plan's limit itself.
//!
//! The numbers are the server's own: `GET /v1/drives/{folder_hash}/seats`
//! (owner, or a Manager naming the owner with `?owner=`) returns the limit an
//! accept is checked against and the people it counts (distinct accounts
//! with a whole-drive membership or a folder grant, never the owner, never a
//! pending invitation). The app does not rebuild either from the member
//! listing and the plan table: that misses bought seats, and would decide a
//! drive is full while the server is only failing to answer.
//!
//! Unknown is never full. A drive the app cannot size (no answer, a Viewer
//! or an Editor, who are refused the route) is left to the server, which
//! refuses the accept with its own message, exactly as before.

use crate::error::{AppError, Result};
use hcfs_shared::network::{DriveMembersResponse, DriveSeatsResponse};
use serde::Serialize;

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How full a drive is, for the Share dialog. camelCase over IPC.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveCapacity {
    /// People the drive may hold, the owner not counted. `None` when the app
    /// cannot tell (limits off on the server, or no answer from it).
    pub member_limit: Option<u32>,
    /// People on the drive now, the owner not counted.
    pub people: u32,
    /// The drive already holds as many people as it may: inviting one more
    /// would end at the server's refusal when they try to join.
    pub full: bool,
}

/// The one rule: full when the drive holds at least as many people as its
/// limit. A limit of 0 is a plan without sharing at all, which the plan gate
/// (`canShareDrives`, the server's `shared_drives_not_entitled` on every
/// mint, a Manager's included) already answers with an upgrade card, so it
/// is not reported as a full drive.
pub fn is_full(member_limit: Option<u32>, people: u32) -> bool {
    matches!(member_limit, Some(limit) if limit > 0 && people >= limit)
}

/// The drive's capacity from the server's seats answer; unknown (never
/// full) without one.
pub fn capacity_from_seats(seats: Option<&DriveSeatsResponse>) -> DriveCapacity {
    let Some(seats) = seats else {
        return DriveCapacity::default();
    };
    DriveCapacity {
        member_limit: seats.member_limit,
        people: seats.people,
        full: is_full(seats.member_limit, seats.people),
    }
}

/// The addresses of everyone already on the drive (members and folder
/// holders), trimmed and lowercased, once each. An emailed invite to one of
/// them takes no new place, so a full drive still lets it through: the send
/// check uses this list, and the Share dialog gets the same list
/// (`ShareAccess.emails_with_access`) to keep Send enabled for them.
pub fn emails_with_access(listing: &DriveMembersResponse) -> Vec<String> {
    let mut emails: Vec<String> = listing
        .members
        .iter()
        .filter_map(|m| m.member_email.as_deref())
        .chain(listing.folder_grants.iter().filter_map(|g| g.member_email.as_deref()))
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    emails.sort();
    emails.dedup();
    emails
}

/// Whether an invite has to be refused because the drive is full. An
/// emailed invite to someone who already has access (a member, or a folder
/// holder being given more) takes no new place on the server, so it is not
/// refused; addresses compare trimmed and case-insensitively, as the server
/// binds an invitation to a mailbox. A link can be opened by anyone, so on a
/// full drive it is always refused.
pub fn invite_refused_as_full<'a>(
    capacity: DriveCapacity,
    invitee_email: Option<&str>,
    emails_with_access: impl IntoIterator<Item = &'a str>,
) -> bool {
    if !capacity.full {
        return false;
    }
    let Some(email) = invitee_email.map(|e| e.trim().to_lowercase()) else {
        return true;
    };
    !emails_with_access.into_iter().any(|known| known.trim().to_lowercase() == email)
}

/// Refuse an invite with `NotReady(DriveFull)` when the drive has no room
/// for the person it would bring in. Called by every command that sends an
/// invite (`mint_invite_link`, `email_drive_invite`) BEFORE the drive key is
/// touched, so a full drive never asks for a password first.
///
/// Every answer short of a verdict lets the invite through: the server still
/// refuses the join past the limit, which is how it behaved before.
pub(crate) async fn refuse_if_drive_full(
    state: &crate::app_state::AppState,
    ctx: &super::commands::ApiCtx,
    identity: &crate::sync::identity::DriveIdentity,
    invitee_email: Option<&str>,
) -> Result<()> {
    let http = state.api_client.clone();
    let owner = super::commands::member_owner(identity);
    let folder_hash = &identity.wire_folder_hash;

    let seats = http_drive_seats(&http, ctx.base_url(), ctx.bearer(), folder_hash, owner).await.ok();
    let capacity = capacity_from_seats(seats.as_ref());
    if !capacity.full {
        return Ok(());
    }

    // Only an email can name someone already on the drive. Without the
    // listing the address cannot be matched, so it is let through rather
    // than guessed.
    let emails = match invitee_email {
        None => Vec::new(),
        Some(_) => match super::commands::http_list_members(&http, ctx.base_url(), ctx.bearer(), folder_hash, owner).await {
            Ok(listing) => emails_with_access(&listing),
            Err(_) => return Ok(()),
        },
    };
    if invite_refused_as_full(capacity, invitee_email, emails.iter().map(String::as_str)) {
        tracing::info!(
            folder_hash = %folder_hash,
            people = capacity.people,
            member_limit = ?capacity.member_limit,
            "Invite refused: the drive is full"
        );
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveFull));
    }
    Ok(())
}

/// `GET /v1/drives/{folder_hash}/seats` (owner, or a Manager naming the
/// owner). Any failure is an error the caller treats as "no answer".
pub async fn http_drive_seats(
    http: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    folder_hash: &str,
    owner: Option<&str>,
) -> Result<DriveSeatsResponse> {
    let mut url = reqwest::Url::parse(&format!("{}/v1/drives/{}/seats", base_url.trim_end_matches('/'), folder_hash))
        .map_err(|e| AppError::Hcfs(format!("invalid shared-drive URL: {e}")))?;
    if let Some(owner) = owner {
        url.query_pairs_mut().append_pair("owner", owner);
    }
    let resp = http
        .get(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("drive-seats request failed: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(super::commands::classify_error_status(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AppError::Hcfs(format!("drive-seats response did not parse: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcfs_shared::network::{DriveGrantHolderEntry, DriveMemberEntry};

    fn member(ss58: &str) -> DriveMemberEntry {
        serde_json::from_value(serde_json::json!({
            "member_ss58": ss58, "role": "writer", "created_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    fn holder(ss58: &str, path: &str) -> DriveGrantHolderEntry {
        serde_json::from_value(serde_json::json!({
            "member_ss58": ss58, "path_prefix": path, "role": "reader", "created_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    fn listing(members: &[&str], holders: &[(&str, &str)]) -> DriveMembersResponse {
        DriveMembersResponse {
            members: members.iter().map(|s| member(s)).collect(),
            folder_grants: holders.iter().map(|(s, p)| holder(s, p)).collect(),
        }
    }

    fn json_seats(included: Option<u32>, extra: u32, limit: Option<u32>, people: u32) -> DriveSeatsResponse {
        serde_json::from_value(serde_json::json!({
            "included_members": included, "extra_seats": extra, "member_limit": limit, "people": people
        }))
        .unwrap()
    }

    #[test]
    fn a_drive_at_its_limit_is_full() {
        assert!(is_full(Some(3), 3), "Plus with 3 people");
        assert!(is_full(Some(8), 9), "above the limit after a downgrade");
        assert!(!is_full(Some(3), 2), "one place left");
        assert!(!is_full(Some(20), 0));
    }

    /// No limit known, or a plan without sharing: never reported as full,
    /// so the app never blocks an invite it cannot vouch for.
    #[test]
    fn an_unknown_or_zero_limit_is_never_full() {
        assert!(!is_full(None, 50));
        assert!(!is_full(Some(0), 0));
        assert!(!is_full(Some(0), 4));
    }

    /// The limit the server checks an accept against already includes the
    /// seats bought for the drive; the app takes it as it is.
    #[test]
    fn the_servers_limit_counts_bought_seats() {
        let c = capacity_from_seats(Some(&json_seats(Some(3), 2, Some(5), 4)));
        assert_eq!(
            c,
            DriveCapacity {
                member_limit: Some(5),
                people: 4,
                full: false
            }
        );
        let c = capacity_from_seats(Some(&json_seats(Some(3), 2, Some(5), 5)));
        assert!(c.full);
    }

    /// A server with member limits off answers `null`: never full.
    #[test]
    fn limits_off_on_the_server_are_never_full() {
        let c = capacity_from_seats(Some(&json_seats(None, 0, None, 30)));
        assert_eq!(c.member_limit, None);
        assert_eq!(c.people, 30);
        assert!(!c.full);
    }

    /// No answer from the server (an outage, a Viewer refused the route) is
    /// unknown, never full: the app does not guess from the plan table.
    #[test]
    fn no_answer_is_unknown_and_never_full() {
        assert_eq!(capacity_from_seats(None), DriveCapacity::default());
        assert!(!capacity_from_seats(None).full);
    }

    fn full() -> DriveCapacity {
        capacity_from_seats(Some(&json_seats(Some(3), 0, Some(3), 3)))
    }

    #[test]
    fn a_link_on_a_full_drive_is_refused() {
        assert!(invite_refused_as_full(full(), None, []));
    }

    #[test]
    fn nothing_is_refused_while_there_is_room() {
        let room = capacity_from_seats(Some(&json_seats(Some(3), 0, Some(3), 2)));
        assert!(!invite_refused_as_full(room, None, []));
        assert!(!invite_refused_as_full(room, Some("new@example.com"), []));
        assert!(!invite_refused_as_full(DriveCapacity::default(), None, []), "unknown is never full");
    }

    /// Someone already on the drive takes no new place, so mailing them (to
    /// the whole drive, or another folder) goes through on a full drive.
    #[test]
    fn an_email_to_someone_with_access_is_not_refused() {
        let on_drive = ["ada@example.com", "Bea@Example.com"];
        assert!(!invite_refused_as_full(full(), Some(" ADA@example.com "), on_drive));
        assert!(!invite_refused_as_full(full(), Some("bea@example.com"), on_drive));
        assert!(invite_refused_as_full(full(), Some("cy@example.com"), on_drive));
    }

    #[test]
    fn emails_with_access_are_normalised_and_listed_once() {
        let mut l = listing(&["5Ada", "5Bea"], &[("5Ada", "Clients"), ("5Cy", "Plans")]);
        l.members[0].member_email = Some(" Ada@Example.com ".into());
        l.folder_grants[0].member_email = Some("ada@example.com".into());
        l.folder_grants[1].member_email = Some("cy@example.com".into());
        assert_eq!(emails_with_access(&l), vec!["ada@example.com", "cy@example.com"]);
    }

    #[test]
    fn capacity_reaches_the_frontend_in_camel_case() {
        let v = serde_json::to_value(full()).unwrap();
        assert_eq!(v, serde_json::json!({ "memberLimit": 3, "people": 3, "full": true }));
        let v = serde_json::to_value(DriveCapacity::default()).unwrap();
        assert_eq!(v, serde_json::json!({ "memberLimit": null, "people": 0, "full": false }));
    }
}
