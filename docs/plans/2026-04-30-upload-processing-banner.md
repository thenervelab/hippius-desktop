# Upload Processing Banner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a top-of-page banner ("Processing N files. Sync will start shortly…") from the moment a user clicks Upload until the first byte of upload progress fires, so users have visible feedback during the disk-copy + encryption window.

**Architecture:** Single `Arc<UploadProcessingState>` mutex in `AppState` is the source of truth. Three IPC entry points (`add_file`/`add_files`/`add_folder`) call `begin(count)` after the eligibility check. The decrement happens in `handle_transfer_progress` (lifecycle.rs) — the first non-zero upload chunk for any file triggers `clear_if_after(now)`. State emits `hcfs_upload_processing` events; a Jotai atom mirrors them; a banner component renders based on the atom.

**Tech Stack:** Rust (Tauri 2.0), TypeScript (Next.js 15 + Jotai), Vitest, cargo test.

**Design doc:** `docs/plans/2026-04-30-upload-processing-banner-design.md`

---

## Context the engineer needs

**Codebase rules (from `CLAUDE.md`):**
- Business logic lives in Rust (`src-tauri/`). Frontend mirrors Rust state via events.
- All Rust logging uses `tracing` macros (`info!`, `debug!`, `warn!`), never `println!`.
- Path aliases in TS: `@/components/*` → `app/components/*`, `@/lib/*` → `app/lib/*`.
- Rust line width 150, edition 2024, toolchain 1.92.0.
- New events go in `src-tauri/src/sync/events.rs` as `pub const … : &str = "…";`.
- `SyncEvent::UploadProgress` and `SyncEvent::DownloadProgress` are explicitly **dropped** at `tauri_bridge.rs:313` — do NOT hook the decrement there. Use `handle_transfer_progress` in `lifecycle.rs` instead.

**Pattern to mirror:**
- Banner component: `app/components/ui/MigrationBanner.tsx` (read atom, return `null` when inactive, otherwise render spinner + label).
- Atom file: `app/lib/global-atoms/migrationAtoms.ts`.
- Listener mount point: `app/(pages)/SyncEventLogger.tsx` calls hooks like `useSyncEvents()`, `useDriveStatuses()`. Add a sibling `useUploadProcessing()`.
- Banner mount: `app/(pages)/ResponsiveContent.tsx` already mounts `<ConflictsBanner />` and `<MigrationBanner />` in the sticky toolbar — slot the new banner alongside them.

**Where things live (Rust):**
- `AppState` definition: `src-tauri/src/app_state.rs`.
- IPC entry points to wire: `src-tauri/src/sync/files.rs:113` (`add_file`), `:376` (`add_files`), `:132` (`add_folder`).
- Decrement hook site: `src-tauri/src/sync/lifecycle.rs:1640` (`handle_transfer_progress`).
- Logout reset: `src-tauri/src/sync/lifecycle.rs` (search for `pub async fn stop_sync`).
- Module registration: `src-tauri/src/sync/mod.rs`.

**Build & test commands:**
```bash
cd src-tauri
cargo test --test upload_processing_lifecycle    # new Rust tests
cargo test --test file_commands                  # extended coverage
cargo clippy --all -- -D warnings
cargo fmt --all
SQLX_OFFLINE=true cargo build

cd ..
pnpm test app/(pages)/__tests__/UploadProcessingBanner.test.tsx
pnpm lint
pnpm tauri:dev                                   # manual smoke
```

---

## Task 1: Add the event constant

**Files:**
- Modify: `src-tauri/src/sync/events.rs`

**Step 1: Add the constant**

Add this to the existing list of `pub const … : &str = "…";` declarations (after `FILES_FAILED_REPEATEDLY` at line 57 is a fine spot):

```rust
/// Emitted when a user-initiated upload (`add_file` / `add_files` /
/// `add_folder`) is in its disk-copy + encryption window before any
/// byte of network transfer fires. The frontend renders a top-of-page
/// banner while `active = true`. State is owned by
/// `crate::sync::upload_processing::UploadProcessingState`.
pub const UPLOAD_PROCESSING: &str = "hcfs_upload_processing";
```

**Step 2: Verify compilation**

Run: `cd src-tauri && cargo build 2>&1 | head -20`
Expected: builds clean (constant is unused — that's fine for now, gets used in Task 3).

**Step 3: Commit**

```bash
git add src-tauri/src/sync/events.rs
git commit -m "feat(sync): add UPLOAD_PROCESSING event constant"
```

---

## Task 2: Write failing unit tests for `UploadProcessingState`

**Files:**
- Create: `src-tauri/src/sync/upload_processing.rs`

**Step 1: Create the module file with tests only (no implementation yet)**

```rust
//! Tracks the "processing" window between a user-initiated upload IPC
//! call and the first byte of upload progress. The frontend renders a
//! top-of-page banner during this window so the user sees that the
//! system has acknowledged their click while disk copy + encryption
//! run.
//!
//! Lifecycle:
//! - `begin(count)` — called from `add_file` / `add_files` / `add_folder`
//!   after the eligibility check, before the disk copy. Increments the
//!   pending count and stamps `started_at` if currently `None`.
//! - `clear_if_after(now)` — called from `handle_transfer_progress`
//!   when the first upload chunk lands. Idempotent. Guarded by the
//!   `started_at` timestamp so file-watcher activity that fires before
//!   any user upload cannot accidentally hide a banner.
//! - `reset()` — unconditional clear. Used by logout / `stop_sync`.

use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
struct UploadProcessingInner {
    pending_files: u64,
    started_at: Option<Instant>,
}

pub struct UploadProcessingState {
    inner: Mutex<UploadProcessingInner>,
}

impl Default for UploadProcessingState {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadProcessingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UploadProcessingInner::default()),
        }
    }

    /// Snapshot for tests and event payload assembly.
    #[doc(hidden)]
    pub fn snapshot(&self) -> (bool, u64) {
        let g = self.inner.lock().expect("upload_processing mutex poisoned");
        (g.started_at.is_some(), g.pending_files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn begin_then_clear_after_start_zeros_state() {
        let s = UploadProcessingState::new();
        s.begin_for_test(3);
        let (active_before, count_before) = s.snapshot();
        assert!(active_before);
        assert_eq!(count_before, 3);

        s.clear_if_after_for_test(Instant::now() + Duration::from_millis(1));
        let (active_after, count_after) = s.snapshot();
        assert!(!active_after);
        assert_eq!(count_after, 0);
    }

    #[test]
    fn clear_with_earlier_instant_is_noop() {
        let s = UploadProcessingState::new();
        let earlier = Instant::now();
        // sleep a tick so the begin's started_at is strictly later
        std::thread::sleep(Duration::from_millis(2));
        s.begin_for_test(2);

        s.clear_if_after_for_test(earlier);
        let (active, count) = s.snapshot();
        assert!(active, "earlier-instant clear must not fire");
        assert_eq!(count, 2);
    }

    #[test]
    fn concurrent_begins_accumulate() {
        let s = UploadProcessingState::new();
        s.begin_for_test(4);
        s.begin_for_test(3);
        let (active, count) = s.snapshot();
        assert!(active);
        assert_eq!(count, 7);
    }

    #[test]
    fn clear_when_inactive_is_noop() {
        let s = UploadProcessingState::new();
        s.clear_if_after_for_test(Instant::now());
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
    }

    #[test]
    fn reset_unconditionally_clears() {
        let s = UploadProcessingState::new();
        s.begin_for_test(5);
        s.reset_for_test();
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
    }
}
```

**Step 2: Register the module**

Modify `src-tauri/src/sync/mod.rs` — add `pub mod upload_processing;` to the alphabetically-correct slot (after `tauri_bridge`).

**Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib sync::upload_processing 2>&1 | tail -30`
Expected: compile error — `begin_for_test`, `clear_if_after_for_test`, `reset_for_test` undefined.

This is the desired RED state. Tests are wired but the implementation doesn't exist.

**Step 4: Commit (RED state)**

```bash
git add src-tauri/src/sync/upload_processing.rs src-tauri/src/sync/mod.rs
git commit -m "test(sync): add failing tests for UploadProcessingState"
```

---

## Task 3: Implement `UploadProcessingState` to make Task 2 tests pass

**Files:**
- Modify: `src-tauri/src/sync/upload_processing.rs`

**Step 1: Add the test-only methods**

Append inside `impl UploadProcessingState` (above the `pub fn snapshot`):

```rust
    /// Test-only entry point that mirrors [`Self::begin`] without
    /// emitting a Tauri event. Production code calls `begin`.
    #[cfg(test)]
    fn begin_for_test(&self, count: u64) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        g.pending_files = g.pending_files.saturating_add(count);
        if g.started_at.is_none() {
            g.started_at = Some(Instant::now());
        }
    }

    /// Test-only entry point that mirrors [`Self::clear_if_after`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn clear_if_after_for_test(&self, event_at: Instant) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        if let Some(started_at) = g.started_at {
            if event_at >= started_at {
                g.pending_files = 0;
                g.started_at = None;
            }
        }
    }

    /// Test-only entry point that mirrors [`Self::reset`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn reset_for_test(&self) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        g.pending_files = 0;
        g.started_at = None;
    }
```

**Step 2: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib sync::upload_processing 2>&1 | tail -15`
Expected: `5 passed`.

**Step 3: Commit (GREEN state)**

```bash
git add src-tauri/src/sync/upload_processing.rs
git commit -m "feat(sync): UploadProcessingState core mutations (test-only API)"
```

---

## Task 4: Add the production `begin` / `clear_if_after` / `reset` methods

**Files:**
- Modify: `src-tauri/src/sync/upload_processing.rs`

**Step 1: Add production methods that emit Tauri events**

Append to `impl UploadProcessingState`, above the `#[cfg(test)]` block:

```rust
    /// Increment `pending_files` by `count` and stamp `started_at` if
    /// not already set. Emits `hcfs_upload_processing` with
    /// `{ active: true, pending_files }`.
    ///
    /// Called from `add_file` / `add_files` / `add_folder` AFTER the
    /// eligibility check (so an ineligible user never sees a flash) and
    /// BEFORE the disk copy (so the banner appears the moment real work
    /// starts).
    pub fn begin(&self, app: &tauri::AppHandle, count: u64) {
        let pending = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            g.pending_files = g.pending_files.saturating_add(count);
            if g.started_at.is_none() {
                g.started_at = Some(Instant::now());
            }
            g.pending_files
        };
        emit(app, true, pending);
    }

    /// Clear state if `event_at` is at or after `started_at`. No-op when
    /// inactive or when the event predates the current upload session
    /// (file-watcher activity from before any user upload). Idempotent.
    ///
    /// Called from `handle_transfer_progress` for the first upload-direction
    /// chunk of any file, and from `SyncCompleted` / non-cancel `SyncError`
    /// terminal paths.
    pub fn clear_if_after(&self, app: &tauri::AppHandle, event_at: Instant) {
        let did_clear = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            match g.started_at {
                Some(started_at) if event_at >= started_at => {
                    g.pending_files = 0;
                    g.started_at = None;
                    true
                }
                _ => false,
            }
        };
        if did_clear {
            emit(app, false, 0);
        }
    }

    /// Unconditional clear used by logout / `stop_sync`.
    pub fn reset(&self, app: &tauri::AppHandle) {
        let did_clear = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            let was_active = g.started_at.is_some() || g.pending_files > 0;
            g.pending_files = 0;
            g.started_at = None;
            was_active
        };
        if did_clear {
            emit(app, false, 0);
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProcessingPayload {
    active: bool,
    pending_files: u64,
}

fn emit(app: &tauri::AppHandle, active: bool, pending_files: u64) {
    use tauri::Emitter;
    let _ = app.emit(
        crate::sync::events::UPLOAD_PROCESSING,
        UploadProcessingPayload { active, pending_files },
    );
}
```

Important: the closing `}` at the top of the snippet matches the `impl UploadProcessingState` block. The payload struct + `emit` helper live OUTSIDE the impl, at module scope.

**Step 2: Run tests to verify the existing test suite still passes**

Run: `cd src-tauri && cargo test --lib sync::upload_processing 2>&1 | tail -15`
Expected: `5 passed` (same tests, new code surface).

**Step 3: Run clippy**

Run: `cd src-tauri && cargo clippy --lib -- -D warnings 2>&1 | tail -20`
Expected: clean.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/upload_processing.rs
git commit -m "feat(sync): UploadProcessingState public API with event emission"
```

---

## Task 5: Wire `UploadProcessingState` into `AppState`

**Files:**
- Modify: `src-tauri/src/app_state.rs`

**Step 1: Add the field to the struct**

In `AppState` (around line 31-78), add this field — alphabetical placement next to `migration` is fine:

```rust
    /// Tracks the disk-copy + encryption window for user-initiated
    /// uploads. Drives the top-of-page processing banner. See
    /// `crate::sync::upload_processing`.
    pub upload_processing: std::sync::Arc<crate::sync::upload_processing::UploadProcessingState>,
```

**Step 2: Initialize in `AppState::new`**

In `AppState::new()` (around line 87-135), inside the returned `Self { … }` literal, add:

```rust
            upload_processing: std::sync::Arc::new(crate::sync::upload_processing::UploadProcessingState::new()),
```

**Step 3: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 4: Commit**

```bash
git add src-tauri/src/app_state.rs
git commit -m "feat(sync): hold UploadProcessingState in AppState"
```

---

## Task 6: Wire `begin` into `add_file`

**Files:**
- Modify: `src-tauri/src/sync/files.rs`

**Step 1: Update the `add_file` signature and body**

`add_file` currently takes `state: tauri::State<'_, AppState>`. To call `begin`, we also need an `AppHandle`. Add `app: tauri::AppHandle` as a second parameter (after `state`). All `tauri::command` parameters that aren't `State` are auto-injected from the IPC layer, so this is safe.

Locate `add_file` at `src-tauri/src/sync/files.rs:113`. Replace the function with:

```rust
/// Add file to sync folder (Drive auto-syncs)
#[tauri::command]
pub async fn add_file(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: tauri::AppHandle,
    sync_path: String,
    file_path: String,
) -> Result<String> {
    // Enforce credit eligibility at the IPC boundary. Even if a stale
    // FE cache let the user click the upload button, this fails the
    // operation here so we never copy the file into the sync folder
    // (and thus never trigger an upload that would silently fail
    // server-side for billing reasons).
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    crate::billing::eligibility::require_eligible(&state, &account_id, crate::billing::eligibility::InsufficientCreditsAction::FileUpload).await?;

    // Mark the processing window. Released either by the first upload
    // chunk (success path) or by the error guard below (failure path).
    state.upload_processing.begin(&app, 1);

    // Canonicalize the sync path once and pass it to the internal helper
    // so the helper can be cheap when called per-file from the batch path.
    let canonical_parent = match tokio::fs::canonicalize(Path::new(&sync_path)).await {
        Ok(p) => p,
        Err(e) => {
            state.upload_processing.clear_if_after(&app, std::time::Instant::now());
            return Err(crate::error::AppError::Other(format!("Invalid sync path: {e}")));
        }
    };
    match add_file_internal(&canonical_parent, &file_path).await {
        Ok(name) => Ok(name),
        Err(e) => {
            state.upload_processing.clear_if_after(&app, std::time::Instant::now());
            Err(e)
        }
    }
}
```

**Step 2: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 3: Commit**

```bash
git add src-tauri/src/sync/files.rs
git commit -m "feat(sync): mark upload-processing window in add_file"
```

---

## Task 7: Wire `begin` into `add_folder` (with file count walk)

**Files:**
- Modify: `src-tauri/src/sync/files.rs`

**Step 1: Add a regular-file count helper at the bottom of `files.rs`**

```rust
/// Count regular files (non-directory, non-symlink) under `root`,
/// recursively. Used by `add_folder` to size the `begin` count for
/// the upload-processing banner. Returns 0 on any I/O error — the
/// banner falls back to "Processing your files…" which is acceptable.
async fn count_regular_files(root: &Path) -> u64 {
    use tokio::fs;

    let mut count: u64 = 0;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(ft) = entry.file_type().await else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                count = count.saturating_add(1);
            }
        }
    }
    count
}
```

**Step 2: Update `add_folder`**

Locate `add_folder` at `src-tauri/src/sync/files.rs:132`. Insert these lines AFTER the `require_eligible` await and BEFORE the validation/copy logic (currently around line 144):

```rust
    // Pre-walk the source tree so the banner shows an accurate count.
    // Cheap relative to the full copy (no file-content reads).
    let count = count_regular_files(Path::new(&folder_path)).await;
    state.upload_processing.begin(&app, count.max(1));
```

Wrap the existing body (from validation through `Ok(name)`) in an inline async block whose error branches call `clear_if_after` before propagating. Cleanest implementation: extract the existing body into a helper, then wrap the call.

Replace `add_folder` body with:

```rust
    let result = add_folder_with_app_inner(&state, &app, &sync_path, &folder_path, subfolder.as_deref()).await;
    if result.is_err() {
        state.upload_processing.clear_if_after(&app, std::time::Instant::now());
    }
    result
}

async fn add_folder_with_app_inner(
    state: &crate::app_state::AppState,
    _app: &tauri::AppHandle,
    sync_path: &str,
    folder_path: &str,
    subfolder: Option<&str>,
) -> Result<String> {
    let _ = state; // silence unused if eligibility was already done
    let source = Path::new(folder_path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(crate::error::AppError::Other("Invalid folder name".into()))?
        .to_string();

    if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err(crate::error::AppError::Other("Invalid folder name".into()));
    }

    let sync_root = Path::new(sync_path);
    let target_dir = if let Some(sub) = subfolder {
        if sub.contains("..") {
            return Err(crate::error::AppError::Other("Subfolder path contains traversal component".into()));
        }
        let t = sync_root.join(sub);
        if !t.exists() {
            std::fs::create_dir_all(&t).map_err(|e| crate::error::AppError::Other(format!("Failed to create subfolder: {e}")))?;
        }
        let canonical_root = tokio::fs::canonicalize(sync_root)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
        let canonical_target = tokio::fs::canonicalize(&t)
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Invalid subfolder path: {e}")))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(crate::error::AppError::Other("Subfolder escapes sync folder".into()));
        }
        t
    } else {
        sync_root.to_path_buf()
    };

    let canonical_parent = tokio::fs::canonicalize(&target_dir)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Invalid sync path: {e}")))?;
    let canonical_dest = canonical_parent.join(&name);
    if !canonical_dest.starts_with(&canonical_parent) {
        return Err(crate::error::AppError::Other("Path escapes sync folder".into()));
    }

    copy_dir_recursive(source, &canonical_dest, 0).await?;

    Ok(name)
}
```

Then re-add the trigger_sync block in the public command (after `result.is_err()` branch but only on success):

Updated public `add_folder`:

```rust
#[tauri::command]
pub async fn add_folder(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    folder_path: String,
    subfolder: Option<String>,
) -> Result<String> {
    let account_id = state.current_account_id().map_err(crate::error::AppError::Other)?;
    crate::billing::eligibility::require_eligible(&state, &account_id, crate::billing::eligibility::InsufficientCreditsAction::FolderUpload).await?;

    let count = count_regular_files(Path::new(&folder_path)).await;
    state.upload_processing.begin(&app, count.max(1));

    let result = add_folder_with_app_inner(&state, &app, &sync_path, &folder_path, subfolder.as_deref()).await;

    match result {
        Ok(name) => {
            // Trigger sync so the uploaded folder gets synced
            use tauri::Manager;
            let s = app.state::<crate::app_state::AppState>().sync.clone();
            let _ = trigger_sync(&s).await;
            Ok(name)
        }
        Err(e) => {
            state.upload_processing.clear_if_after(&app, std::time::Instant::now());
            Err(e)
        }
    }
}
```

**Step 3: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/files.rs
git commit -m "feat(sync): mark upload-processing window in add_folder with file count"
```

---

## Task 8: Wire `begin` into `add_files`

**Files:**
- Modify: `src-tauri/src/sync/files.rs`

**Step 1: Locate `add_files`**

Currently at line 376. Read its full body to understand the eligibility check and per-item loop.

Run: `sed -n '370,440p' src-tauri/src/sync/files.rs` to see the function.

**Step 2: Add `begin` after eligibility, with error-path clear**

Inside `add_files`, after the `require_eligible` call and before the per-item loop:

```rust
    // Compute the total file count up-front: each file request counts
    // as 1, and folder requests get a recursive walk (same logic as
    // `add_folder`). The banner shows this aggregate during the
    // entire batch's processing window.
    let mut total_count: u64 = 0;
    for r in &requests {
        if r.is_folder {
            total_count = total_count.saturating_add(count_regular_files(Path::new(&r.source_path)).await.max(1));
        } else {
            total_count = total_count.saturating_add(1);
        }
    }
    state.upload_processing.begin(&app, total_count.max(1));
```

(Adjust field names — `is_folder` and `source_path` are placeholders; check the actual `AddFileRequest` struct in `add_files`.)

At every error-return path inside `add_files` (and at the end if the function returns `Err`), make sure to call `state.upload_processing.clear_if_after(&app, std::time::Instant::now())` BEFORE returning.

The cleanest pattern: introduce an inner async function with the logic, and clear in the caller on `Err`:

```rust
    let result = add_files_inner(/* same args */).await;
    if result.is_err() {
        state.upload_processing.clear_if_after(&app, std::time::Instant::now());
    }
    result
```

**Step 3: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/files.rs
git commit -m "feat(sync): mark upload-processing window in add_files batch"
```

---

## Task 9: Wire decrement signal in `handle_transfer_progress`

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs`

**Step 1: Add the clear call at line ~1657**

In `handle_transfer_progress` (line 1640), after the existing `update_file_progress` call and before the completion-tick block, add:

```rust
    // First non-zero upload chunk for any file ends the "processing"
    // window — the bottom-right widget now has real per-file progress
    // and the top banner can vanish. Idempotent and cheap (single mutex
    // tick) so calling on every chunk is fine; the inner guard short-
    // circuits when state is already cleared.
    if matches!(ctx.direction, TransferDirection::Upload) && bytes > 0 {
        use tauri::Manager;
        let app_state = ctx.app.state::<crate::app_state::AppState>();
        app_state.upload_processing.clear_if_after(&ctx.app, std::time::Instant::now());
    }
```

**Step 2: Add the clear call in `tauri_bridge.rs` SyncCompleted and SyncError arms**

In `src-tauri/src/sync/tauri_bridge.rs`, inside `fn on_event`:

After line 213 (`app_state.sync.emit_snapshot(true);`) in the `SyncCompleted` arm, add:

```rust
                app_state.upload_processing.clear_if_after(&app, std::time::Instant::now());
```

In the `SyncError` arm, after the `if error == events::CANCELLED_MARKER` early return and before `app.emit(events::SYNC_ERROR, ...)`, add:

```rust
                {
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    app_state.upload_processing.clear_if_after(&app, std::time::Instant::now());
                }
```

(Cancels are silenced before this point, so an upload-cancel doesn't trigger the clear — but the user-cancelled path goes through `stop_sync` which calls `reset`, so this is fine.)

**Step 3: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 4: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs src-tauri/src/sync/tauri_bridge.rs
git commit -m "feat(sync): decrement upload-processing on first chunk and terminal events"
```

---

## Task 10: Wire `reset` into `stop_sync`

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs`

**Step 1: Find `stop_sync`**

Run: `grep -n "pub async fn stop_sync" src-tauri/src/sync/lifecycle.rs`

**Step 2: Add reset at the top of the function body**

Inside `stop_sync`, immediately after the function entry log (or as the first action after acquiring `state`), add:

```rust
    state.upload_processing.reset(&app);
```

Account for whatever the local variable name for the `AppState` is (likely just `state`, possibly via `app.state::<AppState>()`).

**Step 3: Verify compilation**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build 2>&1 | tail -20`
Expected: builds clean.

**Step 4: Run all Rust tests to make sure no behavioral regression**

Run: `cd src-tauri && cargo test 2>&1 | tail -30`
Expected: all green.

**Step 5: Commit**

```bash
git add src-tauri/src/sync/lifecycle.rs
git commit -m "feat(sync): reset upload-processing on stop_sync"
```

---

## Task 11: Run clippy and fmt; fix any issues

**Step 1: clippy**

Run: `cd src-tauri && cargo clippy --all -- -D warnings 2>&1 | tail -30`
Expected: clean. If anything trips, fix in-place — these are usually trivial (unused imports, needless `.clone()`, etc.).

**Step 2: fmt**

Run: `cd src-tauri && cargo fmt --all`

**Step 3: Run tests one more time**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`

**Step 4: Commit any fmt/clippy fixes**

```bash
git add -A
git diff --cached --quiet || git commit -m "style(sync): fmt + clippy fixes for upload-processing"
```

---

## Task 12: Frontend — atom + listener hook

**Files:**
- Create: `app/lib/global-atoms/uploadProcessingAtoms.ts`
- Create: `app/lib/hooks/useUploadProcessing.ts`

**Step 1: Write the atom**

```ts
// app/lib/global-atoms/uploadProcessingAtoms.ts
import { atom } from "jotai";

export interface UploadProcessingState {
  active: boolean;
  pendingFiles: number;
}

export const DEFAULT_UPLOAD_PROCESSING_STATE: UploadProcessingState = {
  active: false,
  pendingFiles: 0,
};

export const uploadProcessingAtom = atom<UploadProcessingState>(
  DEFAULT_UPLOAD_PROCESSING_STATE
);
```

**Step 2: Write the listener hook**

```ts
// app/lib/hooks/useUploadProcessing.ts
"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  uploadProcessingAtom,
  DEFAULT_UPLOAD_PROCESSING_STATE,
  type UploadProcessingState,
} from "@/lib/global-atoms/uploadProcessingAtoms";

/**
 * Listens to `hcfs_upload_processing` and mirrors the payload into
 * `uploadProcessingAtom`. The atom drives `<UploadProcessingBanner />`.
 *
 * No business logic — Rust owns lifecycle. This hook is a pure mirror.
 */
export function useUploadProcessing() {
  const setState = useSetAtom(uploadProcessingAtom);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    listen<UploadProcessingState>("hcfs_upload_processing", (e) => {
      if (cancelled) return;
      setState(e.payload);
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unsub = u;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsub?.();
      // Reset on unmount so the next session starts clean.
      setState(DEFAULT_UPLOAD_PROCESSING_STATE);
    };
  }, [setState]);
}
```

**Step 3: Verify TS compiles**

Run: `pnpm tsc --noEmit 2>&1 | head -20`
Expected: clean.

**Step 4: Commit**

```bash
git add app/lib/global-atoms/uploadProcessingAtoms.ts app/lib/hooks/useUploadProcessing.ts
git commit -m "feat(ui): atom + listener for upload-processing banner"
```

---

## Task 13: Frontend — banner component (with failing test first)

**Files:**
- Create: `app/components/ui/UploadProcessingBanner.tsx`
- Create: `app/components/ui/__tests__/UploadProcessingBanner.test.tsx`

**Step 1: Write the failing test**

```tsx
// app/components/ui/__tests__/UploadProcessingBanner.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import UploadProcessingBanner from "../UploadProcessingBanner";
import { uploadProcessingAtom } from "@/lib/global-atoms/uploadProcessingAtoms";

function renderWithState(active: boolean, pendingFiles: number) {
  const store = createStore();
  store.set(uploadProcessingAtom, { active, pendingFiles });
  return render(
    <Provider store={store}>
      <UploadProcessingBanner />
    </Provider>
  );
}

describe("UploadProcessingBanner", () => {
  it("renders nothing when inactive", () => {
    const { container } = renderWithState(false, 0);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders count + label when active with N > 1", () => {
    renderWithState(true, 47);
    expect(screen.getByText(/Processing 47 files/i)).toBeInTheDocument();
    expect(screen.getByText(/Sync will start shortly/i)).toBeInTheDocument();
  });

  it("uses singular noun when count is 1", () => {
    renderWithState(true, 1);
    expect(screen.getByText(/Processing 1 file\b/i)).toBeInTheDocument();
  });

  it("falls back to generic copy when count is 0", () => {
    renderWithState(true, 0);
    expect(screen.getByText(/Processing your files/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/components/ui/__tests__/UploadProcessingBanner.test.tsx 2>&1 | tail -20`
Expected: FAIL — module not found.

**Step 3: Write the component**

```tsx
// app/components/ui/UploadProcessingBanner.tsx
"use client";

import { useAtomValue } from "jotai";
import { uploadProcessingAtom } from "@/lib/global-atoms/uploadProcessingAtoms";
import { Icons } from "@/components/ui";

export default function UploadProcessingBanner() {
  const { active, pendingFiles } = useAtomValue(uploadProcessingAtom);

  if (!active) return null;

  const label =
    pendingFiles === 0
      ? "Processing your files."
      : `Processing ${pendingFiles} ${pendingFiles === 1 ? "file" : "files"}.`;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-primary-80 bg-primary-50/5 mt-2">
      <Icons.Loader className="size-4 text-primary-50 animate-spin shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-grey-10">{label}</span>{" "}
        <span className="text-sm text-grey-50">Sync will start shortly…</span>
      </div>
    </div>
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run app/components/ui/__tests__/UploadProcessingBanner.test.tsx 2>&1 | tail -15`
Expected: `4 passed`.

**Step 5: Commit**

```bash
git add app/components/ui/UploadProcessingBanner.tsx app/components/ui/__tests__/UploadProcessingBanner.test.tsx
git commit -m "feat(ui): UploadProcessingBanner component"
```

---

## Task 14: Mount the listener and the banner

**Files:**
- Modify: `app/(pages)/SyncEventLogger.tsx`
- Modify: `app/(pages)/ResponsiveContent.tsx`

**Step 1: Mount the hook in `SyncEventLogger`**

Add to imports:
```ts
import { useUploadProcessing } from "@/lib/hooks/useUploadProcessing";
```

Inside the component body, alongside the existing hook calls:
```ts
  useUploadProcessing();
```

**Step 2: Mount the banner in `ResponsiveContent`**

Add to imports:
```ts
import UploadProcessingBanner from "@/components/ui/UploadProcessingBanner";
```

Inside the sticky toolbar JSX, add `<UploadProcessingBanner />` between `<ConflictsBanner />` and `<MigrationBanner />`:

```tsx
          <ConflictsBanner />
          <UploadProcessingBanner />
          <MigrationBanner />
```

**Step 3: Verify TS + lint**

Run: `pnpm tsc --noEmit && pnpm lint 2>&1 | tail -20`
Expected: clean.

**Step 4: Commit**

```bash
git add app/(pages)/SyncEventLogger.tsx app/(pages)/ResponsiveContent.tsx
git commit -m "feat(ui): mount upload-processing listener and banner"
```

---

## Task 15: Manual smoke test

**Step 1: Run the app**

Run: `pnpm tauri:dev`

**Step 2: Test the happy path**

- Log in.
- Pick a sync folder (or use an already-configured one).
- Drag-drop a folder containing ~50–200 files into the Files page.
- Confirm the top banner appears with the correct count: *"Processing N files. Sync will start shortly…"*
- Confirm the banner disappears as soon as the bottom-right widget shows non-zero progress for any file.

**Step 3: Test edge cases**

- Single small file: banner flashes briefly. Acceptable.
- Cancel before the disk copy completes (close the file picker): no banner appears (eligibility check passed but begin runs after — verify this).
- Large folder (1000+ files): banner shows for a few seconds, count is correct, dismisses on first byte.
- Logout while banner is showing: banner disappears immediately.
- Two quick uploads in succession: count accumulates; first chunk clears all.

**Step 4: Document any issues**

If any edge case fails, file a follow-up task; do not patch in this commit.

**Step 5: No commit needed for manual testing** — but note the smoke test result in the eventual PR description.

---

## Task 16: Final verification

**Step 1: All Rust tests**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`

**Step 2: All TS tests**

Run: `pnpm test 2>&1 | tail -20`

**Step 3: Lint everything**

Run: `cd src-tauri && cargo clippy --all -- -D warnings && cd .. && pnpm lint 2>&1 | tail -20`

**Step 4: Full build**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build && cd .. && pnpm build 2>&1 | tail -20`

All must pass before declaring the work complete.

---

## Files touched (summary)

**Created:**
- `src-tauri/src/sync/upload_processing.rs`
- `app/lib/global-atoms/uploadProcessingAtoms.ts`
- `app/lib/hooks/useUploadProcessing.ts`
- `app/components/ui/UploadProcessingBanner.tsx`
- `app/components/ui/__tests__/UploadProcessingBanner.test.tsx`

**Modified:**
- `src-tauri/src/sync/events.rs` (constant)
- `src-tauri/src/sync/mod.rs` (module export)
- `src-tauri/src/app_state.rs` (state field + initialization)
- `src-tauri/src/sync/files.rs` (`add_file`, `add_files`, `add_folder` + helper)
- `src-tauri/src/sync/lifecycle.rs` (`handle_transfer_progress`, `stop_sync`)
- `src-tauri/src/sync/tauri_bridge.rs` (SyncCompleted, SyncError clears)
- `app/(pages)/SyncEventLogger.tsx` (mount hook)
- `app/(pages)/ResponsiveContent.tsx` (mount banner)

## Non-goals (do NOT add)

- No cancel button on the banner.
- No frontend timeout fallback.
- No min-display-time for the banner.
- No per-drive granularity in the banner copy.
- No watchdog timer in v1 (deferred — terminal-event clears + first-chunk clear cover all observed paths). If a future bug surfaces a stuck banner, add a 60s watchdog inside `begin` then.
