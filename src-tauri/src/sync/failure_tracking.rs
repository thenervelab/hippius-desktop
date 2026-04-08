//! Per-file sync failure tracking.
//!
//! Tracks how many consecutive sync cycles each file has failed,
//! and which files have been session-skipped by the user.
//! All state is in-memory only -- cleared on app restart.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Number of consecutive failures before prompting the user.
const FAILURE_THRESHOLD: u32 = 3;

/// Information about a file that has repeatedly failed to sync.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedFileInfo {
    pub label: String,
    pub path: String,
    pub file_name: String,
    pub error: Option<String>,
    pub failure_count: u32,
}

/// Per-file failure counters and session-skip state.
///
/// Keys use the format `"{label}/{relative_path}"` to distinguish
/// files across drives.
pub struct FileFailureState {
    /// Consecutive failure count per file. Incremented after each cycle
    /// where the file remains in error state. Reset on success or retry.
    counts: Mutex<HashMap<String, (u32, Option<String>)>>,
    /// Files the user has chosen to skip for this session. These paths
    /// are also added to the drive's exclude patterns and removed on
    /// teardown.
    skipped: Mutex<HashSet<String>>,
}

impl FileFailureState {
    pub fn new() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
            skipped: Mutex::new(HashSet::new()),
        }
    }

    fn key(label: &str, path: &str) -> String {
        format!("{label}/{path}")
    }

    pub fn record_failure(&self, label: &str, path: &str, error: Option<String>) -> u32 {
        let key = Self::key(label, path);
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        let entry = counts.entry(key).or_insert((0, None));
        entry.0 += 1;
        entry.1 = error;
        entry.0
    }

    pub fn clear_failure(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.remove(&key);
    }

    pub fn clear_all_for_label(&self, label: &str) {
        let prefix = format!("{label}/");
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.retain(|k, _| !k.starts_with(&prefix));
    }

    pub fn files_at_threshold(&self) -> Vec<FailedFileInfo> {
        let counts = self.counts.lock().expect("failure counts lock poisoned");
        counts
            .iter()
            .filter(|(_, (count, _))| *count >= FAILURE_THRESHOLD)
            .filter_map(|(key, (count, error))| {
                let (label, path) = key.split_once('/')?;
                let file_name = path.rsplit('/').next().unwrap_or(path).to_string();
                Some(FailedFileInfo {
                    label: label.to_string(),
                    path: path.to_string(),
                    file_name,
                    error: error.clone(),
                    failure_count: *count,
                })
            })
            .collect()
    }

    pub fn is_at_threshold(&self, label: &str, path: &str) -> bool {
        let key = Self::key(label, path);
        let counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.get(&key).is_some_and(|(c, _)| *c >= FAILURE_THRESHOLD)
    }

    pub fn just_reached_threshold(&self, label: &str, path: &str) -> bool {
        let key = Self::key(label, path);
        let counts = self.counts.lock().expect("failure counts lock poisoned");
        counts
            .get(&key)
            .is_some_and(|(c, _)| *c >= FAILURE_THRESHOLD && *c % FAILURE_THRESHOLD == 0)
    }

    pub fn skip_file(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        {
            let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
            skipped.insert(key.clone());
        }
        // Drop skipped guard before acquiring counts to avoid lock ordering issues.
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.remove(&key);
    }

    pub fn unskip_file(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped.remove(&key);
    }

    pub fn skipped_paths_for_label(&self, label: &str) -> Vec<String> {
        let prefix = format!("{label}/");
        let skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped.iter().filter_map(|k| k.strip_prefix(&prefix).map(String::from)).collect()
    }

    pub fn clear_all_skipped(&self) -> Vec<(String, String)> {
        let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
        let pairs: Vec<(String, String)> = skipped
            .drain()
            .filter_map(|key| {
                let (label, path) = key.split_once('/')?;
                Some((label.to_string(), path.to_string()))
            })
            .collect();
        pairs
    }

    pub fn reset(&self) {
        self.counts.lock().expect("failure counts lock poisoned").clear();
        self.skipped.lock().expect("skipped files lock poisoned").clear();
    }
}

impl Default for FileFailureState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_failure_increments_count() {
        let state = FileFailureState::new();
        assert_eq!(state.record_failure("drive1", "docs/report.pdf", None), 1);
        assert_eq!(state.record_failure("drive1", "docs/report.pdf", None), 2);
        assert_eq!(state.record_failure("drive1", "docs/report.pdf", None), 3);
    }

    #[test]
    fn clear_failure_resets_count() {
        let state = FileFailureState::new();
        state.record_failure("drive1", "a.txt", None);
        state.record_failure("drive1", "a.txt", None);
        state.clear_failure("drive1", "a.txt");
        // After clearing, the next record_failure should start from 1 again.
        assert_eq!(state.record_failure("drive1", "a.txt", None), 1);
    }

    #[test]
    fn clear_all_for_label_only_affects_target() {
        let state = FileFailureState::new();
        state.record_failure("alpha", "file.txt", None);
        state.record_failure("alpha", "file.txt", None);
        state.record_failure("beta", "other.txt", None);
        state.record_failure("beta", "other.txt", None);

        state.clear_all_for_label("alpha");

        // alpha entries should be gone; next failure starts at 1.
        assert_eq!(state.record_failure("alpha", "file.txt", None), 1);
        // beta should be untouched; next failure increments to 3.
        assert_eq!(state.record_failure("beta", "other.txt", None), 3);
    }

    #[test]
    fn files_at_threshold_returns_only_reached() {
        let state = FileFailureState::new();
        // Bring one file to threshold.
        state.record_failure("drive1", "fail.rs", Some("io error".to_string()));
        state.record_failure("drive1", "fail.rs", Some("io error".to_string()));
        state.record_failure("drive1", "fail.rs", Some("io error".to_string()));
        // Keep the other file below threshold.
        state.record_failure("drive1", "ok.rs", None);
        state.record_failure("drive1", "ok.rs", None);

        let at_threshold = state.files_at_threshold();
        assert_eq!(at_threshold.len(), 1);
        assert_eq!(at_threshold[0].path, "fail.rs");
        assert_eq!(at_threshold[0].failure_count, 3);
    }

    #[test]
    fn just_reached_threshold_fires_periodically() {
        let state = FileFailureState::new();
        state.record_failure("drive1", "photo.png", None);
        assert!(!state.just_reached_threshold("drive1", "photo.png"));

        state.record_failure("drive1", "photo.png", None);
        assert!(!state.just_reached_threshold("drive1", "photo.png"));

        // Third failure hits FAILURE_THRESHOLD -- fires.
        state.record_failure("drive1", "photo.png", None);
        assert!(state.just_reached_threshold("drive1", "photo.png"));

        // 4th and 5th: between thresholds -- does not fire.
        state.record_failure("drive1", "photo.png", None);
        assert!(!state.just_reached_threshold("drive1", "photo.png"));
        state.record_failure("drive1", "photo.png", None);
        assert!(!state.just_reached_threshold("drive1", "photo.png"));

        // 6th failure: fires again (multiple of threshold).
        state.record_failure("drive1", "photo.png", None);
        assert!(state.just_reached_threshold("drive1", "photo.png"));
    }

    #[test]
    fn skip_file_clears_counter_and_tracks() {
        let state = FileFailureState::new();
        state.record_failure("drive1", "video.mp4", None);
        state.record_failure("drive1", "video.mp4", None);
        state.record_failure("drive1", "video.mp4", None);

        // File should be at threshold before skipping.
        assert!(state.is_at_threshold("drive1", "video.mp4"));

        state.skip_file("drive1", "video.mp4");

        // Counter should be cleared after skipping.
        assert!(!state.is_at_threshold("drive1", "video.mp4"));

        // The file should appear in the skipped set.
        let skipped = state.skipped_paths_for_label("drive1");
        assert!(skipped.contains(&"video.mp4".to_string()));
    }

    #[test]
    fn unskip_and_retry() {
        let state = FileFailureState::new();
        state.record_failure("drive1", "archive.zip", None);
        state.skip_file("drive1", "archive.zip");

        // Verify it is skipped.
        assert!(!state.skipped_paths_for_label("drive1").is_empty());

        state.unskip_file("drive1", "archive.zip");

        // Skipped set should now be empty.
        assert!(state.skipped_paths_for_label("drive1").is_empty());
    }

    #[test]
    fn error_stored_with_latest_failure() {
        let state = FileFailureState::new();
        state.record_failure("drive1", "data.csv", Some("permission denied".to_string()));
        state.record_failure("drive1", "data.csv", Some("disk full".to_string()));
        state.record_failure("drive1", "data.csv", Some("network timeout".to_string()));

        let at_threshold = state.files_at_threshold();
        assert_eq!(at_threshold.len(), 1);
        // The error field should hold the latest failure message.
        assert_eq!(at_threshold[0].error.as_deref(), Some("network timeout"));
    }
}
