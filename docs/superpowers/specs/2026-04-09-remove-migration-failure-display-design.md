# Remove Migration Failure Display from Frontend

**Date:** 2026-04-09
**Status:** Approved

## Problem

The server handles all migration retries and failure recovery. Showing failed file counts and file lists in the frontend is misleading -- the user cannot act on them, and the server may still be retrying.

## Solution

Remove all failure-related display from the migration UI. Migration always shows as successful from the user's perspective.

## Changes

### migrationAtoms.ts

Remove `failed` field from `MigrationProgress` interface and its default value.

### useMigration.ts

- Remove `failedCount` state and setter
- Remove `failedFiles` state and setter
- Remove the code in the event listener that sets `failedCount` from `result.failed`
- Remove the code that maps `result.failed_files` into the `failedFiles` array
- Remove `failedCount` and `failedFiles` from props passed to `MigrationCompleteDialog`
- Remove `failedCount`/`failedFiles` from state resets in `closeMigration` and `dismissAfterError`

### MigrationBanner.tsx

Remove the `progress.failed > 0` conditional block that shows "X failed" text.

### MigrationCompleteDialog.tsx

- Remove `failedCount` and `failedFiles` from props interface
- Remove `effectiveFailedCount` computation
- Remove `isPartialSuccess` -- all completions treated as full success
- Remove the "Failed" column from the 3-column stats grid (make it 2-column: Total / Migrated)
- Remove the scrollable failed files list
- Remove the "Failed files can still be accessed from your original S3 storage" help text
- Remove `hasFailed` logic

### Backend

No changes. Rust polling still receives failure data from the server for logging purposes.
