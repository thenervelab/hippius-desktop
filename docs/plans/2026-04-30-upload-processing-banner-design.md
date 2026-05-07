# Upload Processing Banner

**Date:** 2026-04-30
**Status:** Design approved, ready for implementation

## Problem

When a user uploads a large folder, two phases run before the bottom-right
sync widget shows useful per-file progress:

1. **Disk copy** — `add_folder` blocks on `copy_dir_recursive` for the full
   folder before the IPC call returns.
2. **Encryption / staging** — hcfs-client encrypts every staged file before
   the first upload byte goes over the wire.

For large folders this can be tens of seconds. During that window the
collapsed bottom-right widget shows at most "Syncing 0%", and the
"Preparing sync…" detail is buried inside the expanded body. Users have
no clear, in-flow signal that the system actually saw their click and
is working.

## Decision

Add a top-of-page banner — visually consistent with the existing
`MigrationBanner` and `ConflictsBanner` — that appears the moment a
user-initiated upload begins and disappears when the first byte of
upload progress is reported.

### Decisions made during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Surface | Top-of-page banner in the sticky toolbar | Matches existing pattern (`MigrationBanner`); user is already looking at the toolbar after clicking Upload. |
| Trigger scope | Explicit user-initiated uploads only (`add_file`, `add_files`, `add_folder`) | File-watcher activity already has the bottom-right widget; surprising the user with a top banner for changes they didn't initiate is noisy. |
| Dismiss timing | First `hcfs_upload_progress` event with `bytes_transferred > 0` after the upload's start time | Maps cleanly to "we're processing" → "bytes are flying". Bottom-right widget takes over with real progress at exactly that moment. |
| Concurrency | Single aggregated banner across all in-flight uploads | The banner is a coarse "we're working" signal, not per-drive detail. Aggregating keeps the toolbar clean. |
| Content | Spinner + file count: *"Processing N files. Sync will start shortly…"* | Confirms to the user that the system registered every file. Cheap to compute. |
| Cancellation | None for v1 | Disk copy is fast, encryption is short, partial-state cleanup isn't worth it. |

## Architecture

```
┌────────────────────┐         ┌──────────────────────┐
│ User clicks Upload │ ──IPC──▶│  add_file/add_files/ │
└────────────────────┘         │      add_folder      │
                               └──────────┬───────────┘
                                          │ before disk copy
                                          ▼
                          ┌──────────────────────────────┐
                          │ UploadProcessingState        │
                          │   (in AppState, Arc<Mutex>)  │
                          │   pending_files: u64         │
                          │   started_at: Option<Instant>│
                          └──────────────┬───────────────┘
                                          │ emit
                                          ▼
                          event: hcfs_upload_processing
                          payload: { active, pendingFiles }
                                          │
                                          ▼
                            ┌──────────────────────────┐
                            │ Frontend: Jotai atom     │
                            │ uploadProcessingAtom     │
                            └────────────┬─────────────┘
                                         │
                                         ▼
                              <UploadProcessingBanner />
                              mounted in ResponsiveContent
                              alongside MigrationBanner
```

### Source of truth

Per the repo's MUST-DO rule, all state and lifecycle decisions live in
Rust (`src-tauri/`). The frontend is a dumb mirror — it owns no
upload-processing logic, only renders what Rust emits.

### Lifecycle

1. `add_file` / `add_files` / `add_folder` IPC hits. After the credit
   eligibility check (which can reject), Rust counts the files,
   increments `pending_files`, sets `started_at = Some(now())` if it was
   `None`, and emits `hcfs_upload_processing` with
   `{ active: true, pending_files }`.
2. Banner renders top-of-page with spinner + count.
3. Inside `TauriSyncBridge::on_event`, the first upload-direction file
   progress event with `bytes_transferred > 0` whose timestamp is at or
   after `started_at` calls `clear_if_after(now)` — zeroing the state
   and emitting `{ active: false, pending_files: 0 }`.
4. Banner unmounts. The bottom-right widget continues showing real
   per-file progress.

## Rust backend

### New module: `src-tauri/src/sync/upload_processing.rs`

```rust
pub struct UploadProcessingState {
    inner: Mutex<UploadProcessingInner>,
}

struct UploadProcessingInner {
    pending_files: u64,
    started_at: Option<Instant>,
}
```

`AppState` gains `pub upload_processing: Arc<UploadProcessingState>`.

### Public API

- **`begin(app: &AppHandle, count: u64)`** — adds `count` to
  `pending_files`, sets `started_at` to `Some(Instant::now())` only if
  currently `None` (so concurrent uploads don't reset the start time),
  emits `hcfs_upload_processing` with `{ active: true, pending_files }`.
- **`clear_if_after(app: &AppHandle, event_at: Instant)`** — if
  `started_at.is_some()` and `event_at >= started_at`, zero
  `pending_files`, set `started_at = None`, emit
  `{ active: false, pending_files: 0 }`. Otherwise no-op. Idempotent.
- **`reset(app: &AppHandle)`** — unconditional clear, used by logout /
  account switch.

The `clear_if_after` guard is the load-bearing invariant: file-watcher
activity that fires before any user upload sees `started_at = None` and
becomes a no-op, so it can never accidentally hide a banner that
shouldn't be hidden.

### Wiring

| Site | Change |
|---|---|
| `add_file` (`sync/files.rs`) | After eligibility check, before `tokio::fs::copy`: `state.upload_processing.begin(&app, 1)`. On any error path: `clear_if_after(now)`. |
| `add_files` (`sync/files.rs`) | After eligibility check, before the per-file loop: `begin(&app, requests.len() as u64)`. On unrecoverable error: `clear_if_after(now)`. |
| `add_folder` (`sync/files.rs`) | After eligibility check, before `copy_dir_recursive`: pre-walk `source` to count regular files, then `begin(&app, count)`. On any error path: `clear_if_after(now)`. |
| `TauriSyncBridge::on_event` (`sync/tauri_bridge.rs`) | On the first upload-direction file progress with `bytes_transferred > 0`: `clear_if_after(now)`. Also on `SyncCompleted` and any non-cancel `SyncError`: `clear_if_after(now)`. |
| `stop_sync` (`sync/lifecycle.rs`) | `state.upload_processing.reset(&app)` so a stale banner doesn't survive logout / account switch. |
| Watchdog (in `begin`) | Spawn `tokio::time::sleep(60s)` task that calls `clear_if_after(started_at + 60s)`. Self-heals if a non-obvious code path skips the normal clear. |

### New event constant

`src-tauri/src/sync/events.rs`:
```rust
pub const UPLOAD_PROCESSING: &str = "hcfs_upload_processing";
```

### Folder file-count walk

`add_folder` walks the source tree once to count regular files. Cost is
bounded by what we're about to copy anyway (single pass over directory
entries, no read of file contents). Cheap relative to the copy itself.

## Frontend

### New atom: `app/lib/global-atoms/uploadProcessingAtoms.ts`

```ts
export interface UploadProcessingState {
  active: boolean;
  pendingFiles: number;
}

export const uploadProcessingAtom = atom<UploadProcessingState>({
  active: false,
  pendingFiles: 0,
});
```

No business logic — pure mirror of the Rust event payload.

### New listener hook: `app/lib/hooks/useUploadProcessing.ts`

Mounted in `SyncEventLogger` alongside the existing backend listeners.
Listens to `hcfs_upload_processing` and writes the payload directly into
`uploadProcessingAtom`.

### New component: `app/components/ui/UploadProcessingBanner.tsx`

Modeled on `MigrationBanner.tsx` for visual consistency:

- Reads `uploadProcessingAtom`. Returns `null` when `!active`.
- Layout: spinning `Loader` icon (primary-50) + label.
- Copy: *"Processing N files. Sync will start shortly…"*
  (singular "file" when N === 1, fallback "your files" when N === 0).
- No progress bar, no close button.

### Mount point

`app/(pages)/ResponsiveContent.tsx`, inside the sticky toolbar div,
between `ConflictsBanner` and `MigrationBanner`. Same place, same
styling, same lifetime — visually a sibling indicator that's mounted
once and visible across all routes.

### Listener registration

Add `hcfs_upload_processing` to the existing `useSyncEvents`
registration list rather than creating a parallel listener machine, so
cleanup and re-registration follow the established pattern.

## Edge cases

| Case | Handling |
|---|---|
| Disk copy fails after `begin` | Every error path in `add_file` / `add_files` / `add_folder` calls `clear_if_after(now)`. |
| Sync session ends before any upload-progress fires | `TauriSyncBridge::on_event` calls `clear_if_after(now)` on `SyncCompleted` and non-cancel `SyncError`. |
| Logout / `stop_sync` | Explicit `upload_processing.reset(app)` in the logout teardown path. |
| App restart mid-encryption | State is in-memory only. Banner stays hidden on restart; bottom-right widget picks up from snapshot. Acceptable — this is a preparing indicator, not an audit log. |
| Tiny single-file upload | Banner flashes for ~50ms. Acceptable for v1; min-display-time is YAGNI. |
| File-watcher activity only | Never calls `begin`. `started_at = None`. `clear_if_after` is no-op. Banner never appears. |
| Concurrent uploads | Second `begin` adds to `pending_files`, leaves `started_at` unchanged. First upload-progress event clears the lot. Matches aggregated semantic. |
| Watchdog | 60s sleep task per `begin`. Self-heals if a non-obvious code path skips the normal clear. |

## Tests

### Rust

`src-tauri/tests/upload_processing_lifecycle.rs`:
- `begin` followed by `clear_if_after(now)` clears state.
- `clear_if_after` with an `Instant` earlier than `started_at` is a no-op.
- Two concurrent `begin` calls accumulate counts; one clear zeros all.
- `clear_if_after` when `started_at = None` is a no-op (file-watcher safety).
- `reset` unconditionally clears.

Extend `src-tauri/tests/file_commands.rs`:
- `add_files` emits `hcfs_upload_processing { active: true }`.
- An error path in `add_files` emits `{ active: false }` before returning.

### Frontend

`app/(pages)/__tests__/UploadProcessingBanner.test.tsx`:
- Returns `null` when `active: false`.
- Renders count + spinner when `active: true`.
- Pluralization correct at 1 vs 0/N.

## Files

### New

- `src-tauri/src/sync/upload_processing.rs`
- `src-tauri/tests/upload_processing_lifecycle.rs`
- `app/lib/global-atoms/uploadProcessingAtoms.ts`
- `app/lib/hooks/useUploadProcessing.ts`
- `app/components/ui/UploadProcessingBanner.tsx`
- `app/(pages)/__tests__/UploadProcessingBanner.test.tsx`

### Modified

- `src-tauri/src/app_state.rs` (hold the new state)
- `src-tauri/src/sync/files.rs` (`add_file`, `add_files`, `add_folder`)
- `src-tauri/src/sync/lifecycle.rs` (`stop_sync` reset)
- `src-tauri/src/sync/tauri_bridge.rs` (decrement signals)
- `src-tauri/src/sync/events.rs` (new event constant)
- `src-tauri/src/sync/mod.rs` (export new module)
- `src-tauri/tests/file_commands.rs` (assert event emission)
- `app/(pages)/SyncEventLogger.tsx` (mount the new listener)
- `app/(pages)/ResponsiveContent.tsx` (mount the banner)

## Non-goals

- No frontend cancel button.
- No frontend timeout fallback — Rust owns the watchdog; if it ever
  fails to clear, that's a Rust bug, not something the FE papers over.
- No per-drive granularity in the banner — that's the bottom-right
  widget's job.
- No pre-emptive show on button click; the banner appears after the
  eligibility check passes, so an ineligible user never sees a flash.
