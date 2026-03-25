# Per-Drive Locks: Eliminating Sync Engine Lock Contention

**Date:** 2026-03-25
**Status:** Approved
**Scope:** hippius-desktop + hcfs-client

## Problem

In `hcfs_drive.rs:1142`, the `drives: TokioMutex<HashMap<String, HcfsDriveManager>>` lock is acquired and held for the entire duration of `sync_with_resolutions()` (10 seconds to 10+ minutes). This blocks:

- **All IPC commands** (`is_drive_active`, `stage_changes`, `list_sync_folder`) hang waiting
- **Other drives can't sync** — sequential round-robin means one slow drive blocks all others
- **Stop commands** must wait for sync to finish before acquiring the lock

**Root cause:** `sync_with_resolver(&mut self)` in hcfs-client requires a mutable borrow. Since all drives live in a single HashMap behind one TokioMutex, locking the map to get `&mut Drive` locks every drive.

## Solution: Per-Drive Locks + Cancellation Tokens

### 1. Per-Drive Locks (hippius-desktop)

Replace the single drives mutex with per-drive locks:

```rust
// BEFORE
pub drives: TokioMutex<HashMap<String, HcfsDriveManager>>,

// AFTER — new wrapper struct
pub struct DriveSlot {
    pub manager: Arc<TokioMutex<HcfsDriveManager>>,
    pub cancel_token: CancellationToken,
}

pub drives: TokioMutex<HashMap<String, DriveSlot>>,
```

The outer HashMap lock is held only for microseconds to clone an Arc. Each drive gets its own TokioMutex. Multiple drives sync concurrently.

**Lock acquisition pattern:**
```rust
// Clone Arc from map (microsecond outer lock)
let drive_arc = {
    let guard = sync.drives.lock().await;
    guard.get(label).map(|slot| slot.manager.clone())
};
// Lock per-drive only
if let Some(drive_arc) = drive_arc {
    let mut drive = drive_arc.lock().await;
    drive.sync_with_resolutions(...).await;
}
```

### 2. Multi-Drive Parallelism (hippius-desktop)

Change the sync loop from sequential to concurrent:

```rust
// BEFORE — sequential
for label in labels {
    trigger_sync_for_drive(&sync, &app, &label).await;
}

// AFTER — parallel
let handles: Vec<_> = labels.iter().map(|label| {
    let sync = sync.clone();
    let app = app.clone();
    let label = label.clone();
    tokio::spawn(async move {
        trigger_sync_for_drive(&sync, &app, &label).await;
    })
}).collect();
futures::future::join_all(handles).await;
```

Change `sync_in_progress: AtomicBool` to `AtomicU32` counter. Increment on sync start, decrement on finish. File watcher suppresses when counter > 0.

### 3. Cancellation via CancellationToken (hcfs-client)

Add a new method to `Drive`:

```rust
pub async fn sync_with_resolver_cancellable<F>(
    &mut self,
    mode: SyncMode,
    conflict_resolver: F,
    cancel_token: CancellationToken,
) -> SyncResult<SyncOutcome>
```

Inside `execute_sync_plan`, wrap each upload/download:
```rust
tokio::select! {
    result = upload_file(...) => result,
    _ = cancel_token.cancelled() => Err(SyncError::Cancelled),
}
```

Add `SyncError::Cancelled` variant for clean cancellation handling.

**Stop commands become instant:** `stop_drive(label)` grabs the DriveSlot from the map (microsecond lock), calls `cancel_token.cancel()`. The sync loop detects cancellation within milliseconds.

### 4. IPC Responsiveness (hippius-desktop)

Read-only IPC commands use `try_lock()` with fallback:

| Command | During Sync Behavior |
|---------|---------------------|
| `is_drive_active` | `try_lock` + assume active if locked |
| `get_sync_status` | Already instant (uses `states` StdMutex) |
| `stage_changes` | `try_lock` + return "sync in progress" |
| `stop_drive` | Instant via cancel token |
| `list_sync_folder` | `try_lock` + cache fallback (existing pattern) |
| `sync_with_conflict_resolutions` | Waits for per-drive lock (acceptable — user-initiated) |

## Files Changed

### hcfs-client (hcfs repo)

| File | Changes |
|------|---------|
| `hcfs-client/src/drive.rs` | New `sync_with_resolver_cancellable` method |
| `hcfs-client/src/sync.rs` | Add `Cancelled` variant to `SyncError` |
| `hcfs-client/Cargo.toml` | Add `tokio-util` dependency |

### hippius-desktop (this repo)

| File | Changes |
|------|---------|
| `src-tauri/src/sync_engine.rs` | `DriveSlot` struct, new drives type, `AtomicU32` counter |
| `src-tauri/src/hcfs_drive.rs` | Refactor sync loop to parallel, `trigger_sync_for_drive` uses per-drive lock, remove stall-detection `select!` loop |
| `src-tauri/src/commands/syncing.rs` | Update IPC commands for `try_lock` patterns |
| `src-tauri/src/commands/file_commands.rs` | Update `list_sync_folder` lock pattern |

## Migration

No data migration needed. The change is purely in-memory lock structure. The `DriveSlot` wrapper is created when drives are registered (at sync initialization) and dropped when drives are removed.

## Backward Compatibility

- `sync_with_resolver` remains unchanged in hcfs-client (no cancellation)
- `sync_with_resolver_cancellable` is additive
- No frontend API changes — IPC command signatures stay the same
- Existing `synced_paths_cache` fallback pattern is preserved and extended
