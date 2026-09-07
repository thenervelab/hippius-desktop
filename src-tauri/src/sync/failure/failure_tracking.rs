//! Per-file sync failure tracking.
//!
//! Tracks how many consecutive sync cycles each file has failed,
//! which files have been session-skipped by the user, and which files the
//! user has dismissed from the Sync Issues dialog.
//!
//! Counters and skips are in-memory only and start empty on every launch.
//! Dismissals are also written to `sync_file_failures.dismissed_at` and
//! restored from there when a drive initializes, so a dismissed file does
//! not reopen the dialog three cycles after every relaunch.

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
    /// Files the user dismissed from the Sync Issues dialog. A dismissed file
    /// never reopens the dialog on its own; a file the user has not seen
    /// does, and the dialog then lists every file at the threshold. Forgotten
    /// on success, retry, skip, and exclude.
    dismissed: Mutex<HashSet<String>>,
}

impl FileFailureState {
    pub fn new() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
            skipped: Mutex::new(HashSet::new()),
            dismissed: Mutex::new(HashSet::new()),
        }
    }

    /// Bump the counter of every file that errored this cycle and decide
    /// whether the Sync Issues dialog should open.
    ///
    /// Opens when a file the user has not dismissed reaches the threshold,
    /// and again every `FAILURE_THRESHOLD` cycles after that while it keeps
    /// failing. A dismissed file stays quiet however long it fails; a new
    /// failing file reopens the dialog, which then lists every file at the
    /// threshold, dismissed ones included, so the user sees the whole set.
    pub fn record_cycle_failures(&self, label: &str, failed: &[(String, Option<String>)]) -> bool {
        let mut prompt = false;
        for (path, error) in failed {
            self.record_failure(label, path, error.clone());
            if self.just_reached_threshold(label, path) && !self.is_dismissed(label, path) {
                prompt = true;
            }
        }
        prompt
    }

    pub fn dismiss(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        self.dismissed.lock().expect("dismissed files lock poisoned").insert(key);
    }

    /// Reinstate dismissals read back from the durable store at drive init.
    pub fn restore_dismissed(&self, label: &str, paths: impl IntoIterator<Item = String>) {
        let mut dismissed = self.dismissed.lock().expect("dismissed files lock poisoned");
        for path in paths {
            dismissed.insert(Self::key(label, &path));
        }
    }

    pub fn is_dismissed(&self, label: &str, path: &str) -> bool {
        let key = Self::key(label, path);
        self.dismissed.lock().expect("dismissed files lock poisoned").contains(&key)
    }

    fn forget_dismissal(&self, key: &str) {
        self.dismissed.lock().expect("dismissed files lock poisoned").remove(key);
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

    /// Forget a file's failures and its dismissal: a success or a retry
    /// starts the file over, so a later outage prompts again.
    pub fn clear_failure(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        {
            let mut counts = self.counts.lock().expect("failure counts lock poisoned");
            counts.remove(&key);
        }
        self.forget_dismissal(&key);
    }

    pub fn clear_all_for_label(&self, label: &str) {
        let prefix = format!("{label}/");
        {
            let mut counts = self.counts.lock().expect("failure counts lock poisoned");
            counts.retain(|k, _| !k.starts_with(&prefix));
        }
        let mut dismissed = self.dismissed.lock().expect("dismissed files lock poisoned");
        dismissed.retain(|k| !k.starts_with(&prefix));
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
        {
            let mut counts = self.counts.lock().expect("failure counts lock poisoned");
            counts.remove(&key);
        }
        self.forget_dismissal(&key);
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
        self.dismissed.lock().expect("dismissed files lock poisoned").clear();
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

#[cfg(test)]
mod dismiss_tests {
    use super::*;

    /// One failed cycle in which every listed path errored; returns whether
    /// the Sync Issues dialog should open.
    fn fail(state: &FileFailureState, label: &str, paths: &[&str]) -> bool {
        let failed: Vec<(String, Option<String>)> = paths.iter().map(|p| ((*p).to_string(), None)).collect();
        state.record_cycle_failures(label, &failed)
    }

    #[test]
    fn prompts_when_a_file_first_reaches_the_threshold() {
        let state = FileFailureState::new();
        assert!(!fail(&state, "d", &["a"]));
        assert!(!fail(&state, "d", &["a"]));
        assert!(fail(&state, "d", &["a"]));
    }

    #[test]
    fn a_dismissed_file_does_not_prompt_again_on_its_own() {
        let state = FileFailureState::new();
        for _ in 0..3 {
            fail(&state, "d", &["a"]);
        }
        state.dismiss("d", "a");
        for _ in 0..6 {
            assert!(
                !fail(&state, "d", &["a"]),
                "a dismissed file must stay quiet however long it keeps failing"
            );
        }
    }

    #[test]
    fn a_new_failing_file_prompts_and_the_list_includes_dismissed_ones() {
        let state = FileFailureState::new();
        for _ in 0..3 {
            fail(&state, "d", &["a"]);
        }
        state.dismiss("d", "a");

        assert!(!fail(&state, "d", &["a", "b"]));
        assert!(!fail(&state, "d", &["a", "b"]));
        assert!(fail(&state, "d", &["a", "b"]), "a file the user has not seen must reopen the dialog");

        let listed: Vec<String> = state.files_at_threshold().into_iter().map(|f| f.path).collect();
        assert!(listed.contains(&"a".to_string()) && listed.contains(&"b".to_string()));
    }

    #[test]
    fn success_forgets_a_dismissal_so_a_later_outage_prompts_again() {
        let state = FileFailureState::new();
        for _ in 0..3 {
            fail(&state, "d", &["a"]);
        }
        state.dismiss("d", "a");
        state.clear_failure("d", "a");

        assert!(!fail(&state, "d", &["a"]));
        assert!(!fail(&state, "d", &["a"]));
        assert!(fail(&state, "d", &["a"]));
    }

    #[test]
    fn restored_dismissals_survive_a_restart() {
        // A fresh process starts with empty counters; the durable dismissal
        // is what keeps the dialog closed after a relaunch.
        let state = FileFailureState::new();
        state.restore_dismissed("d", ["a".to_string()]);
        for _ in 0..3 {
            assert!(!fail(&state, "d", &["a"]));
        }
        assert!(state.is_dismissed("d", "a"));
    }

    #[test]
    fn skip_and_label_clear_forget_dismissals() {
        let state = FileFailureState::new();
        state.dismiss("d", "a");
        state.dismiss("d", "b");
        state.skip_file("d", "a");
        assert!(!state.is_dismissed("d", "a"));
        state.clear_all_for_label("d");
        assert!(!state.is_dismissed("d", "b"));
    }
}
