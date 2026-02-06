# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Rust backend for the Hippius Desktop Tauri 2.0 app. Handles decentralized file sync (via hcfs-client), Polkadot blockchain transactions, Nebula VPN lifecycle, S3 auth token management, and IPFS monitoring.

## Build & Test Commands

```bash
cargo build                       # Build
cargo test                        # Run all tests
cargo test --test <name>          # Run specific test file
cargo clippy -- -D warnings       # Lint
cargo fmt                         # Format
```

`SQLX_OFFLINE=true` is required — the project uses SQLx offline mode (no live DB connection at build time).

## Architecture

### Entry Point & Command Registration

`src/main.rs` — loads `.env`, initializes Tauri plugins, and registers all IPC commands via `tauri::generate_handler![]`. This is the single source of truth for what the frontend can call. Every new command must be added here.

**Note**: `src/lib.rs` is a vestigial Tauri template file — it is not the app entry point.

### Global State

Three key global singletons (all `once_cell::sync::Lazy`):

| Global | Type | Location | Purpose |
|--------|------|----------|---------|
| `DB_POOL` | `OnceCell<SqlitePool>` | `main.rs` | SQLite connection pool |
| `HCFS_DRIVE` | `Arc<Mutex<Option<HcfsDriveManager>>>` | `hcfs_drive.rs` | Active sync drive instance |
| `HCFS_SYNC_STATE` | `Arc<Mutex<HcfsSyncState>>` | `sync_shared.rs` | Sync status + activity ring buffer |

The Substrate client (`SUBSTRATE_CLIENT` in `substrate_client.rs`) is also a lazy global with auto-retry connection (10 attempts, 5s delay).

### HCFS Sync Engine

The old S3/CAS/manifest sync engine was fully removed. All sync is now delegated to **hcfs-client**.

**Flow**: `initialize_sync` command → creates `HcfsDriveManager` → `init()`/`unlock()` the drive → `set_config()` with server URL + auth → stores in `HCFS_DRIVE` global → starts `start_sync_loop()`.

**Sync loop** (`hcfs_drive.rs`):
- File watcher (notify crate) on the sync folder triggers change detection
- 5-second debounce before syncing on changes
- 30-second heartbeat sync regardless
- Cancellation via `GLOBAL_CANCEL_TOKEN` (AtomicBool)
- Emits Tauri events: `hcfs_sync_started`, `hcfs_sync_completed`, `hcfs_sync_error`
- Progress events: `hcfs_upload_progress`, `hcfs_download_progress`, `hcfs_encrypt_progress`, `hcfs_decrypt_progress`, `hcfs_scan_progress`, `hcfs_fetch_progress`

**hcfs-client API used**: `Drive::new()`, `.init()`, `.unlock()`, `.sync_async(SyncMode::NonInteractive)`, `.set_config()`, `.set_progress_handlers()`, `.stage()`, `.cleanup_stale_temp_files()`

### Commands (`src/commands/`)

| Module | Purpose |
|--------|---------|
| `syncing.rs` | `initialize_sync`, `stop_sync`, `trigger_sync_now`, `save_hcfs_config`, `get_hcfs_config` |
| `file_commands.rs` | `add_file`, `add_folder`, `remove_file`, `list_sync_folder`, `export_file` — all operate on the local sync folder (hcfs-client auto-syncs) |
| `accounts.rs` | `reset_app`, `import_app_data`, `export_app_data`, `get_all_subaccount_addresses` |
| `substrate_tx.rs` | `set_sync_path`, `get_sync_path`, `transfer_balance_tauri`, `get_wss_endpoint`, `update_wss_endpoint_command` — blockchain runtime generated from `metadata.scale` via `#[subxt::subxt]` |
| `objectstore_auth.rs` | `save_temp_auth_key_command`, `has_master_token_command`, `request_master_token_command` — manages OAuth tokens + S3 master tokens |
| `vpn_enabled.rs` | `get_vpn_status`, `toggle_vpn_status`, `get_autoconnect_status`, `toggle_autoconnect_status` |
| `indexer.rs` | `get_indexer_api_key` — reads `INDEXER_API_KEY` env var |
| `types.rs` | Shared type definitions (CidInfo, ChunkInfo, erasure coding metadata, folder manifests) |

### Utilities (`src/utils/`)

| Module | Purpose |
|--------|---------|
| `nebula.rs` (1800+ lines) | Full Nebula VPN lifecycle: download, install, certificate management, start/stop, stats. Platform-specific: Linux `setcap`, macOS `osascript` elevation. Background ping task every 10s. |
| `objectstore_tokens.rs` | Two-token auth: temp auth key (OAuth → Hippius API) and master token (S3 credentials → AWS SDK). Per-account scoping via `objectstore_auth_scoped` table. |
| `account_key.rs` | `account_key(id) → String` — SHA256-based 8-char hash for per-user DB namespacing |
| `sync.rs` | `ACTIVE_ACCOUNT_ID` global, sync path helpers |
| `bookmark_db.rs` | macOS security-scoped bookmark persistence for sync folder access |
| `accounts.rs` | Empty stub (encryption moved to hcfs-client) |
| `binary.rs` | Empty stub |

### Startup & DB (`src/builder_blocks/`)

**`setup/mod.rs`** — App initialization:
- Creates SQLite DB at `~/.hippius/hippius.db`
- Runs schema migrations (11 tables: `hcfs_config`, `sync_paths`, `objectstore_auth`, `objectstore_auth_scoped`, `vpn_status`, `nebula_binary_status`, `nebula_certificate`, `autoconnect_vpn_enabled`, `sub_accounts`, `wss_endpoint`, `security_scoped_bookmarks`)
- Seeds default WSS endpoint (`wss://rpc.hippius.network`)
- Resets VPN status on startup, verifies Nebula installation
- Centers window at 80% width x 90% height

**`on_window_event/mod.rs`** — Graceful shutdown: stops Nebula VPN before exit.

### Other Source Files

| File | Purpose |
|------|---------|
| `substrate_client.rs` | Lazy Substrate/Polkadot client with retry logic, WSS endpoint from DB |
| `user_profile_sync.rs` | Tracks files on-chain via blockchain queries. Uses `user_profiles`/`file_paths` DB tables (legacy, separate from HCFS sync). Prevents duplicate sync loops via `SYNCING_ACCOUNTS` mutex. |
| `ipfs.rs` | Stub commands returning hardcoded mock data (placeholder until frontend graph removed) |
| `macos_bookmarks.rs` | Objective-C interop for macOS security-scoped bookmarks via `cocoa`/`objc` crates |
| `events.rs` | `AppEvent` struct (event_type, message, details) |
| `constants.rs` | `WSS_ENDPOINT = "wss://rpc.hippius.network"` |

## Key Dependencies

- **hcfs-client**: Git dep from `ssh://git@github.com/thenervelab/hcfs.git` (pinned rev) — all sync/encryption
- **subxt 0.38** + **sp-core 34.0.0**: Polkadot/Substrate blockchain interaction
- **sqlx 0.7**: SQLite with async runtime (offline mode)
- **notify 6.1**: Filesystem watcher for sync folder
- **tauri 2**: Desktop framework with plugins (fs, dialog, http, deep-link, updater, single-instance, process)

## Patterns

- **Multi-account support**: DB rows namespaced by `owner` column (8-char SHA256 hash of account ID via `account_key()`)
- **Legacy row migration**: `get_sync_path` and `set_sync_path` handle migrating pre-owner rows (owner='') to scoped rows
- **Two-token auth**: Temp auth key for Hippius API, master token for S3 — stored separately per account
- **All Tauri commands** return `Result<T, String>` — errors are string-serialized for IPC
- **Blockchain types** generated at compile time from `metadata.scale` via `#[subxt::subxt(runtime_metadata_path = "metadata.scale")]`

## Gotchas

- `.env` file must exist in this directory (bundled as Tauri resource, loaded via dotenvy)
- `ipfs.rs` commands are stubs returning mock data — not real IPFS integration
- `user_profile_sync.rs` is blockchain file tracking, not the main HCFS file sync
- `accounts.rs` and `binary.rs` in utils/ are empty stubs from pre-hcfs-client era
- macOS builds need `cocoa`/`objc` deps for security-scoped bookmarks
- The Nebula binary path varies by platform — see `nebula.rs` for per-OS logic
