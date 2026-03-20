//! Pure logic functions extracted from the sync engine.
//!
//! These functions contain no side effects, no global state, and no I/O.
//! They exist so that the core decision logic of the sync loop can be
//! unit-tested in isolation without needing a running Tauri app.

use hcfs_shared::network::RemoteFolderInfo;
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

/// Check if a filename is an encrypted-name stub left by hcfs-client
/// when decryption fails.
///
/// These files are named `file_<hex>` where `<hex>` is 16+ ASCII hex
/// digits. Returns `Some(hex_part)` if the name matches, `None` otherwise.
pub fn is_encrypted_name_stub(name: &str) -> Option<&str> {
    let prefix = "file_";
    let rest = name.strip_prefix(prefix)?;
    // Encrypted names are long hex strings (≥16 chars for 8-byte hash prefix)
    if rest.len() >= 16 && rest.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(rest)
    } else {
        None
    }
}

/// Check if a sync error indicates the remote folder was removed by another device.
///
/// When another device deletes a folder from the server (via `delete_remote_folder`),
/// subsequent sync attempts will fail because the server no longer has the folder
/// registered. This function inspects the error string to detect that scenario.
///
/// Returns `true` if the error is consistent with a remotely-removed folder.
pub fn is_remote_folder_removed_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    // Server returns 404 when the folder hash is not registered
    if lower.contains("404") && (lower.contains("not found") || lower.contains("not_found")) {
        return true;
    }
    // Explicit messages from the HCFS server / client library
    if lower.contains("folder not found")
        || lower.contains("folder not registered")
        || lower.contains("folder does not exist")
        || lower.contains("folder has been deleted")
        || lower.contains("folder was removed")
        || lower.contains("no such folder")
    {
        return true;
    }
    false
}

/// Check whether a folder with the given hash is present in the remote folder list.
///
/// Returns `true` if the folder is **missing** and needs recovery (re-registration
/// + sync state wipe). This is the core decision in `check_and_recover_remote_folder`.
pub fn folder_needs_recovery(folders: &[RemoteFolderInfo], target_hash: &str) -> bool {
    !folders.iter().any(|f| f.folder_hash == target_hash)
}

/// Decide whether the folder should be re-registered after a sync cycle.
///
/// Returns `true` when files were uploaded during the sync. The server's upload
/// endpoint does **not** check the folder registry, so files can land on the
/// server while the folder remains invisible to `list_remote_folders` on other
/// devices. Calling `register_folder` after every upload-bearing sync ensures
/// the folder entry exists (the call is idempotent thanks to `ON CONFLICT DO UPDATE`).
pub fn should_register_after_upload(files_uploaded: usize) -> bool {
    files_uploaded > 0
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
        assert!(should_skip_sync_check(&ConnectivityStatus::Degraded, 2, 2,));
        assert!(should_skip_sync_check(
            &ConnectivityStatus::ServerUnreachable,
            5,
            2,
        ));
    }

    #[test]
    fn skip_degraded_below_threshold_does_not_skip() {
        assert!(!should_skip_sync_check(&ConnectivityStatus::Degraded, 1, 2,));
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

    // --- is_encrypted_name_stub ---

    #[test]
    fn encrypted_stub_valid_long_hex() {
        assert_eq!(
            is_encrypted_name_stub("file_a7339456c25845c2abcdef01"),
            Some("a7339456c25845c2abcdef01"),
        );
    }

    #[test]
    fn encrypted_stub_exactly_16_hex_chars() {
        assert_eq!(
            is_encrypted_name_stub("file_0123456789abcdef"),
            Some("0123456789abcdef"),
        );
    }

    #[test]
    fn encrypted_stub_short_hex_rejected() {
        // Fewer than 16 hex chars — likely a user file, not an artifact
        assert_eq!(is_encrypted_name_stub("file_abc123"), None);
        assert_eq!(is_encrypted_name_stub("file_0123456789abcde"), None);
    }

    #[test]
    fn encrypted_stub_non_hex_rejected() {
        assert_eq!(is_encrypted_name_stub("file_hello_world_1234"), None);
    }

    #[test]
    fn encrypted_stub_no_suffix_rejected() {
        assert_eq!(is_encrypted_name_stub("file_"), None);
    }

    #[test]
    fn encrypted_stub_unrelated_file_rejected() {
        assert_eq!(is_encrypted_name_stub("file_report.pdf"), None);
        assert_eq!(is_encrypted_name_stub("readme.txt"), None);
        assert_eq!(is_encrypted_name_stub(""), None);
    }

    #[test]
    fn encrypted_stub_wrong_prefix_rejected() {
        assert_eq!(is_encrypted_name_stub("files_0123456789abcdef"), None,);
    }

    // --- is_remote_folder_removed_error ---

    #[test]
    fn remote_removed_404_not_found() {
        assert!(is_remote_folder_removed_error("HTTP 404 Not Found"));
        assert!(is_remote_folder_removed_error(
            "Server returned 404: resource not_found"
        ));
        assert!(is_remote_folder_removed_error(
            "Request failed with status 404 - not found"
        ));
    }

    #[test]
    fn remote_removed_explicit_messages() {
        assert!(is_remote_folder_removed_error("folder not found"));
        assert!(is_remote_folder_removed_error("Folder not registered"));
        assert!(is_remote_folder_removed_error(
            "The folder does not exist on the server"
        ));
        assert!(is_remote_folder_removed_error("folder has been deleted"));
        assert!(is_remote_folder_removed_error(
            "Your folder was removed by another device"
        ));
        assert!(is_remote_folder_removed_error("no such folder"));
    }

    #[test]
    fn remote_removed_case_insensitive() {
        assert!(is_remote_folder_removed_error("FOLDER NOT FOUND"));
        assert!(is_remote_folder_removed_error("Folder Not Registered"));
    }

    #[test]
    fn remote_removed_unrelated_errors_rejected() {
        assert!(!is_remote_folder_removed_error("Connection timeout"));
        assert!(!is_remote_folder_removed_error("401 Unauthorized"));
        assert!(!is_remote_folder_removed_error("500 Internal Server Error"));
        assert!(!is_remote_folder_removed_error(
            "Sync stalled — no progress for 3 minutes"
        ));
        assert!(!is_remote_folder_removed_error("Network offline"));
        assert!(!is_remote_folder_removed_error(""));
    }

    #[test]
    fn remote_removed_404_alone_not_sufficient() {
        // "404" alone without "not found" could be a generic server error
        assert!(!is_remote_folder_removed_error("Error code 404"));
    }

    // --- folder_needs_recovery ---

    fn make_folder(hash: &str) -> RemoteFolderInfo {
        RemoteFolderInfo {
            label: "test".to_string(),
            folder_hash: hash.to_string(),
            file_count: 0,
            total_bytes: 0,
            created_at: 0,
            updated_at: 0,
            device_name: String::new(),
        }
    }

    #[test]
    fn recovery_needed_when_folder_missing() {
        let folders = vec![make_folder("aaa"), make_folder("bbb")];
        assert!(folder_needs_recovery(&folders, "ccc"));
    }

    #[test]
    fn recovery_not_needed_when_folder_present() {
        let folders = vec![make_folder("aaa"), make_folder("bbb")];
        assert!(!folder_needs_recovery(&folders, "bbb"));
    }

    #[test]
    fn recovery_needed_when_list_empty() {
        let folders: Vec<RemoteFolderInfo> = vec![];
        assert!(folder_needs_recovery(&folders, "any_hash"));
    }

    #[test]
    fn recovery_hash_match_is_exact() {
        // Partial matches should not count
        let folders = vec![make_folder("abcdef1234567890")];
        assert!(folder_needs_recovery(&folders, "abcdef123456789")); // one char short
        assert!(folder_needs_recovery(&folders, "abcdef12345678901")); // one char extra
        assert!(!folder_needs_recovery(&folders, "abcdef1234567890")); // exact match
    }

    #[test]
    fn recovery_single_folder_present() {
        let folders = vec![make_folder("only_one")];
        assert!(!folder_needs_recovery(&folders, "only_one"));
    }

    // --- should_register_after_upload ---

    #[test]
    fn register_after_upload_when_files_uploaded() {
        assert!(should_register_after_upload(1));
        assert!(should_register_after_upload(100));
    }

    #[test]
    fn no_register_when_zero_uploads() {
        assert!(!should_register_after_upload(0));
    }
}
