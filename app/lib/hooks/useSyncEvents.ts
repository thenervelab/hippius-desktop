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
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "./api/useRemoteStorageStats";

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

    // Debounced recent-files refresh: when individual files finish
    // uploading/downloading, schedule a refresh after 2 s of quiet.
    let fileCompletionTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRecentFilesRefresh = () => {
      if (fileCompletionTimer) clearTimeout(fileCompletionTimer);
      fileCompletionTimer = setTimeout(() => {
        fileCompletionTimer = null;
        window.dispatchEvent(
          new CustomEvent("sync_files_completed_changed", {
            detail: { filesCompleted: 1 },
          })
        );
      }, 2000);
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

          // Cancel the debounced per-file refresh — the full sync
          // completion below supersedes it.
          if (fileCompletionTimer) {
            clearTimeout(fileCompletionTimer);
            fileCompletionTimer = null;
          }

          // Always dispatch so file listings refresh metadata (arion
          // hashes, sync status, timestamps) even when no files were
          // transferred — the first sync after login typically has
          // zero transfers but populates server-side metadata.
          window.dispatchEvent(
            new CustomEvent("sync_files_completed_changed", {
              detail: { filesCompleted: totalCompleted },
            })
          );

          if (totalCompleted > 0) {
            queryClient.invalidateQueries({
              queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY],
            });
          }
        }],
        // Refresh recent files when individual files finish syncing.
        // Rust emits this event when bytes == total — no byte-count
        // interpretation needed in TypeScript.
        ["hcfs_file_transfer_complete", () => {
          scheduleRecentFilesRefresh();
        }],
        // Activity updated (e.g. file renamed on disk) — dispatch
        // immediately so recent files reflect the new name without
        // the 2-second debounce used for upload/download completion.
        ["hcfs_activity_updated", () => {
          window.dispatchEvent(
            new CustomEvent("sync_files_completed_changed", {
              detail: { filesCompleted: 0 },
            })
          );
        }],
        // Connectivity health updates
        ["hcfs_connectivity_changed", (e) => {
          setSyncEngineHealthAtom(e.payload as SyncEngineHealthState);
        }],
        // User-initiated stop — reset health to connected
        ["hcfs_sync_stopped", () => {
          setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
        }],
        // Full reset — show setup UI
        ["hcfs_sync_reset", () => {
          invoke("sp_clear_all_data").catch(() => {});
          setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
          setIsSyncConfiguredAtom(false);
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
      if (fileCompletionTimer) clearTimeout(fileCompletionTimer);
      unsubs.forEach((u) => u());
    };
  }, [setSyncEngineHealthAtom, queryClient]);
}
