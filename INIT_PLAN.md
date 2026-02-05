# HCFS Initialization Phase: Frontend-Backend Alignment

## Problem

The backend `initialize_sync` command exists but is **never called from the frontend**. Every place that sets `syncInitialized.current = true` in `wallet-auth-context.tsx` is just a boolean flag — no Tauri command is invoked. This means:

- The HCFS Drive is never created
- `trigger_sync_now`, file uploads, etc. silently fail (`HCFS_DRIVE` is `None`)
- `IS_SYNC_PAUSED = true` blocks all sync UI

## User Requirements

- **Server URL**: Configurable in settings (with sensible default)
- **API key**: Hardcoded constant shared across all desktop clients
- **Password**: User-provided via a password input dialog
- **OAuth key generation**: Auto-generate HCFS mnemonic + show backup dialog

## Design

### Initialization Flow

```
Login/Session Restore
        │
        ▼
  Has sync path? ──No──▶ User selects folder (existing flow)
        │                         │
       Yes                        ▼
        │              Has HCFS config? ──No──▶ Show HcfsSetupDialog
        │                    │                     (password + server URL)
        │                   Yes                        │
        │                    │                         ▼
        │                    │                  save_hcfs_config()
        │                    │                         │
        └────────┬───────────┘◀────────────────────────┘
                 │
                 ▼
        Call initialize_sync(
          sync_path, password,
          server_url, api_key,
          mnemonic?
        )
                 │
                 ▼
        result.mnemonic? ──Yes──▶ Show MnemonicBackupDialog
                 │
                No
                 │
                 ▼
          Sync loop running ✓
```

**When `initialize_sync` is called:**

1. **Session restore** (app start, returning user) — auto-initialize if sync path + HCFS config both exist
2. **After folder selection + HCFS setup** (first-time user) — called at end of setup flow
3. **After changing sync folder** in settings — stop_sync then re-initialize

**Mnemonic handling:**

- **Mnemonic login users**: Pass their mnemonic as `existing_mnemonic` (reuses same keys for HCFS)
- **OAuth login users**: Pass `null` → HCFS generates new mnemonic → show backup dialog
- **Returning users (any auth)**: Drive already initialized on disk → `unlock()` only, mnemonic not needed

---

## Implementation Steps

### Step 1: Backend — Add `hcfs_config` table and commands

**File: `src-tauri/src/builder_blocks/setup/mod.rs`**

- Add `hcfs_config` table:

  ```sql
  CREATE TABLE IF NOT EXISTS hcfs_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL UNIQUE,
      server_url TEXT NOT NULL DEFAULT '',
      drive_password TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  ```

**File: `src-tauri/src/commands/syncing.rs`**

- Add two new commands:

  ```rust
  #[tauri::command]
  pub async fn save_hcfs_config(account_id: String, server_url: String, drive_password: String) -> Result<(), String>
  // Upserts into hcfs_config table

  #[tauri::command]
  pub async fn get_hcfs_config(account_id: String) -> Result<HcfsConfigResult, String>
  // Returns { server_url, has_password: bool }
  // Never returns the actual password to the frontend
  ```

- Add a helper to read password internally (for `initialize_sync` assembly on backend):

  ```rust
  pub(crate) async fn get_drive_password(account_id: &str) -> Result<String, String>
  ```

**File: `src-tauri/src/main.rs`**

- Register `save_hcfs_config` and `get_hcfs_config` in `generate_handler![]`

### Step 2: Backend — Refactor `initialize_sync` to read config from DB

**File: `src-tauri/src/commands/syncing.rs`**

Instead of taking 5 separate parameters, simplify to:

```rust
#[tauri::command]
pub async fn initialize_sync(
    app: AppHandle,
    account_id: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, String>
```

The command now:

1. Reads sync path from `sync_paths` table (using `account_id`)
2. Reads server_url and drive_password from `hcfs_config` table
3. Uses hardcoded API key from env/constant
4. Creates Drive, init/unlock, configure, start sync loop
5. Returns `InitSyncResult { user_id, mnemonic, is_new_setup }`

This is better because:

- Frontend doesn't need to pass sensitive password over IPC
- Config is read from the DB source of truth
- Fewer parameters = simpler frontend calls

### Step 3: Frontend — Add HCFS config constants

**File: `app/lib/config.ts`**

- Add:

  ```typescript
  export const HCFS_CONFIG = {
    defaultServerUrl: "https://hcfs.hippius.com",
    apiKey: "PLACEHOLDER_API_KEY",  // Hardcoded shared key
  } as const;
  ```

### Step 4: Frontend — Add `hcfsConfigUtils.ts`

**New file: `app/lib/utils/hcfsConfigUtils.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";

export interface HcfsConfigResult {
  server_url: string;
  has_password: boolean;
}

export async function saveHcfsConfig(
  accountId: string,
  serverUrl: string,
  drivePassword: string
): Promise<void> {
  await invoke("save_hcfs_config", { accountId, serverUrl, drivePassword });
}

export async function getHcfsConfig(accountId: string): Promise<HcfsConfigResult> {
  return invoke<HcfsConfigResult>("get_hcfs_config", { accountId });
}

export async function initializeSync(
  accountId: string,
  existingMnemonic?: string
): Promise<{ user_id: string; mnemonic: string | null; is_new_setup: boolean }> {
  return invoke("initialize_sync", { accountId, existingMnemonic: existingMnemonic || null });
}
```

### Step 5: Frontend — Create `HcfsSetupDialog` component

**New file: `app/components/page-sections/settings/HcfsSetupDialog.tsx`**

Dialog shown after folder selection (first-time setup). Contains:

- Server URL input (pre-filled with `HCFS_CONFIG.defaultServerUrl`)
- Password input + confirm password input
- "Setup Sync" button

Pattern: Follow `StopSyncDialog.tsx` (Radix UI Dialog + `DialogContainer`)

Props:

```typescript
interface HcfsSetupDialogProps {
  open: boolean;
  onClose: () => void;
  onComplete: (result: { serverUrl: string; password: string }) => void;
  loading?: boolean;
}
```

### Step 6: Frontend — Create `MnemonicBackupDialog` component

**New file: `app/components/page-sections/settings/MnemonicBackupDialog.tsx`**

Dialog shown when HCFS generates a new mnemonic (OAuth users or first-time setup). Contains:

- Warning message about backing up
- Mnemonic display (masked by default, toggle to show)
- Copy button
- "I've backed it up" confirmation button

Pattern: Follow `OAuthTokenSection.tsx` for secret display (masked + eye toggle + copy)

Props:

```typescript
interface MnemonicBackupDialogProps {
  open: boolean;
  mnemonic: string;
  onConfirm: () => void;
}
```

### Step 7: Frontend — Create `useHcfsSync` hook

**New file: `app/lib/hooks/useHcfsSync.ts`**

Central hook for HCFS sync initialization logic:

```typescript
export function useHcfsSync() {
  const { polkadotAddress, authType } = useWalletAuth();
  const [isInitializing, setIsInitializing] = useState(false);
  const [mnemonicToBackup, setMnemonicToBackup] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Check if HCFS is configured
  const checkConfig = async (): Promise<boolean> => { ... }

  // Try to initialize sync (called on session restore + after setup)
  const tryInitializeSync = async (mnemonic?: string): Promise<boolean> => {
    // 1. Check sync path exists and is non-empty
    // 2. Check HCFS config exists (has_password)
    // 3. If both exist, call initialize_sync
    // 4. Handle result (mnemonic backup if needed)
    // 5. Return success/failure
  }

  // Full setup flow (called after folder selection)
  const setupAndInitialize = async (serverUrl: string, password: string, mnemonic?: string) => {
    // 1. save_hcfs_config
    // 2. initialize_sync
    // 3. If result.mnemonic, set mnemonicToBackup
  }

  return { tryInitializeSync, setupAndInitialize, isInitializing, mnemonicToBackup, setMnemonicToBackup, needsSetup, checkConfig };
}
```

### Step 8: Frontend — Wire up FilesContainer

**File: `app/components/page-sections/files/FilesContainer.tsx`**

Modify `handleFolderSelected`:

1. After `setPrivateSyncPath(path, polkadotAddress)` succeeds
2. Check if HCFS config exists via `getHcfsConfig(polkadotAddress)`
3. If no config → open `HcfsSetupDialog`
4. When dialog completes → call `setupAndInitialize(serverUrl, password, mnemonic?)`
5. If `mnemonicToBackup` returned → open `MnemonicBackupDialog`

Add state:

```typescript
const [showHcfsSetup, setShowHcfsSetup] = useState(false);
const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);
const [backupMnemonic, setBackupMnemonic] = useState("");
```

### Step 9: Frontend — Wire up UpdateSyncFolder (settings)

**File: `app/components/page-sections/settings/UpdateSyncFolder.tsx`**

Same pattern as FilesContainer:

- After `handlePrivateFolderSelected` succeeds → check config → show dialog if needed → initialize

### Step 10: Frontend — Wire up wallet-auth-context (session restore)

**File: `app/lib/wallet-auth-context.tsx`**

In the `setupSessionTimeout` effect (lines 186-349), after session is restored:

1. Import and use `tryInitializeSync` logic (or inline it)
2. After `syncInitialized.current = true`, actually call the backend:

   ```typescript
   if (!syncInitialized.current) {
     syncInitialized.current = true;
     // Get mnemonic if available (mnemonic auth only)
     const mnemonic = authType === "mnemonic" ? session?.mnemonic : undefined;
     // Try to initialize (will no-op if config not set)
     tryInitializeSync(polkadotAddress, mnemonic).catch(err => {
       console.error("[WalletAuth] Auto-sync init failed:", err);
     });
   }
   ```

3. In `login()` method — after successful login, try initialize sync with the mnemonic
4. In `setOAuthSession()` — after successful OAuth, try initialize sync without mnemonic

### Step 11: Frontend — Remove `IS_SYNC_PAUSED`

**File: `app/components/ui/SyncPausedAlert.tsx`**

- Change `IS_SYNC_PAUSED = true` to `IS_SYNC_PAUSED = false`

This re-enables all sync UI. The SyncPausedAlert component will return null since `IS_SYNC_PAUSED` is false.

### Step 12: Frontend — Add HCFS settings section

**File: `app/components/page-sections/settings/UpdateSyncFolder.tsx`**
(or a new `HcfsSettings.tsx` component added to the "File Settings" tab)

Below the sync folder section, add:

- "HCFS Server" section header
- Server URL input (read from config, editable)
- "Change Password" button (opens password change dialog)
- Save button

This gives users the ability to change their server URL and password from settings.

---

## Files Summary

### New files to create

| File | Purpose |
|------|---------|
| `app/lib/utils/hcfsConfigUtils.ts` | Config save/get + initializeSync utility |
| `app/components/page-sections/settings/HcfsSetupDialog.tsx` | First-time password + server URL dialog |
| `app/components/page-sections/settings/MnemonicBackupDialog.tsx` | HCFS mnemonic backup dialog |
| `app/lib/hooks/useHcfsSync.ts` | Central sync initialization hook |

### Files to modify

| File | Changes |
|------|---------|
| `src-tauri/src/builder_blocks/setup/mod.rs` | Add `hcfs_config` table |
| `src-tauri/src/commands/syncing.rs` | Add `save_hcfs_config`, `get_hcfs_config`; refactor `initialize_sync` to read from DB |
| `src-tauri/src/main.rs` | Register new commands |
| `app/lib/config.ts` | Add `HCFS_CONFIG` constants |
| `app/components/page-sections/files/FilesContainer.tsx` | Wire up HCFS setup after folder selection |
| `app/components/page-sections/settings/UpdateSyncFolder.tsx` | Wire up HCFS setup + add settings section |
| `app/lib/wallet-auth-context.tsx` | Call `initialize_sync` on session restore |
| `app/components/ui/SyncPausedAlert.tsx` | Set `IS_SYNC_PAUSED = false` |

---

## Verification Plan

1. **Backend compiles**: `cd src-tauri && cargo check`
2. **Frontend lints**: `pnpm lint` (zero errors)
3. **Manual test — First-time mnemonic user**:
   - Login with mnemonic → navigate to Files → select sync folder
   - HcfsSetupDialog appears → enter password + server URL → confirm
   - Sync initializes, no mnemonic backup dialog (mnemonic reused)
   - Check Rust logs for `[Setup]` messages and sync events
4. **Manual test — First-time OAuth user**:
   - Login with OAuth → select sync folder → enter password
   - MnemonicBackupDialog appears with generated mnemonic
   - Confirm backup → sync starts
5. **Manual test — Returning user**:
   - Close and reopen app
   - Session restores → sync auto-initializes (no dialogs)
   - Check console for `hcfs_sync_started` event
6. **Manual test — Settings change**:
   - Change sync folder in settings → setup dialog (if first time) or re-init
   - Change server URL → save → sync restarts
