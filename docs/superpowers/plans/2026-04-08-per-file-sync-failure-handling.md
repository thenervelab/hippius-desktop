# Per-File Sync Failure Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to skip or resolve individual files that fail to sync repeatedly, instead of the engine retrying them indefinitely.

**Architecture:** All new state (failure counters, session-skipped paths) lives in hippius-desktop's `AppState` to avoid modifying the external hcfs-client crate. The `SyncCompleted` event handler in `tauri_bridge.rs` inspects the progress tracker's file states after each cycle to identify failed files and increment counters. When a file hits 3 failures, a custom Tauri event triggers a frontend modal. Session-skip uses the existing `add_exclude_pattern` / `remove_exclude_pattern` IPC, with an in-memory set tracking which patterns are session-only (cleaned up on teardown).

**Tech Stack:** Rust (Tauri backend), TypeScript/React (frontend), Jotai (state), Radix Dialog (modal), sonner (toasts)

---

### Task 1: Add failure tracking state to AppState

**Files:**
- Create: `src-tauri/src/sync/failure_tracking.rs`
- Modify: `src-tauri/src/sync/mod.rs`
- Modify: `src-tauri/src/app_state.rs`

- [ ] **Step 1: Create the failure tracking module**

Create `src-tauri/src/sync/failure_tracking.rs`:

```rust
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

    /// Build the composite key for a file.
    fn key(label: &str, path: &str) -> String {
        format!("{label}/{path}")
    }

    /// Increment failure count for a file. Returns the new count.
    pub fn record_failure(&self, label: &str, path: &str, error: Option<String>) -> u32 {
        let key = Self::key(label, path);
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        let entry = counts.entry(key).or_insert((0, None));
        entry.0 += 1;
        entry.1 = error;
        entry.0
    }

    /// Clear the failure count for a file (on success or user retry).
    pub fn clear_failure(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.remove(&key);
    }

    /// Clear failures for all files belonging to a label (on successful cycle with no failures).
    pub fn clear_all_for_label(&self, label: &str) {
        let prefix = format!("{label}/");
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Collect all files that have reached the failure threshold.
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

    /// Check if a file has reached the failure threshold.
    /// Used to avoid re-emitting the event every cycle.
    pub fn is_at_threshold(&self, label: &str, path: &str) -> bool {
        let key = Self::key(label, path);
        let counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.get(&key).is_some_and(|(c, _)| *c >= FAILURE_THRESHOLD)
    }

    /// Check if the count is exactly at threshold (first time reaching it).
    pub fn just_reached_threshold(&self, label: &str, path: &str) -> bool {
        let key = Self::key(label, path);
        let counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.get(&key).is_some_and(|(c, _)| *c == FAILURE_THRESHOLD)
    }

    /// Mark a file as session-skipped.
    pub fn skip_file(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped.insert(key.clone());
        // Also clear the failure counter so the modal doesn't re-trigger
        let mut counts = self.counts.lock().expect("failure counts lock poisoned");
        counts.remove(&key);
    }

    /// Un-skip a file (user clicked retry).
    pub fn unskip_file(&self, label: &str, path: &str) {
        let key = Self::key(label, path);
        let mut skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped.remove(&key);
    }

    /// Get all session-skipped paths for a given label.
    /// Returns relative paths (without the label prefix).
    pub fn skipped_paths_for_label(&self, label: &str) -> Vec<String> {
        let prefix = format!("{label}/");
        let skipped = self.skipped.lock().expect("skipped files lock poisoned");
        skipped
            .iter()
            .filter_map(|k| k.strip_prefix(&prefix).map(String::from))
            .collect()
    }

    /// Clear all session-skip state (called on teardown).
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

    /// Reset all state (counts and skipped).
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
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/sync/mod.rs`, add:

```rust
pub mod failure_tracking;
```

- [ ] **Step 3: Add FileFailureState to AppState**

In `src-tauri/src/app_state.rs`, add the field to `AppState`:

```rust
pub file_failures: crate::sync::failure_tracking::FileFailureState,
```

And in `AppState::new()`, initialize it:

```rust
file_failures: crate::sync::failure_tracking::FileFailureState::new(),
```

- [ ] **Step 4: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles clean

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync/failure_tracking.rs src-tauri/src/sync/mod.rs src-tauri/src/app_state.rs
git commit -m "feat(sync): add per-file failure tracking state"
```

---

### Task 2: Add unit tests for FileFailureState

**Files:**
- Modify: `src-tauri/src/sync/failure_tracking.rs` (add `#[cfg(test)]` module)

- [ ] **Step 1: Write tests**

Add at the bottom of `src-tauri/src/sync/failure_tracking.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_failure_increments_count() {
        let state = FileFailureState::new();
        assert_eq!(state.record_failure("drive", "file.txt", None), 1);
        assert_eq!(state.record_failure("drive", "file.txt", None), 2);
        assert_eq!(state.record_failure("drive", "file.txt", None), 3);
    }

    #[test]
    fn clear_failure_resets_count() {
        let state = FileFailureState::new();
        state.record_failure("drive", "file.txt", None);
        state.record_failure("drive", "file.txt", None);
        state.clear_failure("drive", "file.txt");
        assert_eq!(state.record_failure("drive", "file.txt", None), 1);
    }

    #[test]
    fn clear_all_for_label_only_affects_target() {
        let state = FileFailureState::new();
        state.record_failure("drive-a", "file.txt", None);
        state.record_failure("drive-b", "other.txt", None);
        state.clear_all_for_label("drive-a");
        // drive-a cleared
        assert_eq!(state.record_failure("drive-a", "file.txt", None), 1);
        // drive-b untouched
        assert_eq!(state.record_failure("drive-b", "other.txt", None), 2);
    }

    #[test]
    fn files_at_threshold_returns_only_reached() {
        let state = FileFailureState::new();
        // file1: 3 failures (at threshold)
        for _ in 0..3 {
            state.record_failure("drive", "file1.txt", Some("timeout".into()));
        }
        // file2: 2 failures (below threshold)
        state.record_failure("drive", "file2.txt", None);
        state.record_failure("drive", "file2.txt", None);

        let failed = state.files_at_threshold();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].path, "file1.txt");
        assert_eq!(failed[0].failure_count, 3);
        assert_eq!(failed[0].error, Some("timeout".to_string()));
    }

    #[test]
    fn just_reached_threshold_fires_once() {
        let state = FileFailureState::new();
        state.record_failure("drive", "f.txt", None);
        assert!(!state.just_reached_threshold("drive", "f.txt"));
        state.record_failure("drive", "f.txt", None);
        assert!(!state.just_reached_threshold("drive", "f.txt"));
        state.record_failure("drive", "f.txt", None);
        assert!(state.just_reached_threshold("drive", "f.txt"));
        // 4th failure: no longer "just reached"
        state.record_failure("drive", "f.txt", None);
        assert!(!state.just_reached_threshold("drive", "f.txt"));
    }

    #[test]
    fn skip_file_clears_counter_and_tracks() {
        let state = FileFailureState::new();
        state.record_failure("drive", "f.txt", None);
        state.record_failure("drive", "f.txt", None);
        state.skip_file("drive", "f.txt");

        assert!(state.files_at_threshold().is_empty());
        let skipped = state.skipped_paths_for_label("drive");
        assert_eq!(skipped, vec!["f.txt"]);
    }

    #[test]
    fn unskip_and_retry() {
        let state = FileFailureState::new();
        state.skip_file("drive", "f.txt");
        state.unskip_file("drive", "f.txt");
        assert!(state.skipped_paths_for_label("drive").is_empty());
    }

    #[test]
    fn clear_all_skipped_returns_pairs() {
        let state = FileFailureState::new();
        state.skip_file("d1", "a.txt");
        state.skip_file("d2", "b.txt");
        let pairs = state.clear_all_skipped();
        assert_eq!(pairs.len(), 2);
        assert!(state.skipped_paths_for_label("d1").is_empty());
    }

    #[test]
    fn error_stored_with_latest_failure() {
        let state = FileFailureState::new();
        state.record_failure("drive", "f.txt", Some("err1".into()));
        state.record_failure("drive", "f.txt", Some("err2".into()));
        state.record_failure("drive", "f.txt", Some("err3".into()));
        let failed = state.files_at_threshold();
        assert_eq!(failed[0].error, Some("err3".to_string()));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib sync::failure_tracking`
Expected: all 8 tests pass

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sync/failure_tracking.rs
git commit -m "test(sync): add unit tests for per-file failure tracking"
```

---

### Task 3: Wire failure tracking into SyncCompleted handler

**Files:**
- Modify: `src-tauri/src/sync/tauri_bridge.rs:99-131` (the `SyncCompleted` arm)
- Modify: `src-tauri/src/sync/events.rs` (add event constant and payload struct)

- [ ] **Step 1: Add event constant and payload struct**

In `src-tauri/src/sync/events.rs`, add after the `PROGRESS_SNAPSHOT` constant:

```rust
/// Emitted when files have repeatedly failed to sync (threshold reached).
pub const FILES_FAILED_REPEATEDLY: &str = "hcfs_files_failed_repeatedly";
```

Add the payload struct after `AuthRequiredPayload`:

```rust
/// Emitted when files have failed to sync repeatedly.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilesFailedRepeatedlyPayload {
    pub files: Vec<crate::sync::failure_tracking::FailedFileInfo>,
}
```

- [ ] **Step 2: Update the SyncCompleted handler in tauri_bridge.rs**

Replace the `SyncEvent::SyncCompleted` arm in `tauri_bridge.rs` (lines 99-131, including the snapshot emit we added earlier) with:

```rust
            SyncEvent::SyncCompleted {
                label,
                files_uploaded,
                files_downloaded,
                files_deleted_locally,
                files_deleted_remotely,
                conflicts_resolved,
                conflicts_skipped,
            } => {
                // Emit a fresh snapshot so the frontend sees the finalized
                // session state (is_active=false, effective_completed=true).
                {
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    app_state.sync.emit_snapshot(true);

                    // Update per-file failure counters from the finalized session.
                    self.update_failure_counts(&app, &label, files_uploaded, files_downloaded);
                }

                let _ = app.emit(
                    events::SYNC_COMPLETED,
                    events::SyncCompletedPayload {
                        label,
                        files_uploaded,
                        files_downloaded,
                        files_deleted_locally,
                        files_deleted_remotely,
                        conflicts_resolved,
                        conflicts_skipped,
                    },
                );
            }
```

- [ ] **Step 3: Implement update_failure_counts on TauriSyncBridge**

Add this method to `TauriSyncBridge` in `tauri_bridge.rs` (after the `app()` method, around line 57):

```rust
    /// Inspect the progress tracker after a sync cycle completes to update
    /// per-file failure counters. If any file reaches the threshold, emit
    /// the `FILES_FAILED_REPEATEDLY` event to trigger the frontend modal.
    fn update_failure_counts(
        &self,
        app: &AppHandle,
        label: &str,
        files_uploaded: usize,
        files_downloaded: usize,
    ) {
        use hcfs_client::engine::progress::state::FileStatus;
        use tauri::Manager;

        let app_state = app.state::<crate::app_state::AppState>();
        let failure_state = &app_state.file_failures;

        // If the cycle had no expected files, nothing to track.
        let has_any_failures = {
            let state = app_state.sync.progress.lock_state();
            state.current_session.as_ref().is_some_and(|session| {
                session.files.values().any(|f| {
                    f.label == label && matches!(f.status, FileStatus::Error)
                })
            })
        };

        if !has_any_failures {
            // All files succeeded for this label -- clear counters.
            failure_state.clear_all_for_label(label);
            return;
        }

        // Collect failed files from the session.
        let failed_files: Vec<(String, Option<String>)> = {
            let state = app_state.sync.progress.lock_state();
            state
                .current_session
                .as_ref()
                .map(|session| {
                    session
                        .files
                        .values()
                        .filter(|f| f.label == label && matches!(f.status, FileStatus::Error))
                        .map(|f| (f.path.clone(), f.error.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };

        // Also clear counters for files that succeeded this cycle.
        {
            let state = app_state.sync.progress.lock_state();
            if let Some(session) = &state.current_session {
                for f in session.files.values() {
                    if f.label == label && matches!(f.status, FileStatus::Completed) {
                        failure_state.clear_failure(label, &f.path);
                    }
                }
            }
        }

        // Increment counters for failed files.
        let mut any_newly_at_threshold = false;
        for (path, error) in &failed_files {
            failure_state.record_failure(label, path, error.clone());
            if failure_state.just_reached_threshold(label, path) {
                any_newly_at_threshold = true;
            }
        }

        // Emit the event if any file just reached the threshold.
        if any_newly_at_threshold {
            let at_threshold = failure_state.files_at_threshold();
            if !at_threshold.is_empty() {
                let _ = app.emit(
                    events::FILES_FAILED_REPEATEDLY,
                    events::FilesFailedRepeatedlyPayload { files: at_threshold },
                );
            }
        }
    }
```

- [ ] **Step 4: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles clean

- [ ] **Step 5: Run clippy**

Run: `cd src-tauri && cargo clippy --all -- -D warnings`
Expected: no warnings

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/tauri_bridge.rs src-tauri/src/sync/events.rs
git commit -m "feat(sync): wire per-file failure tracking into SyncCompleted handler"
```

---

### Task 4: Add IPC commands for skip, exclude, and retry

**Files:**
- Create: `src-tauri/src/sync/failure_commands.rs`
- Modify: `src-tauri/src/sync/mod.rs`
- Modify: `src-tauri/src/main.rs` (register commands in `generate_handler!`)

- [ ] **Step 1: Create the IPC commands module**

Create `src-tauri/src/sync/failure_commands.rs`:

```rust
//! IPC commands for per-file sync failure resolution.
//!
//! These commands let the frontend skip, exclude, or retry files
//! that have repeatedly failed to sync.

use crate::error::Result;

/// Skip a file for this session only.
///
/// Adds the file path to the drive's exclude patterns (so the engine
/// skips it on the next cycle) and records it as a session-skip so
/// the pattern can be removed on teardown/restart.
#[tauri::command]
pub async fn sp_skip_file(
    label: String,
    path: String,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<()> {
    // Add to session-skip tracking
    state.file_failures.skip_file(&label, &path);

    // Add exclude pattern so the engine skips it
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    if let Some(arc) = drive_arc {
        if let Ok(mut m) = arc.try_lock() {
            let _ = m.add_exclude_pattern(&path);
        }
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Permanently exclude a file from sync.
///
/// Adds the file path to the drive's exclude patterns. Unlike
/// `sp_skip_file`, this is NOT recorded as a session-skip, so
/// the pattern persists across restarts.
#[tauri::command]
pub async fn sp_exclude_file(
    label: String,
    path: String,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<()> {
    // Clear from failure tracking
    state.file_failures.clear_failure(&label, &path);

    // Add exclude pattern (permanent)
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    if let Some(arc) = drive_arc {
        if let Ok(mut m) = arc.try_lock() {
            let _ = m.add_exclude_pattern(&path);
        }
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Retry a previously skipped or failed file.
///
/// Resets the failure counter and removes the file from
/// session-skip and exclude patterns. The file will be
/// picked up on the next sync cycle.
#[tauri::command]
pub async fn sp_retry_file(
    label: String,
    path: String,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<()> {
    // Clear failure counter
    state.file_failures.clear_failure(&label, &path);

    // Remove from session-skip tracking
    state.file_failures.unskip_file(&label, &path);

    // Remove exclude pattern (in case it was session-skipped)
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };
    if let Some(arc) = drive_arc {
        if let Ok(mut m) = arc.try_lock() {
            let _ = m.remove_exclude_pattern(&path);
        }
    }

    state.sync.emit_snapshot(true);
    Ok(())
}

/// Clean up session-skip patterns on teardown.
///
/// Called from `teardown_sync` to remove exclude patterns that
/// were added via `sp_skip_file`. Permanent excludes (from
/// `sp_exclude_file`) are left untouched.
pub async fn cleanup_session_skips(state: &crate::app_state::AppState) {
    let pairs = state.file_failures.clear_all_skipped();
    for (label, path) in pairs {
        let drive_arc = {
            let guard = state.sync.drives.lock().await;
            guard.get(&label).map(|slot| slot.manager.clone())
        };
        if let Some(arc) = drive_arc {
            if let Ok(mut m) = arc.try_lock() {
                let _ = m.remove_exclude_pattern(&path);
            }
        }
    }
    state.file_failures.reset();
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/sync/mod.rs`, add:

```rust
pub mod failure_commands;
```

- [ ] **Step 3: Register IPC commands in main.rs**

In `src-tauri/src/main.rs`, add these three commands in the `generate_handler![]` macro, near the other selective sync commands (around line 247):

```rust
crate::sync::failure_commands::sp_skip_file,
crate::sync::failure_commands::sp_exclude_file,
crate::sync::failure_commands::sp_retry_file,
```

- [ ] **Step 4: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles clean

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync/failure_commands.rs src-tauri/src/sync/mod.rs src-tauri/src/main.rs
git commit -m "feat(sync): add IPC commands for skip, exclude, and retry failed files"
```

---

### Task 5: Wire session-skip cleanup into teardown

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs` (the `teardown_sync` function)

- [ ] **Step 1: Add cleanup call to stop_sync**

In `src-tauri/src/sync/lifecycle.rs`, locate the `stop_sync` function at line 894. Add the session-skip cleanup call after the graceful shutdown wait (step 3 in the existing comments) but before the drives map is cleared (step 5), so the drives are still available for removing exclude patterns. Insert after the watcher cleanup block (step 4) and before `guard.clear()`:

```rust
    // 4b. Clean up session-skip exclude patterns before drives are removed.
    crate::sync::failure_commands::cleanup_session_skips(&app_state).await;
```

- [ ] **Step 2: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles clean

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "feat(sync): clean up session-skip patterns on teardown"
```

---

### Task 6: Add frontend atoms and types

**Files:**
- Modify: `app/lib/store/syncAtoms.ts`
- Modify: `app/lib/types/syncTypes.ts` (or create type inline)

- [ ] **Step 1: Add the Jotai atom and type**

In `app/lib/store/syncAtoms.ts`, add:

```typescript
/** Info about a file that has repeatedly failed to sync. */
export interface FailedFileInfo {
  label: string;
  path: string;
  fileName: string;
  error: string | null;
  failureCount: number;
}

/** Files that have repeatedly failed to sync (null when no failures at threshold). */
export const failedFilesAtom = atom<FailedFileInfo[] | null>(null);
```

- [ ] **Step 2: Commit**

```bash
git add app/lib/store/syncAtoms.ts
git commit -m "feat(sync): add failedFilesAtom for per-file failure tracking"
```

---

### Task 7: Create FailedFilesListener component

**Files:**
- Create: `app/(pages)/FailedFilesListener.tsx`
- Modify: `app/(pages)/layout.tsx`

- [ ] **Step 1: Create the listener component**

Create `app/(pages)/FailedFilesListener.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that listens for the hcfs_files_failed_repeatedly
 * event and populates the failedFilesAtom to trigger the modal.
 */
export default function FailedFilesListener() {
  const setFailedFiles = useSetAtom(failedFilesAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "hcfs_files_failed_repeatedly",
        (event) => {
          const payload = event.payload as { files: FailedFileInfo[] };
          if (payload.files.length > 0) {
            setFailedFiles(payload.files);
          }
        },
      ],
    ]);

    return cleanup;
  }, [setFailedFiles]);

  return null;
}
```

- [ ] **Step 2: Mount in layout**

In `app/(pages)/layout.tsx`, add the import and component:

```tsx
import FailedFilesListener from "./FailedFilesListener";
```

Add `<FailedFilesListener />` after `<ConflictEventListener />` in the JSX.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/(pages)/FailedFilesListener.tsx app/(pages)/layout.tsx
git commit -m "feat(sync): add FailedFilesListener for per-file failure events"
```

---

### Task 8: Create FailedFilesModal component

**Files:**
- Create: `app/components/page-sections/files/FailedFilesModal.tsx`
- Modify: `app/(pages)/layout.tsx`

- [ ] **Step 1: Create the modal component**

Create `app/components/page-sections/files/FailedFilesModal.tsx`:

```tsx
"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import DialogContainer from "@/components/ui/DialogContainer";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFilePartsFromFileName } from "@/lib/utils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

function FileRow({
  file,
  onAction,
}: {
  file: FailedFileInfo;
  onAction: (file: FailedFileInfo, action: "retry" | "skip" | "exclude") => void;
}) {
  const { fileFormat } = getFilePartsFromFileName(file.fileName);
  const IconComponent = getFileIcon(fileFormat);

  return (
    <div className="flex items-center gap-3 py-3 px-4 border-b border-grey-80 last:border-b-0">
      <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
        <IconComponent className="w-6 h-6 text-grey-30" />
      </div>

      <div className="flex-1 min-w-0">
        <MiddleTruncatedName
          name={file.fileName}
          className="text-sm font-medium text-grey-10"
        />
        {file.error && (
          <p className="text-xs text-grey-50 truncate mt-0.5">{file.error}</p>
        )}
        <p className="text-xs text-grey-60 mt-0.5">{file.label}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={() => onAction(file, "retry")}
          className="px-3 py-1 text-xs font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => onAction(file, "skip")}
          className="px-3 py-1 text-xs font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={() => onAction(file, "exclude")}
          className="px-3 py-1 text-xs font-medium rounded border border-error-80 text-error-50 hover:bg-error-100/20 transition-colors"
          title="Permanently exclude this file from sync"
        >
          Exclude
        </button>
      </div>
    </div>
  );
}

export default function FailedFilesModal() {
  const [failedFiles, setFailedFiles] = useAtom(failedFilesAtom);
  const open = failedFiles !== null && failedFiles.length > 0;

  const handleAction = useCallback(
    async (file: FailedFileInfo, action: "retry" | "skip" | "exclude") => {
      try {
        if (action === "retry") {
          await invoke("sp_retry_file", { label: file.label, path: file.path });
          toast.success("File will retry on next sync cycle", { duration: 4000 });
        } else if (action === "skip") {
          await invoke("sp_skip_file", { label: file.label, path: file.path });
          toast.success("File skipped for this session", { duration: 4000 });
        } else if (action === "exclude") {
          await invoke("sp_exclude_file", { label: file.label, path: file.path });
          toast.success("File permanently excluded from sync", { duration: 4000 });
        }
      } catch (err) {
        toast.error(`Failed to ${action} file: ${err}`);
        return;
      }

      // Remove the file from the list
      setFailedFiles((prev) => {
        if (!prev) return null;
        const updated = prev.filter(
          (f) => !(f.label === file.label && f.path === file.path)
        );
        return updated.length > 0 ? updated : null;
      });
    },
    [setFailedFiles]
  );

  const handleDismiss = useCallback(() => {
    setFailedFiles(null);
  }, [setFailedFiles]);

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleDismiss()}>
      <DialogContainer className="sm:max-w-[30rem] sm:mx-auto">
        <div className="p-6">
          {/* Header */}
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-grey-10">Sync Issues</h2>
            <p className="text-sm text-grey-50 mt-1">
              These files have failed to sync after multiple attempts.
            </p>
          </div>

          {/* File list */}
          <div className="max-h-[24rem] overflow-y-auto border border-grey-80 rounded">
            {failedFiles?.map((file) => (
              <FileRow
                key={`${file.label}/${file.path}`}
                file={file}
                onAction={handleAction}
              />
            ))}
          </div>

          {/* Footer */}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleDismiss}
              className="px-4 py-2 text-sm font-medium rounded border border-grey-70 text-grey-20 hover:bg-grey-90 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Mount in layout**

In `app/(pages)/layout.tsx`, add the import:

```tsx
import FailedFilesModal from "@/components/page-sections/files/FailedFilesModal";
```

Add `<FailedFilesModal />` after `<InsufficientCreditsDialog />` in the JSX.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/components/page-sections/files/FailedFilesModal.tsx app/(pages)/layout.tsx
git commit -m "feat(sync): add FailedFilesModal for per-file failure resolution"
```

---

### Task 9: Full integration verification

**Files:** None (verification only)

- [ ] **Step 1: Run all Rust tests**

Run: `cd src-tauri && cargo test`
Expected: all tests pass

- [ ] **Step 2: Run clippy**

Run: `cd src-tauri && cargo clippy --all -- -D warnings`
Expected: no warnings

- [ ] **Step 3: Run frontend lint**

Run: `pnpm lint`
Expected: no errors

- [ ] **Step 4: Run frontend build**

Run: `pnpm build`
Expected: builds successfully

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address integration issues from per-file failure handling"
```
