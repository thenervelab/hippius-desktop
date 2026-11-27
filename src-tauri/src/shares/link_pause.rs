//! Folder links paused by Drive Trash.
//!
//! While a shared folder is in Trash the server keeps its folder links dark
//! (recipients get the same 404 as for a dead link). A restore of the whole
//! item in place turns them back on; any other way out of Trash revokes
//! them. The owner's listing (`GET /v1/folder-shares`) says so per row:
//!
//! - `paused`: the link is off while its folder is in Trash;
//! - `held`: a writer's restore (or the purge of a writer's item) would have
//!   revoked it, so it stays off for the owner to revoke. Implies `paused`.
//!
//! hcfs-client's listing does not carry either field, so this module reads
//! them from the same route itself and lays them onto the listing rows by
//! `token_hash`. Both are absent on a server without Trash, which reads as
//! a live link: nothing is shown that the server did not send.

use super::commands::FolderShareSummary;
use super::folder_insights::OwnerApi;
use super::insights::{REQUEST_TIMEOUT, read_ok, transport};
use crate::app_state::AppState;
use crate::error::Result;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::debug;

/// One listing row, reduced to what the pause needs. Every other field is
/// ignored, so a listing that grows stays readable.
#[derive(Debug, Deserialize)]
struct PauseRow {
    token_hash: String,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    held: bool,
}

/// How a paused link is paused.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkPause {
    pub paused: bool,
    pub held: bool,
}

/// The paused rows of a listing body, by `token_hash`. Only rows the server
/// marked are kept. An unreadable body pauses nothing: the badge must never
/// appear on a guess.
pub fn parse_pauses(body: &str) -> HashMap<String, LinkPause> {
    let rows: Vec<PauseRow> = match serde_json::from_str(body) {
        Ok(rows) => rows,
        Err(e) => {
            debug!(error = %e, "folder link pauses: unreadable listing");
            return HashMap::new();
        }
    };
    rows.into_iter()
        .filter(|row| row.paused || row.held)
        .map(|row| {
            let pause = LinkPause {
                // `held` implies `paused`, whatever an older server sends.
                paused: true,
                held: row.held,
            };
            (row.token_hash, pause)
        })
        .collect()
}

/// Lay the pauses onto the listing rows. A revoked row is never paused: it
/// is over, and its own state says so.
pub fn apply_pauses<S: std::hash::BuildHasher>(rows: &mut [FolderShareSummary], pauses: &HashMap<String, LinkPause, S>) {
    for row in rows.iter_mut() {
        let pause = pauses.get(&row.token_hash).copied().unwrap_or_default();
        let live = row.revoked_at.is_none();
        row.paused = live && pause.paused;
        row.held = live && pause.held;
    }
}

/// Read the account's folder link pauses. Anything short of a readable
/// listing pauses nothing, so a failure here never fails the listing.
pub(crate) async fn fetch_pauses(state: &AppState, account_id: &str) -> HashMap<String, LinkPause> {
    match read_listing(state, account_id).await {
        Ok(body) => parse_pauses(&body),
        Err(e) => {
            debug!(error = %e, "folder link pauses: listing not read");
            HashMap::new()
        }
    }
}

async fn read_listing(state: &AppState, account_id: &str) -> Result<String> {
    let api = OwnerApi::for_account(state, account_id).await?;
    let resp = state
        .api_client
        .get(api.url("folder-shares"))
        .bearer_auth(api.bearer())
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| transport("folder link listing", e))?;
    read_ok(resp).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: &str = "a1";
    const PAUSED: &str = "b2";
    const HELD: &str = "c3";

    /// The rows as hcfs-server's `FolderShareListItem` sends them since
    /// Drive Trash (`paused`, `held`), among the fields the listing always
    /// had, plus one from a server that predates Trash.
    fn listing() -> String {
        serde_json::json!([
            { "token_hash": LIVE, "owner_ss58": "5x", "folder_hash": "f", "path_prefix": "Docs",
              "display_name": "Docs", "created_at": "2026-11-01T00:00:00Z", "expires_at": null,
              "revoked_at": null, "paused": false, "held": false },
            { "token_hash": PAUSED, "display_name": "Trip", "paused": true, "held": false },
            { "token_hash": HELD, "display_name": "Team", "paused": true, "held": true },
            { "token_hash": "d4", "display_name": "Old server" },
        ])
        .to_string()
    }

    #[test]
    fn only_the_rows_the_server_marked_are_paused() {
        let pauses = parse_pauses(&listing());
        assert_eq!(pauses.len(), 2, "{pauses:?}");
        assert_eq!(pauses[PAUSED], LinkPause { paused: true, held: false });
        assert_eq!(pauses[HELD], LinkPause { paused: true, held: true });
        assert!(!pauses.contains_key(LIVE));
        assert!(!pauses.contains_key("d4"), "absent fields read as a live link");
    }

    #[test]
    fn held_always_reads_as_paused() {
        let pauses = parse_pauses(r#"[{"token_hash":"e5","held":true}]"#);
        assert_eq!(pauses["e5"], LinkPause { paused: true, held: true });
    }

    #[test]
    fn an_unreadable_listing_pauses_nothing() {
        for body in ["", "not json", "{}", r#"{"error":"nope"}"#, r#"[{"paused":true}]"#] {
            assert!(parse_pauses(body).is_empty(), "{body:?}");
        }
    }
}
