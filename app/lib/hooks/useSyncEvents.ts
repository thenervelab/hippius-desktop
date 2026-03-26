"use client";

/**
 * Sync event listener — thin layer that forwards backend events to Jotai atoms.
 *
 * Session lifecycle (start, merge, complete, mark-failed) is managed entirely
 * by the Rust backend.  This hook only:
 *  - Tracks connectivity health (syncEngineHealthAtom)
 *  - Marks sync as configured (isSyncConfiguredAtom)
 *  - Invalidates queries on sync completion
 *  - Resets atoms on stop / full reset
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
  type SyncEngineHealthState,
} from "../store/syncAtoms";
import { isSyncConfiguredAtom } from "../global-atoms/unpinAtoms";
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

interface TransferProgress {
  label: string;
  bytes: number;
  total: number;
  path: string | null;
}

export function useSyncEvents() {
  const queryClient = useAtomValue(queryClientAtom);
  const setSyncEngineHealthAtom = useSetAtom(syncEngineHealthAtom);
  const setIsSyncConfiguredAtom = useSetAtom(isSyncConfiguredAtom);

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
      .catch((err) => {
        console.warn("[SyncEvents] Failed to get initial health state:", err);
      });

    (async () => {
      try {
        const results = await Promise.all([
          // Mark sync as configured when sync starts
          listen("hcfs_sync_started", () => {
            setIsSyncConfiguredAtom(true);
          }),
          // Invalidate queries when sync completes with file changes
          listen<SyncOutcome>("hcfs_sync_completed", (e) => {
            const totalCompleted =
              e.payload.files_uploaded +
              e.payload.files_downloaded +
              e.payload.files_deleted_locally +
              e.payload.files_deleted_remotely;

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
          }),
          // Refresh recent files when individual files finish syncing
          listen<TransferProgress>("hcfs_upload_progress", (e) => {
            if (e.payload.bytes >= e.payload.total && e.payload.total > 0) {
              scheduleRecentFilesRefresh();
            }
          }),
          listen<TransferProgress>("hcfs_download_progress", (e) => {
            if (e.payload.bytes >= e.payload.total && e.payload.total > 0) {
              scheduleRecentFilesRefresh();
            }
          }),
          // Activity updated (e.g. file renamed on disk) — dispatch
          // immediately so recent files reflect the new name without
          // the 2-second debounce used for upload/download completion.
          listen("hcfs_activity_updated", () => {
            window.dispatchEvent(
              new CustomEvent("sync_files_completed_changed", {
                detail: { filesCompleted: 0 },
              })
            );
          }),
          // Connectivity health updates
          listen<SyncEngineHealthState>(
            "hcfs_connectivity_changed",
            (e) => {
              setSyncEngineHealthAtom(e.payload);
            }
          ),
          // User-initiated stop — reset health to connected
          listen("hcfs_sync_stopped", () => {
            setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
          }),
          // Full reset — show setup UI
          listen("hcfs_sync_reset", async () => {
            await invoke("sp_clear_all_data").catch(() => {});
            setSyncEngineHealthAtom(DEFAULT_SYNC_ENGINE_HEALTH);
            setIsSyncConfiguredAtom(false);
          }),
        ]);
        if (cancelled) {
          results.forEach((u) => u());
        } else {
          unsubs.push(...results);
        }
      } catch (err) {
        console.warn(
          "[SyncEvents] Failed to register event listeners:",
          err
        );
      }
    })();

    return () => {
      cancelled = true;
      if (fileCompletionTimer) clearTimeout(fileCompletionTimer);
      unsubs.forEach((u) => u());
    };
  }, [setSyncEngineHealthAtom, setIsSyncConfiguredAtom, queryClient]);
}
