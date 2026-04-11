# Per-File Sync Failure Handling

**Date:** 2026-04-08
**Status:** Approved

## Problem

When an individual file fails to sync (upload or download), the sync engine retries it every 30 seconds indefinitely. There is no per-file failure tracking, no way to skip a specific file, and no user prompt. The user has no visibility into which files are stuck or any mechanism to resolve the situation without stopping sync entirely.

## Design

### Per-File Failure Tracking

A new `HashMap<String, u32>` field `file_failure_counts` on `SyncRunner`, protected by a `Mutex`. The key is `"{label}/{relative_path}"` to distinguish files across drives.

After each sync cycle in `finalize_session_for_label`, when failures are detected (files_uploaded < expected or files_downloaded < expected), the code identifies which files remain in non-terminal status (Pending/Uploading/Downloading/Encrypting/Decrypting). For each of those files, their counter is incremented. Files that succeeded have their counter removed.

When any file's counter reaches **3**, all files at or above threshold are collected and emitted as `SyncEvent::FilesFailedRepeatedly { files: Vec<FailedFileInfo> }` where `FailedFileInfo` contains:

```rust
pub struct FailedFileInfo {
    pub label: String,
    pub path: String,
    pub file_name: String,
    pub error: Option<String>,
    pub failure_count: u32,
}
```

Counter resets:
- User clicks "Retry" (explicit reset via IPC command)
- File succeeds on a subsequent cycle
- App restart (map is in-memory only)

### Session-Skip Mechanism

A new `HashSet<String>` field `skipped_files` on `SyncRunner`, also `Mutex`-protected. Same key format: `"{label}/{relative_path}"`.

During sync plan construction, after the plan is built but before execution, files whose key is in `skipped_files` are filtered out. The file is invisible to the sync engine for the rest of the session. Skipped files are also removed from `file_failure_counts` to prevent re-triggering the modal.

Three IPC commands exposed from hippius-desktop:

- **`sp_skip_file(label, path)`** -- adds to `skipped_files`, removes from `file_failure_counts`, emits snapshot
- **`sp_exclude_file(label, path)`** -- calls existing `add_exclude_pattern` with the exact relative path, also adds to `skipped_files` for immediate effect, emits snapshot
- **`sp_retry_file(label, path)`** -- removes from `skipped_files`, resets counter in `file_failure_counts` to 0, emits snapshot

All three emit a snapshot afterward so the UI updates immediately.

### Event Flow and Modal Trigger

1. `SyncEvent::FilesFailedRepeatedly` emitted from hcfs-client after a cycle where files hit the threshold
2. Tauri bridge maps it to `"hcfs_files_failed_repeatedly"` event with payload:
   ```json
   { "files": [{ "label": "...", "path": "...", "fileName": "...", "error": "...", "failureCount": 3 }] }
   ```
3. A new `FailedFilesListener` component (mounted in layout alongside `SyncEventLogger`, `ConflictEventListener`, etc.) listens for this event
4. The listener stores the failed files in a Jotai atom and sets a `showFailedFilesModal` flag
5. `FailedFilesModal` renders when the flag is true

The modal appears once per batch. If dismissed without acting on all files, those files continue retrying normally (counters are NOT reset). The modal reappears after the next cycle if the same files hit the threshold again.

After the user acts on a file, a toast confirms:
- Retry: "File will retry on next sync cycle"
- Skip: "File skipped for this session"
- Exclude: "File permanently excluded from sync"

### Modal UI

A centered modal dialog using the app's existing `Dialog` component pattern.

**Header:** "Sync Issues" with subtitle: "These files have failed to sync after multiple attempts."

**Body:** Scrollable list of failed files, each row showing:
- File icon (via `getFileIcon`)
- File name (truncated with `MiddleTruncatedName`)
- Drive label badge
- Error message (single line, muted text)
- Three action buttons: "Retry" (ghost), "Skip" (ghost), "Exclude" (ghost, with confirmation tooltip since permanent)

**Footer:** "Dismiss" button that closes without acting on remaining files.

**Sizing:** Max height capped, scrollable after ~8 files. Width ~30rem, matching existing modals.

No batch actions in v1.

### Data Flow Example

```
Cycle 1: file.txt upload fails
  -> file_failure_counts["drive-1/file.txt"] = 1

Cycle 2: file.txt upload fails again
  -> file_failure_counts["drive-1/file.txt"] = 2

Cycle 3: file.txt upload fails again
  -> file_failure_counts["drive-1/file.txt"] = 3 (threshold)
  -> emit SyncEvent::FilesFailedRepeatedly
  -> Tauri bridge -> "hcfs_files_failed_repeatedly" event
  -> frontend shows FailedFilesModal

User clicks "Skip":
  -> invoke("sp_skip_file", { label: "drive-1", path: "file.txt" })
  -> skipped_files.insert("drive-1/file.txt")
  -> file_failure_counts.remove("drive-1/file.txt")
  -> toast: "File skipped for this session"

Cycle 4+: sync plan filters out file.txt
  -> other files sync normally

App restart: skipped_files and file_failure_counts cleared
  -> file.txt retried from scratch
```

## Scope

### In scope
- Per-file failure counter in `SyncRunner` (hcfs-client)
- `SyncEvent::FilesFailedRepeatedly` event variant (hcfs-client)
- Session-skip `HashSet` in `SyncRunner` (hcfs-client)
- Skip filtering in sync plan phase (hcfs-client)
- `sp_skip_file`, `sp_exclude_file`, `sp_retry_file` IPC commands (hippius-desktop)
- Tauri bridge handler for the new event (hippius-desktop)
- `FailedFilesListener` component (hippius-desktop frontend)
- `FailedFilesModal` component (hippius-desktop frontend)
- Toast notifications for user actions (hippius-desktop frontend)

### Out of scope
- Batch actions (select all + skip all)
- Per-file retry within a single sync cycle
- Configurable failure threshold (hardcoded to 3)
- Per-file error messages from `sync_flow.rs` (uses existing error info from progress tracker)

## Testing

- **Rust unit tests:** failure counter increment/reset logic, skip set filtering, threshold detection
- **Rust integration test:** mock a file that fails 3 times, verify `FilesFailedRepeatedly` event is emitted
- **IPC command tests:** `sp_skip_file`/`sp_retry_file`/`sp_exclude_file` modify state correctly and emit snapshots
- **Frontend:** manual testing of modal appearance, button actions, toast messages
