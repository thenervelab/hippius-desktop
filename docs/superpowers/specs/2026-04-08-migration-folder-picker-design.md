# Migration Folder Picker Design

**Date:** 2026-04-08
**Status:** Approved

## Problem

When migrating files from S3 to HCFS, the local destination folder is auto-generated as `~/Documents/Hippius-Migration-YYYY-MM-DD` with no user input. Users should be able to choose where migrated files land locally.

## Solution

Add a folder picker to the `MigrationPromptDialog` (before migration starts). The user picks the local folder upfront, and the chosen path is used when `complete_migration_transition` initializes sync after the server-side migration finishes.

Server-side migration is unaffected -- it always targets the "default" HCFS folder. Only the local sync path changes.

## Approach

Approach 1 (selected): Folder picker integrated into the existing `MigrationPromptDialog`, with the path passed through the migration flow to `complete_migration_transition`.

## Backend Changes

### `complete_migration_transition` (sync/migration.rs)

- Add an optional `custom_sync_path: Option<String>` parameter.
- If provided and non-empty, use it directly (validate the path exists or create it).
- If `None`, fall back to the existing `compute_default_sync_path()` behavior.
- The IPC command wrapping this function passes the path from the frontend.

### New command: `get_default_migration_path` (sync/migration.rs)

- Returns the auto-generated default path string (`~/Documents/Hippius-Migration-YYYY-MM-DD`).
- Called by the frontend to pre-populate the folder picker.

## Frontend Changes

### MigrationPromptDialog

- Add a folder picker row below the migration info (file count, size) and above the action buttons.
- Pre-populate with the result of `get_default_migration_path` Rust command.
- "Browse" button uses Tauri's `open()` dialog API for folder selection.
- Display the selected path in a truncated text field.
- Store the chosen path in the migration atom state.

### Migration atom state (migrationAtoms.ts)

- Add a `syncPath: string | null` field to the migration atom.
- Set when the user picks a folder in the prompt dialog.
- Read when `complete_migration_transition` is called in the complete dialog.

### MigrationCompleteDialog

- Pass the stored `syncPath` from the atom to `complete_migration_transition`.
- No other UI changes.

### MigrationBanner

- No changes needed.

## Edge Cases

### Path validation (Rust side)

- Non-empty directory: allowed -- sync merges files into it.
- Path doesn't exist: create it (same as `compute_default_sync_path` does today).
- Path creation fails (permissions, invalid path): return error, frontend displays it.

### Crash recovery

- The chosen path is stored in the migration atom (in-memory).
- If the app crashes mid-migration and restarts, `check_migration` detects the in-progress job and resumes, but the custom path is lost.
- On resume, fall back to `compute_default_sync_path()`. Acceptable since crash-during-migration is rare and the user can move the folder later.

### Path conflicts

- If the user picks a folder already used as a sync path for another label, allow it -- the sync engine handles this via the `UNIQUE(owner, label)` constraint, and the "default" label won't conflict.

## Key Files

- `src-tauri/src/sync/migration.rs` -- `complete_migration_transition`, `compute_default_sync_path`, new `get_default_migration_path`
- `app/components/page-sections/files/migration/MigrationPromptDialog.tsx` -- folder picker UI
- `app/components/page-sections/files/migration/useMigration.ts` -- migration hook, calls complete_migration_transition
- `app/lib/global-atoms/migrationAtoms.ts` -- migration atom state (add syncPath field)
- `app/components/page-sections/files/migration/MigrationCompleteDialog.tsx` -- passes syncPath to complete call
