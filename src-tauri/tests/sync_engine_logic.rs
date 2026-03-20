use tauri_project_lib::sync_logic::{
    ConnectivityStatus, compute_backoff, is_failed_download_artifact, should_emit_health_change,
    should_skip_sync_check,
};

// === compute_backoff ===

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
fn backoff_three_failures_8x() {
    assert_eq!(compute_backoff(3, 30), 240);
}

#[test]
fn backoff_four_failures_capped_at_300() {
    // 30 * 16 = 480, but capped at 300
    assert_eq!(compute_backoff(4, 30), 300);
}

#[test]
fn backoff_high_failures_stay_capped() {
    assert_eq!(compute_backoff(10, 30), 300);
    assert_eq!(compute_backoff(100, 30), 300);
}

#[test]
fn backoff_different_heartbeat_values() {
    assert_eq!(compute_backoff(0, 10), 10);
    assert_eq!(compute_backoff(1, 10), 20);
    assert_eq!(compute_backoff(2, 10), 40);
    // 10 * 16 = 160, under cap
    assert_eq!(compute_backoff(4, 10), 160);
}

#[test]
fn backoff_large_heartbeat_does_not_overflow() {
    let result = compute_backoff(4, u64::MAX / 2);
    assert_eq!(result, 300);
}

// === should_emit_health_change ===

#[test]
fn health_auth_expired_always_emits() {
    assert!(should_emit_health_change(
        &ConnectivityStatus::Connected,
        &ConnectivityStatus::AuthExpired,
        1,
        2,
    ));
}

#[test]
fn health_auth_expired_emits_even_below_threshold() {
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
fn health_at_threshold_with_status_change_emits() {
    assert!(should_emit_health_change(
        &ConnectivityStatus::Connected,
        &ConnectivityStatus::Degraded,
        2,
        2,
    ));
}

#[test]
fn health_same_unhealthy_status_does_not_re_emit() {
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

// === should_skip_sync_check ===

#[test]
fn skip_auth_expired_always_skips() {
    assert!(should_skip_sync_check(
        &ConnectivityStatus::AuthExpired,
        0,
        2
    ));
}

#[test]
fn skip_connected_never_skips() {
    assert!(!should_skip_sync_check(
        &ConnectivityStatus::Connected,
        0,
        2
    ));
    assert!(!should_skip_sync_check(
        &ConnectivityStatus::Connected,
        10,
        2
    ));
}

#[test]
fn skip_degraded_above_threshold_skips() {
    assert!(should_skip_sync_check(&ConnectivityStatus::Degraded, 2, 2));
    assert!(should_skip_sync_check(
        &ConnectivityStatus::ServerUnreachable,
        5,
        2
    ));
}

#[test]
fn skip_degraded_below_threshold_does_not_skip() {
    assert!(!should_skip_sync_check(&ConnectivityStatus::Degraded, 1, 2));
    assert!(!should_skip_sync_check(
        &ConnectivityStatus::NetworkOffline,
        0,
        2
    ));
}

// === is_failed_download_artifact ===

#[test]
fn artifact_valid_hex_detected() {
    assert_eq!(
        is_failed_download_artifact("downloaded_a1b2c3d4"),
        Some("a1b2c3d4")
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
