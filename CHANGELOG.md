# Changelog

All notable changes to Hippius Desktop are documented in this file.

## [Unreleased] - 2026-03-06

### Multi-Folder Sync Engine

The sync engine was fundamentally rearchitected from a single-drive model to supporting multiple independent sync folders, each with its own encryption namespace.

**Backend:**

- `HCFS_DRIVE` singleton replaced with `HCFS_DRIVES` — a `HashMap<String, HcfsDriveManager>` keyed by folder label. All commands now operate on a specific drive by label.
- `HCFS_SYNC_STATE` replaced with per-label `HCFS_SYNC_STATES`. Activity items carry a `label` field. Commit/discard of pending activity is scoped per-label.
- The sync loop iterates all registered drives in round-robin. File watchers cover all drive paths.
- `initialize_sync` takes a new required `label` parameter. Only the targeted drive is replaced on re-init.
- `stop_sync` stops all drives (logout). New `stop_drive(label)` stops a single drive.
- All Tauri event payloads now include a `"label"` field.

**DB Schema:**

- `sync_paths` table gains `label TEXT NOT NULL DEFAULT 'default'`. Unique constraint changed from `UNIQUE(owner, type)` to `UNIQUE(owner, label)`, with a full SQLite migration for existing databases.

**Encryption Isolation:**

- Folder-specific mnemonics derived from `SHA256(master_seed[..32] || label_bytes)` instead of filesystem path, making derivation portable across machines.
- Server-side namespace per folder via `{account_id}_{folder_hash(label)}`.

### Multi-Folder Sync UI

- New **MultiFolderSyncManager** in settings — shows all configured local and remote-only folders with status indicators and action menus (pause/resume/remove).
- New **AddLocalFolderDialog** — pick a local directory and assign a label.
- New **RemoteFolderSelector** — detects remote-only folders not yet synced locally, allowing restore to a local path.
- New **SyncFolderTabs** — pill-style tabs ("All" + per-label) above the file list when multiple folders exist.
- New **SyncFolderBadge** — label badge on each file when viewing "All" with multiple folders.
- New **SyncFolderSelect** dropdown in the upload dialog to choose which folder to upload into.
- File deletion, download, and export all resolve the correct sync path from the file's label.

### Mnemonic Security Hardening

The mnemonic is no longer stored in plaintext in the frontend's IndexedDB.

- `sessionStore.ts` no longer reads/writes mnemonic columns.
- `ensureSyncMnemonic.ts` resolves mnemonic from the encrypted Rust Drive on disk — never persisted to the frontend.
- New **billing_auth** Tauri command performs Ethereum challenge-response auth entirely in Rust. The mnemonic is retrieved from the encrypted Drive, used transiently, then zeroized.
- New **PasscodePromptDialog** for staking/unstaking operations that need to decrypt the mnemonic on demand.
- New **persist_master_mnemonic** command saves the login mnemonic to disk at login time before any sync folder is configured.

### Cross-Device Sync Fixes

- New `ensure_derived_mnemonic` migration detects stale folder mnemonics (matching master verbatim, or derived from a different master). Re-derives from the current master and writes a `.needs_rekey` marker.
- `.needs_rekey` handling changed to a safe no-op — stale files encrypted with old keys fail to decrypt and are skipped; local files re-upload with the correct key. No remote purge.
- If no login mnemonic is available and no master exists on disk, sync fails with an actionable error instead of silently generating a random master.

### Undecryptable File Cleanup

- After each sync cycle, files that fail to decrypt (left as `downloaded_<hex>` stubs) are now deleted from the server. This prevents an infinite retry loop where the same broken files are re-downloaded every 30 seconds.

### Sync Status and File Display

- Deleted `useServerSyncStatus` hook — sync status now relies solely on local Tauri events.
- `list_sync_folder` returns a `sync_status` field per file ("synced", "pending", "unknown") by comparing against the drive's persisted sync state.
- New "Pending upload" badge next to files that haven't synced yet.
- Tray sync watcher simplified: removed redundant backend polling, debug logs, and unused functions.
- Sync loop drains stale file watcher events after each cycle to prevent pointless "No changes" runs.

### Auth Token Refresh

- Frontend listens for `hcfs_auth_token_expired` events. When the server returns 401, it silently re-authenticates, updates bearer tokens in all active drives, and resumes sync. Includes a 5-minute cooldown to prevent retry storms.

### Recent Files Fixes

- Deleted files now properly disappear from recent files: `remove_file` records a "deleted" entry in the activity ring buffer, and the recent files query filters out any matching "uploaded" entries for the same file+label.
- Deduplication considers both `name` and `label`, preventing cross-folder collisions.

### Build System

- `tauri:dev` no longer redundantly runs `next build`.
- New `tauri:static` and `tauri:static:nobuild` commands for running against static exports.

### Jotai Store Fixes

- Fixed import patterns in `hippiusDesktopDB.ts` that caused Jotai state corruption when multiple components loaded the module simultaneously.
