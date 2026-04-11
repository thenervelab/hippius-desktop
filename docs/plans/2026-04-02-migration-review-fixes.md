# Migration Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 10 issues identified in the code review of the migration transition commit.

**Architecture:** Fixes span Rust backend (migration.rs, app_state.rs, syncing.rs) and TypeScript frontend (useMigration.ts, migrationAtoms.ts, MigrationProgressDialog.tsx). Most changes are surgical edits to existing files.

**Tech Stack:** Rust/Tauri, TypeScript/React, Jotai atoms

---

### Task 1: Add `migration_client` to AppState and reuse it (Issue #3)

**Files:**
- Modify: `src-tauri/src/app_state.rs` (add field + init)
- Modify: `src-tauri/src/commands/migration.rs` (use shared client)

**Changes:**
1. In `MigrationState`, add `pub client: reqwest::Client`
2. In `MigrationState::new()`, build it with `danger_accept_invalid_certs(true)`
3. In `start_server_migration`, `poll_migration_status`, `cancel_server_migration`: replace `reqwest::Client::builder()...build()?` with `state.migration.client.clone()`
4. In `report_migrated_files` and `fetch_migration_files`: also use the shared client (pass it through or access via AppState)

### Task 2: Extract API key constant (Issue #5)

**Files:**
- Modify: `src-tauri/src/commands/migration.rs`

**Changes:**
1. Add `const MIGRATION_API_KEY: &str = "Arion";` near the top constants
2. Replace all `"Arion"` string literals with `MIGRATION_API_KEY`

### Task 3: Use `complete_migration_transition` in `closeMigration` (Issue #1)

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Changes:**
1. In `closeMigration`, replace the manual `dismiss_migration` + `initialize_sync` calls with a single `invoke("complete_migration_transition", { accountId, existingMnemonic })`
2. Keep the atom resets and state cleanup

### Task 4: Remove backward-compat stubs from return value (Issue #8)

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`
- Modify: `app/components/page-sections/files/migration/MigrationProgressDialog.tsx`
- Modify: `app/(pages)/MigrationChecker.tsx`

**Changes:**
1. Remove `phase`, `uploadedCount`, `currentUploadFile` from `UseMigrationReturn` interface and return statement
2. Remove these optional props from `MigrationProgressDialogProps`
3. Remove usage in `MigrationProgressDialog` — the server migration flow is download-only (no local upload phase), so always show "downloading" UI
4. Remove the props from `MigrationChecker.tsx` where they're passed

### Task 5: Add backend migration lock check (Issue #4)

**Files:**
- Modify: `src-tauri/src/app_state.rs` (add `in_progress: AtomicBool` to MigrationState)
- Modify: `src-tauri/src/commands/migration.rs` (set flag in start/complete)
- Modify: `src-tauri/src/commands/syncing.rs` (check flag in initialize_sync)

**Changes:**
1. Add `pub in_progress: AtomicBool` to `MigrationState`
2. Set `true` in `start_server_migration` and `start_migration`
3. Set `false` in `complete_migration_transition`, `cancel_server_migration`, `cancel_migration`
4. In `initialize_sync_inner`: if `migration.in_progress` is true AND label != "migration", return error

### Task 6: Move `path_prefix` derivation to backend (Issue #6)

**Files:**
- Modify: `src-tauri/src/commands/migration.rs`
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Changes:**
1. In `start_server_migration`, make `path_prefix` an `Option<String>`
2. If `None` or empty, derive it server-side by querying migration files and extracting the first bucket name
3. In frontend `launchServerMigration`, pass `pathPrefix` as optional (still derive from files[0] as hint, but backend validates)

### Task 7: Add poll failure feedback (Issue #9)

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Changes:**
1. Add `consecutiveFailures` ref
2. On poll success, reset to 0
3. On poll failure, increment; after 3 consecutive failures, show toast warning
4. After 10 consecutive failures, stop polling and show error

### Task 8: Fix `setFailedFiles` accumulation (Issue #10)

**Files:**
- Modify: `app/components/page-sections/files/migration/useMigration.ts`

**Changes:**
1. The server returns cumulative failed_files, so the current overwrite behavior is correct
2. Add a comment documenting this assumption

### Task 9: Add tests for extractable logic (Issue #7)

**Files:**
- Modify: `src-tauri/src/commands/migration.rs` (add tests)

**Changes:**
1. Extract `derive_path_prefix(files: &[MigrationFile]) -> String` as a pure function
2. Extract `derive_folder_hash(label: &str) -> String` as a pure function
3. Add tests for both

### Task 10: Address encryption key security concern (Issue #2)

**Files:**
- Modify: `src-tauri/src/commands/migration.rs`

**Changes:**
1. Remove `danger_accept_invalid_certs(true)` from the migration client — use proper TLS validation for requests that send the encryption key
2. If the server uses self-signed certs in dev, gate `danger_accept_invalid_certs` behind a compile-time `#[cfg(debug_assertions)]` flag
