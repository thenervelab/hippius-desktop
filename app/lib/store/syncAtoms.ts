import { atom } from 'jotai';

// Stores the current sync percentage (null when not syncing)
export const syncPercentAtom = atom<number | null>(null);

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
