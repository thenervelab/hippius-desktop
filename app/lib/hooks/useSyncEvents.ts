"use client";

/**
 * Sync event listener — thin layer that forwards backend events to Jotai atoms.
 *
 * Session lifecycle (start, merge, complete, mark-failed) is managed entirely
 * by the Rust backend.  This hook only:
 *  - Tracks connectivity health (syncEngineHealthAtom)
 *  - Invalidates queries on sync completion
 *  - Resets atoms on stop / full reset
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../utils/errorUtils";
import {
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
  type SyncEngineHealthState,
} from "../store/syncAtoms";
import { queryClientAtom } from "jotai-tanstack-query";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "./api/useDriveStorageStats";

interface SyncOutcome {
  label?: string;
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  conflicts_resolved: number;
  conflicts_skipped: number;
}

export function useSyncEvents() {
  const queryClient = useAtomValue(queryClientAtom);
  const setSyncEngineHealthAtom = useSetAtom(syncEngineHealthAtom);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    // Coalesced "files completed" dispatch (fixes Bug 3 — refresh flicker).
    //
    // Three backend events can each trigger a file-list refetch:
    //   - hcfs_sync_completed         (whole-cycle summary)
    //   - hcfs_file_transfer_complete (per-file finish)
    //   - hcfs_activity_updated       (rename / metadata change)
    //
    // When a sync cycle finishes, all three can arrive within a few
    // milliseconds.  Dispatching the window event three times re-runs
    // the row enricher in `use-recent-files` / `use-user-files` three
    // times, which the user sees as a visible flicker.  A trailing-
    // edge 250 ms debounce collapses any burst into a single dispatch
    // while still being fast enough to feel instantaneous.
    let pendingDispatchTimer: ReturnType<typeof setTimeout> | null = null;
    // Carry the largest filesCompleted seen during the burst forward
    // to the single coalesced dispatch.  `hcfs_activity_updated` reports
    // 0, but if a sibling `hcfs_sync_completed` reported N>0 we want
    // the consumer to see N rather than have it overwritten by 0.
    let pendingFilesCompleted = 0;
    const DEBOUNCE_MS = 250;
    // Floor between dispatches while completions keep arriving. The 250ms
    // trailing debounce only collapses near-simultaneous bursts — during a
    // long multi-file sync, per-file `hcfs_file_transfer_complete` events
    // drip in every second or two, and each one used to trigger a full
    // file-list refetch (an expensive `list_user_files` walk plus a
    // whole-table re-render). Spacing the steady drip to one dispatch per
    // interval keeps long listings scrollable during sync; the trailing
    // timer still guarantees the final completion always lands.
    const MIN_DISPATCH_INTERVAL_MS = 3000;
    let lastDispatchAt = 0;
    // NOTE: dispatches are throttled, never held. An earlier iteration
    // suppressed them entirely while a session was transferring, which
    // starved every listing that refreshes off this event — a folder the
    // user had just dropped files into stayed visibly empty until a manual
    // refresh. Liveness wins; row-stability is handled where it belongs
    // (stable row keys + the coarse actionable-files atom).
    const scheduleCompletedDispatch = (filesCompleted: number) => {
      pendingFilesCompleted = Math.max(pendingFilesCompleted, filesCompleted);
      if (pendingDispatchTimer) clearTimeout(pendingDispatchTimer);
      // Idle → fire after the short debounce (feels instantaneous).
      // Mid-storm → push out to the interval floor since the last dispatch.
      const sinceLast = Date.now() - lastDispatchAt;
      const wait = Math.max(DEBOUNCE_MS, MIN_DISPATCH_INTERVAL_MS - sinceLast);
      pendingDispatchTimer = setTimeout(() => {
        const total = pendingFilesCompleted;
        pendingDispatchTimer = null;
        pendingFilesCompleted = 0;
        lastDispatchAt = Date.now();
        window.dispatchEvent(
          new CustomEvent("sync_files_completed_changed", {
            detail: { filesCompleted: total },
          })
        );
      }, wait);
    };

    // Query current health state on mount (backend may already be running)
    invoke<SyncEngineHealthState>("get_sync_engine_health")
      .then((health) => {
        if (!cancelled) {
          setSyncEngineHealthAtom(health);
        }
      })
      .catch((err: unknown) => {
        console.warn("[SyncEvents] Failed to get initial health state:", errorMessage(err));
      });

    const register = async () => {
      const handlers: Array<[string, (e: import("@tauri-apps/api/event").Event<unknown>) => void]> = [
        // Invalidate queries when sync completes with file changes
        // (no-op for `hcfs_sync_started` — drive-configured state is
        // derived from `driveStatusesAtom` via `hasConfiguredDrivesAtom`)
        ["hcfs_sync_completed", (e) => {
          const p = e.payload as SyncOutcome;
          const totalCompleted =
            p.files_uploaded +
            p.files_downloaded +
            p.files_deleted_locally +
            p.files_deleted_remotely;

          // Always dispatch so file listings refresh metadata (arion
          // hashes, sync status, timestamps) even when no files were
          // transferred — the first sync after login typically has
          // zero transfers but populates server-side metadata.  Routed
          // through the coalescing scheduler so a near-simultaneous
          // hcfs_file_transfer_complete or hcfs_activity_updated does
          // not produce a second refetch.
          scheduleCompletedDispatch(totalCompleted);

          if (totalCompleted > 0) {
            queryClient.invalidateQueries({
              queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
            });
          }
        }],
        // Per-file completion — Rust emits this when bytes == total.
        // Coalesced with the rest so a multi-file batch produces one
        // refetch, not one per file.
        ["hcfs_file_transfer_complete", () => {
          scheduleCompletedDispatch(1);
        }],
        // Activity updated (e.g. file renamed on disk) — coalesced
        // with siblings so a sync-completed burst doesn't flicker.
        ["hcfs_activity_updated", () => {
          scheduleCompletedDispatch(0);
        }],
        // Connectivity health updates
        ["hcfs_connectivity_changed", (e) => {
          setSyncEngineHealthAtom(e.payload as SyncEngineHealthState);
        }],
        // User-initiated stop — reset health to connected
        ["hcfs_sync_stopped", () => {
          setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
        }],
        // Full reset — show setup UI. The "is configured?" state is
        // derived from driveStatusesAtom (via hasConfiguredDrivesAtom),
        // which empties on its own when Rust emits hcfs_drive_removed
        // for each drive during the reset.
        ["hcfs_sync_reset", () => {
          invoke("sp_clear_all_data").catch(() => {});
          setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
        }],
      ];

      for (const [event, handler] of handlers) {
        if (cancelled) break;
        try {
          const unsub = await listen(event, handler);
          if (cancelled) { unsub(); } else { unsubs.push(unsub); }
        } catch (err) {
          console.warn(`[SyncEvents] Failed to register ${event}:`, errorMessage(err));
        }
      }
    };

    register();

    return () => {
      cancelled = true;
      // Drop any pending debounced dispatch so an unmount mid-burst
      // doesn't fire a refetch against a stale store or torn-down hook.
      if (pendingDispatchTimer) clearTimeout(pendingDispatchTimer);
      unsubs.forEach((u) => u());
    };
  }, [setSyncEngineHealthAtom, queryClient]);
}
