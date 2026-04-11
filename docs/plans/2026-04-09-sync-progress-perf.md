# Sync Progress Performance Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 100% CPU usage during bulk file downloads by eliminating snapshot flood, redundant rendering, and duplicate IPC calls.

**Architecture:** Three layers of fixes — (1) Rust: batch file-completion snapshot emits instead of bypassing throttle, (2) Frontend: memoize file items in SyncStatusDialog so unchanged files skip re-rendering, (3) Frontend: replace tray 2s polling with the existing push-based snapshot event and eliminate duplicate `sp_get_snapshot` IPC calls.

**Tech Stack:** Rust (sync engine throttle logic), React/TypeScript (SyncStatusDialog, useTraySync, useFilesNotification), Jotai atoms.

---

## Root Cause Analysis

When many files download concurrently, CPU hits 100% because:

1. **Snapshot flood on file completions** — `should_emit_snapshot()` in `src-tauri/src/sync/logic.rs:53-55` unconditionally returns `true` for file completions (`is_file_complete`), bypassing the 250ms throttle. Each emit acquires a Mutex, clones+sorts the entire file list, serializes to JSON, and pushes through `webview.eval`. With 50+ files completing in bursts, this floods the WebKit main thread.

2. **Full file-list re-render on every snapshot** — `SyncStatusDialog.tsx:574` calls `snapshot.files.map(...)` on every snapshot update with zero memoization. Each file item computes `getFilePartsFromFileName()`, `getFileTypeFromExtension()`, `getFileIcon()` — 3 function calls × N files × 4 Hz = thousands of calls/sec.

3. **Tray poller stacks on push events** — `useTraySync.ts:755` polls `sp_get_snapshot` via IPC every 2 seconds, duplicating work the push-based `sync_progress_snapshot` event already does. Each call = Mutex lock + full clone + sort + serialize + IPC roundtrip.

4. **Notification handler duplicates snapshot fetch** — `useFilesNotification.ts:88` calls `sp_get_snapshot` again on `hcfs_sync_completed`, yet the same data is already in the Jotai `snapshotAtom`.

---

## Task 1: Batch file-completion snapshot emits (Rust)

**Files:**
- Modify: `src-tauri/src/sync/logic.rs:53-55` (should_emit_snapshot)
- Modify: `src-tauri/src/sync/logic.rs:78-91` (try_claim_snapshot_emit)
- Modify: `src-tauri/src/sync/logic.rs:113+` (tests)
- Modify: `src-tauri/src/sync/progress.rs:73-89` (update_file_progress)

**Problem:** `should_emit_snapshot` returns `true` unconditionally when `is_file_complete == true`. With N files completing in a burst, N full snapshots are serialized and sent within milliseconds.

**Fix:** Instead of bypassing the throttle entirely for completions, use a shorter completion-specific throttle window (100ms). This batches burst completions while still being responsive (10 Hz vs 4 Hz for regular ticks).

**Step 1: Update `should_emit_snapshot` in `logic.rs`**

Change the pure function to use a completion throttle window instead of unconditional bypass:

```rust
/// min_completion_ms: shorter throttle for file completions (0 = bypass).
pub const fn should_emit_snapshot(
    elapsed_since_last_ms: u64,
    is_file_complete: bool,
    min_interval_ms: u64,
) -> bool {
    if is_file_complete {
        // Use a shorter window for completions (100ms) to batch bursts
        // while still being responsive. The 250ms regular window is too
        // long — users notice per-file completion lag.
        elapsed_since_last_ms >= 100
    } else {
        elapsed_since_last_ms >= min_interval_ms
    }
}
```

**Step 2: Update tests**

The `completion_always_bypasses_throttle` test must change — completions now use a 100ms window, not unconditional bypass:

```rust
#[test]
fn completion_uses_shorter_throttle() {
    // 0ms elapsed — within 100ms completion window → block
    assert!(!should_emit_snapshot(0, true, 250));
    // 50ms elapsed — still within window → block
    assert!(!should_emit_snapshot(50, true, 250));
    // 100ms elapsed — at boundary → allow
    assert!(should_emit_snapshot(100, true, 250));
    // 200ms elapsed — past window → allow
    assert!(should_emit_snapshot(200, true, 250));
}
```

**Step 3: Run tests**

```bash
cd src-tauri && cargo test sync::logic::tests -- --nocapture
```

**Step 4: Commit**

```bash
git add src-tauri/src/sync/logic.rs
git commit -m "perf: batch file-completion snapshot emits with 100ms throttle window"
```

---

## Task 2: Memoize file items in SyncStatusDialog (Frontend)

**Files:**
- Modify: `app/(pages)/SyncStatusDialog.tsx:574+`

**Problem:** Every snapshot update (4 Hz) re-renders the entire file list. Each file runs `getFilePartsFromFileName`, `getFileTypeFromExtension`, `getFileIcon` — all pure functions that return the same result for the same input. With 100 files, that's 1,200 function calls/sec for no visual change.

**Fix:** Extract the file item into a `React.memo` component. The memo comparison checks only the fields that affect rendering: `status`, `progressPercent`, `bytesTransferred`, `bytesEncrypted`, `action`, `fileName`, `error`. When a snapshot update arrives, only files whose progress actually changed re-render.

**Step 1: Extract `SyncFileItem` as a memoized component**

Add above the `SyncStatusDialog` component in the same file:

```tsx
interface SyncFileItemProps {
  file: FileProgress;
  isSingleFile: boolean;
  effectiveInProgress: boolean;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
}

const SyncFileItem = React.memo<SyncFileItemProps>(function SyncFileItem({
  file,
  isSingleFile,
  effectiveInProgress,
  speedBytesPerSec,
  etaSeconds,
}) {
  const isFileCompleted = file.status === "completed";
  const isFileDeleted = isFileCompleted && (file.action === "local_delete" || file.action === "remote_delete");
  const isEncryptingOrDecrypting = file.status === "encrypting" || file.status === "decrypting";
  const isFileInProgress = file.status === "inProgress" || isEncryptingOrDecrypting;
  const isFailed = file.status === "error";
  const { fileFormat } = getFilePartsFromFileName(file.fileName);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const { icon: Icon, color } = getFileIcon(fileType ? fileType : undefined, false);

  return (
    // ... existing JSX from the current inline render ...
  );
}, (prev, next) => {
  // Skip re-render when the visible fields haven't changed
  const pf = prev.file;
  const nf = next.file;
  return (
    pf.status === nf.status &&
    pf.progressPercent === nf.progressPercent &&
    pf.bytesTransferred === nf.bytesTransferred &&
    pf.bytesEncrypted === nf.bytesEncrypted &&
    pf.action === nf.action &&
    pf.fileName === nf.fileName &&
    pf.totalBytes === nf.totalBytes &&
    pf.error === nf.error &&
    prev.isSingleFile === next.isSingleFile &&
    prev.effectiveInProgress === next.effectiveInProgress &&
    prev.speedBytesPerSec === next.speedBytesPerSec &&
    prev.etaSeconds === next.etaSeconds
  );
});
```

**Step 2: Replace the inline `.map` body with the memoized component**

```tsx
{snapshot.files.map((file) => (
  <SyncFileItem
    key={file.path}
    file={file}
    isSingleFile={isSingleFile}
    effectiveInProgress={effectiveInProgress}
    speedBytesPerSec={speedBytesPerSec}
    etaSeconds={etaSeconds}
  />
))}
```

Note: use `file.path` as key instead of `${file.path}-${index}` — stable keys are required for memo to work.

**Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add app/(pages)/SyncStatusDialog.tsx
git commit -m "perf: memoize SyncStatusDialog file items to skip unchanged re-renders"
```

---

## Task 3: Replace tray polling with push-based snapshot (Frontend)

**Files:**
- Modify: `app/lib/hooks/useTraySync.ts:718-999` (startSyncActivityWatcher)

**Problem:** `startSyncActivityWatcher` polls `sp_get_snapshot` via IPC every 2 seconds. Each call acquires the progress Mutex in Rust, builds a full snapshot (clone + sort of all files), serializes to JSON, sends over IPC, deserializes in JS. This happens on top of the 4 Hz push events the `useSyncSnapshotListener` already receives.

**Fix:** Replace the `setInterval` poll with a `listen("sync_progress_snapshot")` event listener. The existing signature-based dedup logic (`lastSyncSummarySignature`) can remain — it just operates on pushed events instead of polled ones.

**Step 1: Replace setInterval with listen**

In `startSyncActivityWatcher`, replace:
```ts
const handle = setInterval(tick, INTERVAL_MS);
```
with:
```ts
listen<SyncSnapshot>("sync_progress_snapshot", (event) => {
  void tick(event.payload);
});
```

And change `tick` to accept an optional `SyncSnapshot` parameter instead of calling `invoke("sp_get_snapshot")`.

**Step 2: Verify TypeScript**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add app/lib/hooks/useTraySync.ts
git commit -m "perf: replace tray 2s polling with push-based sync_progress_snapshot events"
```

---

## Task 4: Eliminate duplicate sp_get_snapshot in useFilesNotification (Frontend)

**Files:**
- Modify: `app/lib/hooks/useFilesNotification.ts:86-102` (captureFileDetails)

**Problem:** On `hcfs_sync_completed`, `captureFileDetails` calls `invoke("sp_get_snapshot")` — another full Mutex lock + clone + sort + serialize + IPC roundtrip for data already available in the Jotai `snapshotAtom`.

**Fix:** Import `snapshotAtom` from `useSyncSnapshot.ts` and read from `appStore.get(snapshotAtom)` instead of making an IPC call.

**Step 1: Replace IPC call with atom read**

```ts
import { snapshotAtom } from "./useSyncSnapshot";
import { appStore } from "@/lib/store/jotaiStore";

const captureFileDetails = () => {
  const snapshot = appStore.get(snapshotAtom);
  const completedFiles: SyncedFileDetail[] = snapshot.files
    .filter((f) => f.status === "completed")
    .map((f) => ({
      fileName: f.fileName,
      totalBytes: f.totalBytes,
      action: f.action,
    }));
  if (completedFiles.length > 0) {
    pendingFilesRef.current.push(...completedFiles);
  }
};
```

**Step 2: Verify TypeScript**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add app/lib/hooks/useFilesNotification.ts
git commit -m "perf: read snapshot from Jotai atom instead of duplicate IPC call"
```

---

## Task 5: Replace started_set Mutex with a lock-free check (Rust)

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:1228-1293` (TransferContext, handle_transfer_progress)

**Problem:** Every chunk of every concurrent transfer locks `started_set: Arc<std::sync::Mutex<HashSet<String>>>` to check if the file's "started" log has been emitted. Under high concurrency, chunk callbacks serialize on this lock.

**Fix:** Since `started_set` is only used to log a one-time "Download started" message per file, replace the `HashSet` with a simpler approach: check if `bytes_transferred == 0` (or `bytes_transferred == resumed_from_bytes` for resumed transfers) to decide if this is the first chunk. This eliminates the Mutex entirely from the hot path.

**Step 1: Remove `started_set` from `TransferContext`**

```rust
struct TransferContext {
    sync: Arc<SyncRunner>,
    app: AppHandle,
    label: Arc<str>,
    direction: TransferDirection,
}
```

**Step 2: Replace lock-based check with byte check in `handle_transfer_progress`**

Replace:
```rust
if let Ok(mut set) = ctx.started_set.lock()
    && set.insert(path_str.to_string())
{
    // log start
}
```

With:
```rust
if bytes == 0 {
    info!("{} started [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
}
```

**Step 3: Update `setup_progress_handlers` to remove `started_set` allocation**

Remove the `upload_started` and `download_started` HashSet allocations.

**Step 4: Run tests**

```bash
cd src-tauri && cargo test && cargo clippy --all -- -D warnings
```

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "perf: remove started_set Mutex from transfer hot path"
```

---

## Expected Impact

| Fix | CPU reduction | Mechanism |
|-----|--------------|-----------|
| Task 1: Batch completions | **HIGH** | 10x fewer snapshot serializations during bursts |
| Task 2: Memoize file items | **HIGH** | O(changed) re-renders instead of O(all) |
| Task 3: Replace tray polling | **MEDIUM** | Eliminates 1 Mutex lock + full serialize every 2s |
| Task 4: Deduplicate notification | **LOW** | Eliminates 1 Mutex lock + full serialize per sync completion |
| Task 5: Remove started_set lock | **MEDIUM** | Eliminates lock contention on every chunk callback |

## Verification

After all tasks, test with a bulk download of 100+ files and confirm:
1. CPU stays well below 100%
2. UI remains responsive during downloads
3. File completion still visually updates within ~100ms
4. Tray menu still updates during sync
5. Notifications still fire after sync completes
