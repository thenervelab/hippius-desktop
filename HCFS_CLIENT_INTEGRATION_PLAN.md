# HCFS-Client Integration Plan for Hippius Desktop

## Overview

**Goal**: Clean-slate replacement of the sync engine with hcfs-client. All old S3/CAS/manifest sync code is deleted — not deprecated, not migrated, deleted.

**User Requirements**:
- Full replacement, no backward compatibility
- HCFS server backend is available
- All files encrypted (no public/private separation)
- Clean state — old sync functionality is removed entirely

---

## Phase 1: Delete Old Sync Code

**This happens FIRST.** Remove everything before building anything new.

### 1.1 Files to DELETE entirely

```
src-tauri/src/sync_engine.rs            (2,295 lines)  - CAS/manifest sync
src-tauri/src/private_folder_sync.rs    (635 lines)    - Already disabled
src-tauri/src/public_folder_sync.rs     (624 lines)    - Already disabled
src-tauri/src/utils/ipfs.rs             (34 lines)     - Unused IPFS helpers
src-tauri/src/utils/s3_client.rs        (32 lines)     - S3 client factory
src-tauri/src/utils/fs_watcher.rs       (213 lines)    - Old FS watcher (replace with new)
```

### 1.2 Files to GUT (remove sync-related code, keep unrelated features)

**`src-tauri/src/sync_shared.rs`** — Delete all contents. Will be rewritten in Phase 3.

**`src-tauri/src/commands/syncing.rs`** — Delete all contents. Will be rewritten in Phase 4.

**`src-tauri/src/commands/ipfs_commands.rs`** — Delete all contents. Will be rewritten in Phase 4.

**`src-tauri/src/utils/file_operations.rs`** — Delete all contents. Will be rewritten in Phase 4.

**`src-tauri/src/utils/accounts.rs`** — Delete old sodiumoxide encryption key code. hcfs-client handles all encryption via BIP-39 mnemonic.

### 1.3 Remove from main.rs

Remove all old sync command registrations from `tauri::generate_handler![]`:
```
// DELETE these registrations:
encrypt_and_upload_file,
download_and_decrypt_file,
upload_file_public,
download_file_public,
encrypt_and_upload_folder,
download_and_decrypt_folder,
public_upload_folder,
public_download_folder,
add_file_to_public_folder,
add_file_to_private_folder,
add_folder_to_public_folder,
add_folder_to_private_folder,
remove_file_from_public_folder,
remove_file_from_private_folder,
remove_folder_from_public_folder,
remove_folder_from_private_folder,
list_folder_contents,
write_file,
read_file,
delete_file,
wipe_s3_objects,
initialize_sync,
start_private_folder_sync_tauri,
start_public_folder_sync_tauri,
cleanup_sync,
stop_sync_for_scope_command,
set_bucket_policy,
get_bucket_policy,
get_sync_activity,
delete_and_unpin_file_by_name,
create_encryption_key,
get_encryption_keys,
import_key,
ensure_aws_env,
```

Remove old module declarations:
```rust
// DELETE these mod declarations:
mod sync_engine;
mod private_folder_sync;
mod public_folder_sync;
```

### 1.4 Remove from Cargo.toml

```toml
# DELETE these dependencies:
aws-config = ...
aws-sdk-s3 = ...
sodiumoxide = ...
reed-solomon-erasure = ...  # if present
fs_extra = ...              # if only used by old sync
```

### 1.5 Database Tables to DROP

Remove from `src-tauri/src/builder_blocks/setup/mod.rs`:

```sql
-- DELETE these table creation statements:
-- bucket_policies
-- bucket_policies_scoped
-- objectstore_auth
-- objectstore_auth_scoped
-- is_first_run
-- user_profiles          (old file tracking - hcfs-client handles state)
-- file_paths             (old file tracking)
```

**KEEP these tables** (used by non-sync features):
```sql
-- encryption_keys        → RENAME/REPURPOSE for hcfs mnemonic storage
-- sync_paths             → KEEP (single path, remove type column)
-- sub_accounts           → KEEP (blockchain accounts)
-- wss_endpoint           → KEEP (blockchain RPC)
-- vpn_status             → KEEP
-- nebula_binary_status   → KEEP
-- nebula_certificate     → KEEP
-- autoconnect_vpn_enabled → KEEP
-- security_scoped_bookmarks → KEEP (macOS)
```

### 1.6 Verify Clean Compile

After all deletions, the project should compile (with missing function errors for removed commands). This is the baseline for building the new system.

---

## Phase 2: Add hcfs-client Dependency and Create Wrapper Module

### 2.1 Cargo.toml

**File**: `src-tauri/Cargo.toml`

```toml
[dependencies]
hcfs-client = { path = "../hippius-arion/sync-engine/hcfs-client" }
```

### 2.2 Create Drive Wrapper

**New File**: `src-tauri/src/hcfs_drive.rs`

```rust
use hcfs_client::{Drive, HcfsClientConfig, SyncMode, SyncOutcome, SyncPlan, SyncProgress};
use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct HcfsDriveManager {
    drive: Drive,
    sync_path: PathBuf,
}

impl HcfsDriveManager {
    pub fn new(sync_path: PathBuf) -> Self {
        Self {
            drive: Drive::new(&sync_path),
            sync_path,
        }
    }

    pub fn init(&mut self, password: &str, mnemonic: Option<&str>) -> Result<String, String> {
        self.drive.init(password, mnemonic).map_err(|e| e.to_string())
    }

    pub fn unlock(&mut self, password: &str) -> Result<String, String> {
        self.drive.unlock(password).map_err(|e| e.to_string())?;
        self.drive.user_id()
            .map(|s| s.to_string())
            .ok_or("Failed to get user_id after unlock".into())
    }

    pub fn is_unlocked(&self) -> bool { self.drive.is_unlocked() }
    pub fn is_initialized(&self) -> bool { self.drive.is_initialized() }
    pub fn user_id(&self) -> Option<&str> { self.drive.user_id() }
    pub fn sync_path(&self) -> &Path { &self.sync_path }

    pub fn set_config(&mut self, config: HcfsClientConfig) -> Result<(), String> {
        self.drive.set_config(config).map_err(|e| e.to_string())
    }

    pub fn set_progress(&mut self, progress: SyncProgress) {
        self.drive.set_progress_handlers(progress);
    }

    pub async fn sync(&mut self) -> Result<SyncOutcome, String> {
        self.drive.sync_async(SyncMode::NonInteractive).await.map_err(|e| e.to_string())
    }

    pub fn stage(&self) -> Result<SyncPlan, String> {
        self.drive.stage().map_err(|e| e.to_string())
    }

    pub fn cleanup_temp(&self) { self.drive.cleanup_stale_temp_files(); }
}

/// Global Drive instance
pub static HCFS_DRIVE: Lazy<Arc<Mutex<Option<HcfsDriveManager>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
```

### 2.3 Register Module

**File**: `src-tauri/src/main.rs`

```rust
mod hcfs_drive;
```

---

## Phase 3: Rewrite sync_shared.rs (Clean)

**File**: `src-tauri/src/sync_shared.rs` — Complete rewrite.

```rust
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// === Cancellation ===
pub static GLOBAL_CANCEL_TOKEN: Lazy<Arc<AtomicBool>> =
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

pub fn request_cancel() { GLOBAL_CANCEL_TOKEN.store(true, Ordering::SeqCst); }
pub fn clear_cancel()   { GLOBAL_CANCEL_TOKEN.store(false, Ordering::SeqCst); }
pub fn is_cancelled() -> bool { GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) }

// === Sync State ===
pub static HCFS_SYNC_STATE: Lazy<Arc<Mutex<HcfsSyncState>>> =
    Lazy::new(|| Arc::new(Mutex::new(HcfsSyncState::default())));

const MAX_ACTIVITY: usize = 100;

#[derive(Default, Clone, Serialize)]
pub struct HcfsSyncState {
    pub is_syncing: bool,
    pub last_sync_time: Option<i64>,
    pub recent_activity: VecDeque<SyncActivityItem>,
}

#[derive(Clone, Serialize)]
pub struct SyncActivityItem {
    pub file_name: String,
    pub action: String,    // "uploaded", "downloaded", "deleted", "conflict"
    pub timestamp: i64,
    pub size_bytes: u64,
}

impl HcfsSyncState {
    pub fn add_activity(&mut self, item: SyncActivityItem) {
        self.recent_activity.push_front(item);
        self.recent_activity.truncate(MAX_ACTIVITY);
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// === Tauri Commands ===
#[tauri::command]
pub fn get_sync_status() -> HcfsSyncState {
    HCFS_SYNC_STATE.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_sync_activity(limit: Option<usize>) -> Vec<SyncActivityItem> {
    let state = HCFS_SYNC_STATE.lock().unwrap();
    state.recent_activity.iter().take(limit.unwrap_or(50)).cloned().collect()
}
```

---

## Phase 4: Implement New Tauri Commands

### 4.1 Sync Control Commands

**File**: `src-tauri/src/commands/syncing.rs` — Complete rewrite.

```rust
use crate::hcfs_drive::{HcfsDriveManager, HCFS_DRIVE};
use crate::sync_shared::{clear_cancel, request_cancel, HCFS_SYNC_STATE};
use hcfs_client::HcfsClientConfig;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct InitSyncResult {
    pub user_id: String,
    pub mnemonic: Option<String>,
    pub is_new_setup: bool,
}

#[tauri::command]
pub async fn initialize_sync(
    app: AppHandle,
    sync_path: String,
    password: String,
    server_url: String,
    api_key: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String> {
    // 1. Create Drive manager
    {
        let mut guard = HCFS_DRIVE.lock().await;
        *guard = Some(HcfsDriveManager::new(sync_path.into()));
    }

    let mut guard = HCFS_DRIVE.lock().await;
    let manager = guard.as_mut().unwrap();

    // 2. Init or unlock
    let is_new = !manager.is_initialized();
    let mnemonic = if is_new {
        Some(manager.init(&password, existing_mnemonic.as_deref())?)
    } else {
        None
    };
    let user_id = manager.unlock(&password)?;

    // 3. Configure server
    manager.set_config(HcfsClientConfig {
        base_url: server_url,
        api_key,
        bearer_token: String::new(),
        accept_invalid_certs: false,
    })?;

    // 4. Setup progress handlers
    setup_progress_handlers(&app, manager);

    // 5. Start sync loop
    drop(guard);
    clear_cancel();
    crate::hcfs_drive::start_sync_loop(app).await;

    Ok(InitSyncResult { user_id, mnemonic, is_new_setup: is_new })
}

#[tauri::command]
pub async fn stop_sync() -> Result<(), String> {
    request_cancel();
    let mut guard = HCFS_DRIVE.lock().await;
    *guard = None;
    HCFS_SYNC_STATE.lock().unwrap().reset();
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync_now(app: AppHandle) -> Result<(), String> {
    crate::hcfs_drive::trigger_sync(&app).await;
    Ok(())
}

fn setup_progress_handlers(app: &AppHandle, manager: &mut HcfsDriveManager) {
    use hcfs_client::SyncProgress;
    use std::sync::Arc;

    let a1 = app.clone();
    let a2 = app.clone();
    let a3 = app.clone();
    let a4 = app.clone();
    let a5 = app.clone();
    let a6 = app.clone();

    manager.set_progress(SyncProgress {
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            let _ = a1.emit("hcfs_upload_progress", serde_json::json!({"bytes":b,"total":t,"path":p}));
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            let _ = a2.emit("hcfs_download_progress", serde_json::json!({"bytes":b,"total":t,"path":p}));
        })),
        on_encrypt_progress: Some(Arc::new(move |b, t, p| {
            let _ = a3.emit("hcfs_encrypt_progress", serde_json::json!({"bytes":b,"total":t,"path":p}));
        })),
        on_decrypt_progress: Some(Arc::new(move |b, t, p| {
            let _ = a4.emit("hcfs_decrypt_progress", serde_json::json!({"bytes":b,"total":t,"path":p}));
        })),
        on_scan_progress: Some(Arc::new(move |n, p| {
            let _ = a5.emit("hcfs_scan_progress", serde_json::json!({"scanned":n,"path":p}));
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            let _ = a6.emit("hcfs_fetch_progress", serde_json::json!({"fetched":f,"total":t}));
        })),
    });
}
```

### 4.2 File Operations Commands

**File**: `src-tauri/src/commands/ipfs_commands.rs` — Complete rewrite. Rename file to `file_commands.rs`.

```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// Add file to sync folder (Drive auto-syncs)
#[tauri::command]
pub async fn add_file(sync_path: String, file_path: String) -> Result<String, String> {
    let source = Path::new(&file_path);
    let name = source.file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();

    let dest = Path::new(&sync_path).join(&name);
    tokio::fs::copy(source, &dest).await
        .map_err(|e| format!("Copy failed: {e}"))?;

    Ok(name)
}

/// Add folder to sync folder
#[tauri::command]
pub async fn add_folder(sync_path: String, folder_path: String) -> Result<String, String> {
    let source = Path::new(&folder_path);
    let name = source.file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid folder name")?
        .to_string();

    let dest = Path::new(&sync_path).join(&name);
    copy_dir_recursive(source, &dest).await?;

    Ok(name)
}

/// Remove file/folder from sync folder
#[tauri::command]
pub async fn remove_file(sync_path: String, name: String) -> Result<(), String> {
    let target = Path::new(&sync_path).join(&name);
    if target.is_dir() {
        tokio::fs::remove_dir_all(&target).await
            .map_err(|e| format!("Remove failed: {e}"))?;
    } else if target.exists() {
        tokio::fs::remove_file(&target).await
            .map_err(|e| format!("Remove failed: {e}"))?;
    }
    Ok(())
}

/// List contents of sync folder
#[tauri::command]
pub async fn list_sync_folder(
    sync_path: String,
    subfolder: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    let target = match subfolder {
        Some(sub) => PathBuf::from(&sync_path).join(sub),
        None => PathBuf::from(&sync_path),
    };

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&target).await
        .map_err(|e| format!("Read dir failed: {e}"))?;

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .hippius config directory
        if name == ".hippius" { continue; }
        // Skip hidden files (hcfs-client convention)
        if name.starts_with('.') { continue; }

        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name,
            is_folder: meta.is_dir(),
            size: meta.len(),
            modified: meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }

    Ok(entries)
}

/// Export file from sync folder to arbitrary location
#[tauri::command]
pub async fn export_file(
    sync_path: String,
    file_name: String,
    output_path: String,
) -> Result<(), String> {
    let source = Path::new(&sync_path).join(&file_name);
    if !source.exists() {
        return Err(format!("File not in sync folder: {file_name}"));
    }
    tokio::fs::copy(&source, &output_path).await
        .map_err(|e| format!("Export failed: {e}"))?;
    Ok(())
}

async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst).await.map_err(|e| e.to_string())?;
    let mut dir = tokio::fs::read_dir(src).await.map_err(|e| e.to_string())?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

### 4.3 Remove Old accounts.rs Encryption Code

**File**: `src-tauri/src/utils/accounts.rs` — Delete sodiumoxide functions:
- `create_and_store_encryption_key()`
- `import_encryption_key()`
- `get_latest_encryption_key_from_db()`
- `decrypt_file()`
- `list_encryption_keys()`

hcfs-client handles ALL encryption via its own mnemonic-based key management.

### 4.4 Delete file_operations.rs

Replaced entirely by `file_commands.rs` above. All S3 fallback logic, DB tracking, and complex copy logic are gone.

---

## Phase 5: File Watcher and Sync Loop

**File**: `src-tauri/src/hcfs_drive.rs` — Add sync loop functions.

```rust
use crate::sync_shared::{is_cancelled, HcfsSyncState, HCFS_SYNC_STATE, SyncActivityItem};
use notify::{recommended_watcher, RecursiveMode, Watcher};
use std::time::Duration;
use tauri::AppHandle;

/// Start background sync loop
pub async fn start_sync_loop(app: AppHandle) {
    let sync_path = {
        let guard = HCFS_DRIVE.lock().await;
        guard.as_ref().map(|m| m.sync_path.clone())
    };

    let Some(sync_path) = sync_path else { return; };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(256);

    // File watcher
    let tx_clone = tx.clone();
    let mut watcher = recommended_watcher(move |_| {
        let _ = tx_clone.blocking_send(());
    }).expect("Failed to create watcher");

    watcher.watch(&sync_path, RecursiveMode::Recursive)
        .expect("Failed to watch path");

    tokio::spawn(async move {
        let _watcher = watcher; // keep alive

        // Initial sync on startup
        trigger_sync(&app).await;

        let mut debounce = tokio::time::interval(Duration::from_secs(5));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        let mut has_changes = false;

        loop {
            if is_cancelled() { break; }

            tokio::select! {
                _ = rx.recv() => { has_changes = true; }
                _ = debounce.tick() => {
                    if has_changes {
                        has_changes = false;
                        trigger_sync(&app).await;
                    }
                }
                _ = heartbeat.tick() => {
                    trigger_sync(&app).await;
                }
            }
        }
    });
}

/// Execute one sync cycle
pub async fn trigger_sync(app: &AppHandle) {
    {
        let mut s = HCFS_SYNC_STATE.lock().unwrap();
        if s.is_syncing { return; } // already running
        s.is_syncing = true;
    }

    let _ = app.emit("hcfs_sync_started", ());

    let result = {
        let mut guard = HCFS_DRIVE.lock().await;
        match guard.as_mut() {
            Some(m) if m.is_unlocked() => Some(m.sync().await),
            _ => None,
        }
    };

    {
        let mut s = HCFS_SYNC_STATE.lock().unwrap();
        s.is_syncing = false;
        s.last_sync_time = Some(chrono::Utc::now().timestamp());
    }

    match result {
        Some(Ok(outcome)) => {
            let _ = app.emit("hcfs_sync_completed", serde_json::json!({
                "files_uploaded": outcome.files_uploaded,
                "files_downloaded": outcome.files_downloaded,
                "files_deleted_locally": outcome.files_deleted_locally,
                "files_deleted_remotely": outcome.files_deleted_remotely,
                "conflicts_resolved": outcome.conflicts_resolved,
                "conflicts_skipped": outcome.conflicts_skipped,
            }));
        }
        Some(Err(e)) => {
            let _ = app.emit("hcfs_sync_error", serde_json::json!({"error": e}));
        }
        None => {}
    }
}
```

---

## Phase 6: Update main.rs (Clean Registration)

**File**: `src-tauri/src/main.rs`

```rust
// New module declarations (replace old ones)
mod hcfs_drive;
mod sync_shared;
mod commands {
    pub mod syncing;       // rewritten
    pub mod file_commands; // new (replaces ipfs_commands)
    pub mod accounts;      // kept for non-sync account features
    pub mod substrate_tx;  // unchanged
    // ... vpn, nebula, etc unchanged
}

// New command registrations in tauri::generate_handler![]
// Sync control
commands::syncing::initialize_sync,
commands::syncing::stop_sync,
commands::syncing::trigger_sync_now,

// File operations
commands::file_commands::add_file,
commands::file_commands::add_folder,
commands::file_commands::remove_file,
commands::file_commands::list_sync_folder,
commands::file_commands::export_file,

// Sync status
sync_shared::get_sync_status,
sync_shared::get_sync_activity,

// hcfs-specific (if exposed separately)
// hcfs_init, hcfs_unlock, etc. - OR fold into initialize_sync

// Keep all existing non-sync commands unchanged:
// VPN, Nebula, blockchain, etc.
```

---

## Phase 7: Frontend Integration

### 7.1 Update wallet-auth-context.tsx

```typescript
const initializeSync = async (
    syncPath: string,
    password: string,
    serverUrl: string,
    apiKey: string,
    existingMnemonic?: string,
) => {
    const result = await invoke<InitSyncResult>('initialize_sync', {
        syncPath,
        password,
        serverUrl,
        apiKey,
        existingMnemonic,
    });

    if (result.mnemonic) {
        // MUST show mnemonic backup dialog
        showMnemonicBackup(result.mnemonic);
    }

    return result;
};
```

### 7.2 New Sync Events Hook

**New File**: `app/lib/hooks/useSyncEvents.ts`

```typescript
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

export function useSyncEvents() {
    const [isSyncing, setIsSyncing] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null);
    const [downloadProgress, setDownloadProgress] = useState(null);
    const [lastOutcome, setLastOutcome] = useState(null);
    const [lastError, setLastError] = useState(null);

    useEffect(() => {
        const unsubs: (() => void)[] = [];

        listen('hcfs_sync_started', () => setIsSyncing(true))
            .then(u => unsubs.push(u));
        listen('hcfs_sync_completed', (e) => {
            setIsSyncing(false);
            setLastOutcome(e.payload);
        }).then(u => unsubs.push(u));
        listen('hcfs_sync_error', (e) => {
            setIsSyncing(false);
            setLastError(e.payload);
        }).then(u => unsubs.push(u));
        listen('hcfs_upload_progress', (e) => setUploadProgress(e.payload))
            .then(u => unsubs.push(u));
        listen('hcfs_download_progress', (e) => setDownloadProgress(e.payload))
            .then(u => unsubs.push(u));

        return () => unsubs.forEach(u => u());
    }, []);

    return { isSyncing, uploadProgress, downloadProgress, lastOutcome, lastError };
}
```

### 7.3 Remove Old Frontend Hooks

Delete or gut:
- Any hook that references old `get_sync_activity` shape
- Any hook that references `S3SyncState`, `BucketItem`, `RecentItem`
- Any code referencing `public`/`private` scope split for sync
- Any code calling old commands: `encrypt_and_upload_file`, `download_and_decrypt_file`, etc.

---

## File Summary

### NEW files to create
| File | Purpose |
|------|---------|
| `src-tauri/src/hcfs_drive.rs` | Drive wrapper + sync loop |
| `src-tauri/src/commands/file_commands.rs` | File add/remove/list/export |
| `app/lib/hooks/useSyncEvents.ts` | Frontend sync event listener |

### Files to REWRITE (delete contents, write new)
| File | Purpose |
|------|---------|
| `src-tauri/src/sync_shared.rs` | Sync state + cancellation |
| `src-tauri/src/commands/syncing.rs` | initialize_sync, stop_sync |

### Files to DELETE entirely
| File | Reason |
|------|--------|
| `src-tauri/src/sync_engine.rs` | Old CAS sync |
| `src-tauri/src/private_folder_sync.rs` | Old private sync |
| `src-tauri/src/public_folder_sync.rs` | Old public sync |
| `src-tauri/src/utils/ipfs.rs` | Unused |
| `src-tauri/src/utils/s3_client.rs` | No more S3 |
| `src-tauri/src/utils/fs_watcher.rs` | Replaced by notify in hcfs_drive |
| `src-tauri/src/utils/file_operations.rs` | Replaced by file_commands |
| `src-tauri/src/commands/ipfs_commands.rs` | Replaced by file_commands |

### Files to MODIFY (minimal)
| File | Changes |
|------|---------|
| `src-tauri/src/main.rs` | Remove old mods/commands, add new |
| `src-tauri/Cargo.toml` | Add hcfs-client, remove aws/sodiumoxide |
| `src-tauri/src/builder_blocks/setup/mod.rs` | Remove old tables |
| `src-tauri/src/utils/accounts.rs` | Remove encryption key functions |
| `app/lib/wallet-auth-context.tsx` | Update sync init call |

---

## Verification

### Build Check
```bash
cd src-tauri && cargo check
```

### Test Sync
```bash
# Manual test flow:
# 1. Run app
# 2. Set sync path
# 3. Enter password (first time → mnemonic shown)
# 4. Place file in sync folder
# 5. Verify file appears on HCFS server (encrypted)
# 6. Delete file locally
# 7. Verify deleted on server
# 8. Add file on another client
# 9. Verify it downloads
```

### Frontend Test
```bash
pnpm dev
# Verify sync status shows in UI
# Verify progress events update UI
# Verify mnemonic backup dialog works
```

---

## Implementation Order

| Step | What | Depends On |
|------|------|------------|
| 1 | Delete all old sync files | Nothing |
| 2 | Remove old deps from Cargo.toml | Step 1 |
| 3 | Remove old commands from main.rs | Step 1 |
| 4 | Remove old DB tables from setup | Step 1 |
| 5 | Add hcfs-client dep | Step 2 |
| 6 | Create `hcfs_drive.rs` | Step 5 |
| 7 | Rewrite `sync_shared.rs` | Step 1 |
| 8 | Rewrite `commands/syncing.rs` | Step 6, 7 |
| 9 | Create `commands/file_commands.rs` | Step 6 |
| 10 | Update `main.rs` with new commands | Step 8, 9 |
| 11 | Add sync loop to hcfs_drive | Step 6 |
| 12 | Verify `cargo check` passes | Step 10 |
| 13 | Update frontend hooks | Step 12 |
| 14 | Manual end-to-end test | Step 13 |
