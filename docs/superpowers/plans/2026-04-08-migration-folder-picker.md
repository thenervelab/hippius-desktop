# Migration Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose the local folder where migrated files sync to, instead of auto-generating `~/Documents/Hippius-Migration-YYYY-MM-DD`.

**Architecture:** Add a folder picker to `MigrationPromptDialog`. Store the chosen path in the migration atom. Pass it through to `complete_migration_transition` in Rust, which uses it instead of `compute_default_sync_path()`.

**Tech Stack:** Rust (Tauri IPC commands), TypeScript/React (Tauri dialog API, Jotai atoms)

---

### Task 1: Bump hcfs dependencies to 72c7f50

**Files:**
- Modify: `src-tauri/Cargo.toml:96-97`

- [ ] **Step 1: Update both hcfs dependency revisions**

In `src-tauri/Cargo.toml`, change lines 96-97 from:
```toml
hcfs-client = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "95461347bb44106b0d2aba9cc214d36789c331d5" }
hcfs-shared = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "95461347bb44106b0d2aba9cc214d36789c331d5" }
```
To:
```toml
hcfs-client = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "72c7f50" }
hcfs-shared = { git = "ssh://git@github.com/thenervelab/hcfs.git", rev = "72c7f50" }
```

- [ ] **Step 2: Build and fix any breaking changes**

Run: `cd src-tauri && cargo build 2>&1`
Expected: Clean build (or fix any API changes from the new hcfs revision).

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test 2>&1`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump hcfs-client and hcfs-shared to 72c7f50"
```

---

### Task 2: Add `get_default_migration_path` Rust command

**Files:**
- Modify: `src-tauri/src/sync/migration.rs`
- Modify: `src-tauri/src/main.rs` (register command in `tauri::generate_handler![]`)

- [ ] **Step 1: Make `compute_default_sync_path` public and add IPC wrapper**

In `src-tauri/src/sync/migration.rs`, change `compute_default_sync_path` visibility from `fn` to `pub(crate) fn` (line 425):

```rust
pub(crate) fn compute_default_sync_path() -> Result<PathBuf> {
```

Then add the new IPC command after `compute_default_sync_path` (after line 443):

```rust
/// Return the auto-generated default migration sync path as a string.
///
/// Called by the frontend to pre-populate the folder picker in the
/// migration prompt dialog.
#[tauri::command]
pub fn get_default_migration_path() -> Result<String> {
    let path = compute_default_sync_path()?;
    Ok(path.to_string_lossy().to_string())
}
```

- [ ] **Step 2: Register the command in main.rs**

In `src-tauri/src/main.rs`, find the `tauri::generate_handler![]` macro invocation and add `crate::sync::migration::get_default_migration_path` to the list, near the other migration commands.

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo build 2>&1`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync/migration.rs src-tauri/src/main.rs
git commit -m "feat(migration): add get_default_migration_path IPC command"
```

---

### Task 3: Add `custom_sync_path` parameter to `complete_migration_transition`

**Files:**
- Modify: `src-tauri/src/sync/migration.rs:453-497`

- [ ] **Step 1: Add the parameter and use it**

Change the `complete_migration_transition` function signature and body. Replace the existing function (lines 453-497) with:

```rust
#[tauri::command]
pub async fn complete_migration_transition(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    custom_sync_path: Option<String>,
) -> Result<crate::sync::lifecycle::InitSyncResult> {
    let pool = state.pool()?;

    // 1. Clear migration-in-progress flag so initialize_sync isn't blocked.
    state.migration.in_progress.store(false, Ordering::SeqCst);

    // 2. Ensure a sync path exists for "default". New migration users won't
    //    have one yet; existing users who already configured sync will.
    let has_sync_path = crate::sync::config::get_sync_path_for_label(pool, &account_id, "default").await.is_ok();

    if !has_sync_path {
        let sync_path = match custom_sync_path.filter(|p| !p.is_empty()) {
            Some(path) => std::path::PathBuf::from(path),
            None => compute_default_sync_path()?,
        };
        std::fs::create_dir_all(&sync_path)?;
        let path_str = sync_path.to_string_lossy().to_string();
        crate::sync::paths::set_sync_path_internal(pool, &account_id, &path_str, false, Some("default")).await?;
        info!("Created default sync path at '{}' for migration completion", path_str);
    }

    // 3. Initialize the "default" drive and start the sync loop.
    let mnemonic_z = crate::sync::mnemonic::get_mnemonic_for_account(&state, &account_id).await?;
    let mnemonic = (*mnemonic_z).clone();
    drop(mnemonic_z);
    let result = crate::sync::lifecycle::initialize_sync(app, account_id.clone(), "default".to_string(), Some(mnemonic)).await?;

    // 4. Mark migration as completed ONLY after sync init succeeds.
    let server_url = get_server_url(pool, &account_id).await.unwrap_or_default();
    upsert_migration_status(pool, &account_id, "completed", 0, 0, "[]", "", &server_url).await?;
    info!("Migration completed for account {account_id}");

    Ok(result)
}
```

The only changes from the original are:
- Added `custom_sync_path: Option<String>` parameter
- Replaced `compute_default_sync_path()?` with a match that uses the custom path if provided

- [ ] **Step 2: Build and run tests**

Run: `cd src-tauri && cargo build && cargo test 2>&1`
Expected: Clean build, all tests pass. The new parameter is optional so existing callers (frontend) will still work (Tauri deserializes missing fields as `None`).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sync/migration.rs
git commit -m "feat(migration): accept custom_sync_path in complete_migration_transition"
```

---

### Task 4: Add `syncPath` field to migration atoms

**Files:**
- Modify: `app/lib/global-atoms/migrationAtoms.ts`

- [ ] **Step 1: Add syncPath to MigrationCheckState**

In `app/lib/global-atoms/migrationAtoms.ts`, add `syncPath` to the `MigrationCheckState` interface and default it to `null` in the atom:

Add to the interface (after `shouldCheck`):
```typescript
  syncPath: string | null;
```

Add to the atom default (after `shouldCheck: false`):
```typescript
  syncPath: null,
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/georgiosdelkos/Documents/Source/Bitensor/hippius-desktop && pnpm build 2>&1 | tail -5`
Expected: Build succeeds. Since we added a new field with a default, existing code that spreads the atom value will pick up the default.

- [ ] **Step 3: Commit**

```bash
git add app/lib/global-atoms/migrationAtoms.ts
git commit -m "feat(migration): add syncPath field to migration check atom"
```

---

### Task 5: Add folder picker to MigrationPromptDialog

**Files:**
- Modify: `app/components/page-sections/files/migration/MigrationPromptDialog.tsx`

- [ ] **Step 1: Add imports and state**

Add these imports at the top of the file:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
```

Update the props interface to include a callback for the chosen path:

```typescript
export interface MigrationPromptDialogProps {
    open: boolean;
    onMigrate: (syncPath: string) => void;
    onSkip: () => void;
    fileCount: number;
    totalSize: number;
}
```

- [ ] **Step 2: Add folder picker state and logic**

Inside the component function, add state and effects:

```typescript
const [syncPath, setSyncPath] = useState<string>("");

useEffect(() => {
    if (!props.open) return;
    invoke<string>("get_default_migration_path")
        .then(setSyncPath)
        .catch(() => setSyncPath(""));
}, [props.open]);

const handleBrowse = async () => {
    const selected = await open({
        directory: true,
        title: "Choose migration folder",
        defaultPath: syncPath || undefined,
    });
    if (selected) {
        setSyncPath(selected);
    }
};
```

(Use `props.open` as the variable name -- check the actual component to see if it destructures props or uses `props.` prefix, and adjust accordingly.)

- [ ] **Step 3: Add folder picker UI**

Add a folder picker row in the dialog body, between the migration info text and the action buttons. The exact JSX:

```tsx
<div className="flex flex-col gap-1.5 mt-4">
    <label className="text-sm font-medium text-grey-30">
        Destination Folder
    </label>
    <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 px-3 py-2 bg-grey-90 rounded-lg border border-grey-80">
            <p className="text-sm text-grey-30 truncate" title={syncPath}>
                {syncPath || "Loading..."}
            </p>
        </div>
        <button
            type="button"
            onClick={handleBrowse}
            className="shrink-0 px-3 py-2 text-sm font-medium text-grey-30 bg-grey-90 rounded-lg border border-grey-80 hover:bg-grey-80 transition-colors"
        >
            Browse
        </button>
    </div>
</div>
```

- [ ] **Step 4: Pass syncPath to onMigrate**

Update the "Migrate My Files" button's onClick to pass the path:

```tsx
onClick={() => onMigrate(syncPath)}
```

- [ ] **Step 5: Verify it compiles**

Run: `pnpm build 2>&1 | tail -5`
Expected: May show type errors in parent components that call `onMigrate` without the argument -- that's expected, fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add app/components/page-sections/files/migration/MigrationPromptDialog.tsx
git commit -m "feat(migration): add folder picker to MigrationPromptDialog"
```

---

### Task 6: Wire folder picker through useMigration and MigrationCompleteDialog

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`
- Modify: `app/components/page-sections/files/migration/MigrationCompleteDialog.tsx` (only if needed)

- [ ] **Step 1: Update useMigration to store and pass syncPath**

In `useMigration.ts`, find where the migration prompt's `onMigrate` callback is defined. It needs to:

1. Accept the `syncPath` string parameter from the dialog
2. Store it in the migration check atom (set `syncPath` field)
3. Pass it to `complete_migration_transition` in the `closeMigration` callback

Find the `onMigrate` handler (likely called `handleMigrate` or similar) and update it to accept and store the path:

```typescript
// In the handleMigrate / startMigration callback:
const handleMigrate = (syncPath: string) => {
    appStore.set(migrationCheckAtom, (prev) => ({ ...prev, syncPath }));
    // ... existing migration start logic
};
```

Then in the `closeMigration` callback (around line 328), update the invoke call to pass the stored path:

```typescript
const migrationState = appStore.get(migrationCheckAtom);
await invoke("complete_migration_transition", {
    accountId,
    customSyncPath: migrationState.syncPath,
});
```

- [ ] **Step 2: Clear syncPath on reset**

In the `closeMigration` callback, where the migration check atom is reset (around line 339), ensure `syncPath` is set to `null`:

```typescript
appStore.set(migrationCheckAtom, {
    checked: true,
    needsMigration: false,
    fileCount: 0,
    totalSize: 0,
    shouldCheck: false,
    syncPath: null,
});
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build 2>&1 | tail -10`
Expected: Clean build, no type errors.

- [ ] **Step 4: Run frontend tests**

Run: `pnpm test 2>&1 | tail -20`
Expected: All tests pass (or only pre-existing failures in SyncStatusHandler).

- [ ] **Step 5: Commit**

```bash
git add app/components/page-sections/files/migration/useMigration.ts app/lib/global-atoms/migrationAtoms.ts
git commit -m "feat(migration): wire folder picker path through migration flow"
```

---

### Task 7: Update CLAUDE.md and final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

In the migration-related section or under Key Patterns, add a note about the folder picker. If no migration section exists, add it near the sync documentation:

```markdown
**Migration folder picker**: The `MigrationPromptDialog` includes a folder picker pre-populated with the default migration path (`~/Documents/Hippius-Migration-YYYY-MM-DD`). The chosen path is stored in `migrationCheckAtom.syncPath` and passed to `complete_migration_transition` as `custom_sync_path`. If not provided, falls back to the auto-generated default.
```

- [ ] **Step 2: Full build and test**

Run:
```bash
cd src-tauri && cargo build && cargo clippy --all -- -D warnings && cargo test
cd .. && pnpm build && pnpm test
```
Expected: All clean.

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: document migration folder picker in CLAUDE.md"
git push origin sync-engine
```
