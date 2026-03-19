//! Integration tests for the sync shared state module.
//!
//! These tests exercise the in-memory global state managed by
//! `sync_shared.rs`: per-label drive state, pending activity
//! deduplication, commit/discard, ring buffer capping, combined
//! status, and activity filtering.

use std::sync::Mutex;

use tauri_project_lib::sync_shared::{
    add_pending_activity, clear_pending_activity_for_test,
    commit_pending_activity_for_label, discard_all_pending_activity,
    discard_pending_activity_for_label, get_or_create_state,
    get_sync_activity, get_sync_status, remove_state, reset_all_states,
    reset_health, reset_sync_failures, update_state, SyncActivityItem,
};

/// Serialises tests so they don't corrupt shared global state.
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Reset every piece of global state before each test.
fn reset_state() {
    reset_all_states();
    clear_pending_activity_for_test();
    reset_health();
    reset_sync_failures();
}

/// Convenience builder for a `SyncActivityItem`.
fn activity(name: &str, action: &str, label: &str, size: u64) -> SyncActivityItem {
    SyncActivityItem {
        file_name: name.to_string(),
        action: action.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        size_bytes: size,
        label: label.to_string(),
    }
}

// ── Activity deduplication ───────────────────────────────────────────

#[test]
fn duplicate_pending_activity_is_skipped() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    let item = activity("a.txt", "uploaded", "docs", 100);
    add_pending_activity(item.clone());
    add_pending_activity(item);
    commit_pending_activity_for_label("docs");

    let state = get_or_create_state("docs");
    assert_eq!(state.recent_activity.len(), 1);
}

#[test]
fn different_action_is_not_deduplicated() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
    add_pending_activity(activity("a.txt", "downloaded", "docs", 100));
    commit_pending_activity_for_label("docs");

    let state = get_or_create_state("docs");
    assert_eq!(state.recent_activity.len(), 2);
}

#[test]
fn different_size_is_not_deduplicated() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
    add_pending_activity(activity("a.txt", "uploaded", "docs", 200));
    commit_pending_activity_for_label("docs");

    let state = get_or_create_state("docs");
    assert_eq!(state.recent_activity.len(), 2);
}

#[test]
fn different_label_is_not_deduplicated() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("a.txt", "uploaded", "docs", 100));
    add_pending_activity(activity("a.txt", "uploaded", "photos", 100));
    commit_pending_activity_for_label("docs");
    commit_pending_activity_for_label("photos");

    assert_eq!(get_or_create_state("docs").recent_activity.len(), 1);
    assert_eq!(get_or_create_state("photos").recent_activity.len(), 1);
}

// ── Commit / discard ─────────────────────────────────────────────────

#[test]
fn commit_moves_matching_label_only() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("d.txt", "uploaded", "docs", 10));
    add_pending_activity(activity("p.jpg", "uploaded", "photos", 20));
    commit_pending_activity_for_label("docs");

    assert_eq!(get_or_create_state("docs").recent_activity.len(), 1);
    // "photos" items still pending, not committed yet
    assert_eq!(get_or_create_state("photos").recent_activity.len(), 0);
}

#[test]
fn discard_removes_matching_label_only() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("d.txt", "uploaded", "docs", 10));
    add_pending_activity(activity("p.jpg", "uploaded", "photos", 20));
    discard_pending_activity_for_label("docs");
    commit_pending_activity_for_label("photos");

    assert_eq!(get_or_create_state("docs").recent_activity.len(), 0);
    assert_eq!(get_or_create_state("photos").recent_activity.len(), 1);
}

#[test]
fn discard_all_clears_everything() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    add_pending_activity(activity("a.txt", "uploaded", "docs", 10));
    add_pending_activity(activity("b.jpg", "uploaded", "photos", 20));
    discard_all_pending_activity();

    commit_pending_activity_for_label("docs");
    commit_pending_activity_for_label("photos");

    assert_eq!(get_or_create_state("docs").recent_activity.len(), 0);
    assert_eq!(get_or_create_state("photos").recent_activity.len(), 0);
}

// ── Ring buffer ──────────────────────────────────────────────────────

#[test]
fn activity_ring_buffer_caps_at_100() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    for i in 0..120 {
        update_state("docs", |state| {
            state.add_activity(activity(
                &format!("file_{i}.txt"),
                "uploaded",
                "docs",
                i as u64,
            ));
        });
    }

    let state = get_or_create_state("docs");
    assert_eq!(state.recent_activity.len(), 100);
}

// ── Per-label isolation ──────────────────────────────────────────────

#[test]
fn per_label_state_is_isolated() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| s.is_syncing = true);
    update_state("photos", |s| s.last_sync_time = Some(1234));

    let docs = get_or_create_state("docs");
    let photos = get_or_create_state("photos");

    assert!(docs.is_syncing);
    assert_eq!(docs.last_sync_time, None);

    assert!(!photos.is_syncing);
    assert_eq!(photos.last_sync_time, Some(1234));
}

#[test]
fn remove_state_deletes_label() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| s.is_syncing = true);
    remove_state("docs");

    let state = get_or_create_state("docs");
    assert!(!state.is_syncing);
    assert_eq!(state.recent_activity.len(), 0);
}

// ── Combined sync status ─────────────────────────────────────────────

#[test]
fn combined_status_any_syncing() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| s.is_syncing = false);
    update_state("photos", |s| s.is_syncing = true);

    let combined = get_sync_status();
    assert!(combined.is_syncing);
}

#[test]
fn combined_status_last_sync_time_is_max() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| s.last_sync_time = Some(100));
    update_state("photos", |s| s.last_sync_time = Some(500));
    update_state("music", |s| s.last_sync_time = Some(300));

    let combined = get_sync_status();
    assert_eq!(combined.last_sync_time, Some(500));
}

#[test]
fn combined_status_merges_activity_sorted_by_time() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    // Insert items with explicit timestamps so ordering is deterministic
    update_state("docs", |s| {
        s.add_activity(SyncActivityItem {
            file_name: "old.txt".to_string(),
            action: "uploaded".to_string(),
            timestamp: 100,
            size_bytes: 1,
            label: "docs".to_string(),
        });
    });
    update_state("photos", |s| {
        s.add_activity(SyncActivityItem {
            file_name: "new.jpg".to_string(),
            action: "uploaded".to_string(),
            timestamp: 200,
            size_bytes: 2,
            label: "photos".to_string(),
        });
    });

    let combined = get_sync_status();
    assert_eq!(combined.recent_activity.len(), 2);
    assert_eq!(combined.recent_activity[0].file_name, "new.jpg");
    assert_eq!(combined.recent_activity[1].file_name, "old.txt");
}

// ── get_sync_activity filtering ──────────────────────────────────────

#[test]
fn get_activity_filters_by_label() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| {
        s.add_activity(activity("a.txt", "uploaded", "docs", 1));
    });
    update_state("photos", |s| {
        s.add_activity(activity("b.jpg", "uploaded", "photos", 2));
    });

    let result = get_sync_activity(None, Some("docs".to_string()));
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].file_name, "a.txt");
}

#[test]
fn get_activity_no_label_returns_all() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| {
        s.add_activity(activity("a.txt", "uploaded", "docs", 1));
    });
    update_state("photos", |s| {
        s.add_activity(activity("b.jpg", "uploaded", "photos", 2));
    });

    let result = get_sync_activity(None, None);
    assert_eq!(result.len(), 2);
}

#[test]
fn get_activity_respects_limit() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| {
        for i in 0..10 {
            s.add_activity(activity(
                &format!("file_{i}.txt"),
                "uploaded",
                "docs",
                i as u64,
            ));
        }
    });

    let result = get_sync_activity(Some(3), Some("docs".to_string()));
    assert_eq!(result.len(), 3);
}

#[test]
fn get_activity_unknown_label_returns_empty() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_state();

    update_state("docs", |s| {
        s.add_activity(activity("a.txt", "uploaded", "docs", 1));
    });

    let result = get_sync_activity(None, Some("nonexistent".to_string()));
    assert!(result.is_empty());
}
