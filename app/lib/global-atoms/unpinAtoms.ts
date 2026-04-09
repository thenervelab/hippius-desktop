import { atom } from "jotai";

// Atom to trigger sync path updates refresh
export const triggerSyncPathRefreshAtom = atom<number>(0);

// Atom to track whether HCFS sync has been configured (has password).
// This is set when sync is initialised successfully, or when we confirm config exists.
// Used to differentiate "stopped by user" vs "never set up".
export const isSyncConfiguredAtom = atom<boolean>(false);

/**
 * Per-drive sync status. Mirrors the Rust backend's `DriveStatus` enum
 * (see `src-tauri/src/sync/drive_status.rs`). Wire format is the tagged
 * shape `{"kind": "active"}` so a future `Error` variant can be added
 * without breaking compatibility.
 */
export type DriveStatus = { kind: "active" } | { kind: "paused" };

/**
 * One row in the response from `get_all_drive_statuses`. Mirrors the
 * Rust `DriveStatusEntry`. The atom itself stores a richer
 * `DriveEntry` (with `folderName`) so consumers like the tray submenu
 * can show user-facing folder names without a second IPC round-trip.
 */
export interface DriveStatusEntry {
  label: string;
  folderName: string;
  status: DriveStatus;
}

/**
 * One row in `driveStatusesAtom`. Bundles status with the user-facing
 * folder name so per-drive UI surfaces (tray submenu, settings) can
 * render the friendly name without re-fetching the sync paths.
 */
export interface DriveEntry {
  folderName: string;
  status: DriveStatus;
}

/**
 * Per-drive status map, keyed by drive label. Single source of truth
 * for "is this drive active or paused". Replaces the old global
 * `syncEngineStatusAtom` enum.
 *
 * Owned by `useDriveStatuses` (mounted once at the protected layout
 * root). All transitions originate from Rust — never mutate this atom
 * from a click handler. Call the `pause_drive` / `resume_drive` /
 * `remove_drive` Tauri commands and let the backend's
 * `hcfs_drive_status_changed` / `hcfs_drive_removed` events propagate
 * the change.
 */
export const driveStatusesAtom = atom<Map<string, DriveEntry>>(new Map());

/**
 * Latch flipped to `true` after `useDriveStatuses` completes its first
 * `get_all_drive_statuses` fetch. Lets gating components distinguish
 * "the map is empty because we haven't loaded yet" (treat as configured)
 * from "the map is empty because the user has no sync paths" (show the
 * setup dialog). Equivalent to the old `"initializing" → "stopped"`
 * transition that the previous `syncEngineStatusAtom` modeled.
 */
export const driveStatusesLoadedAtom = atom<boolean>(false);

/**
 * Derived: does the user have at least one configured sync drive?
 *
 * - Returns `true` while `driveStatusesLoadedAtom` is still `false`
 *   (i.e. cold-start, before the first fetch). This matches the old
 *   "treat `initializing` like `active`" rule and prevents the
 *   "set up sync" dialog from flashing on every page load.
 * - Returns `true` once loaded if the per-drive map has any entries
 *   (regardless of whether they're Active or Paused — a paused drive
 *   is still configured).
 * - Returns `false` only after the load completes AND the map is empty.
 *
 * Use this in click handlers that previously gated on
 * `syncEngineStatus === "stopped"`.
 */
export const hasConfiguredDrivesAtom = atom((get) => {
  const loaded = get(driveStatusesLoadedAtom);
  if (!loaded) return true;
  return get(driveStatusesAtom).size > 0;
});
