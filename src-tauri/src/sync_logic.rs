//! Pure logic functions extracted from the sync engine.
//!
//! These functions contain no side effects, no global state, and no I/O.
//! They exist so that the core decision logic of the sync loop can be
//! unit-tested in isolation without needing a running Tauri app.

use serde::Serialize;

/// Server connectivity status used by the health check system.
/// This is the canonical definition; `sync_shared` re-exports it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityStatus {
    Connected,
    ServerUnreachable,
    NetworkOffline,
    AuthExpired,
    Degraded,
}

/// Compute the backoff interval given a failure count and base heartbeat.
///
/// Returns the base heartbeat when there are no failures. Otherwise
/// doubles the interval for each failure (exponential backoff) up to
/// a maximum of 300 seconds (5 minutes).
///
/// # Examples
/// - 0 failures, 30s heartbeat -> 30
/// - 1 failure,  30s heartbeat -> 60
/// - 2 failures, 30s heartbeat -> 120
/// - 4 failures, 30s heartbeat -> 300 (capped)
pub fn compute_backoff(failures: i64, heartbeat_secs: u64) -> u64 {
    if failures > 0 {
        let shift = failures.min(4) as u64;
        let backed_off = heartbeat_secs.saturating_mul(1u64 << shift);
        backed_off.min(300)
    } else {
        heartbeat_secs
    }
}

/// Decide whether a health status change should be emitted to the frontend.
///
/// - `AuthExpired` always triggers an emission (immediate alert).
/// - Otherwise, emit only when the failure count reaches the threshold
///   AND the status actually changed (was previously `Connected`, or
///   transitioned between different unhealthy states).
pub fn should_emit_health_change(
    previous: &ConnectivityStatus,
    new: &ConnectivityStatus,
    new_failure_count: u32,
    threshold: u32,
) -> bool {
    if *new == ConnectivityStatus::AuthExpired {
        return true;
    }
    new_failure_count >= threshold
        && (*previous == ConnectivityStatus::Connected || previous != new)
}

/// Decide whether the sync loop should skip syncing based on health.
///
/// Skips when auth is expired (nothing will succeed) or when the server
/// has been unreachable for enough consecutive checks to exceed the
/// threshold.
pub fn should_skip_sync_check(
    status: &ConnectivityStatus,
    consecutive_failures: u32,
    threshold: u32,
) -> bool {
    *status == ConnectivityStatus::AuthExpired
        || (*status != ConnectivityStatus::Connected && consecutive_failures >= threshold)
}

/// Check if a filename is a failed-download artifact left by hcfs-client.
///
/// These files are named `downloaded_<hex>` where `<hex>` is all ASCII
/// hex digits. Returns `Some(hex_part)` if the name matches, `None`
/// otherwise.
pub fn is_failed_download_artifact(name: &str) -> Option<&str> {
    let prefix = "downloaded_";
    let rest = name.strip_prefix(prefix)?;
    if rest.is_empty() {
        return None;
    }
    if rest.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(rest)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- compute_backoff ---

    #[test]
    fn backoff_zero_failures_returns_heartbeat() {
        assert_eq!(compute_backoff(0, 30), 30);
    }

    #[test]
    fn backoff_one_failure_doubles() {
        assert_eq!(compute_backoff(1, 30), 60);
    }

    #[test]
    fn backoff_two_failures_quadruples() {
        assert_eq!(compute_backoff(2, 30), 120);
    }

    #[test]
    fn backoff_three_failures() {
        assert_eq!(compute_backoff(3, 30), 240);
    }

    #[test]
    fn backoff_four_failures_capped_at_300() {
        assert_eq!(compute_backoff(4, 30), 300);
    }

    #[test]
    fn backoff_high_failures_stay_capped() {
        assert_eq!(compute_backoff(10, 30), 300);
        assert_eq!(compute_backoff(100, 30), 300);
    }

    #[test]
    fn backoff_different_heartbeat() {
        assert_eq!(compute_backoff(0, 10), 10);
        assert_eq!(compute_backoff(1, 10), 20);
        assert_eq!(compute_backoff(2, 10), 40);
        assert_eq!(compute_backoff(4, 10), 160);
    }

    #[test]
    fn backoff_large_heartbeat_saturates_not_overflows() {
        // With a very large heartbeat, saturating_mul prevents overflow
        let result = compute_backoff(4, u64::MAX / 2);
        assert_eq!(result, 300);
    }

    // --- should_emit_health_change ---

    #[test]
    fn health_auth_expired_always_emits() {
        assert!(should_emit_health_change(
            &ConnectivityStatus::Connected,
            &ConnectivityStatus::AuthExpired,
            1,
            2,
        ));
        // Even below threshold
        assert!(should_emit_health_change(
            &ConnectivityStatus::Degraded,
            &ConnectivityStatus::AuthExpired,
            0,
            2,
        ));
    }

    #[test]
    fn health_below_threshold_does_not_emit() {
        assert!(!should_emit_health_change(
            &ConnectivityStatus::Connected,
            &ConnectivityStatus::Degraded,
            1,
            2,
        ));
    }

    #[test]
    fn health_at_threshold_from_connected_emits() {
        assert!(should_emit_health_change(
            &ConnectivityStatus::Connected,
            &ConnectivityStatus::Degraded,
            2,
            2,
        ));
    }

    #[test]
    fn health_same_unhealthy_status_does_not_re_emit() {
        // Already degraded, still degraded -> no re-emit
        assert!(!should_emit_health_change(
            &ConnectivityStatus::Degraded,
            &ConnectivityStatus::Degraded,
            3,
            2,
        ));
    }

    #[test]
    fn health_different_unhealthy_statuses_emit() {
        assert!(should_emit_health_change(
            &ConnectivityStatus::Degraded,
            &ConnectivityStatus::ServerUnreachable,
            2,
            2,
        ));
        assert!(should_emit_health_change(
            &ConnectivityStatus::ServerUnreachable,
            &ConnectivityStatus::NetworkOffline,
            5,
            2,
        ));
    }

    // --- should_skip_sync_check ---

    #[test]
    fn skip_auth_expired_always_skips() {
        assert!(should_skip_sync_check(
            &ConnectivityStatus::AuthExpired,
            0,
            2,
        ));
    }

    #[test]
    fn skip_connected_never_skips() {
        assert!(!should_skip_sync_check(
            &ConnectivityStatus::Connected,
            0,
            2,
        ));
        assert!(!should_skip_sync_check(
            &ConnectivityStatus::Connected,
            10,
            2,
        ));
    }

    #[test]
    fn skip_degraded_above_threshold_skips() {
        assert!(should_skip_sync_check(
            &ConnectivityStatus::Degraded,
            2,
            2,
        ));
        assert!(should_skip_sync_check(
            &ConnectivityStatus::ServerUnreachable,
            5,
            2,
        ));
    }

    #[test]
    fn skip_degraded_below_threshold_does_not_skip() {
        assert!(!should_skip_sync_check(
            &ConnectivityStatus::Degraded,
            1,
            2,
        ));
        assert!(!should_skip_sync_check(
            &ConnectivityStatus::NetworkOffline,
            0,
            2,
        ));
    }

    // --- is_failed_download_artifact ---

    #[test]
    fn artifact_valid_hex() {
        assert_eq!(
            is_failed_download_artifact("downloaded_a1b2c3d4"),
            Some("a1b2c3d4"),
        );
        assert_eq!(
            is_failed_download_artifact("downloaded_ABCDEF0123456789"),
            Some("ABCDEF0123456789"),
        );
    }

    #[test]
    fn artifact_non_hex_suffix_rejected() {
        assert_eq!(is_failed_download_artifact("downloaded_xyz123"), None);
        assert_eq!(is_failed_download_artifact("downloaded_a1b2g3"), None);
    }

    #[test]
    fn artifact_no_suffix_rejected() {
        assert_eq!(is_failed_download_artifact("downloaded_"), None);
    }

    #[test]
    fn artifact_unrelated_file_rejected() {
        assert_eq!(is_failed_download_artifact("readme.txt"), None);
        assert_eq!(is_failed_download_artifact("download_abc123"), None);
        assert_eq!(is_failed_download_artifact(""), None);
    }

    #[test]
    fn artifact_partial_prefix_rejected() {
        assert_eq!(is_failed_download_artifact("downloaded"), None);
        assert_eq!(is_failed_download_artifact("downloade_abc"), None);
    }

    #[test]
    fn artifact_mixed_hex_nonhex_rejected() {
        assert_eq!(is_failed_download_artifact("downloaded_a1b2c3zz"), None);
    }
}
