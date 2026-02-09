"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

interface SyncOutcome {
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  conflicts_resolved: number;
  conflicts_skipped: number;
}

interface SyncError {
  error: string;
}

interface ProgressPayload {
  bytes: number;
  total: number;
  path?: string;
}

export function useSyncEvents() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [uploadProgress, setUploadProgress] =
    useState<ProgressPayload | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<ProgressPayload | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);
  const [lastError, setLastError] = useState<SyncError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    (async () => {
      try {
        const results = await Promise.all([
          listen("hcfs_sync_started", () => {
            console.log("[SyncEvents] Sync started");
            setIsSyncing(true);
            setLastError(null);
          }),
          listen<SyncOutcome>("hcfs_sync_completed", (e) => {
            console.log("[SyncEvents] Sync completed:", e.payload);
            setIsSyncing(false);
            setLastOutcome(e.payload);
            setUploadProgress(null);
            setDownloadProgress(null);
          }),
          listen<SyncError>("hcfs_sync_error", (e) => {
            console.error("[SyncEvents] Sync error:", e.payload);
            setIsSyncing(false);
            setLastError(e.payload);
          }),
          listen<ProgressPayload>("hcfs_upload_progress", (e) => {
            console.debug("[SyncEvents] Upload progress:", e.payload);
            setUploadProgress(e.payload);
          }),
          listen<ProgressPayload>("hcfs_download_progress", (e) => {
            console.debug("[SyncEvents] Download progress:", e.payload);
            setDownloadProgress(e.payload);
          }),
        ]);
        if (cancelled) {
          results.forEach((u) => u());
        } else {
          unsubs.push(...results);
        }
      } catch (err) {
        console.warn("[SyncEvents] Failed to register event listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  return {
    isSyncing,
    uploadProgress,
    downloadProgress,
    lastOutcome,
    lastError,
  };
}
