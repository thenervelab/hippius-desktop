import { atom } from "jotai";

// Atom to trigger sync path updates refresh
export const triggerSyncPathRefreshAtom = atom<number>(0);

// Atom to track whether HCFS sync has been configured (has password).
// This is set when sync is initialised successfully, or when we confirm config exists.
// Used to differentiate "stopped by user" vs "never set up".
export const isSyncConfiguredAtom = atom<boolean>(false);

/**
 * Sync engine status, mirrored from the Rust backend.
 *
 * The atom is owned by `useSyncEngineStatus` (mounted once at the protected
 * layout root). All transitions originate from Rust — never set this atom
 * directly from a click handler. Use the `stop_drive` / `initialize_sync*`
 * Tauri commands and let the backend's `SYNC_ENGINE_STATUS_CHANGED` event
 * propagate the change back.
 *
 * - `initializing` — process started but `auto_init_sync` hasn't completed
 *   yet. UI components MUST treat this like `active` for purposes of the
 *   "Stopped" alert (i.e. don't render it). On cold start the atom holds
 *   this value until the first event from Rust arrives.
 * - `active` — at least one drive is loaded and the sync loop is running.
 * - `stopping` — `stop_drive` is in flight; teardown in progress.
 * - `stopped` — user explicitly stopped sync (persisted in
 *   `user_preferences.sync_user_stopped`), or auto-init found no drives to
 *   bring up.
 */
export type SyncEngineStatus = "initializing" | "active" | "stopping" | "stopped";

export const syncEngineStatusAtom = atom<SyncEngineStatus>("initializing");
