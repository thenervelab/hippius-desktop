"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useCallback, useRef } from "react";
import { useSetAtom } from "jotai";
import { serverSyncStatusAtom, type ServerSyncStatus } from "../store/syncAtoms";

export type { ServerSyncStatus };

/**
 * Hook that polls the server for sync status.
 * Updates the serverSyncStatusAtom with the latest status.
 * Polling frequency increases during active sync.
 */
export function useServerSyncStatus() {
  const setServerSyncStatus = useSetAtom(serverSyncStatusAtom);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastFilesCompletedRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await invoke<ServerSyncStatus | null>("get_server_sync_status");
      
      // Log the server response for debugging
      console.log("[useServerSyncStatus] Server response:", status);
      
      if (status) {
        console.log(
          `[useServerSyncStatus] active=${status.active}, progress=${status.progress_percent}%, ` +
          `files: completed=${status.files_completed}, active=${status.files_active}, ` +
          `pending=${status.files_pending}, failed=${status.files_failed}`
        );
        setServerSyncStatus(status);
        
        // Track if files_completed changed for triggering refetch
        if (status.files_completed !== lastFilesCompletedRef.current) {
          lastFilesCompletedRef.current = status.files_completed;
          // Emit custom event for components that need to refetch
          window.dispatchEvent(new CustomEvent("sync_files_completed_changed", {
            detail: { filesCompleted: status.files_completed }
          }));
        }
      } else {
        console.log("[useServerSyncStatus] Server returned null status");
      }
      
      return status;
    } catch (err) {
      console.warn("[useServerSyncStatus] Failed to fetch status:", err);
      return null;
    }
  }, [setServerSyncStatus]);

  useEffect(() => {
    // Initial fetch
    fetchStatus();

    // Start polling - 2 seconds during active sync, 10 seconds otherwise
    const startPolling = async () => {
      const poll = async () => {
        const status = await fetchStatus();
        
        // Adjust polling interval based on sync activity
        const interval = status?.active ? 2000 : 10000;
        
        if (intervalRef.current) {
          clearTimeout(intervalRef.current);
        }
        intervalRef.current = setTimeout(poll, interval);
      };
      
      poll();
    };

    startPolling();

    return () => {
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchStatus]);

  return { fetchStatus };
}

export default useServerSyncStatus;
