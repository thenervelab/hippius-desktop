import { atom } from "jotai";
import type { StagedChanges } from "@/lib/types/syncTypes";

// Stores the current sync percentage (null when not syncing)
// This is the AGGREGATE percentage, not per-file
export const syncPercentAtom = atom<number | null>(null);

// Stores pending conflicts detected during auto-sync (null when no conflicts)
export const pendingConflictsAtom = atom<StagedChanges | null>(null);

// Tracks whether we've already updated the tray for the current percentage
export const lastUpdatedPercentAtom = atom<number | null>(null);

// Tracks if the tray menu is currently being updated to prevent conflicts
export const trayUpdateInProgressAtom = atom<boolean>(false);

// Tracks the last time the tray was successfully updated
export const lastTrayUpdateTimeAtom = atom<number>(0);

// Track the overall sync status
export const syncStatusAtom = atom<{
  synced_files: number;
  total_files: number;
  in_progress: boolean;
  percent: number;
} | null>(null);

// Local sync event progress tracking (from Tauri events)
export interface SyncProgressPayload {
  bytes: number;
  total: number;
  path?: string;
}

// Whether a sync operation is currently in progress (from hcfs_sync_started/completed events)
export const isSyncingAtom = atom<boolean>(false);

// Current upload progress (from hcfs_upload_progress events)
export const uploadProgressAtom = atom<SyncProgressPayload | null>(null);

// Current download progress (from hcfs_download_progress events)
export const downloadProgressAtom = atom<SyncProgressPayload | null>(null);

// Last sync error (from hcfs_sync_error events)
export const lastSyncErrorAtom = atom<string | null>(null);

// Track if sync ended with an error - keeps widget visible until user dismisses
export const hasSyncErrorAtom = atom<boolean>(false);

// Track completed files count during current sync session
// This counts files that have finished uploading (bytes == total)
export const completedFilesCountAtom = atom<number>(0);

// Track expected total files to sync (from hcfs_sync_started event)
// This is set when sync starts and used to show accurate "X of Y" progress
export const totalFilesToSyncAtom = atom<number>(0);

// Track the current file being synced
export const currentSyncFileAtom = atom<string | null>(null);

// Track files that have been completed in this sync session (to avoid double counting)
export const completedFilePathsAtom = atom<Set<string>>(new Set<string>());

// Track sync action counts from hcfs_sync_started event
// This helps the UI show appropriate text like "Downloading X of Y files" vs "Uploading X of Y files"
export interface SyncActionCounts {
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
}

export const syncActionCountsAtom = atom<SyncActionCounts>({
  uploads: 0,
  downloads: 0,
  localDeletes: 0,
  remoteDeletes: 0,
});
