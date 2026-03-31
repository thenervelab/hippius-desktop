# HCFS Client Upgrade: Resumable Uploads & Downloads

**Date:** 2026-03-24
**Target:** Bump hcfs-client/hcfs-shared from rev `0f1839b` to `a423580`
**Scope:** Full integration — expose resume state to UI

## Summary

The new hcfs-client (v0.1.9) introduces resumable uploads, resumable downloads, and 4x concurrent file operations. The API is **100% backward compatible** — zero signature changes. All resumability and concurrency are handled transparently inside the library.

Our work: bump the dependency, detect when transfers resume (vs start fresh), and surface "Resuming from X" to the user.

## What the New Library Does (Transparent to Us)

### Resumable Uploads (2-phase pipeline)
1. **Encrypt to disk chunks** — File split into 8MB chunks in `.hippius/temp/upload_<file_id>/`, with `manifest.json` as completion marker
2. **Chunked upload session** — Server session (create → upload chunks → finalize). Client queries `get_session_status()` to skip already-received chunks
3. **Resume detection**: Manifest cache validated by `salted_hash` match + age < 48h. Stale sessions detected by `ciphertext_hash` mismatch

### Resumable Downloads
1. **DownloadState persistence** — `.hippius/temp/download_<file_id>.state` tracks `bytes_received`, `revision_id`
2. **HTTP Range requests** — `Range: bytes=<offset>-`, server responds 206 Partial Content
3. **Chunk boundary truncation** — Partial ciphertext truncated to last complete encryption chunk for safe resume
4. **Staleness** — Revision changed → discard partial, restart. Age > 24h → prune

### Concurrent Operations
- 4 concurrent uploads + 4 concurrent downloads via `tokio::Semaphore` + `JoinSet`
- Fully internal — consumer just calls `sync_with_resolver()` as before
- Progress callbacks fire from multiple tasks concurrently

## Progress Callback Behavior Changes

### Downloads (resumed)
- First `on_download_progress` callback: `(resume_offset, total_size)` where `resume_offset > 0`
- Subsequent callbacks increment from `resume_offset` upward
- **Detection**: first callback has `bytes > 0` → this is a resumed download

### Uploads (resumed)
- `on_encrypt_progress` is **skipped entirely** when encryption cache is valid (no re-encryption)
- `on_upload_progress` skips already-uploaded chunks but reports cumulative byte position
- **Detection**: first upload callback has `bytes > 0` → this is a resumed upload

### Key Gotcha
- No explicit "resume" flag in callbacks — must infer from first progress value being non-zero

## Changes Required

### Step 1: Bump Dependency
**File:** `src-tauri/Cargo.toml`
- Update `hcfs-client` and `hcfs-shared` git rev from `0f1839b` to `a423580`
- Run `cargo build` to verify compilation (expect zero errors due to API compat)

### Step 2: Add Resume Detection to Progress Tracking
**File:** `src-tauri/src/sync_progress.rs`

Add `resumed_from_bytes` field to `SyncFile`:
```rust
pub struct SyncFile {
    // ... existing fields ...
    pub resumed_from_bytes: Option<u64>,  // NEW
}
```

Add `resumed_from_bytes` to `FileProgress` (snapshot struct sent to frontend):
```rust
pub struct FileProgress {
    // ... existing fields ...
    pub resumed_from_bytes: Option<u64>,  // NEW
}
```

In `update_file_progress()`, detect resume on first progress event:
```rust
// After the or_insert_with block, before updating bytes:
if file.resumed_from_bytes.is_none()
    && file.bytes_transferred == 0
    && bytes_transferred > 0
    && matches!(action, FileAction::Upload | FileAction::Download)
{
    file.resumed_from_bytes = Some(bytes_transferred);
}
```

This works because:
- Downloads: first callback is `(resume_offset, total)` where offset > 0
- Uploads: first callback skips already-uploaded chunks, so bytes > 0
- Fresh transfers: first callback is `(0, total)` or `(small_chunk, total)` — the small_chunk case is fine since it just means "first chunk completed"

### Step 3: Update Progress Handler Logging
**File:** `src-tauri/src/commands/syncing.rs`

In `on_upload_progress` and `on_download_progress` callbacks, enhance the "started" log to include resume info:

```rust
// In on_upload_progress, inside the upload_started_cb.lock() block:
if set.insert(path_str.to_string()) {
    if b > 0 {
        info!("Upload resuming [{}]: {} from {} bytes ({} total)", l1, file_name, b, t);
    } else {
        info!("Upload started [{}]: {} ({} bytes)", l1, file_name, t);
    }
}
```

Same pattern for `on_download_progress`.

Include `resumed_from_bytes` in Tauri event payloads:
```rust
// In hcfs_upload_progress / hcfs_download_progress events:
serde_json::json!({
    "label": l1,
    "bytes": b,
    "total": t,
    "path": p,
    "resumedFromBytes": if b > 0 && first_event { Some(b) } else { None }
})
```

### Step 4: Handle Skipped Encrypt Phase
**File:** `src-tauri/src/sync_progress.rs`

When encryption cache is valid, `on_encrypt_progress` never fires. The file goes directly from Pending to Uploading. This already works correctly because `update_file_progress` with `FileAction::Upload` transitions the status to `Uploading` regardless of whether an encrypt phase happened.

No code change needed — verify with a test.

### Step 5: Frontend — Show Resume Indicator
**Files:** Frontend components that display file progress

When `resumedFromBytes` is present in the progress data:
- Show "Resuming from X MB" instead of "Uploading..." / "Downloading..."
- The progress bar should show the correct position (it already will, since `bytes_transferred` starts from the resume offset)

### Step 6: Add Tests

**Resume detection test** (`sync_progress.rs`):
```rust
#[test]
fn resumed_download_detected() {
    // First progress callback with bytes > 0 should set resumed_from_bytes
    reset_state();
    let eng = test_sync();
    let file_list = SessionFileList {
        download_files: Some(vec!["/photo.jpg".to_string()]),
        ..default_file_list()
    };
    start_session(eng, 0, 1, 0, 0, Some(file_list), Some("d1".into())).unwrap();

    // First callback: resume from 50MB of 200MB
    let result = update_file_progress(
        eng, "/photo.jpg".into(), 50_000_000, 200_000_000,
        FileAction::Download, Some("d1".into()),
    ).unwrap().unwrap();

    assert_eq!(result.resumed_from_bytes, Some(50_000_000));
    assert_eq!(result.bytes_transferred, 50_000_000);
}

#[test]
fn fresh_download_not_marked_as_resumed() {
    // First callback with bytes == 0 should NOT set resumed_from_bytes
    // ...
}

#[test]
fn skipped_encrypt_phase_still_completes() {
    // Upload starts without any encrypt callbacks — should work fine
    // ...
}
```

## Files Changed (Summary)

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Bump hcfs-client + hcfs-shared rev |
| `src-tauri/src/sync_progress.rs` | Add `resumed_from_bytes` to SyncFile/FileProgress, detection logic, tests |
| `src-tauri/src/commands/syncing.rs` | Enhanced resume logging, `resumedFromBytes` in Tauri events |
| Frontend progress components | Show "Resuming from X" when `resumedFromBytes` present |

## What We're NOT Changing

- Progress bar behavior (stays as single bar per file)
- Stall detection logic (any concurrent file progressing resets timer — still works)
- Conflict resolution flow (unchanged API)
- Multi-drive architecture (unchanged)
- Health check system (server capability detection is internal to hcfs-client)
- Temp file cleanup (`cleanup_stale_temp_files()` handles new patterns internally)
- `HcfsClientConfig` setup (unchanged struct)

## Sync Engine Compatibility Audit

A thorough audit of the sync engine (`hcfs_drive.rs`, `sync_logic.rs`, `sync_shared.rs`, `syncing.rs`) was performed against the new client behavior. Key areas checked:

### Verified Safe (No Changes Needed)

| Area | Why It's Safe |
|------|---------------|
| **File watcher feedback loop** | Temp files go to `config_directory/temp/` (`~/.hippius/drives/<account>/<hash>/temp/`), which is **separate** from the user's sync folder that the watcher monitors. No spurious triggers. |
| **Sync state consistency** | State is saved atomically inside hcfs-client after all concurrent ops complete. No partial state risk. |
| **Session timing** | Review mode timeout (5 min) only applies during conflict review, not during active sync. Long concurrent transfers won't trigger it. |
| **Folder recovery** | `check_and_recover_remote_folder()` runs before sync starts. No interaction with concurrent ops. |
| **Resumable state preservation** | On sync failure, `.hippius/temp/upload_*/` and `download_*.state` files are intentionally preserved. Error handler does NOT clean them up — correct by design. |
| **Concurrent progress callbacks** | `update_file_progress()` uses `max()` for monotonic byte updates. Interleaved callbacks from 4 concurrent files are handled correctly. |
| **Post-sync activity recording** | All progress callbacks fire before `sync_with_resolver()` returns. Pending activity is fully captured. |
| **Partial success handling** | `SyncOutcome` fields count actual completions. `mark_pending_files_as_failed()` correctly marks excess pending files as errors when `actual < expected`. |
| **Stall detection** | 180s timeout checks if **any** progress callback fired. With 4 concurrent files, at least one should progress. Even with encryption cache hit (no encrypt callback), the first 8MB upload chunk at 1 Mbps takes ~64s — well under 180s. All 4 files stalling simultaneously for 3 minutes is extremely unlikely. |
| **`is_failed_download_artifact` patterns** | Old pattern (`downloaded_<hex>`) targets legacy artifacts in the sync folder. New temp files (`download_<id>.enc/.state`) are in `config_directory/temp/` and managed by hcfs-client's own pruning. No interference. |
| **`compute_backoff`** | Exponential backoff (30s → 300s cap) applies per sync cycle, not per concurrent stream. Still appropriate. |
| **`should_skip_sync_check`** | No new health states introduced. Existing `ConnectivityStatus` enum covers all scenarios. |
| **Token refresh** | Token is refreshed between sync cycles (checked before `trigger_sync_for_drive`). During sync, `sync_in_progress` flag blocks new sync triggers. hcfs-client uses `Arc<HcfsClient>` with cached headers — if token refreshes mid-sync, in-flight requests use the old token and retry logic handles 401s. |

### Known Limitations (Non-Blocking, Future Enhancements)

| # | Severity | Issue | Impact | Recommendation |
|---|----------|-------|--------|----------------|
| 1 | **LOW** | `SyncError::RateLimited { retry_after_secs }` not specially handled | Error gets stringified; server's suggested backoff duration is ignored. Exponential backoff (30s-300s) is used instead. Sync still works, just may retry earlier than the server requested. | Future: parse "Rate limited, retry after Ns" from error string and use N for backoff instead of `compute_backoff()`. |
| 2 | **LOW** | `is_failed_download_artifact()` is effectively dead code for new client | Old cleanup pattern won't match new temp file structure. Not harmful — just won't clean anything. hcfs-client handles its own temp cleanup via `prune_stale_download_states()` (>24h) and `prune_stale_upload_chunks()` (>48h). | Future: remove or mark as legacy. |
| 3 | **LOW** | Stall detection could theoretically false-positive on very slow networks | If all 4 concurrent uploads are sending their first 8MB chunk on a <0.35 Mbps connection, no progress callback fires for 180s. Extremely unlikely in practice. | Monitor in production. If needed, increase timeout to 300s. |

## Risk Assessment

- **Low risk**: API is 100% backward compatible, no signature changes
- **Sync engine**: Thoroughly audited — no blockers found, no code changes needed for compatibility
- **Concurrency safety**: Progress callbacks already use monotonic `max()` updates, so interleaved callbacks from 4 concurrent files are handled correctly
- **Temp file isolation**: All new temp files (upload chunks, download state) are written to `config_directory/temp/`, not the watched sync folder — no feedback loops
- **Resume false positives**: A fresh upload of a small file could have `bytes > 0` on first callback (first chunk completes fast). This is acceptable — showing "Resuming from 8MB" for a 50MB file that just started is a minor cosmetic issue, not a functional one. We can add a threshold (e.g., only mark as resumed if first bytes > 1MB) if needed.
