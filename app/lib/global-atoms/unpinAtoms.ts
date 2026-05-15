import { atom } from "jotai";

// Atom to trigger sync path updates refresh
export const triggerSyncPathRefreshAtom = atom<number>(0);

/**
 * Per-drive sync status. Mirrors the Rust backend's `DriveStatus` enum
 * (see `src-tauri/src/sync/drive_status.rs`). Wire format is the tagged
 * shape `{"kind": "active"}`. The `error` variant is emitted by
 * `auto_init_sync_inner` when a per-drive init fails (e.g. mnemonic not
 * yet recoverable on slow-system cold starts); consumers render it as a
 * "needs attention" state with a retry affordance.
 */
export type DriveStatus =
  | { kind: "active" }
  | { kind: "paused" }
  | { kind: "error"; message: string };

/**
 * One row in the response from `get_all_drive_statuses`. Mirrors the
 * Rust `DriveStatusEntry`. The atom itself stores a richer
 * `DriveEntry` (with `folderName` and `path`) so consumers like the
 * tray submenu, folder pickers, and "Reveal in Finder" wiring can
 * render user-facing data without a second IPC round-trip into the
 * `sync_paths` table.
 */
export interface DriveStatusEntry {
  label: string;
  folderName: string;
  path: string;
  status: DriveStatus;
}

/**
 * One row in `driveStatusesAtom`. Bundles status with the user-facing
 * folder name and on-disk path so per-drive UI surfaces (tray submenu,
 * settings, folder pickers) can render the friendly name and resolve
 * label → path without re-fetching the sync paths.
 */
export interface DriveEntry {
  folderName: string;
  path: string;
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

/**
 * Per-drive "metadata stale" set, keyed by drive label.
 *
 * A label appears in this map when Rust's `spawn_reconcile_timestamps`
 * exhausts its retry budget for that drive (every attempt to fetch
 * the server's authoritative `remote_timestamps` failed). The value
 * is the short human-readable reason from the backend, suitable for
 * display under the banner heading.
 *
 * The entry self-clears the next time the same label emits
 * `hcfs_activity_updated` — the assumption being that any successful
 * cycle has backfilled the missing timestamps. This avoids an
 * explicit "retry now" channel; the next normal sync handles it.
 *
 * Owned by `useMetadataStaleListener`, which is mounted via
 * `SyncEventLogger`. Frontend code must never mutate this atom from
 * a click handler — it mirrors backend state.
 */
export const metadataStaleLabelsAtom = atom<Map<string, string>>(new Map());

/**
 * Set to `true` when Rust's `restore_session` successfully rehydrated
 * the session but the OS keychain didn't contain the user's BIP-39
 * mnemonic — so `AuthInfo.mnemonic` is `None` and the sync engine is
 * wedged behind the encrypted `drive_password` chicken-and-egg lock.
 *
 * This specifically matches `AuthCapabilities::Restored` for mnemonic
 * users. OAuth users use `ensure_sync_mnemonic` to generate a mnemonic
 * on demand and don't hit this state.
 *
 * Owned by `wallet-auth-context.tsx`:
 *   - written from `result.syncRequiresReauth` after `restore_session`
 *     returns;
 *   - cleared to `false` after a successful `login_with_mnemonic`
 *     (which populates `AuthInfo.mnemonic` and the keychain).
 *
 * Consumed by `<SyncReauthRequiredAlert />` which renders a banner
 * with a call-to-action that routes to `/login` for re-entering the
 * seed phrase — the only recovery path.
 *
 * Parallel to the deleted `SyncStoppedAlert` UI (commit `6f467abe`)
 * but scoped to the specific "mnemonic lost" case rather than the
 * old global engine-stopped state.
 */
export const syncRequiresReauthAtom = atom<boolean>(false);

