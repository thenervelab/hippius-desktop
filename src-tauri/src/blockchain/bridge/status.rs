//! Pure unified-status derivation for the bridge explorer views, ported from
//! `app/lib/bridge/explorer-api.ts` (`getDepositStatus` / `getWithdrawalStatus`
//! / `isStaleTransaction`). Returns the display status the UI renders. No I/O,
//! fully unit-tested.

/// ~6s/block on both chains → 30 min ≈ 300 blocks of no progress = timed out.
const STALE_BLOCK_THRESHOLD: u64 = 300;

/// True when `created_at_block` is more than the staleness window behind the
/// current chain height.
#[must_use]
pub fn is_stale(created_at_block: u64, current_height: u64) -> bool {
    current_height.saturating_sub(created_at_block) > STALE_BLOCK_THRESHOLD
}

/// Unified deposit status (`pending` | `processing` | `completed` | `failed`).
/// `bt_status` is the Bittensor-side status, if the cross-ref succeeded.
#[must_use]
pub fn deposit_status(h_status: &str, vote_count: u64, created_at_block: u64, current_height: Option<u64>, bt_status: Option<&str>) -> &'static str {
    let h = h_status.to_ascii_lowercase();
    if h == "completed" {
        return "completed";
    }
    if h == "denied" || h == "expired" {
        return "failed";
    }
    if let Some(cur) = current_height
        && is_stale(created_at_block, cur)
    {
        return "failed";
    }
    if let Some(bt) = bt_status {
        let bt = bt.to_ascii_lowercase();
        if bt == "failed" || bt == "denied" {
            return "failed";
        }
        if bt == "completed" {
            return "processing"; // BT done, waiting on Hippius
        }
    }
    if vote_count > 0 {
        return "processing";
    }
    "pending"
}

/// Unified withdrawal status. The Bittensor side is the final destination, so it
/// is checked first.
#[must_use]
pub fn withdrawal_status(
    h_status: &str,
    created_at_block: u64,
    current_height: Option<u64>,
    bt_status: Option<&str>,
    bt_vote_count: u64,
) -> &'static str {
    if let Some(bt) = bt_status {
        let bt = bt.to_ascii_lowercase();
        if bt == "completed" {
            return "completed";
        }
        if bt == "failed" || bt == "denied" {
            return "failed";
        }
        if bt_vote_count > 0 {
            return "processing";
        }
    }
    let h = h_status.to_ascii_lowercase();
    if h == "denied" || h == "expired" {
        return "failed";
    }
    if let Some(cur) = current_height
        && is_stale(created_at_block, cur)
        && h != "completed"
    {
        return "failed";
    }
    if h == "requested" {
        return "pending";
    }
    "processing"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_status_branches() {
        assert_eq!(deposit_status("Completed", 0, 0, None, None), "completed");
        assert_eq!(deposit_status("Denied", 0, 0, None, None), "failed");
        assert_eq!(deposit_status("Expired", 0, 0, None, None), "failed");
        // Stale pending → failed.
        assert_eq!(deposit_status("Pending", 0, 100, Some(500), None), "failed");
        // BT side completed → processing (waiting on Hippius).
        assert_eq!(deposit_status("Pending", 0, 100, Some(150), Some("Completed")), "processing");
        // BT side failed → failed.
        assert_eq!(deposit_status("Pending", 0, 100, Some(150), Some("Failed")), "failed");
        // Votes started → processing.
        assert_eq!(deposit_status("Pending", 2, 100, Some(150), None), "processing");
        // Fresh, no votes → pending.
        assert_eq!(deposit_status("Pending", 0, 100, Some(150), None), "pending");
    }

    #[test]
    fn withdrawal_status_branches() {
        assert_eq!(withdrawal_status("Requested", 0, None, Some("Completed"), 0), "completed");
        assert_eq!(withdrawal_status("Requested", 0, None, Some("Failed"), 0), "failed");
        assert_eq!(withdrawal_status("Requested", 0, None, Some("Pending"), 3), "processing");
        assert_eq!(withdrawal_status("Denied", 0, None, None, 0), "failed");
        // Stale requested → failed.
        assert_eq!(withdrawal_status("Requested", 100, Some(500), None, 0), "failed");
        // Fresh requested → pending.
        assert_eq!(withdrawal_status("Requested", 100, Some(150), None, 0), "pending");
        // Otherwise processing.
        assert_eq!(withdrawal_status("Processing", 100, Some(150), None, 0), "processing");
    }

    #[test]
    fn staleness() {
        assert!(is_stale(100, 401));
        assert!(!is_stale(100, 400));
        assert!(!is_stale(500, 100)); // saturating — future block isn't stale
    }
}
