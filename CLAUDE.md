# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MUST-DO Rule for AI Agents (Claude and all others)

**Business logic MUST live in the Rust backend (`src-tauri/`). Frontend-only concerns MUST stay in the TypeScript frontend (`app/`).**

- All business logic — data processing, state transitions, persistence, network/IPC, blockchain, crypto, sync, validation, and domain rules — goes in `src-tauri/` (Rust).
- The `app/` TypeScript frontend is for UI, presentation, routing, and user interaction only. It calls into Rust via Tauri `invoke()` and listens to backend events.
- Do NOT implement business logic in TypeScript. If a feature needs logic, add a Rust command in `src-tauri/` and call it from the frontend.

## Overview

Hippius Desktop is a Tauri 2.0 application combining a Next.js 15 frontend with a Rust backend. It provides encrypted file sync, blockchain wallet management, VM provisioning, VPN (Nebula), and billing — all integrated with the Hippius/Bittensor network.

## Coding rules
When writing code on this project we ALWAYS try to put the buisness logic in the RUST side of the project in /src-tauri and interface with the frontend /app instead of writting it to the frontend.
When making a change on the code make sure to include tests for it. Do not add dummy tests that are never going to help us identify issues we need proper testing.
When making a change on the code make sure to add documentation on the code and also update the CLAUDE.md.

## Build & Development Commands

```bash
pnpm install                    # Install frontend dependencies
pnpm dev                        # Next.js dev server (localhost:3000)
pnpm tauri:dev                  # Full desktop dev (frontend + Rust backend)
pnpm build                      # Production frontend build (static export to out/)
pnpm tauri:build                # Full desktop production build
pnpm lint                       # ESLint

# Rust backend (from src-tauri/)
cd src-tauri
cargo build                     # Build Rust backend
cargo clippy --all -- -D warnings
cargo fmt --all
cargo test                      # All Rust tests
cargo test --test auth_commands # Single test file
SQLX_OFFLINE=true cargo build   # Required for CI (offline SQLx mode)
RUST_LOG=debug pnpm tauri:dev   # With debug logging
```

**Prerequisites:** Node.js v18+, pnpm 9.12.3+, Rust toolchain. A `src-tauri/.env` file must exist (referenced in tauri.conf.json resources).

## Architecture

### Frontend → Backend Communication

All frontend-to-backend calls go through Tauri IPC via `invoke()` from `@tauri-apps/api/core`. Backend commands are Rust functions annotated with `#[tauri::command]` and registered in `src-tauri/src/main.rs` via `tauri::generate_handler![]`. Backend-to-frontend events use `app.emit()` (Rust) and `listen()` (TypeScript).

### Frontend Structure (app/)

- **`app/(pages)/`** — Next.js route groups: files, wallet, stake/unstake, vm, billing, notifications, support, referrals, bridge. Also contains invisible event-listener components mounted in the layout: `SyncEventLogger`, `ConflictEventListener`, `MigrationChecker`, `SyncFilesHandler`.
- **`app/lib/wallet-auth-context.tsx`** — Central auth provider (login, session restore, logout, token refresh). Wraps the entire app.
- **`app/lib/global-atoms/`** — Jotai atoms for global state (polkadot API, sync status, migration)
- **`app/lib/store/jotaiStore.ts`** — Standalone Jotai store (`appStore`) used outside React (e.g., tray sync)
- **`app/lib/hooks/`** — Custom hooks: `useHcfsSync` (sync init), `useSyncEvents` (event listeners), `useSyncProgress` (progress tracking), `useStagedChanges` (conflict review), `useTraySync` (system tray)
- **`app/lib/utils/`** — Utility functions including `hcfsConfigUtils.ts` (sync config), `syncPathUtils.ts` (path CRUD)
- **`app/components/tray/`** — System tray UI components

**Path aliases** (tsconfig.json): `@/components/*` → `app/components/*`, `@/lib/*` → `app/lib/*`, `@/services/*` → `app/lib/services/*`

### Backend Structure (src-tauri/src/)

- **`main.rs`** — Entry point. Registers all IPC commands, initializes plugins, sets up single-instance and deep-link handling. `lib.rs` re-exports all modules for integration tests.
- **`error.rs`** — `AppError` enum with `thiserror` for structured error handling. Custom `Serialize` produces `{ "kind": "...", "message": "..." }` for frontend error matching. `NotReadyKind` enum gives machine-readable variants for auth/sync readiness errors.
- **`app_state.rs`** — Centralized `AppState` struct with sub-states: `AuthInfo`, `BlockchainState`, `BlockSubscriptionState`, `OAuthState`, `NebulaState`, `MigrationState`, and `SyncRunner` (Arc). Also holds shared `reqwest::Client` for API calls and `tokio::sync::Notify` for drive-removal wakeups.
- **`auth/`** — Authentication and account management: `login.rs` (mnemonic login), `logout.rs`, `session_restore.rs` (boot-time session rehydration), `service.rs` (token refresh, key derivation), `accounts.rs` (sub-account CRUD, import/export with encryption), `oauth.rs` (OAuth flow), `ssh_keys.rs`, `billing_auth.rs` (billing API auth), `tokens.rs` (token helpers), `keychain.rs` (OS keychain), `contacts.rs`, `state.rs` (AuthInfo struct), `account_key.rs` (account key hashing), `auth_session_repo.rs` (SQLite session CRUD with inline tests).
- **`sync/`** — Core sync engine (16 submodules): `lifecycle.rs` (init, auto-init, teardown, progress handler setup), `control.rs` (start/stop/pause drive commands), `files.rs` (file listing, recent files, user files with parallel folder listing), `folders.rs` (folder CRUD), `paths.rs` (sync path DB operations), `config.rs` (HCFS config loading), `progress.rs` (in-memory session/file progress tracking), `status.rs` (sync status queries), `events.rs` (event name constants and payload structs), `logic.rs` (pure I/O-free helpers: snapshot throttling), `migration.rs` (S3→HCFS migration: check, start, poll, complete_migration_transition), `mnemonic.rs` (mnemonic resolution for sync), `remote.rs` (remote folder operations), `selective.rs` (selective sync), `device.rs` (device name), `tauri_bridge.rs` (OnceLock-based event dispatch to Tauri).
- **`blockchain/`** — Substrate/Polkadot integration: `client.rs` (RPC client with double-check lock pattern), `queries.rs` (balance, staking info with snapshot-consistent reads), `staking.rs` (stake/unstake commands), `transfers.rs` (balance transfers), `subscription.rs` (block subscription), `convert.rs` (unit conversion), `helpers.rs` (signer extraction), `state.rs`, `types.rs`, `runtime.rs`.
- **`billing/`** — Billing and credits: `charts.rs` (chart data formatting), `credits.rs` (credit balance queries), `queries.rs` (billing API queries), `subscriptions.rs` (plan management).
- **`api/`** — HTTP clients: `client.rs` (generic Hippius API client), `indexer.rs` (indexer API).
- **`crypto/`** — Encryption at rest: `store.rs` (HKDF-SHA256 key derivation, ChaCha20-Poly1305 AEAD encrypt/decrypt, `migrate_if_needed` for transparent plaintext→encrypted migration of sub-account seed phrases).
- **`nebula/`** — Nebula VPN management (download, install, start, certificate handling). **Permission escalation** (macOS osascript / Linux pkexec) for the Nebula binary is requested ONLY when the user enables the VPN via `toggle_vpn_status`, never during app startup or splash screen.
- **`notifications/`** — Notification management commands.
- **`infra/`** — VM provisioning and support ticket commands.
- **`utils/`** — Schema management (`schema.rs` with `ensure_table_schema()`), bookmarks, preferences, platform info, tray menu, support helpers.

### Key Patterns

**Global state in Rust** is centralized in `AppState` (`app_state.rs`), registered via `app.manage(AppState::new())` at startup. Sub-states: `AuthInfo`, `BlockchainState`, `BlockSubscriptionState`, `OAuthState`, `NebulaState`, `MigrationState`, and `SyncRunner` (Arc). Also holds a shared `reqwest::Client` for connection pooling and a `tokio::sync::Notify` for drive-removal wakeups. Command handlers access it via `tauri::State<'_, AppState>`, background tasks via `app.state::<AppState>()`. The DB pool uses `OnceLock` within AppState. No module-level `static` variables remain.

**Multi-drive sync**: Drives are keyed by label string. The sync loop iterates all drives sequentially (round-robin). `SyncActivityItem` includes a `label` field; all Tauri events include `"label"` in JSON payload. DB constraint: `UNIQUE(owner, label)` in sync_paths table.

**hcfs-client dependency**: The sync engine delegates to `hcfs-client` (from the `hcfs` repo, pinned to a git rev in Cargo.toml). Drive API: `new()`, `init()`, `unlock()`, `sync_async(SyncMode)`, `stage()`, `set_config()`, `set_progress_handlers()`. All file encryption is handled by hcfs-client via BIP-39 mnemonic.

**Rename detection**: The file watcher captures OS rename events (From/To pairs from the `notify` crate) and stores them as `RenameHint` structs in `SyncRunner.rename_hints`. Before each sync cycle, the hints are drained, converted to relative paths, and expanded into per-file hints. The pairing/expansion logic lives in `hcfs-client` (fully tested there). When hcfs-client gains rename support (thenervelab/hcfs#52), the hints will be passed through to avoid redundant delete+re-upload cycles for renamed files.

**SQLite**: Database pool lives in `AppState` as a `OnceLock<SqlitePool>`. Schema is maintained via `ensure_table_schema()` in `utils/schema.rs` (not migration files). Access pattern: `state.pool()?` (from command handlers) or `app.state::<AppState>().pool()?` (from background tasks).

**Logging**: All Rust code uses `tracing` macros (`info!`, `debug!`, `warn!`, `error!`) — never `println!`/`eprintln!`. The subscriber is initialized in `main.rs` with module-path targets. Set `RUST_LOG=debug` for verbose output.

**Frontend static export**: Next.js is configured with `output: "export"` — no server-side rendering. All data fetching happens client-side via Tauri IPC or TanStack Query.

**User preferences**: Generic key-value store in SQLite (`user_preferences` table) accessed via `get_user_preference` / `save_user_preference` Rust commands. Frontend wrapper in `app/lib/utils/userPreferencesDb.ts` provides typed helpers including `getLastBrowseDirectory()` / `saveLastBrowseDirectory()` which remember the last directory the user browsed to in file/folder pickers (fallback chain: last browse dir → home dir → OS default). Used by `FileDropzone`, `FolderUploadDialog`, and `FolderToFolderUploadDialog`.

**Asset protocol scope**: The static scope in `tauri.conf.json` is `$HOME/.hippius/**` (for HCFS drive metadata). User-chosen sync folders live at arbitrary paths, so the scope is expanded at runtime via `app.asset_protocol_scope().allow_directory(path, true)`. This happens in three places: `set_sync_path` (when user configures a new path), `initialize_sync_inner` (on every sync start/restart), and the frontend `tryAutoInitSync` (belt-and-suspenders at login). The `allow_asset_scope` IPC command is also exposed for direct frontend use. The helper `allow_asset_directory()` lives in `sync/files.rs`.

**Sync widget anti-flicker**: The sync status widget (`SyncStatusDialog` + `SyncStatusHandler`) uses multiple layered guards to prevent visual flicker: (1) **Unconditional finalization emit** — `finalize_session_for_label` in hcfs-client always calls `runner.emit_snapshot(true)` at exit (mirrors `handle_sync_error`), so any session-state cleanup mutations reach the FE immediately and stale per-chunk snapshots are flushed. (2) **isPreparing suppression** — `SyncStatusHandler` only sets `isPreparing=true` (from `hcfs_sync_started` events) when the widget is NOT already visible (tracked via `shouldShowRef`). (3) **Targeted CSS transitions** — `SyncStatusDialog` uses `transition-[width]`, `transition-[border-radius]`, `transition-[padding]`, and `transition-[opacity]` instead of `transition-all`. (4) **Single width source** — The outer wrapper div owns the width via inline style. (5) **Two-state collapsed widths** — `W_COLLAPSED_DONE` and `W_COLLAPSED_ACTIVE`. (6) **Stalled completion fixup** — `fixup_stalled_completion()` in `sync/progress.rs` detects when hcfs-client leaves a session active despite all files being done (caused by the file watcher detecting self-generated writes via `changes_pending`). It overrides `effective_completed`, `effective_in_progress`, `widget_state`, and `status_variant` so the widget shows "Complete" instead of being stuck on "Syncing...". (7) **Stable file row keys** — `SyncStatusDialog` keys file rows by `file.path` only (not `${file.path}-${index}`) so that React moves DOM nodes when `snapshot.files` reorders by priority instead of unmount/remount, which avoids ghost text from `transition-opacity` restarts.

**Per-drive sync status** is owned by Rust as the single source of truth — there is NO global "sync engine status" enum, no global "user stopped" flag, no global "Syncing is currently stopped" banner. Every locally synced folder is one drive, and each drive has its own status (`Active | Paused`) computed from `sync_paths.is_paused`. The full design is in `src-tauri/src/sync/drive_status.rs`. Key pieces:

- **`DriveStatus` enum** (`Active | Paused`) and **`DriveStatusEntry` struct** (`{ label, folder_name, status }`). Wire format is the tagged shape `{"kind": "active"}` so a future `Error { message }` variant can be added without breaking the frontend. `folder_name` is the basename of the sync path (e.g. `/Users/me/Documents/Hippius` → `"Hippius"`) — the user-facing name shown in tray submenus and per-drive UI rows.
- **`get_all_drive_statuses` IPC** returns one entry per `sync_paths` row for the current account, filtered to skip the internal `migration` pseudo-drive. Called by the frontend on mount to bootstrap the per-drive map.
- **Two events**: `hcfs_drive_status_changed` (payload `{label, status}`) fires when a single drive transitions Active ↔ Paused. `hcfs_drive_removed` (payload `{label}`) fires when `remove_drive` deletes a drive's row, telling the FE to drop the entry from its map.
- **`pause_drive`** sets `is_paused=true` in the DB, removes the drive from the in-memory map, emits `hcfs_drive_status_changed` with status=Paused. **`resume_drive`** clears `is_paused`, calls `initialize_sync_inner` (which emits Active on success). **`remove_drive`** (renamed from `stop_drive`) deletes the `sync_paths` row, tears down the in-memory state, leaves files on disk untouched, and emits `hcfs_drive_removed`. There is no longer a global "Stop Sync" button.
- **`stop_sync`** is internal cleanup only (logout, login, reset). It does NOT touch any persisted state — `is_paused` rows survive logout/login because they represent user intent.
- **`auto_init_sync`** filters out paused paths and emits per-drive Paused for each before the init loop. For each successful init, the per-drive Active status is emitted by `initialize_sync_inner`. There is no global aggregation; every status emit is per-drive.
- **Frontend mirror**: `driveStatusesAtom: Map<label, DriveEntry>` in `app/lib/global-atoms/unpinAtoms.ts`, populated by `useDriveStatuses` (mounted in `SyncEventLogger`). Derived `hasConfiguredDrivesAtom` answers "does the user have any drives configured" — used by upload buttons to gate the "set up sync first" toast. **Frontend code must never mutate `driveStatusesAtom` directly** — call the corresponding Rust IPC (`pause_drive`, `resume_drive`, `remove_drive`) and let the event listener propagate the change.
- **Three pause/resume surfaces** all share the same atom: (1) the 3-dot menu in `MultiFolderSyncManager` (settings → Sync & Storage), (2) the per-folder tab menu in `FilesContainer`, (3) the **Sync Folders** tray submenu in `useTraySync`. All call the same Rust IPCs and read pause state from the same atom — no local state mirrors.
- **Legacy migration**: existing users with the old global `user_preferences.sync_user_stopped = true` flag get every `sync_paths` row painted `is_paused = true` on first launch via `sync/user_stopped_migration.rs`. Idempotent, runs at every startup, safely deletable once enough releases have shipped.

**Tray sync state cleanup**: The tray menu in `useTraySync.ts` uses module-level latching variables (`latchedComplete`, `latchedSnapshot`, `lastSyncSummarySignature`) to keep completed sync info visible after backend resets. These are explicitly cleared in the `useTrayInit` logout cleanup effect to prevent stale data from a previous account appearing after account switch.

**Migration folder picker**: The `MigrationPromptDialog` includes a folder picker pre-populated with the default migration path (`~/Documents/Hippius-Migration-YYYY-MM-DD`). The chosen path is stored in `migrationCheckAtom.syncPath` and passed to `complete_migration_transition` as `custom_sync_path`. If not provided, falls back to the auto-generated default.

**Per-file sync completion**: hcfs-client's `on_file_synced` callback fires per-file after the upload (or download + AEAD-verifying decrypt) succeeds. The desktop `build_file_synced_callback` calls `crate::sync::progress::mark_file_synced` to transition that single file's progress status to `Completed` immediately, instead of waiting for the entire sync cycle to finish in `complete_pending_files`. This fixes the bug where a small decrypted file would stay pinned at "Decrypting" while a large file was still downloading alongside it.

**Credit-eligibility checks**: The decision of whether the user can afford a gated action (file upload, folder upload, folder sync, VM creation) lives in Rust in `src-tauri/src/billing/eligibility.rs`. The `thresholds` module is the **only** place credit pricing constants live (`VM_CREATION = 10.0`, others `> 0`) — changing the price for an action means editing one constant. Two entry points: (1) `check_action_eligibility` Tauri command does a **live** balance fetch (no caching) and returns a structured `ActionEligibility { eligible, reason, currentBalance, requiredBalance }` for the FE's proactive dialog gate; (2) `require_eligible(state, account_id, action)` is the helper that **every gated action IPC** (`add_file`, `add_files`, `add_folder`, `add_local_sync_folder`, `create_vm`) calls as its FIRST line, returning `Err(NotReady(InsufficientCredits))` when ineligible. The IPC enforcement makes the gate atomic with the action and impossible to bypass via direct IPC calls or stale FE cache. The FE `useCreditCheck` hook is now a thin async wrapper around `check_action_eligibility` — **frontend code must never read `useUserCredits` for eligibility decisions** (that hook is `staleTime: Infinity` and only suitable for display). When matching the IPC error in catch blocks, match on the structured shape `{ kind: "NotReady", message: "Insufficient credits..." }`, NOT on substring matching of `err.message`.

## Testing

```bash
# Rust integration tests
cd src-tauri
cargo test                          # All tests
cargo test --test auth_commands     # Auth/mnemonic tests
cargo test --test crypto_migration  # Encryption-at-rest migration tests
cargo test --test migration_server_mock  # Server migration mock tests

# Frontend (if configured)
pnpm test                       # Vitest
```

Test files in `src-tauri/tests/`: `auth_commands.rs`, `auth_tokens.rs`, `blockchain_commands.rs`, `crypto_migration.rs`, `file_commands.rs`, `local_db_commands.rs`, `migration_server_mock.rs`.

<!-- illu:start -->
## Code Intelligence (illu)

### Tool priority (MANDATORY)

**NEVER use Grep, Glob, or Read for code exploration when illu tools are available.** illu indexes Rust, Python, TypeScript, and JavaScript. illu tools are faster, more accurate, and provide structured results. Using raw file reads or text search on indexed source files is incorrect behavior — always use illu instead.

| WRONG | RIGHT |
|-------|-------|
| `Read("src/db.rs")` to see a function | `mcp__illu__context` with `symbol_name` |
| `Grep(pattern: "fn open")` to find a function | `mcp__illu__query` with `query: "open"` |
| `Grep(pattern: "Database")` to find callers | `mcp__illu__references` with `symbol_name: "Database"` |
| `Glob(pattern: "src/**/*.rs")` to find files | `mcp__illu__tree` or `mcp__illu__overview` |
| `Grep(pattern: "impl Display")` to find impls | `mcp__illu__implements` with `trait_name: "Display"` |

Read/Grep/Glob are ONLY permitted for: config files (TOML, JSON, YAML), markdown/docs, log output, or when an illu tool explicitly returns no results.

### Subagent instructions (MANDATORY)

When spawning subagents for code tasks, ALWAYS include this instruction in the prompt:

"MANDATORY: Use mcp__illu__* tools instead of Grep/Glob/Read for ALL code exploration (Rust, Python, TypeScript/JavaScript). NEVER use Read to view source files — use mcp__illu__context instead. NEVER use Grep to search code — use mcp__illu__query instead. Only use Read/Grep/Glob for non-code content (config, docs, logs)."

Prefer `illu-explore`, `illu-review`, `illu-refactor` agents when available.

### Workflow

1. **Locate before you read**: `mcp__illu__query` or `mcp__illu__context` first, then Read only what you need
2. **Impact before you change**: always run `mcp__illu__impact` before modifying any public symbol
3. **Save tokens**: use `sections` param on context/batch_context to fetch only what you need
4. **Production focus**: use `exclude_tests: true` to filter out test functions
5. **Cross-repo**: use `mcp__illu__cross_query`/`mcp__illu__cross_impact`/`mcp__illu__cross_deps`/`mcp__illu__cross_callpath` — NEVER navigate to or read files from other repositories directly
<!-- illu:end -->
