# Sync Progress Widget Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the polling-based sync progress widget with a push-based architecture where Rust emits `SyncSnapshot` events and the frontend is a pure renderer.

**Architecture:** Rust backend owns all state, computes sorted file lists and overall stats in a pure `build_snapshot()` function, and pushes snapshots via Tauri events on state changes (throttled for byte updates). Frontend listens with a single atom and renders — no polling, no type conversions, no priority fallbacks.

**Tech Stack:** Rust (Tauri 2.0, tokio, serde), TypeScript (Jotai atoms, React, Vitest)

---

### Task 1: Add new types and `build_snapshot()` pure function

**Files:**
- Modify: `src-tauri/src/sync_progress.rs`

**Step 1: Add `FileProgressStatus` enum and `FileProgress` struct**

Add these types above the existing types (keep old types for now — Phase 4 removes them):

```rust
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileProgressStatus {
    Pending,
    InProgress,
    Completed,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    pub path: String,
    pub file_name: String,
    pub label: String,
    pub action: FileAction,
    pub status: FileProgressStatus,
    pub progress_percent: u32,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub is_active: bool,
    pub overall_percent: u32,
    pub bytes_transferred: u64,
    pub bytes_expected: u64,
    pub total_files: usize,
    pub completed_files: usize,
    pub failed_files: usize,
    pub files: Vec<FileProgress>,
}
```

**Step 2: Add `build_snapshot()` pure function**

Add this function after the new types. It reads from the existing `SyncProgressState` — no new state struct yet:

```rust
use std::cmp::Ordering;

/// Build a snapshot from the current state.
///
/// This is a pure function with no side effects — all sorting, counting,
/// and percentage calculation happens here. Unit tests call this directly
/// with constructed state.
pub fn build_snapshot(state: &SyncProgressState) -> SyncSnapshot {
    let session = match &state.current_session {
        Some(s) => s,
        None => {
            return SyncSnapshot {
                is_active: false,
                overall_percent: 0,
                bytes_transferred: 0,
                bytes_expected: 0,
                total_files: 0,
                completed_files: 0,
                failed_files: 0,
                files: Vec::new(),
            };
        }
    };

    let mut files: Vec<FileProgress> = session
        .files
        .values()
        .map(|f| {
            let status = match f.status {
                FileStatus::Pending => FileProgressStatus::Pending,
                FileStatus::Uploading
                | FileStatus::Downloading
                | FileStatus::Deleting => FileProgressStatus::InProgress,
                FileStatus::Completed => FileProgressStatus::Completed,
                FileStatus::Error => FileProgressStatus::Error,
            };
            FileProgress {
                path: f.path.clone(),
                file_name: f.file_name.clone(),
                label: f.label.clone(),
                action: f.action.clone(),
                status,
                progress_percent: f.progress,
                bytes_transferred: f.bytes_transferred,
                total_bytes: f.total_bytes,
                error: f.error.clone(),
            }
        })
        .collect();

    // Sort: known sizes descending, then unknowns at bottom
    files.sort_by(|a, b| {
        let a_known = a.total_bytes > 0;
        let b_known = b.total_bytes > 0;
        match (a_known, b_known) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => b.total_bytes.cmp(&a.total_bytes),
        }
    });

    // Single pass for stats
    let mut completed_files: usize = 0;
    let mut failed_files: usize = 0;
    let mut bytes_transferred: u64 = 0;
    let mut bytes_expected: u64 = 0;

    for f in &files {
        match f.status {
            FileProgressStatus::Completed => completed_files += 1,
            FileProgressStatus::Error => failed_files += 1,
            _ => {}
        }
        if f.total_bytes > 0 {
            bytes_transferred += f.bytes_transferred;
            bytes_expected += f.total_bytes;
        }
    }

    let total_files = files.len();
    let overall_percent = if total_files == 0 {
        0
    } else if completed_files + failed_files == total_files {
        100
    } else if bytes_expected > 0 {
        let pct = (bytes_transferred as f64 / bytes_expected as f64) * 100.0;
        (pct.round() as u32).min(100)
    } else {
        let pct = (completed_files as f64 / total_files as f64) * 100.0;
        (pct.round() as u32).min(100)
    };

    SyncSnapshot {
        is_active: session.is_active,
        overall_percent,
        bytes_transferred,
        bytes_expected,
        total_files,
        completed_files,
        failed_files,
        files,
    }
}
```

**Step 3: Verify existing tests still pass**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All existing tests PASS (we only added new code, nothing changed)

**Step 4: Commit**

```bash
git add src-tauri/src/sync_progress.rs
git commit -m "Add SyncSnapshot types and build_snapshot() pure function"
```

---

### Task 2: Write unit tests for `build_snapshot()`

**Files:**
- Modify: `src-tauri/src/sync_progress.rs` (tests module)

**Step 1: Add test helpers**

Add these helpers inside the existing `#[cfg(test)] mod tests` block:

```rust
/// Create a SyncFile for testing with common defaults.
fn make_file(
    path: &str,
    total_bytes: u64,
    action: FileAction,
    status: FileStatus,
    bytes_transferred: u64,
) -> SyncFile {
    SyncFile {
        id: generate_file_id(path),
        path: path.to_string(),
        file_name: extract_file_name(path),
        label: "default".to_string(),
        action,
        status,
        progress: if total_bytes > 0 {
            ((bytes_transferred as f64 / total_bytes as f64) * 100.0) as u32
        } else {
            0
        },
        bytes_transferred,
        total_bytes,
        started_at: now_ms(),
        completed_at: if status == FileStatus::Completed {
            Some(now_ms())
        } else {
            None
        },
        error: None,
    }
}

/// Create a SyncProgressState with the given files in an active session.
fn state_with_files(files: Vec<SyncFile>) -> SyncProgressState {
    let mut file_map = HashMap::new();
    for f in files {
        file_map.insert(f.path.clone(), f);
    }
    SyncProgressState {
        current_session: Some(SyncSession {
            session_id: "test_session".to_string(),
            started_at: now_ms(),
            completed_at: None,
            is_active: true,
            expected_uploads: 0,
            expected_downloads: 0,
            expected_local_deletes: 0,
            expected_remote_deletes: 0,
            files: file_map,
        }),
        recent_files: Vec::new(),
        last_updated: now_ms(),
    }
}
```

**Step 2: Add snapshot tests**

```rust
#[test]
fn snapshot_sorts_biggest_first() {
    let state = state_with_files(vec![
        make_file("/small.txt", 100, FileAction::Upload, FileStatus::Pending, 0),
        make_file("/big.zip", 50_000, FileAction::Upload, FileStatus::Pending, 0),
        make_file("/medium.pdf", 5_000, FileAction::Download, FileStatus::Pending, 0),
    ]);
    let snapshot = build_snapshot(&state);
    assert_eq!(snapshot.files.len(), 3);
    assert_eq!(snapshot.files[0].file_name, "big.zip");
    assert_eq!(snapshot.files[1].file_name, "medium.pdf");
    assert_eq!(snapshot.files[2].file_name, "small.txt");
}

#[test]
fn snapshot_unknown_size_files_last() {
    let state = state_with_files(vec![
        make_file("/known.txt", 500, FileAction::Upload, FileStatus::Pending, 0),
        make_file("/unknown.dat", 0, FileAction::Download, FileStatus::Pending, 0),
        make_file("/also_known.pdf", 200, FileAction::Upload, FileStatus::Pending, 0),
    ]);
    let snapshot = build_snapshot(&state);
    assert_eq!(snapshot.files[0].file_name, "known.txt");
    assert_eq!(snapshot.files[1].file_name, "also_known.pdf");
    assert_eq!(snapshot.files[2].file_name, "unknown.dat");
}

#[test]
fn snapshot_overall_percent_byte_weighted() {
    let state = state_with_files(vec![
        make_file("/a.txt", 1000, FileAction::Upload, FileStatus::Uploading, 800),
        make_file("/b.txt", 4000, FileAction::Upload, FileStatus::Uploading, 200),
    ]);
    let snapshot = build_snapshot(&state);
    // 1000 / 5000 = 20%
    assert_eq!(snapshot.bytes_transferred, 1000);
    assert_eq!(snapshot.bytes_expected, 5000);
    assert_eq!(snapshot.overall_percent, 20);
}

#[test]
fn snapshot_100_when_all_completed() {
    let state = state_with_files(vec![
        make_file("/a.txt", 1000, FileAction::Upload, FileStatus::Completed, 1000),
        make_file("/b.txt", 2000, FileAction::Download, FileStatus::Completed, 2000),
    ]);
    let snapshot = build_snapshot(&state);
    assert_eq!(snapshot.overall_percent, 100);
    assert_eq!(snapshot.completed_files, 2);
    assert_eq!(snapshot.total_files, 2);
}

#[test]
fn snapshot_100_when_all_completed_or_failed() {
    let state = state_with_files(vec![
        make_file("/a.txt", 1000, FileAction::Upload, FileStatus::Completed, 1000),
        make_file("/b.txt", 2000, FileAction::Upload, FileStatus::Error, 500),
    ]);
    let snapshot = build_snapshot(&state);
    assert_eq!(snapshot.overall_percent, 100);
    assert_eq!(snapshot.completed_files, 1);
    assert_eq!(snapshot.failed_files, 1);
}

#[test]
fn snapshot_empty_when_no_session() {
    let state = SyncProgressState {
        current_session: None,
        recent_files: Vec::new(),
        last_updated: now_ms(),
    };
    let snapshot = build_snapshot(&state);
    assert!(!snapshot.is_active);
    assert_eq!(snapshot.total_files, 0);
    assert_eq!(snapshot.overall_percent, 0);
    assert!(snapshot.files.is_empty());
}

#[test]
fn snapshot_maps_status_correctly() {
    let state = state_with_files(vec![
        make_file("/pending.txt", 100, FileAction::Upload, FileStatus::Pending, 0),
        make_file("/uploading.txt", 100, FileAction::Upload, FileStatus::Uploading, 50),
        make_file("/downloading.txt", 100, FileAction::Download, FileStatus::Downloading, 50),
        make_file("/deleting.txt", 100, FileAction::LocalDelete, FileStatus::Deleting, 0),
        make_file("/completed.txt", 100, FileAction::Upload, FileStatus::Completed, 100),
        make_file("/error.txt", 100, FileAction::Upload, FileStatus::Error, 0),
    ]);
    let snapshot = build_snapshot(&state);
    // Find each file and check status mapping
    let find = |name: &str| snapshot.files.iter().find(|f| f.file_name == name).unwrap();
    assert_eq!(find("pending.txt").status, FileProgressStatus::Pending);
    assert_eq!(find("uploading.txt").status, FileProgressStatus::InProgress);
    assert_eq!(find("downloading.txt").status, FileProgressStatus::InProgress);
    assert_eq!(find("deleting.txt").status, FileProgressStatus::InProgress);
    assert_eq!(find("completed.txt").status, FileProgressStatus::Completed);
    assert_eq!(find("error.txt").status, FileProgressStatus::Error);
}

#[test]
fn snapshot_encrypted_file_name_detected() {
    let state = state_with_files(vec![
        make_file("file_a7339456c25845c2deadbeef0123", 500, FileAction::Download, FileStatus::Downloading, 100),
    ]);
    let snapshot = build_snapshot(&state);
    assert_eq!(snapshot.files[0].file_name, "Encrypted file");
}
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src-tauri/src/sync_progress.rs
git commit -m "Add unit tests for build_snapshot() sorting and stats"
```

---

### Task 3: Add `sp_get_snapshot` command and `emit_snapshot()` with throttling

**Files:**
- Modify: `src-tauri/src/sync_progress.rs`
- Modify: `src-tauri/src/main.rs`

**Step 1: Add emit infrastructure to `sync_progress.rs`**

Add a global `AppHandle` store and the emit function. Add these after the existing `SYNC_PROGRESS` static:

```rust
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// Global app handle for emitting events. Set once during app setup.
static SYNC_APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

/// Last time a snapshot was emitted (for byte-update throttling).
static LAST_EMIT_TIME: Lazy<Mutex<Instant>> = Lazy::new(|| Mutex::new(Instant::now()));

/// Whether a delayed emit is already scheduled.
static EMIT_SCHEDULED: Lazy<std::sync::atomic::AtomicBool> =
    Lazy::new(|| std::sync::atomic::AtomicBool::new(false));

const EMIT_THROTTLE_MS: u64 = 250;

/// Store the app handle for later event emission.
/// Call this once during app setup (from main.rs).
pub fn set_app_handle(app: AppHandle) {
    if let Ok(mut handle) = SYNC_APP_HANDLE.lock() {
        *handle = Some(app);
    }
}

/// Emit a snapshot event to the frontend.
///
/// - `immediate`: if true, bypasses throttle (use for status transitions like
///   file completed, error, session start/stop).
/// - If false (byte-progress updates), throttles to one emit per 250ms.
///   Schedules a delayed flush if an update arrives within the throttle window.
pub fn emit_snapshot(immediate: bool) {
    let state = SYNC_PROGRESS.lock().unwrap_or_else(|p| {
        warn!("Poisoned mutex in emit_snapshot");
        p.into_inner()
    });
    let snapshot = build_snapshot(&state);
    let app = SYNC_APP_HANDLE.lock().ok().and_then(|g| g.clone());
    drop(state); // Release lock before emitting

    let Some(app) = app else { return };

    if immediate {
        if let Ok(mut t) = LAST_EMIT_TIME.lock() {
            *t = Instant::now();
        }
        let _ = app.emit("sync_progress_snapshot", &snapshot);
        return;
    }

    // Throttled path: check if enough time has elapsed
    let should_emit = LAST_EMIT_TIME
        .lock()
        .ok()
        .map_or(true, |t| t.elapsed().as_millis() >= EMIT_THROTTLE_MS as u128);

    if should_emit {
        if let Ok(mut t) = LAST_EMIT_TIME.lock() {
            *t = Instant::now();
        }
        let _ = app.emit("sync_progress_snapshot", &snapshot);
    } else if !EMIT_SCHEDULED.swap(true, Ordering::AcqRel) {
        // Schedule a delayed emit to flush the pending update
        let app_clone = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(EMIT_THROTTLE_MS)).await;
            EMIT_SCHEDULED.store(false, Ordering::Release);
            let state = SYNC_PROGRESS.lock().unwrap_or_else(|p| {
                warn!("Poisoned mutex in delayed emit");
                p.into_inner()
            });
            let snapshot = build_snapshot(&state);
            drop(state);
            if let Ok(mut t) = LAST_EMIT_TIME.lock() {
                *t = Instant::now();
            }
            let _ = app_clone.emit("sync_progress_snapshot", &snapshot);
        });
    }
}
```

**Step 2: Add `sp_get_snapshot` Tauri command**

Add this after the existing Tauri commands:

```rust
#[tauri::command]
pub fn sp_get_snapshot() -> Result<SyncSnapshot, String> {
    let state = SYNC_PROGRESS.lock().unwrap_or_else(|poisoned| {
        warn!("Poisoned mutex recovered in sp_get_snapshot");
        poisoned.into_inner()
    });
    Ok(build_snapshot(&state))
}
```

**Step 3: Wire `emit_snapshot()` into existing mutation commands**

Add `emit_snapshot(true)` at the end of these commands (before `Ok(...)`):
- `sp_start_session` — after `state.current_session = Some(session);`
- `sp_merge_into_session` — after `state.last_updated = now;`
- `sp_complete_session` — after `state.last_updated = now;`
- `sp_stop_session` — after `state.last_updated = now_ms();`
- `sp_complete_pending_files` — after `state.last_updated = now;`
- `sp_mark_pending_files_as_failed` — after `state.last_updated = now;`
- `sp_mark_all_pending_files_as_failed` — after `state.last_updated = now;`
- `sp_mark_file_error` — after `state.last_updated = now;`
- `sp_remove_files_for_label` — after `state.last_updated = now;`
- `sp_clear_all_data` — after `state.last_updated = now_ms();`

Add `emit_snapshot(false)` (throttled) to:
- `sp_update_file_progress` — after `state.last_updated = now;`

**Important:** Drop the mutex lock before calling `emit_snapshot()`. Change the pattern from:
```rust
state.last_updated = now;
Ok(result)
```
to:
```rust
state.last_updated = now;
drop(state);
emit_snapshot(true); // or false for byte updates
Ok(result)
```

**Step 4: Register `sp_get_snapshot` in `main.rs`**

In `src-tauri/src/main.rs`:
- Add `sp_get_snapshot` to the import from `sync_progress` (line ~36)
- Add `sp_get_snapshot` to the `generate_handler![]` list (after `sp_should_hide_file`, line ~394)

**Step 5: Call `set_app_handle()` during app setup in `main.rs`**

Find the `.setup()` callback in `main.rs` and add:
```rust
crate::sync_progress::set_app_handle(app.handle().clone());
```

Run: `cd src-tauri && cargo build`
Expected: Compiles without errors

**Step 6: Run tests**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src-tauri/src/sync_progress.rs src-tauri/src/main.rs
git commit -m "Add sp_get_snapshot command and push-based emit_snapshot()"
```

---

### Task 4: Add TypeScript types and `snapshotAtom`

**Files:**
- Create: `app/lib/types/syncSnapshot.ts`

**Step 1: Create the type file**

```typescript
export type FileAction = "upload" | "download" | "local_delete" | "remote_delete";
export type FileProgressStatus = "pending" | "inProgress" | "completed" | "error";

export interface FileProgress {
  path: string;
  fileName: string;
  label: string;
  action: FileAction;
  status: FileProgressStatus;
  progressPercent: number;
  bytesTransferred: number;
  totalBytes: number;
  error?: string;
}

export interface SyncSnapshot {
  isActive: boolean;
  overallPercent: number;
  bytesTransferred: number;
  bytesExpected: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  files: FileProgress[];
}

export const EMPTY_SNAPSHOT: SyncSnapshot = {
  isActive: false,
  overallPercent: 0,
  bytesTransferred: 0,
  bytesExpected: 0,
  totalFiles: 0,
  completedFiles: 0,
  failedFiles: 0,
  files: [],
};
```

**Step 2: Commit**

```bash
git add app/lib/types/syncSnapshot.ts
git commit -m "Add SyncSnapshot TypeScript types"
```

---

### Task 5: Add `snapshotAtom` and `useSyncSnapshotListener` hook

**Files:**
- Create: `app/lib/hooks/useSyncSnapshot.ts`

**Step 1: Create the hook**

```typescript
"use client";

import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "../types/syncSnapshot";

export const snapshotAtom = atom<SyncSnapshot>(EMPTY_SNAPSHOT);

/**
 * Listens for push-based sync progress snapshots from the Rust backend.
 *
 * Mount this once at the app root. The Rust side emits "sync_progress_snapshot"
 * events whenever state changes (throttled to 250ms for byte updates, immediate
 * for status transitions). No polling needed.
 */
export function useSyncSnapshotListener() {
  const setSnapshot = useSetAtom(snapshotAtom);

  useEffect(() => {
    let cancelled = false;

    invoke<SyncSnapshot>("sp_get_snapshot")
      .then((snapshot) => {
        if (!cancelled) setSnapshot(snapshot);
      })
      .catch((err) => {
        console.error("[SyncSnapshot] Failed to get initial snapshot:", err);
      });

    let unsubFn: (() => void) | null = null;

    listen<SyncSnapshot>("sync_progress_snapshot", (e) => {
      if (!cancelled) setSnapshot(e.payload);
    })
      .then((unsub) => {
        if (cancelled) {
          unsub();
        } else {
          unsubFn = unsub;
        }
      })
      .catch((err) => {
        console.error("[SyncSnapshot] Failed to listen:", err);
      });

    return () => {
      cancelled = true;
      unsubFn?.();
    };
  }, [setSnapshot]);
}

/**
 * Read-only hook to access the current sync snapshot.
 */
export function useSyncSnapshot(): SyncSnapshot {
  return useAtomValue(snapshotAtom);
}
```

**Step 2: Commit**

```bash
git add app/lib/hooks/useSyncSnapshot.ts
git commit -m "Add useSyncSnapshotListener hook with push-based atom"
```

---

### Task 6: Mount the snapshot listener at app root

**Files:**
- Modify: `app/(pages)/SyncStatusHandler.tsx` — add `useSyncSnapshotListener()` call

**Step 1: Find the component that mounts `useSyncEvents`**

The `useSyncEvents` hook is called somewhere at the app root. Find it and mount `useSyncSnapshotListener` alongside it. Check `app/(pages)/layout.tsx` or similar.

Run: `grep -rn "useSyncEvents" app/ --include="*.tsx" --include="*.ts" | head -10`

Mount `useSyncSnapshotListener()` in the same component that calls `useSyncEvents()`. Add the import and the hook call — they run in parallel, no conflicts.

```typescript
import { useSyncSnapshotListener } from "../lib/hooks/useSyncSnapshot";
// ... inside the component:
useSyncSnapshotListener();
```

**Step 2: Verify the app compiles**

Run: `pnpm build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add app/
git commit -m "Mount useSyncSnapshotListener at app root"
```

---

### Task 7: Refactor `SyncStatusDialog` to accept `SyncSnapshot`

**Files:**
- Modify: `app/(pages)/SyncStatusDialog.tsx`
- Modify: `app/(pages)/SyncStatusHandler.tsx`

**Step 1: Update `SyncStatusDialog` props**

Replace the current `SyncStatusDialogProps` interface with:

```typescript
import { type SyncSnapshot, type FileProgress, type FileProgressStatus } from "../lib/types/syncSnapshot";
import { type SyncActionCounts } from "../lib/store/syncAtoms";

interface SyncStatusDialogProps {
  snapshot: SyncSnapshot;
  open: boolean;
  onClose?: () => void;
  actionCounts?: SyncActionCounts;
}
```

**Step 2: Rewrite the component body**

Replace the `calculatedMetrics` computed value and file rendering with direct reads from `snapshot`:

- `snapshot.overallPercent` replaces `percentage`
- `snapshot.totalFiles` replaces `totalFiles`
- `snapshot.completedFiles` replaces `syncedFiles`
- `snapshot.failedFiles` replaces `propFilesFailed`
- `snapshot.isActive` replaces `isInProgress`
- `snapshot.bytesTransferred` replaces `totalBytesTransferred`
- `snapshot.bytesExpected` replaces `totalBytesExpected`
- `snapshot.files` replaces `syncFiles` — iterate directly, no type conversion
- `file.status === "completed"` replaces `file.status === "uploaded"`
- `file.status === "inProgress"` replaces `file.status === "uploading"`
- `file.status === "error"` replaces `file.status === "failed"`
- `file.progressPercent` replaces `(file as any).progress`
- `file.bytesTransferred` replaces `(file as any).bytesTransferred`
- `file.totalBytes` replaces `(file as any).totalBytes`

Add `data-testid="file-item"` to each file's container div for testing.

Remove imports of `SyncActivityRow`, the `syncFileToActivityRow`/`recentFileToActivityRow` conversion functions are no longer needed (they live in `SyncStatusHandler` but are not used by the dialog).

**Step 3: Update `SyncStatusHandler` to pass `snapshot`**

In `SyncStatusHandler.tsx`:

```typescript
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";

// Inside the component:
const snapshot = useSyncSnapshot();

// Replace the <SyncStatusDialog> render:
<SyncStatusDialog
  snapshot={snapshot}
  open={!isLoading && isSyncOpen}
  onClose={handleClose}
  actionCounts={syncActionCounts}
/>
```

Remove the `displayFiles` and `syncMetrics` useMemo blocks. Replace references to their values with `snapshot` fields:
- `syncMetrics.isInProgress` → `snapshot.isActive`
- `syncMetrics.syncPercent` → `snapshot.overallPercent`
- `syncMetrics.totalFiles` → `snapshot.totalFiles`
- `syncMetrics.isCompleted` → `!snapshot.isActive && snapshot.completedFiles > 0`
- `filesFailed` → `snapshot.failedFiles`
- `displayFiles.length` → `snapshot.files.length`

Keep `isSyncingFromEvents`, `hasSyncError`, `overallProgress` atom reads for now — they're still used by the open/close logic. Those get removed in Phase 3.

**Step 4: Verify the app compiles**

Run: `pnpm build`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add app/(pages)/SyncStatusDialog.tsx app/(pages)/SyncStatusHandler.tsx
git commit -m "Refactor SyncStatusDialog to render from SyncSnapshot"
```

---

### Task 8: Simplify `useSyncEvents` — remove polling

**Files:**
- Modify: `app/lib/hooks/useSyncEvents.ts`

**Step 1: Remove `refreshProgressState` and related imports**

Remove these from the hook:
- The `refreshProgressState` callback function
- The `throttledRefreshProgressState` callback + `refreshTimerRef` + `refreshPendingRef`
- All 6 atom setters: `setSessionFilesAtom`, `setRecentFilesAtom`, `setTrayMenuFilesAtom`, `setOverallProgressAtom`, `setHasSyncActivityAtom`, `setLastProgressUpdateAtom`
- The imports from `useSyncProgress` and `syncProgressService` for query functions: `getCurrentSessionFiles`, `getRecentFiles`, `getTrayMenuFiles`, `getOverallProgress`, `hasAnySyncActivity`
- The `cleanupIntervalRef` and its `setInterval` (cleanup is no longer needed — no retention system)
- Remove all `await refreshProgressState()` calls and `throttledRefreshProgressState()` calls

**Step 2: Remove query-function calls from event handlers**

In each event handler, remove the `await refreshProgressState()` / `throttledRefreshProgressState()` calls. The Rust backend now emits snapshots automatically via `emit_snapshot()` when its state changes.

In `hcfs_upload_progress` and `hcfs_download_progress` handlers:
- Keep `ensureSession()` and `updateFileProgress()` calls (these mutate Rust state, which triggers `emit_snapshot` automatically)
- Remove `throttledRefreshProgressState()`

In `hcfs_sync_started` / `hcfs_sync_plan_ready`:
- Keep `startSession()` / `mergeIntoSession()` calls
- Remove `await refreshProgressState()`

In `hcfs_sync_completed`:
- Keep `completeSession()`, `completePendingFiles()`, `markPendingFilesAsFailed()` calls
- Remove `await refreshProgressState()` (both places)

In `hcfs_sync_error`:
- Keep `markAllPendingFilesAsFailed()` call
- Remove `await refreshProgressState()`

In `hcfs_sync_stopped` / `hcfs_sync_reset`:
- Keep `stopSession()` / `sp_clear_all_data` calls
- Remove `await refreshProgressState()`

**Step 3: Clean up the cleanup function**

In the `return () => { ... }` cleanup:
- Remove `refreshTimerRef` cleanup
- Remove `cleanupIntervalRef` cleanup
- Keep `completionTimerRef` cleanup and event listener unsubs

**Step 4: Verify the app compiles**

Run: `pnpm build`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add app/lib/hooks/useSyncEvents.ts
git commit -m "Remove IPC polling from useSyncEvents, rely on push snapshots"
```

---

### Task 9: Remove `useSyncProgress.ts` and dead atoms

**Files:**
- Delete: `app/lib/hooks/useSyncProgress.ts`
- Modify: `app/lib/store/syncAtoms.ts`
- Modify: All files that import from `useSyncProgress.ts`

**Step 1: Find all imports of `useSyncProgress`**

Run: `grep -rn "useSyncProgress" app/ --include="*.ts" --include="*.tsx"`

Update each importing file:
- `SyncStatusHandler.tsx`: Remove imports of `sessionFilesAtom`, `recentFilesAtom`, `overallProgressAtom`, `hasSyncActivityAtom`. These are now replaced by `snapshotAtom`.
- `useSyncEvents.ts`: Remove imports of the 6 atoms from `useSyncProgress`. Remove the setter calls.
- `useTraySync.ts`: Replace `overallProgressAtom` / `hasSyncActivityAtom` with `snapshotAtom` from `useSyncSnapshot.ts`. Update tray menu logic to read from snapshot.

**Step 2: Delete `useSyncProgress.ts`**

**Step 3: Remove dead atoms from `syncAtoms.ts`**

Remove these atoms if no longer imported anywhere:
- `syncStatusAtom`
- `currentSyncFileAtom`
- `completedFilePathsAtom`

Keep these (still used by tray and other components):
- `isSyncingAtom`, `hasSyncErrorAtom`, `syncPercentAtom`
- `uploadProgressAtom`, `downloadProgressAtom`
- `completedFilesCountAtom`, `totalFilesToSyncAtom`
- `syncActionCountsAtom`, `syncEngineHealthAtom`

**Step 4: Verify no broken imports**

Run: `pnpm build`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add -A
git commit -m "Remove useSyncProgress.ts, replace with snapshot atom"
```

---

### Task 10: Remove deprecated Rust commands

**Files:**
- Modify: `src-tauri/src/sync_progress.rs`
- Modify: `src-tauri/src/main.rs`

**Step 1: Verify no frontend code calls the deprecated commands**

Run: `grep -rn "sp_get_session_files\|sp_get_recent_files\|sp_get_tray_menu_files\|sp_get_overall_progress\|sp_has_any_sync_activity\|sp_cleanup_expired_files\|sp_record_deleted_file\|sp_is_encrypted_file_id\|sp_should_hide_file" app/ --include="*.ts" --include="*.tsx"`

If any hits remain, update those call sites first.

**Step 2: Remove deprecated Tauri commands from `sync_progress.rs`**

Remove these functions:
- `sp_get_session_files`
- `sp_get_recent_files`
- `sp_get_tray_menu_files`
- `sp_get_overall_progress`
- `sp_has_any_sync_activity`
- `sp_cleanup_expired_files`
- `sp_record_deleted_file`
- `sp_is_encrypted_file_id`
- `sp_should_hide_file`

Also remove the `RecentFile` struct, the `clean_expired` function, `move_completed_to_recent`, and the `RECENT_FILES_RETENTION_MS` / `TRAY_MENU_MAX_FILES` constants — all part of the retention system we're removing.

Keep these (still called by frontend mutation path):
- `sp_start_session`, `sp_merge_into_session`, `sp_complete_session`, `sp_stop_session`
- `sp_update_file_progress`
- `sp_complete_pending_files`, `sp_mark_pending_files_as_failed`, `sp_mark_all_pending_files_as_failed`, `sp_mark_file_error`
- `sp_remove_files_for_label`, `sp_clear_all_data`
- `sp_get_snapshot`

**Step 3: Remove from `main.rs` handler list**

Remove the deprecated commands from both the `use` import and the `generate_handler![]` macro.

**Step 4: Remove `syncProgressService.ts` query functions**

In `app/lib/services/syncProgressService.ts`, remove:
- `getCurrentSessionFiles`
- `getRecentFiles`
- `getTrayMenuFiles`
- `getOverallProgress`
- `hasAnySyncActivity`
- `cleanupExpiredFiles`
- `recordDeletedFile`
- `isEncryptedFileId`
- `shouldHideFile`

Also remove the old type definitions (`SyncFile`, `SyncSession`, `RecentFile`, `SyncProgressState`, `OverallProgress`) — they're replaced by `syncSnapshot.ts` types.

Keep: `startSession`, `mergeIntoSession`, `completeSession`, `stopSession`, `updateFileProgress`, `completePendingFiles`, `markPendingFilesAsFailed`, `markAllPendingFilesAsFailed`, `markFileError`, `clearAllData`.

**Step 5: Build both sides**

Run: `cd src-tauri && cargo build && cd .. && pnpm build`
Expected: Both compile without errors

**Step 6: Run Rust tests**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "Remove deprecated query commands and old type system"
```

---

### Task 11: Clean up `SyncStatusHandler.tsx` — remove legacy metric logic

**Files:**
- Modify: `app/(pages)/SyncStatusHandler.tsx`

**Step 1: Simplify the component**

The component should now be thin:
- Read `snapshot` from `useSyncSnapshot()`
- Read `isSyncingFromEvents` from `isSyncingAtom` (for open/close logic)
- Read `hasSyncError` from `hasSyncErrorAtom` (for keeping widget visible on error)
- Read `syncActionCounts` from `syncActionCountsAtom` (for upload/download text)
- No more `displayFiles` merge, no more `syncMetrics` priority chain

Remove:
- All imports from `syncProgressService` (types are now from `syncSnapshot.ts`)
- `sessionFilesAtom`, `recentFilesAtom`, `overallProgressAtom`, `hasSyncActivityAtom` imports
- `syncFileToActivityRow`, `recentFileToActivityRow`, `getFileTypeFromName` functions
- The `displayFiles` useMemo block
- The `syncMetrics` useMemo block

Replace the open/close logic to use snapshot fields:
- `hasFilesToDisplay` → `snapshot.files.length > 0 || snapshot.completedFiles > 0`
- `isInProgress` → `snapshot.isActive`
- `isCompleted` → `!snapshot.isActive && (snapshot.completedFiles > 0 || snapshot.failedFiles > 0)`

**Step 2: Verify the app compiles**

Run: `pnpm build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add app/(pages)/SyncStatusHandler.tsx
git commit -m "Simplify SyncStatusHandler to use snapshot directly"
```

---

### Task 12: Update tray menu to use snapshot

**Files:**
- Modify: `app/lib/hooks/useTraySync.ts`

**Step 1: Replace tray progress data source**

Replace imports of `overallProgressAtom` and `hasSyncActivityAtom` from `useSyncProgress` with `snapshotAtom` from `useSyncSnapshot`:

```typescript
import { snapshotAtom } from "./useSyncSnapshot";
```

Where the tray menu reads overall progress, replace with snapshot fields. Where it calls `getOverallProgress()` or `getRecentFiles()`, use the snapshot atom value instead.

**Step 2: Verify the app compiles**

Run: `pnpm build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add app/lib/hooks/useTraySync.ts
git commit -m "Update tray menu to read from snapshot atom"
```

---

### Task 13: Remove old types from Rust `sync_progress.rs`

**Files:**
- Modify: `src-tauri/src/sync_progress.rs`

**Step 1: Check what old types are still needed**

The existing `SyncFile`, `SyncSession`, `SyncProgressState`, `SessionFileList`, `OverallProgress` types are still used by the mutation commands (`sp_start_session`, `sp_update_file_progress`, etc.) which store state internally. These are internal to the module — they don't need to be public or serializable if they're not returned to the frontend anymore.

- `OverallProgress` struct: Remove entirely (replaced by `SyncSnapshot`)
- `RecentFile` struct: Remove if not already removed in Task 10
- `SyncProgressState.recent_files` field: Remove
- `clean_expired`, `move_completed_to_recent`: Remove if not already removed

Keep `SyncFile`, `SyncSession`, `SyncProgressState`, `SessionFileList`, `FileStatus`, `FileAction` — they're the internal storage format. The mutation commands still use them. `build_snapshot()` maps from these to the public `FileProgress`/`SyncSnapshot` types.

**Step 2: Remove old tests that test removed functions**

Any tests that reference `sp_get_overall_progress`, `sp_get_session_files`, `sp_get_recent_files`, etc. should be removed or rewritten to use `build_snapshot()`.

**Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src-tauri/src/sync_progress.rs
git commit -m "Remove old OverallProgress/RecentFile types, clean up internals"
```

---

### Task 14: Add frontend component tests

**Files:**
- Create: `vitest.config.ts` (project root)
- Create: `app/(pages)/__tests__/SyncStatusDialog.test.tsx`

**Step 1: Create vitest config**

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "app/components"),
      "@/lib": path.resolve(__dirname, "app/lib"),
      "@/services": path.resolve(__dirname, "app/lib/services"),
      "@/app": path.resolve(__dirname, "app"),
    },
  },
});
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

Install dev dependencies if missing:
```bash
pnpm add -D @testing-library/react @testing-library/jest-dom @vitejs/plugin-react jsdom
```

**Step 2: Create test helper**

Create `app/lib/test-utils/syncSnapshotFactory.ts`:

```typescript
import {
  type SyncSnapshot,
  type FileProgress,
  type FileAction,
  type FileProgressStatus,
  EMPTY_SNAPSHOT,
} from "../types/syncSnapshot";

export function makeFileProgress(
  fileName: string,
  overrides: Partial<FileProgress> = {}
): FileProgress {
  return {
    path: `/${fileName}`,
    fileName,
    label: "default",
    action: "upload" as FileAction,
    status: "pending" as FileProgressStatus,
    progressPercent: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    ...overrides,
  };
}

export function makeSnapshot(
  files: FileProgress[],
  overrides: Partial<SyncSnapshot> = {}
): SyncSnapshot {
  const completedFiles = files.filter((f) => f.status === "completed").length;
  const failedFiles = files.filter((f) => f.status === "error").length;
  const bytesTransferred = files.reduce((sum, f) => sum + f.bytesTransferred, 0);
  const bytesExpected = files.reduce((sum, f) => sum + f.totalBytes, 0);
  const overallPercent =
    files.length === 0
      ? 0
      : completedFiles + failedFiles === files.length
        ? 100
        : bytesExpected > 0
          ? Math.round((bytesTransferred / bytesExpected) * 100)
          : 0;

  return {
    isActive: files.some((f) => f.status === "pending" || f.status === "inProgress"),
    overallPercent,
    bytesTransferred,
    bytesExpected,
    totalFiles: files.length,
    completedFiles,
    failedFiles,
    files,
    ...overrides,
  };
}
```

**Step 3: Write component tests**

Create `app/(pages)/__tests__/SyncStatusDialog.test.tsx`:

```typescript
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider } from "jotai";
import SyncStatusDialog from "../SyncStatusDialog";
import { makeSnapshot, makeFileProgress } from "../../lib/test-utils/syncSnapshotFactory";

// Mock Tauri APIs that SyncStatusDialog might import transitively
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

function renderDialog(props: Partial<React.ComponentProps<typeof SyncStatusDialog>> = {}) {
  const defaultSnapshot = makeSnapshot([]);
  return render(
    <Provider>
      <SyncStatusDialog
        snapshot={defaultSnapshot}
        open={true}
        onClose={vi.fn()}
        {...props}
      />
    </Provider>
  );
}

describe("SyncStatusDialog", () => {
  test("renders nothing when snapshot has no files and not active", () => {
    renderDialog({ snapshot: makeSnapshot([]) });
    expect(screen.queryByTestId("file-item")).not.toBeInTheDocument();
  });

  test("renders files in snapshot order (pre-sorted by Rust)", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("big.zip", { totalBytes: 50000, status: "inProgress", progressPercent: 30, bytesTransferred: 15000 }),
      makeFileProgress("medium.pdf", { totalBytes: 5000, status: "pending" }),
      makeFileProgress("small.txt", { totalBytes: 100, status: "pending" }),
    ]);
    renderDialog({ snapshot });
    const items = screen.getAllByTestId("file-item");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("big.zip");
    expect(items[1]).toHaveTextContent("medium.pdf");
    expect(items[2]).toHaveTextContent("small.txt");
  });

  test("shows overall progress percentage", () => {
    const snapshot = makeSnapshot(
      [
        makeFileProgress("a.txt", { totalBytes: 1000, bytesTransferred: 500, status: "inProgress", progressPercent: 50 }),
      ],
      { overallPercent: 50, isActive: true }
    );
    renderDialog({ snapshot });
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  test("shows completed state for finished files", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("done.txt", { totalBytes: 1000, bytesTransferred: 1000, status: "completed", progressPercent: 100 }),
    ]);
    renderDialog({ snapshot });
    expect(screen.getByText("Synced")).toBeInTheDocument();
  });

  test("shows error state for failed files", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("fail.txt", { totalBytes: 1000, status: "error", error: "Network timeout" }),
    ]);
    renderDialog({ snapshot });
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  test("shows per-file progress bar for in-progress files", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("uploading.txt", {
        totalBytes: 1000,
        bytesTransferred: 750,
        status: "inProgress",
        progressPercent: 75,
      }),
    ]);
    renderDialog({ snapshot });
    expect(screen.getByText("75%")).toBeInTheDocument();
  });
});
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: All tests PASS (some tests may need adjustment based on the actual component rendering — the dialog starts collapsed, so you may need to simulate expanding it first)

**Step 5: Commit**

```bash
git add vitest.config.ts app/lib/test-utils/ app/(pages)/__tests__/ package.json pnpm-lock.yaml
git commit -m "Add frontend component tests for SyncStatusDialog"
```

---

### Task 15: Final verification

**Step 1: Run all Rust tests**

Run: `cd src-tauri && cargo test --lib sync_progress`
Expected: All tests PASS

**Step 2: Run all frontend tests**

Run: `pnpm test`
Expected: All tests PASS

**Step 3: Run linters**

Run: `cd src-tauri && cargo clippy --all -- -D warnings && cargo fmt --check`
Run: `pnpm lint`
Expected: No warnings or errors

**Step 4: Build the full app**

Run: `pnpm build && cd src-tauri && cargo build`
Expected: Both compile without errors

**Step 5: Commit any fixups**

```bash
git add -A
git commit -m "Final cleanup: fix lint warnings and verify build"
```
