# Migration Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make migration survive app restarts by detecting in-progress server jobs and showing a persistent progress banner.

**Architecture:** Extend `check_migration` with an `is_in_progress` return case. Replace the `MigrationProgressDialog` modal with a `MigrationBanner` component rendered in the layout. Auto-resume polling on app relaunch.

**Tech Stack:** Rust (Tauri commands), TypeScript/React (Jotai atoms, Tauri event listeners), Radix UI ProgressBar

**Design doc:** `docs/plans/2026-04-07-migration-resilience-design.md`

---

### Task 1: Extend `MigrationCheckResult` with in-progress fields

**Files:**
- Modify: `src-tauri/src/sync/migration.rs` (struct at line 38, function at line 316)

**Step 1: Add fields to `MigrationCheckResult`**

In `src-tauri/src/sync/migration.rs`, add four fields to the struct (after `completion_status`):

```rust
/// Server migration is actively running (app was reopened mid-migration).
/// Frontend should show the progress banner and start polling.
pub is_in_progress: bool,
/// Current progress when `is_in_progress` is true.
pub progress_completed: u64,
pub progress_total: u64,
pub progress_failed: u64,
```

Update ALL existing `MigrationCheckResult` construction sites to include these fields with default values:
```rust
is_in_progress: false,
progress_completed: 0,
progress_total: 0,
progress_failed: 0,
```

There are 4 return sites in `check_migration` plus the final default return. Search for `MigrationCheckResult {` to find them all.

**Step 2: Add in-progress detection branch in `check_migration`**

In the section after "No pending files" (around line 316), add a NEW branch BEFORE the existing terminal status check. The logic order becomes:

1. (existing) Check terminal local status — early return
2. (existing) Check server for pending files — `needs_migration`
3. (existing) Cache path prefix
4. **NEW:** Local `in_progress` + server `in_progress` → `is_in_progress: true`
5. (existing) Local `in_progress` + server terminal → `needs_completion: true`
6. (existing) Default return

Insert this code between the `has_local_in_progress` definition and the existing terminal status check:

```rust
if has_local_in_progress
    && let Ok(job_status) = poll_migration_status_internal(&state, &account_id).await
    && job_status.status == "in_progress"
{
    info!(
        completed = job_status.completed,
        total = job_status.total,
        "Server migration still in progress — resuming tracking"
    );
    return Ok(MigrationCheckResult {
        needs_migration: false,
        file_count: 0,
        total_size: 0,
        files: vec![],
        sync_path: None,
        is_resuming: false,
        needs_completion: false,
        completion_status: None,
        is_in_progress: true,
        progress_completed: job_status.completed as u64,
        progress_total: job_status.total as u64,
        progress_failed: job_status.failed as u64,
    });
}
```

**Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Clean compilation (only the `trie-db` future-incompat warning)

**Step 4: Run existing tests**

Run: `cd src-tauri && cargo test -p Hippius -- migration`
Expected: All existing migration tests pass

**Step 5: Commit**

```bash
git add src-tauri/src/sync/migration.rs
git commit -m "feat: detect in-progress server migration in check_migration"
```

---

### Task 2: Add `migrationProgressAtom`

**Files:**
- Modify: `app/lib/global-atoms/migrationAtoms.ts`

**Step 1: Add the progress atom**

Append to `app/lib/global-atoms/migrationAtoms.ts`:

```typescript
export interface MigrationProgress {
  active: boolean;
  completed: number;
  total: number;
  failed: number;
}

/** Tracks live migration progress for the banner. */
export const migrationProgressAtom = atom<MigrationProgress>({
  active: false,
  completed: 0,
  total: 0,
  failed: 0,
});
```

**Step 2: Commit**

```bash
git add app/lib/global-atoms/migrationAtoms.ts
git commit -m "feat: add migrationProgressAtom for banner state"
```

---

### Task 3: Create `MigrationBanner` component

**Files:**
- Create: `app/components/ui/MigrationBanner.tsx`

**Step 1: Create the banner component**

Create `app/components/ui/MigrationBanner.tsx`:

```tsx
"use client";

import { useAtomValue } from "jotai";
import { migrationProgressAtom } from "@/lib/global-atoms/migrationAtoms";
import { ProgressBar, Icons } from "@/components/ui";

function formatCount(n: number): string {
  return n.toLocaleString();
}

export default function MigrationBanner() {
  const progress = useAtomValue(migrationProgressAtom);

  if (!progress.active) return null;

  const percentage =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-primary-80 bg-primary-50/5">
      <Icons.Loader className="size-4 text-primary-50 animate-spin shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-grey-10">
            Migrating files...
          </span>
          <span className="text-xs text-grey-50">
            {formatCount(progress.completed)} / {formatCount(progress.total)}
            {progress.failed > 0 && (
              <span className="text-error-50 ml-2">
                {formatCount(progress.failed)} failed
              </span>
            )}
          </span>
        </div>
        <ProgressBar value={percentage} className="h-1.5" />
      </div>
      <span className="text-xs font-medium text-primary-50 shrink-0">
        {percentage}%
      </span>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/components/ui/MigrationBanner.tsx
git commit -m "feat: add MigrationBanner component"
```

---

### Task 4: Wire banner into layout and MigrationChecker

**Files:**
- Modify: `app/(pages)/layout.tsx`
- Modify: `app/(pages)/MigrationChecker.tsx`
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Step 1: Mount banner in layout**

In `app/(pages)/layout.tsx`, import and render the banner inside the content area, after `MigrationChecker` and before the flex container:

```tsx
import MigrationBanner from "@/components/ui/MigrationBanner";

// In the return, add after <MigrationChecker />:
<MigrationChecker />
<MigrationBanner />
```

Wait — the banner needs to be inside the content area (not above the sidebar). Place it inside `ResponsiveContent` or just after `<Sidebar />`. Looking at the layout:

```tsx
<div className="flex min-h-screen w-full">
  <SyncFilesHandler />
  <Sidebar />
  <ResponsiveContent>{children}</ResponsiveContent>
</div>
```

The banner should appear above page content but after the sidebar. The best place is inside `ResponsiveContent`. Check what `ResponsiveContent` renders and add the banner at the top of its children. If `ResponsiveContent` just wraps `{children}` in a div, modify the layout to:

```tsx
<ResponsiveContent>
  <MigrationBanner />
  {children}
</ResponsiveContent>
```

**Step 2: Handle `is_in_progress` in MigrationChecker**

In `app/(pages)/MigrationChecker.tsx`, update the `checkMigration` handling. The `useMigration` hook's `checkMigration` function needs to detect `is_in_progress` from the Rust result and activate the banner.

In `useMigration.ts`, update the `checkMigration` callback. After the existing `needs_completion` check (around line 199), add:

```typescript
// Server migration actively running — show banner and start polling
if (result.is_in_progress) {
  appStore.set(migrationProgressAtom, {
    active: true,
    completed: result.progress_completed,
    total: result.progress_total,
    failed: result.progress_failed,
  });
  appStore.set(migrationLockAtom, true);
  activeAccountIdRef.current = accountId;
  startPolling(accountId);
  return true;
}
```

Add import for `migrationProgressAtom` at the top of `useMigration.ts`.

Also update the `MigrationCheckResult` TypeScript interface in `useMigration.ts` to include:
```typescript
is_in_progress: boolean;
progress_completed: number;
progress_total: number;
progress_failed: number;
```

**Step 3: Update poll handler to write to progress atom**

In the `startPolling` callback's event handler (the `listen("migration_progress", ...)` section), add a line to update the progress atom on each poll:

```typescript
// After setOverallProgress:
appStore.set(migrationProgressAtom, {
  active: true,
  completed: result.completed,
  total: result.total,
  failed: result.failed,
});
```

On terminal status (in the `TERMINAL_STATUSES.includes(result.status)` block), deactivate the banner:

```typescript
appStore.set(migrationProgressAtom, {
  active: false,
  completed: result.completed,
  total: result.total,
  failed: result.failed,
});
```

**Step 4: Switch `launchServerMigration` from modal to banner**

In `launchServerMigration`, change:
- Remove `setCurrentStep("progress")` at the top
- After `start_server_migration` succeeds, before `startPolling`:

```typescript
// Dismiss any open dialogs
setCurrentStep(null);

// Activate the banner
appStore.set(migrationProgressAtom, {
  active: true,
  completed: 0,
  total: fileCount,
  failed: 0,
});
```

Note: `launchServerMigration` needs access to `fileCount`. It's already available in the hook's state.

**Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add app/(pages)/layout.tsx app/(pages)/MigrationChecker.tsx \
  app/components/page-sections/files/migration/useMigration.ts \
  app/components/ui/MigrationBanner.tsx
git commit -m "feat: wire migration banner into layout and poll handler"
```

---

### Task 5: Remove `MigrationProgressDialog`

**Files:**
- Delete: `app/components/page-sections/files/migration/MigrationProgressDialog.tsx`
- Delete: `app/components/page-sections/files/migration/__tests__/MigrationProgressDialog.test.tsx`
- Modify: `app/(pages)/MigrationChecker.tsx` — remove the `"progress"` step rendering
- Modify: `app/components/page-sections/files/migration/useMigration.ts` — remove `"progress"` from `MigrationStep` type
- Modify: `app/components/page-sections/files/migration/index.ts` — remove re-export

**Step 1: Remove `"progress"` step from MigrationChecker**

In `app/(pages)/MigrationChecker.tsx`, remove the entire block:
```tsx
{migration.currentStep === "progress" && (
  <MigrationProgressDialog ... />
)}
```

Remove the `MigrationProgressDialog` import.

**Step 2: Remove `"progress"` from MigrationStep type**

In `useMigration.ts`, change:
```typescript
export type MigrationStep = "prompt" | "skip-confirm" | "setup" | "progress" | "complete";
```
to:
```typescript
export type MigrationStep = "prompt" | "skip-confirm" | "setup" | "complete";
```

Search for any remaining references to `setCurrentStep("progress")` and remove/replace them.

**Step 3: Remove the export from the barrel file**

In `app/components/page-sections/files/migration/index.ts`, remove the `MigrationProgressDialog` export line.

**Step 4: Delete the files**

```bash
rm app/components/page-sections/files/migration/MigrationProgressDialog.tsx
rm app/components/page-sections/files/migration/__tests__/MigrationProgressDialog.test.tsx
```

**Step 5: Clean up useMigration return type**

Remove these from `UseMigrationReturn` and the return object if they are only used by the progress dialog:
- `files` (still used by completion dialog for `failedFiles` — keep)
- `currentFileIndex` (only used by progress dialog — remove)
- `overallProgress` (only used by progress dialog — remove)

Actually, check each consumer before removing. The completion dialog uses `successCount`, `failedCount`, `failedFiles`. The prompt uses `fileCount`, `totalSize`. The banner uses the atom. So `currentFileIndex` and `overallProgress` can likely be removed from the return type but keep the internal state if the poll handler still uses them for the atom calculation.

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove MigrationProgressDialog, replaced by banner"
```

---

### Task 6: Clear banner and lock on completion/dismiss/cancel

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Step 1: Update closeMigration**

In `closeMigration`, add at the start:
```typescript
appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
```

**Step 2: Update cancelMigration**

In `cancelMigration`, add after `stopPolling()`:
```typescript
appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
```

**Step 3: Update confirmSkip**

In `confirmSkip`, add:
```typescript
appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
```

**Step 4: Update dismissAfterError**

In `dismissAfterError`, add:
```typescript
appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
```

**Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add app/components/page-sections/files/migration/useMigration.ts
git commit -m "fix: clear migration banner on all exit paths"
```

---

### Task 7: Test the full flow

**Manual test scenarios:**

1. **Fresh migration:**
   - Log in with an account that has pending S3 files
   - Prompt dialog appears -> click "Migrate" -> setup dialog -> enter password
   - Banner appears (no modal) with progress updating every 3s
   - On completion -> completion dialog
   - After dismiss -> banner gone, sync starts

2. **App restart during migration:**
   - Start a migration, see the banner
   - Close the app (Cmd+Q)
   - Reopen the app
   - Banner appears immediately with current progress (no prompt/setup dialogs)
   - Progress continues updating

3. **App restart after migration completed while closed:**
   - Start a migration, close the app
   - Wait for server to finish
   - Reopen the app
   - Completion dialog appears (existing behavior, unchanged)

4. **Cancel migration:**
   - Start a migration, see the banner
   - (If cancel is exposed — currently only in progress modal which is removed)
   - Consider if cancel should be on the banner — DEFERRED, not in this plan

**Automated tests:**

Run: `cd src-tauri && cargo test -p Hippius -- migration`
Expected: All Rust tests pass

Run: `pnpm test` (if vitest is configured)
Expected: Frontend tests pass (MigrationProgressDialog tests are deleted)

**Step 1: Commit any test fixes**

```bash
git add -A
git commit -m "test: verify migration resilience flow"
```
