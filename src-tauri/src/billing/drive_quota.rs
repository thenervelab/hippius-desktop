//! Drive storage quota: would this write fit under the account's plan?
//!
//! Drive storage is sold as a plan, so what may be written is decided by
//! the plan's allowance and what is already stored — not by a credit
//! balance. This replaces the credit gate on every Drive write path; VM
//! creation is genuinely credit-priced and keeps its own gate.
//!
//! ## Fail open, deliberately
//!
//! An account the Drive backend does not map to a plan has no allowance to
//! check. Rather than refuse it, the write proceeds and hcfs-server decides
//! with its own gate, which is the real backstop on every write. The same
//! applies when the allowance or the usage cannot be read: this check
//! exists to give a clear answer early, never to be the only thing standing
//! between a paying account and its own storage.

use crate::api::client::ApiClient;
use crate::app_state::{AppState, SessionAccount};
use crate::error::AppError;
use serde::Serialize;

/// What a quota check concluded, and the numbers behind it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaVerdict {
    pub allowed: bool,
    /// Bytes already stored, per the indexer.
    pub used_bytes: u64,
    /// The plan's allowance, or `None` when no plan could be read.
    pub limit_bytes: Option<u64>,
}

impl QuotaVerdict {
    /// No allowance to judge against; the server decides on the write.
    fn unknown(used_bytes: u64) -> Self {
        Self {
            allowed: true,
            used_bytes,
            limit_bytes: None,
        }
    }
}

/// The plan's storage allowance in bytes, or `None` when the account has no
/// readable Drive plan.
async fn plan_allowance(state: &AppState, account: &SessionAccount) -> Option<u64> {
    let client = ApiClient::new(state.api_client.clone(), state.pool().ok()?.clone());
    let sub: serde_json::Value = client.get("/api/drive/subscription/", account).await.ok()?;
    // `active: false` is the normal shape for an account with no plan, and
    // a plan with no stated allowance tells us nothing either way.
    if !sub.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    sub.get("storage_bytes").and_then(serde_json::Value::as_u64).filter(|b| *b > 0)
}

/// Would storing `incoming_bytes` more keep the account inside its plan?
pub async fn check_drive_quota(state: &AppState, account: &SessionAccount, incoming_bytes: u64) -> Result<QuotaVerdict, AppError> {
    let (allowance, stats) = tokio::join!(
        plan_allowance(state, account),
        crate::billing::queries::fetch_drive_storage_stats(state, account.as_str()),
    );

    // Usage that cannot be read is not evidence of being over quota.
    let used_bytes = match stats {
        Ok(s) => s.total_bytes,
        Err(_) => return Ok(QuotaVerdict::unknown(0)),
    };

    let Some(limit_bytes) = allowance else {
        return Ok(QuotaVerdict::unknown(used_bytes));
    };

    Ok(QuotaVerdict {
        // Saturating so a bogus huge size cannot wrap into "fits".
        allowed: used_bytes.saturating_add(incoming_bytes) <= limit_bytes,
        used_bytes,
        limit_bytes: Some(limit_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(used: u64, incoming: u64, limit: u64) -> bool {
        used.saturating_add(incoming) <= limit
    }

    #[test]
    fn a_write_that_fits_is_allowed() {
        assert!(verdict(1_000, 500, 2_000));
    }

    #[test]
    fn exactly_filling_the_plan_is_allowed() {
        // The allowance is what the account may store, not one byte less.
        assert!(verdict(1_500, 500, 2_000));
    }

    #[test]
    fn a_write_past_the_allowance_is_refused() {
        assert!(!verdict(1_800, 500, 2_000));
    }

    #[test]
    fn an_absurd_size_cannot_wrap_into_fitting() {
        assert!(!verdict(u64::MAX - 1, u64::MAX, 2_000));
    }

    #[test]
    fn an_unknown_allowance_allows_the_write() {
        // Most accounts have no Drive plan mapped; refusing them here would
        // block writes hcfs-server would accept.
        let v = QuotaVerdict::unknown(123);
        assert!(v.allowed);
        assert!(v.limit_bytes.is_none());
    }
}
