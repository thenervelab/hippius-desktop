//! Drive storage quota: would hcfs-server accept this write?
//!
//! Every Drive write path asks this before it starts, so the user gets a
//! clear refusal up front instead of a failed upload several chunks in. The
//! answer comes from hcfs-server's own `/can_upload` pre-flight, the same
//! question its write handlers ask themselves, so the desktop and the server
//! cannot disagree about one account.
//!
//! ## Why the server decides, not this module
//!
//! The server's rule is grant-only: a plan covers its allowance, the legacy
//! credit balance pays for anything beyond it, and only a double denial
//! refuses (`hcfs-server/src/billing/entitlement.rs`). Which plan an account
//! is on is itself the Drive backend's business — the drive rail, the legacy
//! Stripe subscription, and the free tier all count. An earlier version of
//! this module re-derived that from the drive rail alone and judged
//! everything else against the free tier, which refused uploads, sync setup
//! and share links to paying accounts the server accepted. Re-implementing
//! the server's rule here is how it drifts; asking is how it stays right.
//!
//! ## Fail open, deliberately
//!
//! A pre-flight that produces no verdict — no token yet, transport failure,
//! a 5xx, an unparseable body, or the server's own billing outage — lets the
//! write proceed. hcfs-server gates the write itself, which is the real
//! backstop; this check exists to give a clear answer early, never to be the
//! only thing standing between a paying account and its own storage.

use std::time::Duration;

use hcfs_shared::network::{CanUploadRequest, CanUploadResponse};

use crate::app_state::{AppState, SessionAccount};
use crate::auth::tokens::get_api_token;

/// Bound on the pre-flight round-trip. hcfs-server's own entitlement client
/// gives its backend 3 s; a gate that hangs longer than that in front of a
/// click is worse than falling open.
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(3);

/// Marks the one `/can_upload` refusal that is not a verdict: the server
/// could not read the credit balance. hcfs-server documents that string as
/// "the only `/can_upload` error carrying the word billing", which is how the
/// hippius-s3 gateway tells a transient outage from a quota refusal — so this
/// matches the same way, by the word and not the sentence, and a reworded or
/// detail-suffixed message still falls open instead of refusing every
/// desktop for the length of a billing blip.
const BILLING_OUTAGE_MARKER: &str = "billing";

/// Whether a `/can_upload` refusal is the server saying it could not answer.
fn is_billing_outage(error: &str) -> bool {
    error.to_ascii_lowercase().contains(BILLING_OUTAGE_MARKER)
}

/// What a quota check concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaVerdict {
    pub allowed: bool,
    /// hcfs-server's denial slug (`drive_quota_exceeded`, `zero_balance`, …),
    /// kept for logs and support bundles. Never shown to the user: every
    /// refusal is answered by a bigger plan, so the UI needs one message.
    pub server_reason: Option<String>,
}

impl QuotaVerdict {
    /// hcfs-server answered. Its rule is grant-only (plan, then credits), so a
    /// `false` is a real refusal — except the billing-outage string, which is
    /// the server saying it could not answer.
    fn from_preflight(resp: &CanUploadResponse) -> Self {
        if resp.result {
            return Self::allowed();
        }
        match resp.error.as_deref() {
            None => Self::unknown(),
            Some(reason) if is_billing_outage(reason) => Self::unknown(),
            Some(reason) => Self {
                allowed: false,
                server_reason: Some(reason.to_owned()),
            },
        }
    }

    fn allowed() -> Self {
        Self {
            allowed: true,
            server_reason: None,
        }
    }

    /// No verdict from the server; the write proceeds and the server's own
    /// gate decides.
    fn unknown() -> Self {
        Self::allowed()
    }
}

/// Would hcfs-server accept `incoming_bytes` more from this account?
///
/// Never errors: anything short of a server verdict falls open (see the
/// module doc), and the reason is logged so a refusal that failed to fire is
/// traceable from a support bundle.
pub async fn check_drive_quota(state: &AppState, account: &SessionAccount, incoming_bytes: u64) -> QuotaVerdict {
    check_drive_quota_for(state, account, incoming_bytes, None).await
}

/// The same pre-flight, for a write whose destination drive is known.
///
/// `drive` names the drive being written to. It matters for a drive shared
/// WITH this account: storage there is paid for by the OWNER, and the server
/// checks the owner's allowance when the request names a real folder hash.
/// Sending the empty hash asks about the CALLER's plan instead, which refuses
/// a member whose own plan is full while the drive they are writing to has
/// room, and lets one through whose drive is full while their own plan is not.
///
/// `None` is an own-drive write, where caller and payer are the same account.
pub async fn check_drive_quota_for(
    state: &AppState,
    account: &SessionAccount,
    incoming_bytes: u64,
    drive: Option<&crate::sync::identity::DriveIdentity>,
) -> QuotaVerdict {
    let Some((base_url, token)) = preflight_target(state, account).await else {
        return QuotaVerdict::unknown();
    };

    let request = preflight_request(account.as_str(), incoming_bytes, drive);
    let response = state
        .api_client
        .post(format!("{base_url}/can_upload"))
        .bearer_auth(token)
        .timeout(PREFLIGHT_TIMEOUT)
        .json(&request)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            tracing::warn!(%err, "can_upload pre-flight produced no verdict; letting the write through to the server's own gate");
            return QuotaVerdict::unknown();
        }
    };
    let verdict = match response.json::<CanUploadResponse>().await {
        Ok(body) => QuotaVerdict::from_preflight(&body),
        Err(err) => {
            tracing::warn!(%err, "can_upload pre-flight body did not parse; letting the write through to the server's own gate");
            return QuotaVerdict::unknown();
        }
    };

    if !verdict.allowed {
        tracing::info!(
            account = %account.as_str(),
            reason = verdict.server_reason.as_deref().unwrap_or(""),
            size_bytes = incoming_bytes,
            "hcfs-server refused the Drive write pre-flight"
        );
    }
    verdict
}

/// The server to ask and the bearer to ask with, or `None` when the account
/// has no usable session yet (fall open — the write cannot start either).
///
/// An empty stored server URL is the region auto-detect sentinel: the sync
/// engine lets hcfs-client race the regions itself, and this raw-reqwest
/// path has no such step, so it resolves one here the way `console_access`
/// does. Either region is correctness-equivalent (shared replicated DB), so
/// the race is a pure latency choice.
/// Who the pre-flight asks about.
///
/// A member drive names the OWNER and the drive's wire hash, which is what
/// routes the server to the owner's allowance; storage there is paid for by
/// them. An own drive sends the empty hash, which keeps the server's
/// membership fallback inert and checks the caller, who pays.
///
/// Pure, so the rule is testable without a server: it is invisible from the
/// app either way, since a wrong answer here is a refusal the user reads as
/// "my plan is full" whoever's plan it actually was.
fn preflight_request(caller_ss58: &str, incoming_bytes: u64, drive: Option<&crate::sync::identity::DriveIdentity>) -> CanUploadRequest {
    let member_drive = drive.filter(|d| d.is_member);
    CanUploadRequest {
        ss58_address: member_drive.map_or_else(|| caller_ss58.to_owned(), |d| d.wire_ss58.clone()),
        folder_hash: member_drive.map(|d| d.wire_folder_hash.clone()).unwrap_or_default(),
        size_bytes: incoming_bytes,
    }
}

async fn preflight_target(state: &AppState, account: &SessionAccount) -> Option<(String, String)> {
    let pool = state.pool().ok()?;

    let token = match get_api_token(pool, account.as_str()).await {
        Ok(Some(token)) => token,
        Ok(None) => {
            tracing::debug!("can_upload pre-flight skipped: no API token for the session account");
            return None;
        }
        Err(err) => {
            tracing::warn!(%err, "can_upload pre-flight skipped: token lookup failed");
            return None;
        }
    };

    let stored = match crate::sync::remote::get_server_url(pool, account.as_str()).await {
        Ok(url) => url,
        Err(err) => {
            tracing::warn!(%err, "can_upload pre-flight skipped: no sync server configured for the account");
            return None;
        }
    };
    let base_url = if stored.is_empty() {
        // Resolved once per process: nearly every install stores the
        // auto-detect sentinel, and racing the regions in front of every
        // upload, share and sync-init click (twice — the proactive check and
        // the gate) put two probes and up to the probe timeout ahead of each
        // one. Either region answers identically, so the first winner is as
        // good as any later one.
        let resolved = state
            .hcfs_region
            .get_or_try_init(|| hcfs_client::client::pick_fastest(&state.api_client))
            .await;
        match resolved {
            Ok(url) => url.clone(),
            Err(err) => {
                tracing::warn!(%err, "can_upload pre-flight skipped: no region answered");
                return None;
            }
        }
    } else {
        stored
    };

    Some((base_url, token))
}

#[cfg(test)]
mod tests {
    use crate::sync::identity::DriveIdentity;

    fn member(owner: &str, hash: &str) -> DriveIdentity {
        DriveIdentity {
            wire_ss58: owner.into(),
            wire_folder_hash: hash.into(),
            is_member: true,
        }
    }

    /// Storage on a drive shared WITH this account is paid for by its OWNER,
    /// and the server checks their allowance when the request names a real
    /// folder hash. Sending the empty hash asked about the caller's own plan:
    /// a member whose plan was full could not upload to a drive with room,
    /// and one whose plan had room could pass a pre-flight for a drive that
    /// was full. Either way the refusal reads as "my plan is full", whoever's
    /// plan it actually was.
    #[test]
    fn a_member_drive_is_checked_against_its_owner() {
        let req = preflight_request("5Me", 100, Some(&member("5Owner", "abc123")));
        assert_eq!(req.ss58_address, "5Owner", "the owner pays, so the owner is asked about");
        assert_eq!(req.folder_hash, "abc123", "a real hash is what routes the server to them");
        assert_eq!(req.size_bytes, 100);
    }

    /// An own drive keeps the previous shape exactly: the empty hash leaves
    /// the server's membership fallback inert.
    #[test]
    fn an_own_drive_is_checked_against_the_caller() {
        for drive in [None, Some(&DriveIdentity::own("5Me", "abc123"))] {
            let req = preflight_request("5Me", 100, drive);
            assert_eq!(req.ss58_address, "5Me");
            assert!(req.folder_hash.is_empty(), "an own drive must not name a folder");
        }
    }

    use super::*;

    fn preflight(result: bool, error: Option<&str>) -> CanUploadResponse {
        CanUploadResponse {
            result,
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn a_server_yes_allows() {
        let verdict = QuotaVerdict::from_preflight(&preflight(true, None));
        assert!(verdict.allowed);
        assert_eq!(verdict.server_reason, None);
    }

    /// Every slug the server can answer with is a storage refusal here —
    /// including the credit ones, because on the server credits are the
    /// overflow for the plan and the fix for all of them is a bigger plan.
    #[test]
    fn every_server_denial_is_a_refusal_that_keeps_its_reason() {
        for slug in [
            "drive_quota_exceeded",
            "drive_not_entitled",
            "zero_balance",
            "insufficient_balance: need 3 cents, have 1 cents",
        ] {
            let verdict = QuotaVerdict::from_preflight(&preflight(false, Some(slug)));
            assert!(!verdict.allowed, "{slug} must refuse");
            assert_eq!(verdict.server_reason.as_deref(), Some(slug));
        }
    }

    /// The server's own "I could not read the balance" is not a verdict; its
    /// write path retries that case rather than refusing, and so must this.
    #[test]
    fn a_transient_billing_outage_falls_open() {
        // The exact string the server sends today, and the shapes it could
        // drift to — matched the way the hippius-s3 gateway matches, by the
        // word. A drift that refused every desktop for a billing blip would
        // be a worse outage than the one it reports.
        for wording in [
            "Failed to fetch billing balance",
            "Failed to fetch billing balance: upstream timeout",
            "billing unavailable",
            "Billing service returned 503",
        ] {
            let verdict = QuotaVerdict::from_preflight(&preflight(false, Some(wording)));
            assert!(verdict.allowed, "{wording:?} must fall open");
        }
    }

    /// The quota and entitlement slugs carry no such word, so the marker
    /// cannot swallow a real refusal.
    #[test]
    fn the_outage_marker_matches_no_denial_slug() {
        for slug in [
            "drive_quota_exceeded",
            "drive_not_entitled",
            "zero_balance",
            "insufficient_balance: need 3 cents, have 1 cents",
        ] {
            assert!(!is_billing_outage(slug), "{slug} is a verdict, not an outage");
        }
    }

    /// A `false` with no reason is malformed for the wire contract (the
    /// server always names its refusal); treat it as no verdict rather than
    /// inventing one.
    #[test]
    fn a_reasonless_denial_falls_open() {
        assert!(QuotaVerdict::from_preflight(&preflight(false, None)).allowed);
    }
}
