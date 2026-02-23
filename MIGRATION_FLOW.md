# Desktop App Migration Flow Documentation

## Overview

This document outlines the migration flow for users with existing files in the old S3-based storage system to the new HCFS sync engine. The migration involves downloading files from S3 and re-uploading them through the HCFS client.

---

## User Flow

### 1. Detection (On App Start / Files Page Mount)

When user opens the app or navigates to the Files page:

1. Check if migration is needed by calling backend command `check_migration_needed`
2. If old S3 data exists, show migration prompt dialog
3. Block file uploads until migration is complete or skipped

### 2. Migration Prompt Dialog

Shows when migration is detected. User has two choices:
- **Migrate My Files** (Recommended) - Download and re-upload all files
- **Start Fresh** - Skip migration, lose access to old files in app

### 3. Start Fresh Confirmation

If user chooses "Start Fresh":
- Show confirmation dialog requiring user to type "DELETE" 
- Warn that files won't appear in Hippius Drive (but still accessible via IPFS links)

### 4. Migration Progress

If user chooses "Migrate My Files":
- Show progress dialog with:
  - Current step indicator (Step 1: Downloading, Step 2: Uploading)
  - Progress bar with percentage
  - Current file being processed
  - Files completed / total count
  - Estimated time remaining
  - Cancel button

### 5. Migration Complete

Show completion dialog with:
- Success count
- Failed count (with option to view details/retry)
- Done button to close

---

## Backend API Requirements (Rust Commands)

### 1. `check_migration_needed`

**Purpose**: Check if user has old S3 data that needs migration

**Returns**:
```typescript
interface MigrationCheckResult {
  needsMigration: boolean;
  fileCount: number;
  totalSize: number; // bytes
}
```

### 2. `start_migration`

**Purpose**: Begin downloading files from old S3 and sync to HCFS

**Parameters**: None (uses stored S3 credentials)

**Emits Events**:
- `migration_started`
- `migration_progress` - { currentFile, totalFiles, completedFiles, currentFileName, bytesDownloaded, totalBytes, step: "downloading" | "uploading" }
- `migration_file_complete` - { fileName, success, error? }
- `migration_complete` - { success: number, failed: number, failedFiles: string[] }
- `migration_error` - { error: string }

### 3. `cancel_migration`

**Purpose**: Cancel ongoing migration

**Returns**: `{ success: boolean }`

### 4. `skip_migration`

**Purpose**: Mark migration as skipped (user chose "Start Fresh")

**Returns**: `{ success: boolean }`

### 5. `get_migration_status`

**Purpose**: Get current migration status (for reconnection scenarios)

**Returns**:
```typescript
interface MigrationStatus {
  isInProgress: boolean;
  currentStep: "idle" | "downloading" | "uploading" | "complete" | "cancelled" | "skipped";
  progress: number; // 0-100
  currentFile: string;
  completedFiles: number;
  totalFiles: number;
}
```

---

## Frontend Components

### File Structure

```
app/
├── components/
│   └── page-sections/
│       └── files/
│           └── migration/
│               ├── MigrationPromptDialog.tsx
│               ├── MigrationConfirmSkipDialog.tsx
│               ├── MigrationProgressDialog.tsx
│               └── MigrationCompleteDialog.tsx
├── lib/
│   ├── hooks/
│   │   └── use-migration.ts
│   └── global-atoms/
│       └── migrationAtoms.ts
```

---

## Component Designs

### 1. MigrationPromptDialog

Uses existing patterns from `DeleteConfirmationDialog` and `DialogContainer`.

```tsx
// Key elements:
// - Graphsheet background with icon (use Icons.FolderSync or similar)
// - Title: "Migration Required"
// - Subtitle explaining the upgrade
// - File count/size display box
// - Two CardButton actions: "Migrate My Files" (primary), "Start Fresh" (secondary)
// - Warning text about blocked uploads
```

**Props**:
```typescript
interface MigrationPromptDialogProps {
  open: boolean;
  onClose: () => void;
  onMigrate: () => void;
  onSkip: () => void;
  fileCount: number;
  totalSize: number;
}
```

### 2. MigrationConfirmSkipDialog

Similar to `DeleteConfirmationDialog` pattern.

```tsx
// Key elements:
// - Error icon (warning style)
// - Title: "Are you sure?"
// - Warning text about losing file access
// - Input field requiring "DELETE" confirmation
// - Cancel and Confirm buttons (Confirm disabled until "DELETE" typed)
```

**Props**:
```typescript
interface MigrationConfirmSkipDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}
```

### 3. MigrationProgressDialog

Similar to `SyncStatusDialog` pattern.

```tsx
// Key elements:
// - Download icon with Graphsheet background
// - Title: "Migrating Your Files"
// - Step indicator: "Step 1 of 2: Downloading from cloud"
// - ProgressBar component showing percentage
// - Current file name
// - "Downloaded: X of Y files"
// - Estimated time remaining
// - Scrollable file list (like SyncStatusDialog)
// - Warning: "Please don't close the app during migration"
// - Cancel Migration button (secondary style)
// - preventClose={true} on DialogContainer
```

**Props**:
```typescript
interface MigrationProgressDialogProps {
  open: boolean;
  onCancel: () => void;
  step: "downloading" | "uploading";
  progress: number;
  currentFile: string;
  completedFiles: number;
  totalFiles: number;
  fileList: Array<{ name: string; status: "pending" | "in-progress" | "complete" | "error" }>;
}
```

### 4. MigrationCompleteDialog

```tsx
// Key elements:
// - Success icon (checkmark) with Graphsheet background
// - Title: "Migration Complete!"
// - Success message
// - Stats box: "✓ X files migrated successfully" + "⚠️ Y files failed (view details)"
// - View Log button (secondary) - optional
// - Done button (primary)
```

**Props**:
```typescript
interface MigrationCompleteDialogProps {
  open: boolean;
  onClose: () => void;
  successCount: number;
  failedCount: number;
  failedFiles?: string[];
  onViewLog?: () => void;
}
```

---

## State Management (Jotai Atoms)

```typescript
// app/lib/global-atoms/migrationAtoms.ts

import { atom } from "jotai";

export interface MigrationState {
  needsMigration: boolean;
  isChecking: boolean;
  isInProgress: boolean;
  currentStep: "idle" | "downloading" | "uploading" | "complete" | "cancelled" | "skipped";
  progress: number;
  currentFile: string;
  completedFiles: number;
  totalFiles: number;
  totalSize: number;
  successCount: number;
  failedCount: number;
  failedFiles: string[];
  fileList: Array<{ name: string; status: "pending" | "in-progress" | "complete" | "error" }>;
}

export const migrationStateAtom = atom<MigrationState>({
  needsMigration: false,
  isChecking: false,
  isInProgress: false,
  currentStep: "idle",
  progress: 0,
  currentFile: "",
  completedFiles: 0,
  totalFiles: 0,
  totalSize: 0,
  successCount: 0,
  failedCount: 0,
  failedFiles: [],
  fileList: [],
});

// Dialog visibility atoms
export const showMigrationPromptAtom = atom(false);
export const showMigrationProgressAtom = atom(false);
export const showMigrationCompleteAtom = atom(false);
export const showMigrationSkipConfirmAtom = atom(false);
```

---

## Hook: useMigration

```typescript
// app/lib/hooks/use-migration.ts

export function useMigration() {
  // Returns:
  return {
    // State
    migrationState,
    
    // Actions
    checkMigrationNeeded: () => Promise<void>,
    startMigration: () => Promise<void>,
    cancelMigration: () => Promise<void>,
    skipMigration: () => Promise<void>,
    
    // Dialog controls
    showPrompt: () => void,
    hidePrompt: () => void,
    showProgress: () => void,
    hideProgress: () => void,
    showComplete: () => void,
    hideComplete: () => void,
  };
}
```

---

## Files Page Integration

### Changes to `app/(pages)/files/page.tsx`:

1. Check migration on mount:
```tsx
const { migrationState, checkMigrationNeeded } = useMigration();

useEffect(() => {
  checkMigrationNeeded();
}, []);
```

2. Disable upload when migration needed:
```tsx
const canUpload = !migrationState.needsMigration || migrationState.currentStep === "skipped";
```

3. Show migration banner (optional, for visibility):
```tsx
{migrationState.needsMigration && migrationState.currentStep === "idle" && (
  <MigrationBanner onMigrate={showPrompt} />
)}
```

4. Render migration dialogs:
```tsx
<MigrationPromptDialog ... />
<MigrationConfirmSkipDialog ... />
<MigrationProgressDialog ... />
<MigrationCompleteDialog ... />
```

---

## Event Listeners

Listen to Tauri events for progress updates:

```typescript
import { listen } from "@tauri-apps/api/event";

// In useMigration hook or component:
useEffect(() => {
  const unlistenProgress = listen("migration_progress", (event) => {
    // Update migrationState with progress
  });
  
  const unlistenComplete = listen("migration_complete", (event) => {
    // Show completion dialog
  });
  
  const unlistenError = listen("migration_error", (event) => {
    // Handle error, show toast
  });
  
  return () => {
    unlistenProgress.then(fn => fn());
    unlistenComplete.then(fn => fn());
    unlistenError.then(fn => fn());
  };
}, []);
```

---

## UI Component Usage Reference

Use these existing components/patterns:

| Element | Component/Pattern |
|---------|------------------|
| Dialog container | `DialogContainer` from `@/components/ui/DialogContainer` |
| Dialog state | `@radix-ui/react-dialog` |
| Buttons | `CardButton` from `@/components/ui` |
| Icons | `Icons` from `@/components/ui` |
| Background pattern | `Graphsheet` from `@/components/ui` |
| Progress bar | `ProgressBar` from `@/components/progress-bar` |
| Warning box | Pattern from `ImportantWarnings` |
| File list | Pattern from `SyncStatusDialog` |
| Toast notifications | `toast` from `sonner` |

---

## Styling Notes

- Use existing Tailwind classes from the design system
- Primary button: `CardButton variant="dialog"` or `variant="primary"`
- Secondary button: `CardButton variant="secondary"`
- Error/Warning styling: `bg-error-50`, `text-error-50`, `bg-warning-50/10`
- Success styling: `text-success-50`
- Icon containers: Use Graphsheet background pattern with gradient overlay
- Dialog max-width: `md:max-w-[428px]` to `md:max-w-[500px]`

---

## Error Handling

1. **Network errors during download**: Show toast, allow retry
2. **Partial failure**: Complete what's possible, show failed files in completion dialog
3. **Cancellation**: Clean up partial downloads, reset state
4. **App crash during migration**: On next launch, check `get_migration_status` and resume or show completion

---

## Testing Checklist

- [ ] Migration detection works correctly
- [ ] "Migrate My Files" starts download process
- [ ] Progress updates show correctly
- [ ] Cancel migration works and cleans up
- [ ] "Start Fresh" requires confirmation
- [ ] Completion dialog shows accurate counts
- [ ] Failed files can be retried
- [ ] Upload is blocked during pending migration
- [ ] Migration state persists across app restarts
- [ ] Events properly update UI state
