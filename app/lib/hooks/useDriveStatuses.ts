"use client";

/**
 * Subscribe to per-drive sync status from the Rust backend.
 *
 * This hook is the **only** producer for `driveStatusesAtom`. The atom
 * mirrors whatever Rust says, full stop. On mount the hook calls
 * `get_all_drive_statuses` once to bootstrap the map, then subscribes
 * to two backend events:
 *
 * - `hcfs_drive_status_changed` — a single drive transitioned between
 *   Active and Paused. Updates that one entry in the map.
 * - `hcfs_drive_removed` — a drive was permanently removed via
 *   `remove_drive`. Drops that entry from the map.
 *
 * Mount this exactly once, at the protected layout root, alongside the
 * other invisible event-listener components (SyncEventLogger,
 * ConflictEventListener, MigrationChecker). It also flips
 * `driveStatusesLoadedAtom` to `true` after the initial fetch, so
 * gating components can distinguish "loading" from "loaded with no
 * drives".
 *
 * Replaces the legacy `useSyncEngineStatus` hook (deleted in the
 * per-drive status migration) which mirrored a single global enum and
 * couldn't represent multi-drive state.
 */

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
  type DriveEntry,
  type DriveStatus,
  type DriveStatusEntry,
} from "@/app/lib/global-atoms/unpinAtoms";

const DRIVE_STATUS_CHANGED = "hcfs_drive_status_changed";
const DRIVE_REMOVED = "hcfs_drive_removed";

interface DriveStatusChangedPayload {
  label: string;
  folderName: string;
  path: string;
  status: DriveStatus;
}

interface DriveRemovedPayload {
  label: string;
}

export function useDriveStatuses() {
  const setDriveStatuses = useSetAtom(driveStatusesAtom);
  const setLoaded = useSetAtom(driveStatusesLoadedAtom);

  useEffect(() => {
    let cancelled = false;
    let unlistenStatus: (() => void) | null = null;
    let unlistenRemoved: (() => void) | null = null;

    (async () => {
      // 1. Initial fetch — Rust returns one entry per row in
      //    `sync_paths` for the current account, with status derived
      //    from the `is_paused` column. Empty array when logged out.
      try {
        const entries = await invoke<DriveStatusEntry[]>(
          "get_all_drive_statuses"
        );
        if (cancelled) return;
        const map = new Map<string, DriveEntry>();
        for (const entry of entries) {
          map.set(entry.label, {
            folderName: entry.folderName,
            path: entry.path,
            status: entry.status,
          });
        }
        setDriveStatuses(map);
      } catch (err) {
        // Fail-soft: leave the map empty. The next per-drive event
        // from Rust will populate it incrementally. We still flip
        // `loaded` so gates don't get stuck in the "still loading"
        // state forever.
        console.warn("[useDriveStatuses] initial fetch failed:", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }

      if (cancelled) return;

      // 2. Per-drive status updates. Always create a new Map reference
      //    so Jotai/React observers re-render. The event payload now
      //    carries the full `{label, folderName, path, status}` shape
      //    so newly-configured drives populate correctly without a
      //    second `get_all_drive_statuses` round-trip — every consumer
      //    (tray, folder picker, "Reveal in Finder") gets a fully
      //    hydrated entry the moment Rust emits it.
      const statusHandle = await listen<DriveStatusChangedPayload>(
        DRIVE_STATUS_CHANGED,
        (event) => {
          if (cancelled) return;
          setDriveStatuses((prev) => {
            const next = new Map(prev);
            next.set(event.payload.label, {
              folderName: event.payload.folderName,
              path: event.payload.path,
              status: event.payload.status,
            });
            return next;
          });
        }
      );
      if (cancelled) {
        statusHandle();
        return;
      }
      unlistenStatus = statusHandle;

      // 3. Drive removals. Drop the entry from the map so per-drive
      //    UI can disappear without a separate "is removed" check.
      const removedHandle = await listen<DriveRemovedPayload>(
        DRIVE_REMOVED,
        (event) => {
          if (cancelled) return;
          setDriveStatuses((prev) => {
            if (!prev.has(event.payload.label)) return prev;
            const next = new Map(prev);
            next.delete(event.payload.label);
            return next;
          });
        }
      );
      if (cancelled) {
        removedHandle();
        return;
      }
      unlistenRemoved = removedHandle;
    })();

    return () => {
      cancelled = true;
      if (unlistenStatus) unlistenStatus();
      if (unlistenRemoved) unlistenRemoved();
    };
  }, [setDriveStatuses, setLoaded]);
}
