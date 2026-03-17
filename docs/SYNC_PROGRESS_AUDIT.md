# Sync Progress Audit

**Date:** 2026-03-17 (re-verified after pull)
**Branch:** `sync-engine`
**Scope:** Sync progress state management across Rust backend, frontend UI, and system tray

---

## HIGH Severity

### 1. Sync progress not cleared on logout — cross-account data leak

**Files:**
- `app/lib/wallet-auth-context.tsx:182-185`
- `src-tauri/src/sync_progress.rs:946-961`

**Problem:** `wallet-auth-context.tsx` explicitly skips calling `sp_clear_all_data()` on logout. Recent files (names, sizes, timestamps) persist in Rust memory for up to 1 hour. If user A logs out and user B logs in, B sees A's recent sync activity in the tray menu and sync widget.

The `sp_clear_all_data()` command exists but is **never called anywhere** in the codebase.

The comment in `wallet-auth-context.tsx` says this is intentional:
> "We intentionally do NOT clear sync progress data on logout. The data is preserved in the Rust backend so the tray and sync widget show the last-known state immediately after re-login."

**Fix:** Call `sp_clear_all_data()` on logout. The "show last-known state on re-login" benefit does not outweigh the privacy concern.

---

### 2. Stuck at 100% in multi-drive sync

**Files:**
- `app/lib/hooks/useSyncEvents.ts:355-360`
- `app/(pages)/SyncStatusDialog.tsx:77-98`

**Problem:** When Drive A completes, `syncPercentAtom` is set to 100 and `expectedCountsRef` is reset to `{0, 0}`. If Drive B's `hcfs_sync_started` fires immediately after, the UI briefly shows "100% complete" while `isSyncingAtom` is already true again. The tray icon flashes green then back to syncing.

**Fix:** Don't set `syncPercentAtom` to 100 on individual drive completion when other drives are still registered. Or defer the 100% display until all drives have completed their cycle.

---

### 3. In-progress files orphaned when a drive is removed mid-sync

**Files:**
- `src-tauri/src/commands/syncing.rs:1041-1073`
- `src-tauri/src/sync_progress.rs` (session state)

**Problem:** `stop_drive(label)` removes the drive from `HCFS_DRIVES` and clears its per-drive state in `HCFS_SYNC_STATES`, but does **not** remove its files from `SYNC_PROGRESS.current_session`. Files from the removed drive remain stuck as "uploading"/"downloading" forever until the session expires or a new sync overwrites it.

**Fix:** Add a function to remove files associated with a specific drive label from the current session when `stop_drive()` is called. Requires either tagging session files with a label or matching by path prefix.

---

## MEDIUM Severity

### ~~4. Deleted files can still appear in session files list~~ FIXED

Filtered at both Rust backend (encrypted IDs via `should_hide_file()`) and frontend (`SyncStatusHandler.tsx` filters session files against recent delete paths).

---

### 5. Multi-drive expected count accumulation breaks failure detection

**Files:**
- `app/lib/hooks/useSyncEvents.ts:267-268, 300-369`

**Problem:** `expectedCountsRef` accumulates across drives with `+=`, but resets to `{0, 0}` on completion. If Drive A syncs 5 files and Drive B syncs 3, the accumulated expected is 8. When Drive B completes reporting 3 files uploaded, failure detection compares 3 against the accumulated total of 8 and incorrectly flags a failure.

**Fix:** Track expected counts per-drive (keyed by label) rather than using a single accumulator.

---

### ~~6. `hcfs_sync_stopped` doesn't clear session/recent atoms on failure~~ FIXED

`refreshProgressState()` refetches all state from the Rust backend, effectively updating atoms with current values. Not a direct clear, but functionally equivalent.

---

### 7. Tray icon stays green after recent files expire (PARTIALLY FIXED)

**Files:**
- `src-tauri/src/sync_progress.rs:888` (`sp_has_any_sync_activity`)
- `app/lib/hooks/useTraySync.ts:268-372`

**Problem:** `sp_has_any_sync_activity()` returns true if the session has files (`!s.files.is_empty()`), even for an inactive session. Recent files do expire after 1 hour, but if the inactive session object still has files in its HashMap (not moved to recent or not cleared), the icon stays green indefinitely.

**Fix:** Only consider active sessions in `sp_has_any_sync_activity()`, or clear the session object entirely once it's inactive and its files have been moved to recent.

---

### 8. `hcfs_sync_reset` event emitted but never listened to

**Files:**
- `src-tauri/src/commands/syncing.rs:1115-1122`

**Problem:** `reset_sync_data` emits `hcfs_sync_reset`, but the frontend has **no listener** for it. If sync data is reset (e.g., from settings), the UI won't update until the user navigates away and back.

**Fix:** Add a frontend listener for `hcfs_sync_reset` that clears all sync-related atoms and refreshes the file list.

---

## LOW Severity

### 9. Four progress events emitted but never listened to

**Files:**
- `src-tauri/src/commands/syncing.rs:1228-1251`

**Problem:** `hcfs_encrypt_progress`, `hcfs_decrypt_progress`, `hcfs_scan_progress`, `hcfs_fetch_progress` are emitted on every sync cycle but no frontend code listens for them. Wasted CPU/IPC overhead.

**Fix:** Either remove the emissions or add frontend listeners to show encryption/scan progress in the UI.

---

### 10. Duplicate cleanup intervals

**Files:**
- `app/lib/hooks/useSyncProgress.ts:143-157`
- `app/lib/hooks/useSyncEvents.ts:192-201`

**Problem:** Both hooks independently set up 60-second intervals calling `cleanupExpiredFiles()` + `refreshProgressState()`. Double the work, same result.

**Fix:** Consolidate into a single cleanup interval in one hook.

---

### 11. Encrypted file names show as "synced file" when resolution fails

**Files:**
- `src-tauri/src/hcfs_drive.rs:1219-1225`

**Problem:** Download progress callbacks record encrypted names (e.g., `file_a7339456`). After sync, `resolve_encrypted_names()` tries to map them to real names via the path index. If the path index is unavailable, the fallback is the generic string `"synced file"` — which shows in the tray menu and recent files.

**Fix:** Improve resolution reliability, or show a more descriptive fallback (e.g., "1 file downloaded" without a name rather than a fake name).

---

### 12. Inconsistent action capitalization in recent files

**Files:**
- `app/lib/hooks/use-recent-files/index.ts:138-165`

**Problem:** The `type` field maps `"uploaded"` → `"Uploaded"` but leaves `"deleted"` lowercase. Minor UI inconsistency.

**Fix:** Normalize all action strings to title case.

---

### 13. Ad-hoc session creation has no file list

**Files:**
- `app/lib/hooks/useSyncEvents.ts:212-225`

**Problem:** `ensureSession()` creates a session with expected count of 1 but no file list. The session briefly shows "1 file" with no details until a progress event fills in the file metadata.

**Fix:** Accept this as a minor edge case, or delay session display until at least one file has metadata.

---

## Summary

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Cross-account data leak on logout | HIGH | Open |
| 2 | Stuck at 100% during multi-drive sync | HIGH | Open |
| 3 | Orphaned files when drive removed mid-sync | HIGH | Open |
| 4 | ~~Deleted files still visible in session~~ | ~~MEDIUM~~ | **Fixed** |
| 5 | Multi-drive failure detection broken | MEDIUM | Open |
| 6 | ~~Sync stopped doesn't clear atoms on failure~~ | ~~MEDIUM~~ | **Fixed** |
| 7 | Tray icon stays green after expiry | MEDIUM | Partially fixed |
| 8 | `hcfs_sync_reset` event not listened to | MEDIUM | Open |
| 9 | Unused progress events emitted | LOW | Open |
| 10 | Duplicate cleanup intervals | LOW | Open |
| 11 | Encrypted names fallback to "synced file" | LOW | Open |
| 12 | Inconsistent action capitalization | LOW | Open |
| 13 | Ad-hoc session has no file list | LOW | Open |
