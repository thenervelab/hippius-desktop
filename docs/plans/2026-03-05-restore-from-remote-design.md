# Restore from Remote — Design

## Problem

When a user sets up the desktop app on a new device, they have no way to discover which sync folders already exist on the remote server. They must manually recreate each folder label, which is error-prone and defeats the purpose of multi-device sync.

## Solution

Add folder registration (automatic) and folder discovery + restore (user-initiated) across three layers: server, hcfs-client, and desktop app.

## Server Changes

### New redb table: `folder_registry`

Key: `{base_address}:{folder_hash}`

Value:
```rust
FolderRegistryEntry {
    label: String,
    created_at: i64,
    updated_at: i64,
}
```

### New endpoint: `POST /register_folder`

Authenticated. Body:
```json
{ "folder_hash": "a2c8f4b1e9d3c7f5", "label": "default" }
```

Server derives `base_address` from the bearer token, stores/updates the entry in `folder_registry`. Called implicitly during every `initialize_sync`.

### New endpoint: `GET /list_folders/{base_address}`

Authenticated. Bearer token must resolve to the same `base_address`.

Response:
```json
{
  "folders": [
    {
      "label": "default",
      "folder_hash": "a2c8f4b1e9d3c7f5",
      "file_count": 42,
      "total_bytes": 1073741824,
      "created_at": 1709654400,
      "updated_at": 1709740800
    }
  ]
}
```

`file_count` and `total_bytes` are computed on-the-fly from existing file records for each `{base_address}_{folder_hash}` user_id.

## hcfs-client Changes

### New shared type (`hcfs-shared`)

```rust
pub struct RemoteFolderInfo {
    pub label: String,
    pub folder_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### New standalone functions

```rust
pub async fn register_folder(
    server_url: &str,
    api_key: &str,
    bearer_token: &str,
    folder_hash: &str,
    label: &str,
) -> Result<(), HcfsError>

pub async fn list_remote_folders(
    server_url: &str,
    api_key: &str,
    bearer_token: &str,
) -> Result<Vec<RemoteFolderInfo>, HcfsError>
```

Standalone (not `Drive` methods) because `list_remote_folders` must work before any drive is initialized.

## Desktop App — Rust Backend

### New command: `list_remote_folders`

```rust
#[tauri::command]
pub async fn list_remote_folders(
    account_id: String,
) -> Result<Vec<RemoteFolderInfo>, String>
```

Reads `hcfs_config` from DB for server URL, constructs bearer token from account's base SS58 address, calls `hcfs_client::list_remote_folders()`.

### New command: `restore_remote_folders`

```rust
#[tauri::command]
pub async fn restore_remote_folders(
    app: AppHandle,
    account_id: String,
    base_path: String,
    folders: Vec<RestoreFolderRequest>,
) -> Result<Vec<RestoreFolderResult>, String>
```

For each selected folder:
1. Create directory `<base_path>/<label>/`
2. Insert into `sync_paths` table (owner, path, label)
3. Call `initialize_sync` for that label (drives creation, unlock, sync loop start, pulls remote files)

### Update `initialize_sync`

After successful `unlock()` and `set_config()`, call `register_folder()` with the current label and folder_hash. Keeps the server registry in sync automatically.

## Desktop App — Frontend

### New component: `RestoreFromRemote`

Located in Settings dialog, below existing sync folder configuration.

**Flow:**
1. User clicks "Restore from Remote" button
2. App calls `list_remote_folders` Tauri command
3. Dialog shows folder list with checkboxes:
   - Label, file count, total size per row
   - Already-synced folders shown disabled with "Synced" badge (matched by label against local `sync_paths`)
4. User selects folders to restore
5. User picks a base directory via native folder picker (or app suggests `~/Hippius/`)
6. User clicks "Restore" → calls `restore_remote_folders`
7. Toast per folder (success/failure), settings view refreshes

Button only visible when authenticated and HCFS config exists.

## Data Flow

### Registration (automatic)

```
initialize_sync() → unlock drive → register_folder(server, token, hash, label)
  → Server stores {base_address}:{folder_hash} → label
```

### Restore (user-initiated)

```
Settings → "Restore from Remote"
  → list_remote_folders(account_id)
  → Server returns all folders for base_address
  → UI: checkboxes + folder picker
  → restore_remote_folders(account_id, base_path, selected)
    → For each folder:
      1. mkdir <base_path>/<label>/
      2. INSERT INTO sync_paths
      3. initialize_sync(account_id, label, master_mnemonic)
         → Drives sync remote files down
```

### Prerequisite

Master mnemonic required for restore — it derives per-folder encryption keys. Without it, remote files exist but can't be decrypted.

## Files to Modify

| Layer | File | Change |
|-------|------|--------|
| Server | `hcfs-server/src/main.rs` | Add `/register_folder` and `/list_folders/{base_address}` routes |
| Server | `hcfs-server/src/database.rs` | Add `folder_registry` redb table, register/list methods |
| Shared | `hcfs-shared/src/lib.rs` | Add `RemoteFolderInfo` type |
| Client | `hcfs-client/src/lib.rs` | Add `register_folder()`, `list_remote_folders()` functions |
| Desktop | `src-tauri/src/commands/syncing.rs` | Add `list_remote_folders`, `restore_remote_folders` commands; update `initialize_sync` to call `register_folder` |
| Desktop | `src-tauri/src/main.rs` | Register new commands |
| Desktop | `app/components/page-sections/settings/RestoreFromRemote.tsx` | New UI component |
| Desktop | `app/components/page-sections/settings/SettingsDialogContent.tsx` | Add RestoreFromRemote section |
