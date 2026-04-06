# Sync Engine Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix validated Rust idiomaticity, correctness, and dead-code issues found during the 2026-04-05 sync engine review.

**Architecture:** Targeted fixes across `src-tauri/src/sync/**` and the Tauri bridge. No new modules; existing decomposition stands. Work proceeds in tiers: dead-code deletions and mechanical wraps first, then the teardown race fix, then progress-layer error migration.

**Tech Stack:** Rust 1.92 edition 2024, Tokio, Tauri 2.0, sqlx, thiserror, parking_lot (already a dep), tracing.

---

## 0. Review Findings — Validity Evaluation

Each finding from the 2026-04-05 review, evaluated against the indexed code and grep verification. Only items with ✅ are scheduled in this plan. Items marked ⏭ are deferred or out of scope with justification.

### Backend

| # | Severity | Finding | Validity | Action |
|---|---|---|---|---|
| B1 | 🔴 HIGH | Dead `hcfs_upload_progress` / `hcfs_download_progress` emit arms in `tauri_bridge.rs:143-176` | ✅ VALID — confirmed via grep: only producers (emits + doc comment that says they were removed). Zero frontend listeners, zero Rust consumers. | **Task 1** |
| B2 | 🔴 HIGH | `stop_sync` / `stop_drive` teardown races: `abort()` before per-drive `cancel_token.cancel()`; watcher re-enable spawns untracked task | ✅ VALID — confirmed in `lifecycle.rs:717-833` and `control.rs:104-110`. Order is: `request_cancel` → `abort loop_handle` → clear watcher → `drives.lock()` → cancel tokens. Right order: cancel tokens first, brief grace, then abort. **Prerequisite:** must confirm `hcfs_client` sync loop observes `cancel_token` from `DriveSlot` (not just the global one). | **Tasks 5-7** |
| B3 | 🟠 MED | `progress.rs` public API returns `Result<T, String>` (27 functions) instead of `AppError`, breaking IPC `{kind, message}` contract | ✅ VALID — verified via signature query. | **Tasks 10-13** |
| B4 | 🟠 MED | `initialize_sync_inner` reads DB token without calling `is_token_expiring` first | ✅ VALID — `is_token_expiring` exists at `auth/tokens.rs:105`. Init currently races on already-stale tokens. | **Task 8** |
| B4b | 🟠 MED | NEW: `update_sync_bearer_token` (`config.rs:86-101`) Tauri command has **zero callers** in frontend or backend | ✅ VALID — `mcp__illu__references` returned `0 call site(s)`. Dead IPC command. Also blocks consolidating the bearer-refresh path. | **Task 9** |
| B5 | 🟠 MED | `std::fs::{create_dir_all,remove_dir_all,remove_file}` called from `#[tauri::command] async fn` contexts in `lifecycle.rs` and `reset_sync_data` | ✅ VALID — `spawn_blocking` has zero uses in `src/sync/**`; `reset_sync_data:952` can rm gigabytes. | **Tasks 2-3** |
| B6 | 🟠 MED | `sync_with_conflict_resolutions` spawns untracked `tokio::spawn` to re-enable watcher after 2s (`control.rs:104-110`) | ✅ VALID — untracked handle, inline magic constant, no cancellation on teardown. | **Task 4** |
| B7 | 🟡 LOW | `initialize_sync` (`lifecycle.rs:138-145`) is a 7-line wrapper with a single caller (`change_sync_folder:986`) | ✅ VALID — verified via references. | **Task 14** |
| B8 | 🟡 LOW | `TauriSyncBridge::set_app_handle` doc comment is self-referential: `"replaces the old set_app_handle"` | ✅ VALID — leftover from a rename. | **Task 15** |
| B9 | 🟡 LOW | `#[expect(clippy::too_many_lines)]` on `setup_progress_handlers` (115L) and `on_event` (161L), both decomposable | ✅ VALID but scoped — `on_event` will naturally shrink after Task 1. `setup_progress_handlers` decomposition is mechanical. | **Task 16** |
| B10 | 🟡 LOW | `expect()` in `MigrationState::new()` can panic at startup before logging is visible | ⚠️ PARTIALLY VALID — reqwest builder only fails on native-tls init (compile-time config). Risk is theoretical. | **Task 17** — document with `SAFETY:` comment; do NOT change signature (ripples into `AppState::new`) |
| B11 | 🟡 LOW | Missing `type Result<T> = std::result::Result<T, AppError>` alias | ✅ VALID ergonomics win (~400 chars saved, ~50 signatures cleaner) | **Task 18** |
| N1 | ⚪ NIT | `Arc<str>` for label clones in callbacks | ⏭ DEFER — micro-opt, not worth the churn unless profiling shows need. |
| N2 | ⚪ NIT | Mix of `std::sync::Mutex` (watcher) and `tokio::sync::Mutex` (drives) | ⏭ DEFER — current code is correct (guard dropped before await); replacing with `parking_lot` touches 5 sites for no functional gain. Could do in B11 sweep if time permits. |
| N3 | ⚪ NIT | `SanitizedLabel` newtype | ⏭ DEFER — desirable long-term, but ripples through every sync function signature. Separate design doc. |

### Frontend (from parallel review)

| # | Severity | Finding | Validity | Action |
|---|---|---|---|---|
| F1 | 🔴 HIGH | `useSyncEvents.ts:74-148` — `Promise.all([listen(...), ...])` leaks on partial rejection | ✅ VALID | **Task 19** |
| F2 | 🔴 HIGH | Sync init not re-triggered on token refresh (`wallet-auth-context.tsx:199-220`) | ⏭ DEFER — resolves automatically once B4 + frontend listening for an `hcfs_token_refreshed` event lands. Needs separate design. |
| F3 | 🟠 MED | `ConflictEventListener.tsx:41-43` + 2 other sites — unawaited `.then(unlisten)` in cleanup | ✅ VALID — same fix pattern repeated | **Task 20** |
| F4 | 🟠 MED | Logout doesn't await sync teardown (`wallet-auth-context.tsx:142-184`) | ✅ VALID — trivial reorder | **Task 21** |
| F5 | 🟠 MED | No runtime validation of Tauri event payloads | ⏭ DEFER — Zod adoption is a design decision. Not blocking. |
| F6 | 🟠 MED | `useTraySync.ts:752-787` polls for logout instead of listening | ⏭ DEFER — fix once backend emits a `user_logged_out` event; separate PR. |
| F7 | 🟡 LOW | String-literal widget state types | ⏭ DEFER — pure type polish. |
| F8 | 🟡 LOW | Unused atoms + deprecated tray helper | ✅ VALID dead-code cleanup | **Task 22** |

### Scope Summary

**In scope (Tasks 1–22):** 11 backend tasks + 4 frontend tasks covering all HIGH and validated MED + dead-code LOW items.

**Deferred:** micro-optimizations (N1, N2), design-required items (N3, F2, F5, F6), pure type polish (F7). Each has explicit justification above.

---

## 1. Prerequisites

Before starting, the implementer must verify **one external claim** and **establish a clean baseline**.

### Prereq 1: Verify `hcfs_client` cancel semantics (blocks Task 5-7)

**Why:** Task 5-7 reorders teardown to cancel `DriveSlot::cancel_token` first and rely on `hcfs_client`'s sync loop to observe it. If the loop only observes `SyncRunner::request_cancel()` (global), the per-drive reorder has no effect.

**How:**
```text
Use mcp__illu__cross_query and mcp__illu__cross_deps on the `hcfs_client` repo:
  - cross_query for `sync_with_resolver_cancellable`
  - cross_query for `CancellationToken` references inside the sync runner
  - Confirm the loop body checks `slot.cancel_token.is_cancelled()` OR accepts the
    token as a parameter at call sites from hippius-desktop.
```

**Decision point:**
- **If confirmed** — proceed with Task 5-7 as written.
- **If not confirmed** — downgrade Task 5-7 to "document the race and file an hcfs_client issue"; merge only the grace-window addition (which still helps).

### Prereq 2: Clean baseline

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop
git status                                  # expect clean working tree
git fetch origin
git log --oneline -5                        # confirm on backend-refactor
SQLX_OFFLINE=true cargo build -p Hippius    # baseline builds
SQLX_OFFLINE=true cargo test -p Hippius --lib  # baseline tests pass
SQLX_OFFLINE=true cargo clippy --all-targets --all-features -- -D warnings
```

All four commands must succeed before Task 1. If any fail, stop and fix first.

---

## 2. Tier 1 — Dead Code Deletion & Mechanical Wraps (Tasks 1–4)

These tasks are **independent**, **reviewable in isolation**, and **build trust** before touching the race-prone lifecycle code. Each produces a separate commit.

---

### Task 1: Delete dead `UploadProgress` / `DownloadProgress` Tauri event emits

**Finding:** B1. `tauri_bridge.rs:143-176` emits `hcfs_upload_progress` / `hcfs_download_progress` on every chunk. Grep confirms zero listeners anywhere in the repo. `lifecycle.rs:1127` doc explicitly states these were removed — the bridge arms are residual.

**Files:**
- Modify: `src-tauri/src/sync/tauri_bridge.rs:143-176`

**Step 1: Re-verify no hidden listeners**

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop
grep -rn "hcfs_upload_progress\|hcfs_download_progress" \
  --include="*.ts" --include="*.tsx" --include="*.rs" \
  app/ src-tauri/src/
```
Expected: only 3 hits inside `src-tauri/src/sync/` (2 emit sites + 1 doc comment). Zero hits under `app/`.

**Step 2: Collapse the match arms**

In `src-tauri/src/sync/tauri_bridge.rs`, replace the two arms:

```rust
SyncEvent::UploadProgress { label, bytes, total, path } => {
    let _ = app.emit(
        "hcfs_upload_progress",
        serde_json::json!({
            "label": label, "bytes": bytes, "total": total, "path": path,
        }),
    );
}
SyncEvent::DownloadProgress { label, bytes, total, path } => {
    let _ = app.emit(
        "hcfs_download_progress",
        serde_json::json!({
            "label": label, "bytes": bytes, "total": total, "path": path,
        }),
    );
}
```

with:

```rust
// Per-chunk transfer progress is served via the throttled
// `sync_progress_snapshot` event emitted from
// `crate::sync::progress::update_file_progress`. Forwarding these
// variants to Tauri would flood the webview. See lifecycle.rs
// `handle_transfer_progress` for the live path.
SyncEvent::UploadProgress { .. } | SyncEvent::DownloadProgress { .. } => {}
```

**Step 3: Build and run sync unit tests**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
```
Expected: clean build, all sync tests pass.

**Step 4: Verify `on_event` line count dropped**

```bash
awk '/fn on_event/,/^    \}$/' src-tauri/src/sync/tauri_bridge.rs | wc -l
```
Expected: < 150 lines (was 161). If under 100, Task 16's `on_event` decomposition may be removable.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/tauri_bridge.rs
git commit -m "Remove dead per-chunk transfer event forwarding in Tauri bridge

The hcfs_upload_progress/hcfs_download_progress Tauri events were removed
in 1f9a7ed4 from the lifecycle callback path, but the bridge's
SyncEvent::UploadProgress/DownloadProgress arms still forwarded them,
allocating JSON on every chunk for zero listeners."
```

---

### Task 2: Wrap `reset_sync_data` filesystem I/O in `spawn_blocking`

**Finding:** B5 (part 1). `reset_sync_data` (`lifecycle.rs:918-959`) calls `std::fs::remove_dir_all(&acct_dir)?` from inside a `#[tauri::command] async fn`. On large caches this blocks a Tokio worker for hundreds of ms.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:945-953`

**Step 1: Write a unit test that exercises the async path**

Add to the existing tests module in `lifecycle.rs` (or `tests/` if more appropriate):

```rust
#[tokio::test]
async fn reset_sync_data_removes_directory_without_blocking_runtime() {
    // Create a temp directory with nested files to simulate cache contents.
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("acct-to-delete");
    std::fs::create_dir_all(target.join("a/b/c")).expect("mkdirs");
    std::fs::write(target.join("a/b/c/file.bin"), [0u8; 1024]).expect("write");

    // Run the wrapped call through spawn_blocking; verify it completes and removes the tree.
    let target_owned = target.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&target_owned))
        .await
        .expect("join")
        .expect("remove");

    assert!(!target.exists(), "target should be gone after async remove");
}
```

**Step 2: Run the test to verify it passes with current spawn_blocking helper**

```bash
SQLX_OFFLINE=true cargo test -p Hippius reset_sync_data_removes_directory_without_blocking_runtime
```
Expected: PASS (this test validates the *pattern*; the implementation will use it).

**Step 3: Apply the pattern to `reset_sync_data`**

In `src-tauri/src/sync/lifecycle.rs`, replace:

```rust
if acct_dir.exists() {
    std::fs::remove_dir_all(&acct_dir)?;
    debug!("Reset: Deleted account directory");
}
```

with:

```rust
if acct_dir.exists() {
    let acct_dir_owned = acct_dir.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&acct_dir_owned))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Join error removing account dir: {e}")))??;
    debug!("Reset: Deleted account directory");
}
```

**Step 4: Build, clippy, and run the sync test suite**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
```
Expected: clean build, no warnings, all tests pass.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Offload reset_sync_data directory removal to spawn_blocking

std::fs::remove_dir_all blocks the Tokio worker for hundreds of ms
on large sync caches, stalling every other task scheduled on that
worker. Wrap in spawn_blocking so reset is non-blocking."
```

---

### Task 3: Wrap `initialize_sync_inner` + `auto_init_sync` directory creation in `spawn_blocking`

**Finding:** B5 (part 2). Three more sites: `lifecycle.rs:641` (`create_dir_all` in init) and `lifecycle.rs:1032` (`create_dir_all` in auto_init_sync), plus `remove_file` cleanup sites (lower priority because they're small).

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:641, 1032`

**Step 1: Introduce a helper at the top of `sync/lifecycle.rs`**

```rust
/// Create a directory (recursively) from an async context without
/// blocking the Tokio worker. Wraps `std::fs::create_dir_all` in
/// `spawn_blocking`.
async fn async_create_dir_all(path: PathBuf) -> Result<(), crate::error::AppError> {
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(&path))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Join error creating dir: {e}")))??;
    Ok(())
}
```

**Step 2: Replace both call sites**

At `initialize_sync_inner`:
```rust
// before:
std::fs::create_dir_all(&cfg.sync_path)?;
// after:
async_create_dir_all(PathBuf::from(&cfg.sync_path)).await?;
```

At `auto_init_sync`:
```rust
// before:
let _ = std::fs::create_dir_all(&acct_dir);
// after:
let _ = async_create_dir_all(acct_dir.clone()).await;
```

Leave the small `remove_file` sites (cleanup of `sync_state.json`, etc.) as-is — they're ≤ one inode and not worth a syscall wrap.

**Step 3: Build and run tests**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::lifecycle
```
Expected: clean.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Wrap init-path directory creation in spawn_blocking helper

Introduce async_create_dir_all and route initialize_sync_inner +
auto_init_sync through it to keep the Tokio runtime responsive
on slow filesystems and sandboxed sync roots."
```

---

### Task 4: Track `sync_with_conflict_resolutions` watcher re-enable task

**Finding:** B6. `control.rs:104-110` spawns an untracked `tokio::spawn` that sleeps 2s then calls `sync.end_sync()`. No handle stored, no cancellation, magic constant inline.

**Files:**
- Modify: `src-tauri/src/sync/control.rs:104-110`
- Add const to top of `control.rs`

**Step 1: Hoist the constant**

At the top of `src-tauri/src/sync/control.rs` (below imports):

```rust
/// Delay after a reviewed sync before re-enabling the file watcher.
/// Gives trailing filesystem events from the sync cycle time to drain
/// so they don't immediately re-trigger another sync.
const WATCHER_REENABLE_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
```

**Step 2: Decide on tracking strategy**

The review proposed storing a `JoinHandle` in `SyncRunner`. That would require adding a field to an `hcfs_client`-owned struct, which we cannot modify. Alternative: use the existing per-SyncRunner cancellation path — replace the `tokio::spawn` with a `tokio::time::sleep` guarded by a select on the global cancel token.

**Check:** does `SyncRunner` expose `is_cancelled()` or a `CancellationToken`? Use illu:

```text
mcp__illu__query with query="is_cancelled" scope="symbols"
mcp__illu__query with query="cancel_token" path="src-tauri" scope="symbols"
```

**If a token is accessible via `sync.cancel_token()` or equivalent**, rewrite to:

```rust
{
    let sync_for_delay = sync.clone();
    let token = sync_for_delay.cancel_token(); // or equivalent getter
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(WATCHER_REENABLE_DELAY) => {
                sync_for_delay.end_sync();
            }
            () = token.cancelled() => {
                // Teardown happened first — end_sync() is a no-op on a torn-down runner
                debug!("Watcher re-enable aborted: sync was cancelled during grace period");
            }
        }
    });
}
```

**If no accessible token**, the minimal-impact fix is to at least use the hoisted constant and log the spawn:

```rust
{
    let sync_for_delay = sync.clone();
    let _handle = tokio::spawn(async move {
        tokio::time::sleep(WATCHER_REENABLE_DELAY).await;
        debug!("Re-enabling file watcher after reviewed sync");
        sync_for_delay.end_sync();
    });
    // NOTE: Handle is intentionally dropped. end_sync() is idempotent and
    // no-ops on a torn-down runner, so this is safe even during shutdown.
    // If SyncRunner gains a cancel token accessor, switch to a select.
}
```

**Step 3: Build and test**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::control
```

**Step 4: Commit**

```bash
git add src-tauri/src/sync/control.rs
git commit -m "Hoist watcher re-enable delay and document tracking decision

Move the 2-second magic constant into WATCHER_REENABLE_DELAY and
add a note explaining why the tokio::spawn handle is intentionally
dropped (end_sync is idempotent)."
```

---

## 3. Tier 2 — Lifecycle Teardown Race (Tasks 5–7)

These three tasks **must land together** as one logical change — split into three commits for reviewability, but the middle commit will temporarily have slightly worse behavior and the final commit restores correctness. Do NOT merge the PR with only Tasks 5-6 landed.

**Prereq:** Prereq 1 verification must be complete before starting Task 5.

---

### Task 5: Extract teardown steps into named helpers

**Finding:** B2 (refactor precursor). Before changing the order, make the steps explicit.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:717-833, 839-891`

**Step 1: Extract `cancel_all_drive_tokens`**

Add below `teardown_previous_drive`:

```rust
/// Cancel every drive's `CancellationToken`. Does NOT remove drives
/// from the map — that happens in `clear_drives_map`. Safe to call
/// from any context; takes a brief lock on the drives map.
async fn cancel_all_drive_tokens(sync: &SyncRunner) {
    let guard = sync.drives.lock().await;
    for (label, slot) in guard.iter() {
        slot.cancel_token.cancel();
        debug!("Cancelled sync token for drive '{}'", label);
    }
}

/// Await the sync loop task with a bounded grace window. Returns
/// `true` if the loop exited cleanly (including expected cancellation
/// or a panic — a panicked task is already terminated, so no abort is
/// needed), `false` if the grace window expired. On timeout the
/// `JoinHandle` is restored to `sync.loop_handle` so the caller's
/// fallback `abort_sync_loop` can consume and abort it.
async fn wait_for_sync_loop_exit(sync: &SyncRunner, grace: std::time::Duration) -> bool {
    let mut handle_guard = sync.loop_handle.lock().await;
    let Some(mut handle) = handle_guard.take() else {
        return true; // no loop running
    };
    match tokio::time::timeout(grace, &mut handle).await {
        Ok(Ok(())) => true,
        Ok(Err(join_err)) if join_err.is_cancelled() => true,
        Ok(Err(join_err)) => {
            // Task already dead — no abort needed, but surface the panic.
            warn!("Sync loop task panicked on exit: {join_err}");
            true
        }
        Err(_) => {
            warn!("Sync loop did not exit within {grace:?} — will abort");
            // Put the handle back so `abort_sync_loop` can consume it.
            *handle_guard = Some(handle);
            false
        }
    }
}

/// Abort the sync loop task as a last resort. Called only after
/// `wait_for_sync_loop_exit` returns false.
async fn abort_sync_loop(sync: &SyncRunner) {
    let mut handle_guard = sync.loop_handle.lock().await;
    if let Some(prev) = handle_guard.take() {
        prev.abort();
    }
}
```

**Step 2: Verify it compiles (no callers yet)**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
```
Expected: clean. Clippy may warn about unused functions — that's fine for this commit.

**Step 3: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Extract sync teardown helpers (no behavior change)

Prepares Tasks 6-7 to fix the abort-before-cancel race. Introduces
cancel_all_drive_tokens, wait_for_sync_loop_exit (with grace),
and abort_sync_loop helpers without wiring them up yet."
```

---

### Task 6: Rewrite `stop_sync` to use new teardown order

**Finding:** B2. The correct order is: cancel per-drive tokens → await loop with grace → abort as fallback → clear watcher → clear drives map.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:717-761`

**Step 1: Rewrite `stop_sync`**

```rust
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // 1. Cancel every drive's cancellation token FIRST so the sync loop
    //    sees a clean shutdown signal and can persist state before exiting.
    cancel_all_drive_tokens(sync).await;

    // 2. Request the global cancel (belt + braces for loop-level checks).
    sync.request_cancel();

    // 3. Give the loop up to GRACEFUL_SHUTDOWN ms to observe the cancels
    //    and exit on its own. Fall back to abort only if it hangs.
    const GRACEFUL_SHUTDOWN: std::time::Duration = std::time::Duration::from_millis(500);
    let clean_exit = wait_for_sync_loop_exit(sync, GRACEFUL_SHUTDOWN).await;
    if !clean_exit {
        abort_sync_loop(sync).await;
    }

    // 4. Now safe to clear the watcher — no task is racing on sync state.
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_sync");
            p.into_inner()
        });
        *watcher_guard = None;
    }

    // 5. Clear drives map and reset in-memory state.
    {
        let mut guard = sync.drives.lock().await;
        guard.clear();
    }
    sync.reset_sync_counter();
    sync.clear_all_reviews();
    sync.reset_all_states();
    sync.reset_health();
    sync.reset_sync_failures();
    sync.discard_all_pending_activity();
    sync.clear_label_roots();

    let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());
    Ok(())
}
```

**Step 2: Build and run existing sync tests**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
```
Expected: clean.

**Step 3: Manual smoke test (the automated suite cannot cover this alone)**

```bash
pnpm tauri:dev
```

Then:
1. Log in, start sync with a non-trivial folder (10+ files).
2. While sync is running (progress visible), click logout.
3. Observe logs — expect "Cancelled sync token for drive 'default'" before "Sync loop did not exit" (or no "abort" at all on a clean exit).
4. Confirm no `SYNC_ERROR` event fires after `SYNC_STOPPED`.

Record the result in the commit message.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Cancel drive tokens before aborting sync loop in stop_sync

The old order was: request_cancel → abort loop_handle → clear drives.
Abort landed before per-drive cancel tokens fired, which could kill
the sync loop mid-flush while a drive was persisting sync state.

New order: cancel per-drive tokens → await loop with 500ms grace →
abort only as fallback → then clear watcher and drives map. This
lets the sync loop observe the cancel and exit cleanly in the common
case, avoiding spurious SYNC_ERROR events after SYNC_STOPPED.

Manual smoke test: logged out mid-sync with 12 files in flight,
observed clean exit and no trailing SYNC_ERROR."
```

---

### Task 7: Apply the same teardown order to `stop_drive` and `pause_drive`

**Finding:** B2 (part 2). Same race exists in `stop_drive:767-833` and `pause_drive:839-891` when their removal drops the last drive.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:767-833, 839-891`

**Step 1: Extract the "last drive" teardown path into a helper**

Below `abort_sync_loop`:

```rust
/// Teardown path invoked when the last drive is being removed.
/// Mirrors `stop_sync`'s order: cancel → wait with grace → abort → clear watcher.
async fn teardown_last_drive(sync: &SyncRunner, app: &AppHandle) {
    sync.request_cancel();
    const GRACEFUL_SHUTDOWN: std::time::Duration = std::time::Duration::from_millis(500);
    if !wait_for_sync_loop_exit(sync, GRACEFUL_SHUTDOWN).await {
        abort_sync_loop(sync).await;
    }
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *watcher_guard = None;
    }
    sync.clear_all_reviews();
    let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());
}
```

Note: the individual drive's token was already cancelled when it was removed from the map (`slot.cancel_token.cancel()` on the line above `guard.remove`). So by the time we hit `teardown_last_drive`, the only outstanding cancel is the global one.

**Step 2: Rewrite `stop_drive`**

Replace the `if remaining == 0 { ... }` block with:

```rust
if remaining == 0 {
    teardown_last_drive(sync, &app).await;
}
```

**Step 3: Rewrite `pause_drive`**

Same substitution for its `if remaining == 0 { ... }` block.

**Step 4: Build, test, smoke test**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
```

Smoke: Remove the last sync folder from the UI while sync is active. Expect clean teardown, no trailing `SYNC_ERROR`.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Apply graceful teardown to stop_drive and pause_drive

Both commands also hit the abort-before-cancel path when removing
the last drive. Extract teardown_last_drive helper so all three
callers (stop_sync, stop_drive, pause_drive) share the same
cancel → grace → abort → clear watcher sequence."
```

---

## 4. Tier 3 — Bearer Token Path Cleanup (Tasks 8–9)

---

### Task 8: Proactively check token expiry in `initialize_sync_inner`

**Finding:** B4. If the stored token is already expired at init time, the first sync forces a 401 → refresh roundtrip. `is_token_expiring` exists at `auth/tokens.rs:105`.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:646-650` (init token fetch)
- Reference: `src-tauri/src/auth/tokens.rs:105`, `src-tauri/src/auth/service.rs:refresh_auth_token_internal`

**Step 1: Fetch the function signatures you need**

```text
mcp__illu__context with symbol_name="is_token_expiring" sections=["source"]
mcp__illu__context with symbol_name="refresh_auth_token_internal" sections=["source"]
```

Confirm parameter names/types before editing.

**Step 2: Modify `initialize_sync_inner` token fetch**

Replace:
```rust
let bearer_token = get_api_token(pool, &account_id)
    .await?
    .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;
```

with:
```rust
// If the stored token is expired (or expires within 60s), refresh it
// before handing it to the drive. This avoids an immediate 401 on the
// first sync cycle after a long splash or resume-from-sleep.
const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;
if crate::auth::tokens::is_token_expiring(pool, &account_id, TOKEN_REFRESH_MARGIN_SECS).await {
    debug!("Stored token near expiry; refreshing before sync init");
    if let Err(e) = crate::auth::service::refresh_auth_token_internal(pool, &app, &account_id).await {
        warn!("Pre-init token refresh failed: {e} — will rely on runtime 401 handler");
    }
}
let bearer_token = get_api_token(pool, &account_id)
    .await?
    .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;
```

**Step 3: Build and test**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
```

**Step 4: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Refresh expiring auth token before initializing sync

initialize_sync_inner read the stored token from the DB without
checking its expiry. On resume-from-sleep or long splash screens,
this forced an immediate 401 → refresh roundtrip on the first
sync cycle. Check is_token_expiring with a 60s margin and refresh
proactively. Best-effort: a failed refresh falls through to the
runtime SyncCallbacks::refresh_auth_token path."
```

---

### Task 9: Delete dead `update_sync_bearer_token` Tauri command

**Finding:** B4b. Verified via `mcp__illu__references` — **zero call sites** anywhere in the codebase. It's an orphaned IPC command.

**Files:**
- Modify: `src-tauri/src/sync/config.rs:86-101` (delete)
- Modify: `src-tauri/src/main.rs` (remove from `tauri::generate_handler!`)

**Step 1: Re-verify no callers**

```bash
grep -rn "update_sync_bearer_token" \
  --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.json" \
  app/ src-tauri/src/
```
Expected: only the definition in `config.rs` and the registration in `main.rs`. If the frontend grep finds any `invoke("update_sync_bearer_token")`, STOP and reclassify — that's a real caller that illu missed.

**Step 2: Delete the function**

Remove lines 82-101 (doc + function + attributes) from `src-tauri/src/sync/config.rs`.

**Step 3: Remove from the IPC handler registry**

In `src-tauri/src/main.rs`, find the line `update_sync_bearer_token,` inside the `tauri::generate_handler!` invocation and delete it.

**Step 4: Build and verify no orphan references**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
```
Expected: clean.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/config.rs src-tauri/src/main.rs
git commit -m "Delete dead update_sync_bearer_token IPC command

Zero call sites in the frontend or backend. Bearer token refresh
during a live session is handled by SyncCallbacks::refresh_auth_token
(Tauri bridge implementation) which hcfs_client invokes on 401.
This dead command was a leftover from an earlier manual-refresh design."
```

---

## 5. Tier 4 — Progress Layer Error Migration (Tasks 10–13)

**Finding:** B3. `sync/progress.rs` has 27 functions returning `Result<T, String>` instead of `Result<T, AppError>`. This breaks the `{kind, message}` IPC contract for every `sp_*` Tauri command.

This is a **bigger refactor** — split into 4 tasks for reviewability. Each commit must leave the tree building.

---

### Task 10: Add `Progress` variant to `AppError`

**Files:**
- Modify: `src-tauri/src/error.rs:9-51` (add variant), `src-tauri/src/error.rs:97-119` (add to serialize)

**Step 1: Add the variant**

In `AppError`:
```rust
#[error("Progress error: {0}")]
Progress(String),
```

In the `serialize` match:
```rust
Self::Progress(_) => "Progress",
```

**Step 2: Build and run error tests**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo test -p Hippius error::
```

**Step 3: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "Add AppError::Progress variant for sync progress errors

Prepares Tasks 11-13 to migrate sync/progress.rs off Result<_, String>
and onto the unified AppError type so Tauri commands deliver the
{kind, message} IPC contract consistently."
```

---

### Task 11: Migrate `sync/progress.rs` internal functions to `Result<_, AppError>`

**Files:**
- Modify: `src-tauri/src/sync/progress.rs` (the non-`sp_*` functions)

**Step 1: Add a `type Result<T>` alias at top of the file**

```rust
type Result<T> = std::result::Result<T, crate::error::AppError>;
```

**Step 2: Rewrite the internal layer**

For each of these 14 functions, change `Result<T, String>` to `Result<T>` and wrap upstream errors:

- `update_file_progress` (line 66)
- `merge_into_session` (line 83)
- `remove_files_for_label` (line 105)
- `clear_all_data` (line 112)
- `start_session` (line 119)
- `complete_session` (line 141)
- `stop_session` (line 148)
- `complete_pending_files` (line 155)
- `mark_pending_files_as_failed` (line 162)
- `mark_all_pending_files_as_failed` (line 169)
- `mark_file_error` (line 176)
- `get_overall_progress` (line 183)
- `get_snapshot` (line 188)
- `record_deleted_file` (line 203)

Example — `update_file_progress`:

```rust
pub fn update_file_progress(
    sync: &SyncRunner,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>> {
    let result = sync.progress
        .update_file_progress(path, bytes_transferred, total_bytes, action, label)
        .map_err(crate::error::AppError::Progress)?;
    let is_file_complete = is_file_completion_tick(bytes_transferred, total_bytes);
    if try_claim_snapshot_emit(&LAST_THROTTLED_EMIT_MS, monotonic_now_ms(), is_file_complete, SNAPSHOT_THROTTLE_MS) {
        sync.emit_snapshot(false);
    }
    Ok(result)
}
```

Repeat the `.map_err(crate::error::AppError::Progress)?` pattern for every upstream `.progress.xxx()?` call.

**Step 3: Build — expect errors from the `sp_*` layer**

```bash
SQLX_OFFLINE=true cargo build -p Hippius 2>&1 | head -50
```
Expected: compilation errors ONLY in `sp_*` functions (they still return `Result<_, String>` but now receive `Result<_, AppError>`). That's fine — Task 12 fixes them.

**Step 4: Commit (partial — build broken intentionally)**

```bash
git add src-tauri/src/sync/progress.rs
git commit -m "Migrate sync/progress.rs internals to Result<_, AppError>

Adds a Result<T> alias and threads AppError::Progress through the
14 internal progress functions. The sp_* Tauri command wrappers
still return Result<_, String> and will fail to build — fixed in
the next commit."
```

**Note:** This is the one acceptable "intentionally broken middle commit" in the plan. Tasks 12 immediately restores build. If you cannot stomach a broken middle commit, bundle Tasks 11 and 12 into a single larger commit.

---

### Task 12: Migrate `sp_*` Tauri command wrappers to `Result<_, AppError>`

**Files:**
- Modify: `src-tauri/src/sync/progress.rs` (all `sp_*` functions, lines ~212-325)

**Step 1: Rewrite each `sp_*` wrapper**

For each of the 13 `sp_*` functions, change:
- Return type `Result<T, String>` → `Result<T>`
- Propagate the inner call with `?` (which now flows `AppError` naturally)

Example — `sp_update_file_progress`:

```rust
#[tauri::command]
pub fn sp_update_file_progress(
    state: tauri::State<'_, crate::app_state::AppState>,
    path: String,
    bytes_transferred: u64,
    total_bytes: u64,
    action: FileAction,
    label: Option<String>,
) -> Result<Option<SyncFile>> {
    update_file_progress(&state.sync, path, bytes_transferred, total_bytes, action, label)
}
```

Every `sp_*` becomes a near-one-liner.

**Step 2: Build and run tests**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
```
Expected: clean.

**Step 3: Commit**

```bash
git add src-tauri/src/sync/progress.rs
git commit -m "Migrate sp_* progress Tauri commands to Result<_, AppError>

All 13 sp_* wrappers now return the unified AppError type. The
frontend will receive { kind: 'Progress', message: '...' } for
progress errors instead of a bare string, making the IPC contract
consistent with the rest of the backend."
```

---

### Task 13: Verify frontend still parses progress errors correctly

**Why:** The error shape changed from `string` to `{kind, message}`. Any frontend code that assumed string-shape error payloads from `sp_*` commands will break.

**Step 1: Find frontend consumers**

```bash
grep -rn "invoke<.*>(\"sp_" app/ --include="*.ts" --include="*.tsx"
```
Expected: a list of `invoke(...)` calls targeting `sp_*` commands.

**Step 2: For each hit, check error handling**

For each caller, read the surrounding code:
```bash
# Example pattern to look for:
# try {
#   await invoke("sp_get_snapshot");
# } catch (e) {
#   // If this treats `e` as a string, it will now see [object Object]
# }
```

If any site treats the error as a bare string, update to:
```typescript
catch (e) {
  const msg = typeof e === "string"
    ? e
    : (e as { message?: string })?.message ?? String(e);
  // ...
}
```

Or (preferred) introduce a shared helper in `app/lib/utils/`:
```typescript
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
```
and use it at every invoke catch site.

**Step 3: Manual smoke test**

```bash
pnpm tauri:dev
```
Trigger a progress error path (e.g. by stopping sync mid-transfer). Confirm the frontend displays the error message, not `[object Object]`.

**Step 4: Commit**

```bash
git add app/
git commit -m "Update frontend error handling for AppError-shaped progress errors

sp_* progress commands now return { kind, message } instead of bare
strings. Add errorMessage() helper and use it at all invoke catch sites."
```

---

## 6. Tier 5 — Low-Priority Cleanups (Tasks 14–18)

Quick wins. Can be batched into one PR.

---

### Task 14: Delete or inline `initialize_sync` thin wrapper

**Finding:** B7. Single caller (`change_sync_folder:986`).

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:138-145` (delete), `src-tauri/src/sync/lifecycle.rs:986` (inline call), `src-tauri/src/main.rs` (remove from handler registry IF registered)

**Step 1: Check if it's a registered Tauri command**

```bash
grep -n "initialize_sync," src-tauri/src/main.rs
```

If it IS registered: it's a frontend IPC entry point — KEEP it, skip this task entirely. If NOT registered (only internal): proceed.

**Step 2: Inline into `change_sync_folder`**

Replace `initialize_sync(app, account_id, label, mnemonic).await` with:
```rust
initialize_sync_inner(app, account_id, label, mnemonic, true).await
```

**Step 3: Delete `initialize_sync`**

Remove the 7-line wrapper at `lifecycle.rs:138-145`.

**Step 4: Build and test**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
```

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Inline initialize_sync thin wrapper into change_sync_folder

initialize_sync was a 7-line forwarder to initialize_sync_inner with
a single caller. Delete the wrapper and inline the call."
```

---

### Task 15: Fix self-referential doc comment on `set_app_handle`

**Files:**
- Modify: `src-tauri/src/sync/tauri_bridge.rs:32`

**Step 1: Rewrite the doc**

Change:
```rust
/// Set the AppHandle once it's available (replaces the old `set_app_handle`).
```

to:
```rust
/// Register the Tauri `AppHandle` for use by sync callbacks and event emission.
/// Called exactly once from `main.rs` setup after the Tauri app is built.
```

**Step 2: Commit**

```bash
git add src-tauri/src/sync/tauri_bridge.rs
git commit -m "Fix self-referential doc comment on TauriSyncBridge::set_app_handle"
```

---

### Task 16: Decompose `setup_progress_handlers` callback setup

**Finding:** B9. 115 lines, `#[expect(clippy::too_many_lines)]`. The encrypt/decrypt/scan/fetch/file-synced arms follow an identical structure.

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs:1272-1386`

**Step 1: Extract three helper builders**

Above `setup_progress_handlers`, add:

```rust
fn build_encrypt_callback(sync: Arc<SyncRunner>, label: String) -> hcfs_client::sync::EncryptProgressFn {
    // (move the on_encrypt_progress closure body here, parameterized on FileAction::Encrypt
    //  and direction string "Encrypt"; also take the direction as an argument to collapse
    //  with decrypt)
}

fn build_scan_callback(app: AppHandle, sync: Arc<SyncRunner>, label: String) -> hcfs_client::sync::ScanProgressFn { /* ... */ }
fn build_fetch_callback(app: AppHandle, sync: Arc<SyncRunner>, label: String) -> hcfs_client::sync::FetchProgressFn { /* ... */ }
fn build_file_synced_callback(sync: Arc<SyncRunner>, label: String) -> hcfs_client::sync::FileSyncedFn { /* ... */ }
```

Check the exact type aliases in `hcfs_client::sync` via:
```text
mcp__illu__cross_query on "hcfs_client" for "ScanProgressFn" and "FileSyncedFn"
```

If the type aliases don't exist, use the raw `Arc<dyn Fn(...) + Send + Sync>` types.

**Step 2: Refactor `setup_progress_handlers` to use the builders**

Target: drop from 115 lines to ≤ 50.

**Step 3: Remove the `#[expect(clippy::too_many_lines)]` attribute**

**Step 4: Build, test, clippy**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets -- -D warnings
SQLX_OFFLINE=true cargo test -p Hippius --lib sync::
```

Expected: clean. Clippy should now not require the `too_many_lines` suppression.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "Decompose setup_progress_handlers into per-callback builders

Extract build_encrypt_callback, build_scan_callback, build_fetch_callback,
and build_file_synced_callback helpers. Drops setup_progress_handlers
from 115 lines to under 50 and removes the #[expect(too_many_lines)]
suppression. No behavior change."
```

**Fallback:** If the type aliases prove hostile to extraction (captures fight the borrow checker), SKIP this task and leave the `#[expect]` with a better justification. The closure-capture argument is real for upload/download but weak for the stateless scan/fetch arms.

---

### Task 17: Document `expect()` in `MigrationState::new()`

**Files:**
- Modify: `src-tauri/src/sync/migration.rs:697-715`

**Step 1: Add safety comment**

Above the `.expect(...)` call:

```rust
// SAFETY: reqwest::ClientBuilder::build() only fails on native-tls
// backend initialization, which is configured at compile time. A
// failure here would indicate a broken build artifact, not a runtime
// condition — so panicking at startup is acceptable (the app cannot
// function without an HTTP client).
```

**Step 2: Commit**

```bash
git add src-tauri/src/sync/migration.rs
git commit -m "Document reqwest::Client build expect() in MigrationState::new"
```

---

### Task 18: Introduce `crate::error::Result<T>` alias

**Finding:** B11. ~50 sites repeat `Result<T, crate::error::AppError>`.

**Files:**
- Modify: `src-tauri/src/error.rs` (add alias)
- Modify: all files under `src-tauri/src/sync/` (use the alias)

**Step 1: Add alias in `error.rs`**

At the bottom of `src-tauri/src/error.rs`, after the `AppError` definition:

```rust
/// Project-wide result type alias. Every Tauri command and most
/// async helpers return this.
pub type Result<T> = std::result::Result<T, AppError>;
```

**Step 2: Replace signatures file-by-file**

For each file under `src-tauri/src/sync/`:

1. Add `use crate::error::Result;` to the imports
2. Replace `Result<T, crate::error::AppError>` with `Result<T>`
3. Replace `Result<T, AppError>` (where `AppError` is imported) with `Result<T>`

**Do this per file, in separate commits**, to keep PRs reviewable. Suggested order:
- `sync/config.rs`
- `sync/control.rs`
- `sync/files.rs`
- `sync/folders.rs`
- `sync/lifecycle.rs`
- `sync/paths.rs`
- `sync/migration.rs`
- `sync/selective.rs`
- `sync/remote.rs`

**Step 3: Build after EACH file**

```bash
SQLX_OFFLINE=true cargo build -p Hippius
```
If clean, commit. Move to next file.

**Step 4: Commit (per file)**

```bash
git add src-tauri/src/sync/<file>.rs
git commit -m "Use crate::error::Result alias in sync/<file>.rs

No behavior change — pure ergonomics. Saves ~25 chars per signature."
```

---

## 7. Tier 6 — Frontend Hardening (Tasks 19–22)

These can be done in a **separate PR**, in parallel with backend Tiers 1-5.

---

### Task 19: Fix listener registration race in `useSyncEvents.ts`

**Finding:** F1. `Promise.all([listen(...), ...])` — if one listen rejects, the resolved unlisten functions leak.

**Files:**
- Modify: `app/lib/hooks/useSyncEvents.ts:74-148`

**Step 1: Read the current implementation**

```bash
# Use Read — TypeScript is indexed by illu, but Read is fine here since it's a hook we're rewriting wholesale
```

**Step 2: Rewrite to use the `useSyncSnapshot.ts:18-53` pattern**

The template:
```typescript
useEffect(() => {
  let cancelled = false;
  const unsubs: (() => void)[] = [];

  const register = async () => {
    try {
      const handlers: Array<[string, (e: Event<unknown>) => void]> = [
        ["hcfs_sync_started", () => setIsSyncConfiguredAtom(true)],
        // ... all the other listeners
      ];

      for (const [event, handler] of handlers) {
        if (cancelled) break;
        try {
          const unsub = await listen(event, handler);
          if (cancelled) {
            unsub();
          } else {
            unsubs.push(unsub);
          }
        } catch (err) {
          console.warn(`[SyncEvents] Failed to register ${event}:`, err);
        }
      }
    } catch (err) {
      console.warn("[SyncEvents] Listener registration failed:", err);
    }
  };

  register();

  return () => {
    cancelled = true;
    unsubs.forEach((u) => u());
  };
}, [/* deps */]);
```

Sequential registration means one failure doesn't leak others. `cancelled` flag + check before pushing means unmount-during-registration is handled.

**Step 3: Test**

```bash
pnpm lint
pnpm test  # if configured
```

Manual: open and close a page that mounts `SyncEvents` rapidly (navigation) — confirm no "listener leaked" warnings in console.

**Step 4: Commit**

```bash
git add app/lib/hooks/useSyncEvents.ts
git commit -m "Fix listener leak race in useSyncEvents

Promise.all registration leaked resolved unlisten fns if any of
the concurrent listen() promises rejected. Switch to sequential
registration with a cancelled flag, matching the useSyncSnapshot
pattern."
```

---

### Task 20: Standardize listen-effect cleanup pattern across `ConflictEventListener`, `SyncStatusHandler`, and other sites

**Finding:** F3. The pattern `return () => listeners.forEach((p) => p.then((u) => u()))` is fire-and-forget — the returned cleanup doesn't wait for the promise.

**Files:**
- Modify: `app/(pages)/ConflictEventListener.tsx:19-47`
- Modify: `app/(pages)/SyncStatusHandler.tsx:21-39` (if same bug present)
- Any other sites matching the anti-pattern

**Step 1: Grep for the anti-pattern**

```bash
grep -rn "listeners.forEach.*then\|\.then.*unlisten" app/ --include="*.ts" --include="*.tsx"
```

**Step 2: Create a shared helper**

Create `app/lib/utils/tauriListeners.ts`:

```typescript
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

type EventHandler<T> = (event: Event<T>) => void;

/**
 * Register multiple Tauri event listeners and return a single
 * unlisten function. Sequential registration — one failure does not
 * leak previously resolved listeners. The returned cleanup is
 * synchronous and safe to call from a useEffect return.
 */
export function registerTauriListeners(
  registrations: Array<[string, EventHandler<unknown>]>
): { cleanup: () => void; cancelled: () => boolean } {
  let cancelled = false;
  const unsubs: UnlistenFn[] = [];

  (async () => {
    for (const [event, handler] of registrations) {
      if (cancelled) return;
      try {
        const unsub = await listen(event, handler);
        if (cancelled) {
          unsub();
        } else {
          unsubs.push(unsub);
        }
      } catch (err) {
        console.warn(`[TauriListeners] Failed to register ${event}:`, err);
      }
    }
  })();

  return {
    cleanup: () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      unsubs.length = 0;
    },
    cancelled: () => cancelled,
  };
}
```

**Step 3: Migrate call sites**

For each hit from Step 1, replace the ad-hoc pattern with:

```typescript
useEffect(() => {
  const { cleanup } = registerTauriListeners([
    ["hcfs_conflicts_pending", (event) => setPendingConflicts(event.payload as { label: string; staged: StagedChanges }).staged)],
    ["hcfs_sync_completed", () => setPendingConflicts(null)],
    // ...
  ]);
  return cleanup;
}, [setPendingConflicts]);
```

**Step 4: Lint and smoke test**

```bash
pnpm lint
pnpm tauri:dev  # navigate between pages, watch for console warnings
```

**Step 5: Commit**

```bash
git add app/lib/utils/tauriListeners.ts app/\(pages\)/ConflictEventListener.tsx app/\(pages\)/SyncStatusHandler.tsx
git commit -m "Introduce registerTauriListeners helper and migrate callers

The ad-hoc pattern of returning () => listeners.forEach(p => p.then(u => u()))
from useEffect is a fire-and-forget — the cleanup doesn't await the
promise, so unmount-before-settle leaks the listener. Centralize the
correct pattern in registerTauriListeners and migrate ConflictEventListener
and SyncStatusHandler."
```

---

### Task 21: Synchronize logout with sync teardown in `wallet-auth-context.tsx`

**Finding:** F4. Logout fires `invoke("logout_full")` with `.catch()` then immediately clears local state. If Rust teardown is still in-flight, local state races ahead.

**Files:**
- Modify: `app/lib/wallet-auth-context.tsx:142-184`

**Step 1: Rewrite logout to await teardown**

```typescript
const logout = useCallback(
  async (redirectPath?: string) => {
    // Cancel any pending logout timer.
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }

    const currentAddress = polkadotAddressRef.current;

    // 1. Await sync teardown before clearing local state.
    //    logout_full in Rust calls stop_sync internally; awaiting it
    //    ensures we don't race local cleanup against in-flight cycles.
    try {
      await invoke("logout_full", { accountId: currentAddress || "" });
    } catch (err) {
      console.warn("[WalletAuth] logout_full failed:", err);
      // Continue with local cleanup — a stuck backend shouldn't lock the user out.
    }

    // 2. Clear browser-side session.
    if (typeof window !== "undefined") {
      localStorage.removeItem("hippius_oauth_session");
      localStorage.removeItem("hippius_oauth_session_expiry");
      localStorage.removeItem("hippius_oauth_provider");
    }
    clearLoginStatusCache();

    // 3. Reset local auth state.
    setPolkadotAddress(null);
    setAuthType(null);
    setOAuthSessionState(null);
    setIsAuthenticated(false);
    setSessionTimeRemaining(null);
    syncInitialized.current = false;
    sessionMnemonicRef.current = null;

    if (redirectPath && typeof window !== "undefined") {
      router.push(redirectPath);
    }
  },
  [router]
);
```

**Step 2: Smoke test**

```bash
pnpm tauri:dev
```
Log in, start sync, log out mid-sync. Confirm:
- No `SYNC_ERROR` events fire after logout
- Tray icon updates to logged-out state promptly
- Re-login works without stale drive state

**Step 3: Commit**

```bash
git add app/lib/wallet-auth-context.tsx
git commit -m "Await sync teardown before clearing local auth state on logout

logout() was firing invoke('logout_full') without awaiting,
then immediately clearing local state. This raced the Rust
sync teardown: local state said 'logged out' while Rust was
still processing the final sync cycle, causing flashes of
stale UI and occasional spurious SYNC_ERROR events."
```

---

### Task 22: Delete unused atoms and deprecated tray helper

**Finding:** F8. Dead code cleanup.

**Files:**
- Modify: `app/lib/store/syncAtoms.ts:8-11` (verify unused, delete)
- Modify: `app/lib/hooks/useTraySync.ts:742-746` (delete or properly deprecate)

**Step 1: Verify atoms truly unused**

```bash
grep -rn "trayUpdateInProgressAtom\|lastTrayUpdateTimeAtom" app/ --include="*.ts" --include="*.tsx"
```
If zero hits outside the definition, delete. If there are hits, leave them.

**Step 2: Remove deprecated tray helper**

```bash
grep -rn "setTraySyncPercent" app/ --include="*.ts" --include="*.tsx"
```
If only self-reference remains, delete. Otherwise migrate remaining callers to `syncPercentAtom` and then delete.

**Step 3: Commit**

```bash
git add app/
git commit -m "Delete unused sync atoms and deprecated setTraySyncPercent helper"
```

---

## 8. Acceptance Criteria

Before merging the plan's work to `backend-refactor`:

- [ ] All Tier 1-2 tasks landed (blocking)
- [ ] `SQLX_OFFLINE=true cargo build -p Hippius` clean
- [ ] `SQLX_OFFLINE=true cargo clippy -p Hippius --all-targets --all-features -- -D warnings` clean
- [ ] `SQLX_OFFLINE=true cargo test -p Hippius` all pass
- [ ] `pnpm lint` clean
- [ ] Manual smoke test: login → sync 10+ files → logout mid-sync → no trailing `SYNC_ERROR` event, clean re-login
- [ ] Manual smoke test: pause drive mid-sync → drive lock released within 500ms
- [ ] Manual smoke test: trigger conflict review → resolve → verify sync completes and widget doesn't flicker
- [ ] Frontend progress errors display as messages, not `[object Object]` (if Tier 4 landed)

---

## 9. Out of Scope (explicit non-goals)

- `hcfs_client` internal changes (external dependency; verify only, don't fix)
- Zod runtime validation layer (F5) — separate design doc needed
- `parking_lot::Mutex` migration for watcher (N2) — current code is correct
- `SanitizedLabel` newtype (N3) — requires signature-level refactor across ~30 functions
- Token refresh re-init on the frontend (F2) — depends on a new Rust event not yet designed
- Any changes to `hcfs_client` Git revision in `Cargo.toml`

---

## 10. Risks & Rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| HCFS cancel semantics different from assumed (invalidates Tasks 5-7) | MEDIUM | Prereq 1 verification must complete first. If it fails, downgrade Tasks 5-7 to "documentation + grace window only" |
| Progress error migration (Tier 4) breaks frontend | LOW | Task 13 explicitly audits frontend catch sites; covered by smoke test |
| `setup_progress_handlers` decomposition (Task 16) fights the borrow checker | MEDIUM | Task 16 has an explicit fallback: keep the `#[expect]` with a better justification |
| `stop_sync` grace window too short (500ms) | LOW | If observed in smoke testing, tune via the local const — not a protocol change |

**Rollback strategy:** Each task is a separate commit on its own branch. Any failing task can be reverted individually with `git revert <sha>` without touching earlier work. Task 11 is the only intentional "broken middle" — revert Tasks 11+12 together if needed.

---

## 11. References

- Review document: conversation 2026-04-05 (not saved to disk; summarized in §0)
- Related prior plans:
  - `docs/plans/2026-03-24-hcfs-client-upgrade-design.md`
  - `docs/plans/2026-03-25-per-drive-locks-design.md`
- Rust best-practice skills to consult during execution:
  - `rfr-async-programming` — for Tasks 2, 3, 5-7
  - `rfr-error-handling` — for Tasks 10-12
  - `rust-idiomatic-patterns` — for Task 16 decomposition
