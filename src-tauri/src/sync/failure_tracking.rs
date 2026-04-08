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
        counts.get(&key).is_some_and(|(c, _)| *c == FAILURE_THRESHOLD)
    }

    pub fn skip_file(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped.insert(key.clone());
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
