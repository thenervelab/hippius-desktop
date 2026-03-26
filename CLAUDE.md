# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- **`main.rs`** — Entry point. Registers all IPC commands, initializes plugins, sets up single-instance and deep-link handling. `lib.rs` is vestigial — ignore it.
- **`commands/`** — IPC command handlers organized by domain: `syncing.rs` (file sync), `auth.rs` (mnemonic login), `session.rs` (credential storage), `billing.rs`, `blockchain.rs` (queries, staking, unit conversion), `chart_formatting.rs` (chart data, marketplace credits, storage cost), `migration.rs` (S3→HCFS migration: check, start, cancel, dismiss, `complete_migration_transition` for atomic dismiss+stop+reinit), `vm.rs`, `file_commands.rs`, `oauth.rs`, `local_db.rs` (notifications, contacts, preferences), etc.
- **`hcfs_drive.rs`** — Core sync engine. Wraps `hcfs_client::Drive` in `HcfsDriveManager`, manages multi-drive registry (`HCFS_DRIVES` HashMap keyed by label), runs background sync loop with file watching. Includes **remote folder auto-recovery**: before each sync cycle, `check_and_recover_remote_folder()` verifies the folder exists on the server; if missing (e.g., another device deleted it), it re-registers the folder, wipes `sync_state.json`, and lets the next sync re-upload local files. A fallback in the error handler also triggers recovery if `sync_with_resolutions` returns a folder-not-found error. **Post-upload folder registration**: after any sync cycle that uploads files, `ensure_folder_registered()` is called to guarantee the folder exists in the server's `folder_registry` — this is critical because the server's upload endpoint does NOT check registration, so files can land on the server while the folder remains invisible to `list_remote_folders` on other devices.
- **`sync_shared.rs`** — Shared sync state: cancellation token, per-drive status, connectivity health, activity ring buffer
- **`sync_logic.rs`** — Pure logic functions for sync engine decisions (no I/O, fully testable): backoff computation, health-change detection, sync-skip decisions, encrypted-name detection, remote-folder-removal error detection, folder recovery decision (`folder_needs_recovery`), post-upload registration decision (`should_register_after_upload`)
- **`sync_progress.rs`** — In-memory sync progress tracking (sessions, file progress, tray menu data)
- **`substrate_client.rs`** — Substrate/Polkadot RPC client for blockchain operations
- **`api_client.rs`** — HTTP client for Hippius API (billing, VMs, support)
- **`auth_state.rs`** — In-memory auth state (encrypted mnemonic, passcode)
- **`builder_blocks/setup.rs`** — App setup: SQLite database init with schema migration, deep-link registration, tray icon setup
- **`constants/substrate.rs`** — WSS endpoint and chain constants
- **`utils/nebula/`** — Nebula VPN management (download, install, start, certificate handling)

### Key Patterns

**Global state in Rust** is centralized in `AppState` (`app_state.rs`), registered via `app.manage(AppState::new())` at startup. Sub-states: `AuthInfo`, `BlockchainState`, `BlockSubscriptionState`, `OAuthState`, `NebulaState`, `MigrationState`, and `SyncEngine` (Arc). Command handlers access it via `tauri::State<'_, AppState>`, background tasks via `app.state::<AppState>()`. The DB pool uses `OnceLock` within AppState. No module-level `static` variables remain.

**Multi-drive sync**: Drives are keyed by label string. The sync loop iterates all drives sequentially (round-robin). `SyncActivityItem` includes a `label` field; all Tauri events include `"label"` in JSON payload. DB constraint: `UNIQUE(owner, label)` in sync_paths table.

**hcfs-client dependency**: The sync engine delegates to `hcfs-client` (from the `hippius-arion` repo, pinned to a git rev in Cargo.toml). Drive API: `new()`, `init()`, `unlock()`, `sync_async(SyncMode)`, `stage()`, `set_config()`, `set_progress_handlers()`. All file encryption is handled by hcfs-client via BIP-39 mnemonic.

**Rename detection**: The file watcher captures OS rename events (From/To pairs from the `notify` crate) and stores them as `RenameHint` structs in `SyncEngine.rename_hints`. Before each sync cycle, `trigger_sync_for_drive` drains the hints, converts them to relative paths, and expands directory-level hints into per-file hints. The pure pairing/expansion logic lives in `sync_logic.rs` (fully tested). When hcfs-client gains rename support (thenervelab/hcfs#52), the hints will be passed through to avoid redundant delete+re-upload cycles for renamed files. Until then, hints are logged and consumed without effect. When a rename hint is captured, `push_rename_hint` also updates existing activity items (committed and pending) and the `synced_paths_cache` to reflect the new filename immediately, then emits `hcfs_activity_updated` so the frontend refreshes the recent-files list without waiting for a full sync cycle. The label-to-root mapping (`SyncEngine.label_roots`) enables converting absolute watcher paths to relative activity filenames.

**SQLite**: Database pool lives in `AppState` as a `OnceLock<SqlitePool>`. Schema is maintained via `ensure_table_schema()` in `builder_blocks/setup.rs` (not migration files). Access pattern: `state.pool()?` (from command handlers) or `app.state::<AppState>().pool()?` (from background tasks).

**Logging**: All Rust code uses `tracing` macros (`info!`, `debug!`, `warn!`, `error!`) — never `println!`/`eprintln!`. The subscriber is initialized in `main.rs` with module-path targets. Set `RUST_LOG=debug` for verbose output.

**Frontend static export**: Next.js is configured with `output: "export"` — no server-side rendering. All data fetching happens client-side via Tauri IPC or TanStack Query.

**User preferences**: Generic key-value store in SQLite (`user_preferences` table) accessed via `get_user_preference` / `save_user_preference` Rust commands. Frontend wrapper in `app/lib/utils/userPreferencesDb.ts` provides typed helpers including `getLastBrowseDirectory()` / `saveLastBrowseDirectory()` which remember the last directory the user browsed to in file/folder pickers (fallback chain: last browse dir → home dir → OS default). Used by `FileDropzone`, `FolderUploadDialog`, and `FolderToFolderUploadDialog`.

**Asset protocol scope**: The static scope in `tauri.conf.json` is `$HOME/.hippius/**` (for HCFS drive metadata). User-chosen sync folders live at arbitrary paths, so the scope is expanded at runtime via `app.asset_protocol_scope().allow_directory(path, true)`. This happens in three places: `set_sync_path` (when user configures a new path), `initialize_sync_inner` (on every sync start/restart), and the frontend `tryAutoInitSync` (belt-and-suspenders at login). The `allow_asset_scope` IPC command is also exposed for direct frontend use. The helper `allow_asset_directory()` lives in `file_commands.rs`.

## Testing

```bash
# Rust integration tests
cd src-tauri
cargo test --test auth_commands
cargo test --test session_commands
cargo test --test blockchain_commands

# Frontend (if configured)
pnpm test                       # Vitest
```

Test files in `src-tauri/tests/`: `auth_commands.rs`, `session_commands.rs`, `blockchain_commands.rs`, `migration_server_mock.rs`.
