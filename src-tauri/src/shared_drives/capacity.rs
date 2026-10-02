//! Whether a shared drive has room for one more person.
//!
//! One drive holds at most as many people as its OWNER's plan includes
//! (Plus 3, Max 8, Scale 20). hcfs-server enforces it when an invite is
//! ACCEPTED, so without this the owner only learns the drive is full when the
//! person they invited is turned away. The Share dialog reads the verdict
//! from here (`ShareAccess::capacity`) and warns before anything is sent; it
//! never counts people or knows a plan's limit itself.
//!
//! People are counted the way the server counts them: distinct accounts
//! holding a whole-drive membership or a folder grant, each once however many
//! folders they hold. The owner is never counted, and pending invitations do
//! not count (the server checks the limit on accept, not on invite).
//!
//! Where the numbers come from, in order:
//!
//! 1. `GET /v1/drives/{folder_hash}/seats`: the server's own limit and head
//!    count for the drive, for the owner and for a Manager (`?owner=`).
//! 2. A server without that route (or one that did not answer): the people
//!    in the member listing the dialog already read, against the limit of
//!    this account's own plan. Only on a drive this account owns: a Manager
//!    cannot read the owner's plan, so there the limit is unknown.
//!
//! Unknown is never full. A drive the app cannot size is left to the server,
//! which refuses the accept with its own message, exactly as before.

use crate::error::{AppError, Result};
use hcfs_shared::network::DriveMembersResponse;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How full a drive is, for the Share dialog. camelCase over IPC.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveCapacity {
    /// People the drive may hold, the owner not counted. `None` when the app
    /// cannot tell (limits off on the server, an unreadable plan, a drive
    /// this account manages for an owner on an older server).
    pub member_limit: Option<u32>,
    /// People on the drive now, the owner not counted.
    pub people: u32,
    /// The drive already holds as many people as it may: inviting one more
    /// would end at the server's refusal when they try to join.
    pub full: bool,
}

/// `GET /v1/drives/{folder_hash}/seats`. Only the two numbers the warning
/// needs are read; the rest of the body is the server's business.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct DriveSeats {
    /// What an accept is checked against. `null` when the server runs with
    /// member limits off.
    #[serde(default)]
    pub member_limit: Option<u32>,
    pub people: u32,
}

/// The one rule: full when the drive holds at least as many people as its
/// limit. A limit of 0 is a plan without sharing at all, which the plan gate
/// (`canShareDrives`, the server's `shared_drives_not_entitled`) already
/// answers with an upgrade card, so it is not reported as a full drive.
pub fn is_full(member_limit: Option<u32>, people: u32) -> bool {
    matches!(member_limit, Some(limit) if limit > 0 && people >= limit)
}

/// Distinct people on the drive in a member listing: whole-drive members and
/// folder-grant holders, each once, the owner never.
pub fn count_people(listing: &DriveMembersResponse, owner_ss58: &str) -> u32 {
    let people: HashSet<&str> = listing
        .members
        .iter()
        .map(|m| m.member_ss58.as_str())
        .chain(listing.folder_grants.iter().map(|g| g.member_ss58.as_str()))
        .filter(|ss58| *ss58 != owner_ss58)
        .collect();
    u32::try_from(people.len()).unwrap_or(u32::MAX)
}

/// Decide a drive's capacity from what could be read. `seats` is the server's
/// own answer and wins whenever there is one; otherwise `listed_people` (from
/// the member listing) is held against `fallback_limit` (this account's plan,
/// on a drive it owns; `None` anywhere else).
pub fn resolve_capacity(seats: Option<DriveSeats>, listed_people: u32, fallback_limit: Option<u32>) -> DriveCapacity {
    let (member_limit, people) = match seats {
        Some(seats) => (seats.member_limit, seats.people),
        None => (fallback_limit, listed_people),
    };
    DriveCapacity {
        member_limit,
        people,
        full: is_full(member_limit, people),
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
    let (seats, listing) = tokio::join!(
        http_drive_seats(&http, ctx.base_url(), ctx.bearer(), &identity.wire_folder_hash, owner),
        super::commands::http_list_members(&http, ctx.base_url(), ctx.bearer(), &identity.wire_folder_hash, owner),
    );
    let seats = seats.ok();
    let listing = listing.ok();
    let capacity = match (seats, &listing) {
        (Some(seats), _) => resolve_capacity(Some(seats), 0, None),
        (None, Some(listing)) => {
            let fallback = if identity.is_member {
                None
            } else {
                crate::billing::storage_overview::fetch_people_per_drive(state).await
            };
            resolve_capacity(None, count_people(listing, &identity.wire_ss58), fallback)
        }
        (None, None) => return Ok(()),
    };
    let emails = listing.as_ref().map(emails_with_access).unwrap_or_default();
    // Without the listing an address cannot be matched to someone already
    // on the drive, so an emailed invite is let through rather than guessed.
    if invitee_email.is_some() && listing.is_none() {
        return Ok(());
    }
    if invite_refused_as_full(capacity, invitee_email, emails.iter().map(String::as_str)) {
        tracing::info!(
            folder_hash = %identity.wire_folder_hash,
            people = capacity.people,
            member_limit = ?capacity.member_limit,
            "Invite refused: the drive is full"
        );
        return Err(AppError::NotReady(crate::error::NotReadyKind::DriveFull));
    }
    Ok(())
}

/// `GET /v1/drives/{folder_hash}/seats` (owner, or a Manager naming the
/// owner). Any failure is an error the caller treats as "no answer": an
/// older server without the route answers a bare 404.
pub async fn http_drive_seats(http: &reqwest::Client, base_url: &str, bearer: &str, folder_hash: &str, owner: Option<&str>) -> Result<DriveSeats> {
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

    const OWNER: &str = "5Owner";

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

    /// The server counts people, not rows: someone holding two folders, or a
    /// folder and the whole drive, is one person, and the owner is nobody.
    #[test]
    fn people_are_counted_once_and_the_owner_never() {
        let l = listing(
            &["5Ada", "5Bea", OWNER],
            &[("5Ada", "Clients"), ("5Cy", "Clients"), ("5Cy", "Plans/2027")],
        );
        assert_eq!(count_people(&l, OWNER), 3, "Ada, Bea and Cy");
        assert_eq!(count_people(&listing(&[], &[]), OWNER), 0);
    }

    #[test]
    fn the_servers_answer_wins_over_the_listing_and_the_plan() {
        let seats = DriveSeats {
            member_limit: Some(8),
            people: 8,
        };
        let c = resolve_capacity(Some(seats), 2, Some(3));
        assert_eq!(
            c,
            DriveCapacity {
                member_limit: Some(8),
                people: 8,
                full: true
            }
        );
    }

    /// A server with member limits off answers `null`: not full, whatever
    /// this account's plan says.
    #[test]
    fn limits_off_on_the_server_are_not_overridden_by_the_plan() {
        let seats = DriveSeats {
            member_limit: None,
            people: 30,
        };
        let c = resolve_capacity(Some(seats), 30, Some(3));
        assert_eq!(c.member_limit, None);
        assert!(!c.full);
    }

    #[test]
    fn without_the_servers_answer_the_listing_meets_the_owners_plan() {
        let c = resolve_capacity(None, 3, Some(3));
        assert!(c.full, "Plus owner with 3 people listed");
        assert_eq!(c.member_limit, Some(3));
        let c = resolve_capacity(None, 2, Some(3));
        assert!(!c.full);
        let c = resolve_capacity(None, 12, None);
        assert!(!c.full, "a Manager on an older server cannot know the owner's limit");
        assert_eq!(c.member_limit, None);
        assert_eq!(c.people, 12);
    }

    #[test]
    fn the_seats_body_parses_and_ignores_the_rest() {
        let s: DriveSeats = serde_json::from_str(r#"{"included_members":8,"extra_seats":0,"member_limit":8,"people":5}"#).unwrap();
        assert_eq!(
            s,
            DriveSeats {
                member_limit: Some(8),
                people: 5
            }
        );
        let off: DriveSeats = serde_json::from_str(r#"{"included_members":null,"extra_seats":0,"member_limit":null,"people":2}"#).unwrap();
        assert_eq!(off.member_limit, None);
    }

    fn full() -> DriveCapacity {
        resolve_capacity(None, 3, Some(3))
    }

    #[test]
    fn a_link_on_a_full_drive_is_refused() {
        assert!(invite_refused_as_full(full(), None, []));
    }

    #[test]
    fn nothing_is_refused_while_there_is_room() {
        let room = resolve_capacity(None, 2, Some(3));
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
        let v = serde_json::to_value(resolve_capacity(None, 3, Some(3))).unwrap();
        assert_eq!(v, serde_json::json!({ "memberLimit": 3, "people": 3, "full": true }));
        let v = serde_json::to_value(DriveCapacity::default()).unwrap();
        assert_eq!(v, serde_json::json!({ "memberLimit": null, "people": 0, "full": false }));
    }
}
