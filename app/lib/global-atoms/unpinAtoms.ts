import { atom } from "jotai";

// Atom to trigger sync path updates refresh
export const triggerSyncPathRefreshAtom = atom<number>(0);

// Atom to track whether HCFS sync has been configured (has password).
// This is set when sync is initialised successfully, or when we confirm config exists.
// Used to differentiate "stopped by user" vs "never set up".
export const isSyncConfiguredAtom = atom<boolean>(false);

// Atom to track sync engine status.
// "active"   = drive is loaded and syncing
// "stopping" = user pressed stop, waiting for engine to finish
// "stopped"  = engine fully stopped
export type SyncEngineStatus = "active" | "stopping" | "stopped";

/** localStorage key used to persist the user's explicit "stop sync" choice across app restarts. */
export const SYNC_STOPPED_STORAGE_KEY = "hippius_sync_stopped";

/** localStorage key used to persist the user's choice to skip files onboarding. */
export const FILES_ONBOARDING_SKIPPED_KEY = "hippius_files_onboarding_skipped";

// Read persisted state: if the user explicitly stopped sync before quitting,
// start in "stopped" so auto-init is skipped.
const initialSyncStatus: SyncEngineStatus =
  typeof window !== "undefined" && localStorage.getItem(SYNC_STOPPED_STORAGE_KEY) === "true"
    ? "stopped"
    : "active";

export const syncEngineStatusAtom = atom<SyncEngineStatus>(initialSyncStatus);
