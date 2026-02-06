# CLAUDE.md — src-tauri/ (Rust Backend)

Read this file like a book. It walks through the entire Rust backend top-to-bottom: how the app starts, how data flows, and where every piece lives.

## Build & Run

```bash
cargo build                       # Debug build
cargo test                        # All tests
cargo clippy -- -D warnings       # Lint
cargo fmt                         # Format
```

`SQLX_OFFLINE=true` is required — SQLx runs in offline mode (no live DB at build time). The `.env` file must exist in this directory (bundled as a Tauri resource).

## How the App Starts

**`src/main.rs`** — The only entry point. (`src/lib.rs` is a vestigial Tauri template file — ignore it.)

Startup sequence:
1. `load_env()` — loads `.env` via dotenvy
2. Registers Tauri plugins: `process`, `updater`, `opener`, `dialog`, `fs`, `http`, `single-instance`, `deep-link`
3. Registers all 49 IPC commands via `tauri::generate_handler![]` — this is the **single source of truth** for what the frontend can call
4. Calls `setup(builder)` → `on_window_event(builder)` → `builder.run()`

**`src/builder_blocks/setup/mod.rs`** — Runs inside `Builder::setup()`:
1. Loads `.env` from Tauri resource path
2. Registers deep links (Linux only)
3. Centers and sizes the window (80% width, 90% height)
4. Spawns an async task that:
   - Creates `~/.hippius/hippius.db` (SQLite)
   - Runs schema migrations for 11 tables
   - Seeds default WSS endpoint (`wss://rpc.hippius.network`)
   - Resets VPN status (unless autoconnect is enabled)
   - Verifies Nebula installation and certificates

**`src/builder_blocks/on_window_event/mod.rs`** — Graceful shutdown: stops Nebula VPN before the window closes.

## Global State

Three singletons drive the app. Understanding these is key to understanding everything else.

| Global | Type | File | Purpose |
|--------|------|------|---------|
| `DB_POOL` | `OnceCell<SqlitePool>` | `main.rs` | SQLite connection pool, set once during setup |
| `HCFS_DRIVE` | `Arc<tokio::sync::Mutex<Option<HcfsDriveManager>>>` | `hcfs_drive.rs` | The active sync drive (None when logged out) |
| `HCFS_SYNC_STATE` | `Arc<std::sync::Mutex<HcfsSyncState>>` | `sync_shared.rs` | Sync status + recent activity ring buffer (100 items) |

Other globals:
- `GLOBAL_CANCEL_TOKEN` (`Arc<AtomicBool>`) in `sync_shared.rs` — signals the sync loop to stop
- `SYNC_LOOP_HANDLE` (`Arc<tokio::sync::Mutex<Option<JoinHandle>>>`) in `hcfs_drive.rs` — the background sync task handle
- `SYNC_IN_PROGRESS` (`Arc<AtomicBool>`) in `hcfs_drive.rs` — suppresses file watcher during sync
- `SUBSTRATE_CLIENT` (`RwLock<Option<Arc<OnlineClient>>>`) in `substrate_client.rs` — lazy Substrate RPC client
- `ACTIVE_ACCOUNT_ID` (`Mutex<Option<String>>`) in `utils/sync.rs` — currently logged-in account

## The HCFS Sync Engine

This is the core of the app. The old S3/CAS/manifest sync engine was fully removed. All sync is now delegated to **hcfs-client**, an external Rust library.

### The Drive Wrapper

**`src/hcfs_drive.rs`** defines `HcfsDriveManager`, a thin wrapper around `hcfs_client::Drive`:

```
HcfsDriveManager
├── new(sync_path)        → creates Drive pointing at a folder
├── init(password, mnemonic?) → first-time setup, returns BIP-39 mnemonic
├── unlock(password)      → unlocks drive, returns user_id
├── set_config(config)    → sets server URL + auth token
├── set_progress(handlers)→ registers upload/download/encrypt/decrypt callbacks
├── sync()                → runs one sync cycle (SyncMode::NonInteractive)
├── cleanup_temp()        → removes stale .tmp files from previous crashes
└── stage() / is_unlocked() / is_initialized() / user_id() / sync_path()
```

### Initialization Flow

When the user logs in, the frontend calls `initialize_sync`. Here's what happens:

**`src/commands/syncing.rs` → `initialize_sync(app, account_id, existing_mnemonic?)`**:
1. Reads sync path from `sync_paths` table (type='private')
2. Reads drive password and server URL from `hcfs_config` table
3. Creates the sync directory on disk if it doesn't exist
4. Creates `HcfsDriveManager::new(sync_path)`
5. If drive is already initialized → `unlock(password)` → returns user_id
6. If new → `init(password, mnemonic?)` → `unlock(password)` → returns user_id + mnemonic for backup
7. Calls `set_config()` with server URL, `api_key: "Arion"`, `bearer_token: user_id`
8. Registers progress event handlers (upload, download, encrypt, decrypt, scan, fetch)
9. Clears cancellation token
10. Stores manager in `HCFS_DRIVE` global
11. Starts the background sync loop

### The Sync Loop

**`start_sync_loop(app)`** in `hcfs_drive.rs`:
1. Aborts any previous sync loop task
2. Gets sync path from the drive
3. Creates a file watcher (notify crate) on the sync folder
4. Spawns a tokio task that:
   - Cleans up stale temp files
   - Runs an initial sync
   - Enters a select loop:
     - **File change detected** → sets `has_changes = true`
     - **Every 5 seconds (debounce tick)** → if `has_changes` or 30s heartbeat is due, runs `trigger_sync()`
   - Checks `GLOBAL_CANCEL_TOKEN` each iteration — breaks if cancelled

The file watcher is **suppressed during sync** via `SYNC_IN_PROGRESS` flag to prevent feedback loops (sync writes files → watcher fires → triggers another sync). The flag is cleared 2 seconds after sync completes.

If the file watcher fails to create (e.g., OS limit reached), the loop falls back to heartbeat-only mode (sync every 30 seconds without file change detection).

### A Single Sync Cycle

**`trigger_sync(app)`** in `hcfs_drive.rs`:
1. Acquires `HCFS_SYNC_STATE` lock, checks `is_syncing`, sets it to `true`
2. Sets `SYNC_IN_PROGRESS` flag
3. Emits `hcfs_sync_started` event
4. Acquires `HCFS_DRIVE` lock, calls `drive.sync()` if unlocked
5. Spawns a task to clear `SYNC_IN_PROGRESS` after 2 seconds
6. Updates state: `is_syncing = false`, `last_sync_time = now`
7. Emits `hcfs_sync_completed` (with counts) or `hcfs_sync_error`

### Progress Events

`setup_progress_handlers()` in `syncing.rs` registers callbacks on the drive that emit Tauri events:

| Event | Payload | When |
|-------|---------|------|
| `hcfs_upload_progress` | `{bytes, total, path}` | During file upload |
| `hcfs_download_progress` | `{bytes, total, path}` | During file download |
| `hcfs_encrypt_progress` | `{bytes, total, path}` | During encryption |
| `hcfs_decrypt_progress` | `{bytes, total, path}` | During decryption |
| `hcfs_scan_progress` | `{scanned, path}` | During folder scan |
| `hcfs_fetch_progress` | `{fetched, total}` | During remote state fetch |

When an upload or download completes (`bytes == total && total > 0`), the handler also records the file in `HCFS_SYNC_STATE.recent_activity`.

Note: `encrypt/decrypt/scan/fetch` events are emitted but not yet consumed by the frontend.

### Stopping Sync

**`stop_sync()`** in `syncing.rs`:
1. Sets `GLOBAL_CANCEL_TOKEN` to `true`
2. Aborts the background sync loop task via `SYNC_LOOP_HANDLE`
3. Sets `HCFS_DRIVE` to `None` (drops the drive)
4. Resets `HCFS_SYNC_STATE`

## Commands Reference

Every Tauri command returns `Result<T, String>` — errors are string-serialized for IPC.

### File Operations (`src/commands/file_commands.rs`)

These operate on the **local sync folder**. hcfs-client auto-syncs changes.

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `add_file` | `sync_path, file_path` | `String` (filename) | Copies file into sync folder. Validates name for path traversal. |
| `add_folder` | `sync_path, folder_path` | `String` (folder name) | Recursive copy. Validates name for path traversal. |
| `remove_file` | `sync_path, name` | `()` | Removes file or folder. Uses `ensure_within()` for path safety. |
| `list_sync_folder` | `sync_path, subfolder?` | `Vec<FileEntry>` | Lists directory. Skips dotfiles (`.hippius`, etc). Returns empty if dir doesn't exist. |
| `export_file` | `sync_path, file_name, output_path` | `()` | Copies file/folder out. Uses `ensure_within()` for path safety. |

**Path traversal protection**: `ensure_within(parent, child)` canonicalizes both paths and verifies the child is contained within the parent. Applied to `remove_file`, `export_file`, `list_sync_folder` (with subfolder), and validated in `add_file`/`add_folder` via name sanitization.

### Sync Control (`src/commands/syncing.rs`)

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `initialize_sync` | `app, account_id, existing_mnemonic?` | `InitSyncResult` | See "Initialization Flow" above |
| `stop_sync` | — | `()` | Cancels + drops drive + resets state |
| `trigger_sync_now` | `app` | `()` | Runs one sync cycle immediately |
| `save_hcfs_config` | `account_id, server_url, drive_password` | `()` | Upserts config into `hcfs_config` table |
| `get_hcfs_config` | `account_id` | `HcfsConfigResult` | Returns server_url + has_password flag |
| `update_hcfs_server_url` | `account_id, server_url` | `()` | Updates only the server URL (no password re-entry) |

### Sync Status (`src/sync_shared.rs`)

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `get_sync_status` | — | `HcfsSyncState` | `{is_syncing, last_sync_time, recent_activity}` |
| `get_sync_activity` | `limit?` | `Vec<SyncActivityItem>` | Last N items from activity ring buffer (default 50) |
| `app_close` | `app` | — | Calls `app.exit(0)` |

### Blockchain / Substrate (`src/commands/substrate_tx.rs`)

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `get_sync_path` | `{isPublic, accountId?}` | `SyncPathResult` | Reads from `sync_paths` table with legacy migration |
| `set_sync_path` | `{path, isPublic, accountId}` | `String` | Upserts into `sync_paths` table + macOS bookmark |
| `transfer_balance_tauri` | `sender_seed, recipient_address, amount` | `String` | On-chain balance transfer |
| `get_wss_endpoint` | — | `String` | Current RPC endpoint from DB |
| `update_wss_endpoint_command` | `endpoint` | `String` | Updates endpoint, clears cached client |

**Sync path legacy migration**: `get_sync_path` handles pre-multi-account data. If no scoped row exists (with `owner`), it looks for a legacy row (`owner=''`) and migrates it.

**Serde**: Both `SetSyncPathParams` and `GetSyncPathParams` use `#[serde(rename_all = "camelCase")]` so the frontend sends `{ isPublic, accountId }`.

### Account Management (`src/commands/accounts.rs`)

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `reset_app` | — | `String` | Clears all tables, drops Drive, stops Nebula |
| `import_app_data` | `data` | `String` | Restores from JSON export |
| `export_app_data` | — | `String` (JSON) | Exports sync_paths, hcfs_config, sub_accounts |
| `get_all_subaccount_addresses` | `account_id` | `Vec<String>` | Lists sub-account addresses |

### Object Store Auth (`src/commands/objectstore_auth.rs`)

Two-token system for S3 access:
1. **Temp auth key** — OAuth token from the Hippius API
2. **Master token** — S3 credentials (access_key_id + secret) obtained by exchanging the temp key

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `save_temp_auth_key_command` | `account_id, temp_auth_key` | `()` | Stores OAuth token in `objectstore_auth_scoped` |
| `has_master_token_command` | `account_id` | `bool` | Checks if S3 credentials exist |
| `request_master_token_command` | `account_id, temp_auth_key?` | `MasterTokenResponse` | Calls `POST /api/objectstore/master-tokens/`, stores result |

### User Profile Sync (`src/user_profile_sync.rs`)

**This is NOT the HCFS file sync.** This is blockchain file tracking — it queries on-chain storage to build a local cache of what files the user has pinned.

| Command | Params | Returns |
|---------|--------|---------|
| `get_user_synced_files` | `owner` | `Vec<UserProfileFileWithType>` |
| `get_user_total_file_size` | `owner` | `FileSizeBreakdown {public_size, private_size}` |
| `list_folder_contents` | `account_id, scope, main_folder_name?, subfolder_path?` | `Vec<FolderContentEntry>` |

`start_user_sync(app, account_id)` runs a background loop (every 120s) that:
1. Queries the Substrate chain for user's profile CID and storage requests
2. Fetches file metadata from IPFS gateway (`get.hippius.network`)
3. Stores results in the `user_profiles` DB table
4. Uses `SYNCING_ACCOUNTS` mutex to prevent duplicate loops per account

### VPN / Nebula

**`commands/vpn_enabled.rs`**: `get_vpn_status`, `toggle_vpn_status`, `get_autoconnect_status`, `toggle_autoconnect_status` — read/write SQLite flags.

**`utils/nebula.rs`** (1800+ lines): Full Nebula VPN lifecycle. Platform-specific: Linux uses `setcap`, macOS uses `osascript` for privilege elevation.

Commands: `get_nebula_version`, `check_nebula_update`, `get_nebula_ip`, `get_nebula_stats`, `get_nebula_status`, `get_nebula_binary_installed_status`, `check_nebula_requirements`, `download_nebula`, `install_nebula`, `verify_nebula`, `finish_setup`, `start_nebula`.

### Other Commands

| Module | Command | Notes |
|--------|---------|-------|
| `ipfs.rs` | `get_ipfs_node_info`, `get_ipfs_bandwidth`, `get_ipfs_peers` | **Stubs** returning hardcoded mock data (placeholder until frontend graph is removed) |
| `commands/indexer.rs` | `get_indexer_api_key` | Reads `INDEXER_API_KEY` from env |

## Database Schema

SQLite at `~/.hippius/hippius.db`. Schema defined in `builder_blocks/setup/mod.rs`.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `hcfs_config` | HCFS sync settings per user | `owner (UNIQUE)`, `server_url`, `drive_password` |
| `sync_paths` | Sync folder paths per user | `owner`, `path`, `type` (public/private), `UNIQUE(owner, type)` |
| `objectstore_auth` | Legacy single-user S3 auth (pre-multi-account) | `temp_auth_key`, `master_access_key_id`, `master_secret` |
| `objectstore_auth_scoped` | Per-user S3 auth | `owner (PK)`, `temp_auth_key`, `master_access_key_id`, `master_secret` |
| `vpn_status` | VPN on/off state | `is_enabled` (singleton row, id=1) |
| `nebula_binary_status` | Nebula installation state | `is_nebula_binary_installed` |
| `nebula_certificate` | Nebula cert info | `certificate_id`, `expires_at`, `is_active` |
| `autoconnect_vpn_enabled` | VPN autoconnect preference | `is_enabled` |
| `sub_accounts` | Sub-account seed phrases | `account_id`, `sub_account_seed_phrase` |
| `wss_endpoint` | Substrate RPC endpoint | `endpoint` (singleton row, id=1) |
| `security_scoped_bookmarks` | macOS sandbox bookmarks | `path`, `bookmark_data (BLOB)`, `scope_type` |
| `user_profiles` | Blockchain file cache | `owner`, `cid`, `file_hash`, `file_name`, `type`, ... |
| `file_paths` | Local file path mapping | `file_name`, `path` |

### Multi-Account Support

DB rows are namespaced by `owner` — an 8-character hex string derived from `SHA256(account_id)[..8]` via `utils/account_key::account_key()`. This means switching accounts scopes all sync, config, and auth data without conflicts.

## Utilities (`src/utils/`)

| Module | Purpose |
|--------|---------|
| `account_key.rs` | `account_key(id) → String` — SHA256-based 8-char hex hash for DB namespacing |
| `sync.rs` | `ACTIVE_ACCOUNT_ID` global, `get_public_sync_path()`, `get_private_sync_path()` — convenience wrappers |
| `objectstore_tokens.rs` | Two-token auth: save/get temp key, save/get/ensure master token, `clear_objectstore_env()` |
| `bookmark_db.rs` | macOS security-scoped bookmark persistence for sync folder access across app restarts |
| `nebula.rs` | Full Nebula VPN lifecycle (see VPN section above) |
| `accounts.rs` | Empty stub (encryption moved to hcfs-client) |
| `binary.rs` | Empty stub |

## Substrate Client (`src/substrate_client.rs`)

Lazy singleton with retry logic (10 attempts, 5-second delay). Connects to the WSS endpoint stored in the database (defaults to `wss://rpc.hippius.network`).

`clear_substrate_client()` drops the cached connection — called when the endpoint changes or connection errors occur. The next `get_substrate_client()` call will reconnect.

Blockchain types are generated at compile time from `metadata.scale` via `#[subxt::subxt(runtime_metadata_path = "metadata.scale")]` in `substrate_tx.rs`.

## Key Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `hcfs-client` | Git (pinned rev) | All sync, encryption, file operations |
| `tauri` | 2.x | Desktop framework + IPC |
| `subxt` | 0.38 | Substrate blockchain client |
| `sp-core` | 34.0.0 | Cryptographic primitives (sr25519, BIP-39) |
| `sqlx` | 0.7 | SQLite (async, offline mode) |
| `notify` | 6.1 | Filesystem watcher for sync folder |
| `reqwest` | — | HTTP client for IPFS gateway + API calls |
| `serde` / `serde_json` | — | Serialization for IPC and DB |
| `chrono` | — | Timestamps |
| `once_cell` | — | Lazy static initialization |
| `cocoa` / `objc` | — | macOS security-scoped bookmarks (conditional) |

## Patterns & Conventions

- **All Tauri commands** return `Result<T, String>` — errors are string-serialized for JavaScript
- **DB access pattern**: `DB_POOL.get().ok_or("Database not initialized")?` — returns early if DB isn't ready
- **Mutex poisoning recovery**: `HCFS_SYNC_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())` — recovers from panics in other threads
- **Cancellation**: Set `GLOBAL_CANCEL_TOKEN` to `true`, abort the `SYNC_LOOP_HANDLE` task, set `HCFS_DRIVE` to `None`
- **Event emission**: `app.emit("event_name", payload)` — returns `Result`, always discarded with `let _ =`
- **Path safety**: `ensure_within()` canonicalizes and validates containment for all user-supplied paths

## Gotchas

- `.env` must exist in this directory (even if empty) — it's bundled as a Tauri resource
- `lib.rs` is vestigial — the real entry point is `main.rs`
- `ipfs.rs` commands return hardcoded mock data — they're stubs
- `user_profile_sync.rs` is blockchain file tracking, NOT the main HCFS file sync
- `utils/accounts.rs` and `utils/binary.rs` are empty stubs from the pre-hcfs-client era
- macOS builds require `cocoa`/`objc` deps for security-scoped bookmarks
- Nebula binary paths are platform-specific — see `nebula.rs`
- `accept_invalid_certs: true` in `initialize_sync` — the HCFS server uses a self-signed cert
- The `user_profiles` DB insert is currently commented out in `user_profile_sync.rs` (the data is still fetched and processed, just not persisted)
