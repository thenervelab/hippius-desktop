import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import type { SyncSnapshot } from "@/lib/types/syncSnapshot";

/** Serialisable summary of a synced file stored inside releaseNotes JSON. */
export interface SyncedFileDetail {
  fileName: string;
  totalBytes: number;
  action: string; // upload | download | local_delete | remote_delete
}

interface SyncOutcome {
  label?: string;
  files_uploaded: number;
  files_downloaded: number;
  files_deleted_locally: number;
  files_deleted_remotely: number;
  conflicts_resolved: number;
  conflicts_skipped: number;
}

interface SyncError {
  label?: string;
  error: string;
}

/** Build a human-readable description from aggregated sync counts. */
export function buildSyncDescription(counts: {
  uploaded: number;
  downloaded: number;
  deletedLocally: number;
  deletedRemotely: number;
}): string {
  const parts: string[] = [];
  if (counts.uploaded > 0)
    parts.push(`${counts.uploaded} file${counts.uploaded !== 1 ? "s" : ""} uploaded`);
  if (counts.downloaded > 0)
    parts.push(`${counts.downloaded} file${counts.downloaded !== 1 ? "s" : ""} downloaded`);
  if (counts.deletedLocally > 0)
    parts.push(`${counts.deletedLocally} file${counts.deletedLocally !== 1 ? "s" : ""} deleted locally`);
  if (counts.deletedRemotely > 0)
    parts.push(`${counts.deletedRemotely} file${counts.deletedRemotely !== 1 ? "s" : ""} deleted remotely`);
  return parts.join(", ") + ".";
}

export function useFilesNotification() {
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const { polkadotAddress, oauthSession } = useWalletAuth();

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Accumulate counts and file details across multiple drives before creating one notification.
  const pendingCountsRef = useRef({
    uploaded: 0,
    downloaded: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
  });
  const pendingFilesRef = useRef<SyncedFileDetail[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!areFilesNotificationsEnabled || !polkadotAddress) return;

    let cancelled = false;
    const unsubs: (() => void)[] = [];

    const userAddress = oauthSession?.substrateAddress || polkadotAddress;

    const flushNotification = async () => {
      if (cancelled || !userAddress) return;
      const counts = { ...pendingCountsRef.current };
      const capturedFiles = [...pendingFilesRef.current];
      // Reset accumulators
      pendingCountsRef.current = {
        uploaded: 0,
        downloaded: 0,
        deletedLocally: 0,
        deletedRemotely: 0,
      };
      pendingFilesRef.current = [];

      const totalFiles =
        counts.uploaded + counts.downloaded + counts.deletedLocally + counts.deletedRemotely;
      if (totalFiles === 0) return;

      const fileDetailsJson = capturedFiles.length > 0
        ? JSON.stringify(capturedFiles)
        : "";

      const timestamp = new Date().toISOString();
      await addNotification({
        userAddress,
        notificationType: "Files",
        notificationSubtype: `FileSyncComplete-${timestamp}`,
        notificationTitleText: "Sync Complete",
        notificationDescription: buildSyncDescription(counts),
        notificationLinkText: "View Files",
        notificationLink: "/files",
        notificationReleaseNotes: fileDetailsJson,
      });
      await refreshUnread();
    };

    /** Capture completed file details from the snapshot immediately (before the session resets). */
    const captureFileDetails = async () => {
      try {
        const snapshot = await invoke<SyncSnapshot>("sp_get_snapshot");
        const completedFiles: SyncedFileDetail[] = snapshot.files
          .filter((f) => f.status === "completed")
          .map((f) => ({
            fileName: f.fileName,
            totalBytes: f.totalBytes,
            action: f.action,
          }));
        if (completedFiles.length > 0) {
          pendingFilesRef.current.push(...completedFiles);
        }
      } catch (err) {
        console.warn("[FilesNotification] Failed to get file details from snapshot:", err);
      }
    };

    (async () => {
      try {
        const results = await Promise.all([
          listen<SyncOutcome>("hcfs_sync_completed", (e) => {
            const o = e.payload;
            const totalCompleted =
              o.files_uploaded + o.files_downloaded + o.files_deleted_locally + o.files_deleted_remotely;
            if (totalCompleted === 0) return;

            // Accumulate counts (multi-drive may fire several events in quick succession)
            pendingCountsRef.current.uploaded += o.files_uploaded;
            pendingCountsRef.current.downloaded += o.files_downloaded;
            pendingCountsRef.current.deletedLocally += o.files_deleted_locally;
            pendingCountsRef.current.deletedRemotely += o.files_deleted_remotely;

            // Capture file details NOW, before the session resets
            captureFileDetails();

            // Debounce: wait 2s after last completion event to aggregate across drives
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
            }
            debounceTimerRef.current = setTimeout(() => {
              debounceTimerRef.current = null;
              flushNotification();
            }, 2000);
          }),
          listen<SyncError>("hcfs_sync_error", async (e) => {
            if (cancelled || !userAddress) return;
            const label = e.payload.label || "default";
            const timestamp = new Date().toISOString();
            await addNotification({
              userAddress,
              notificationType: "Files",
              notificationSubtype: `FileSyncError-${timestamp}`,
              notificationTitleText: "Sync Failed",
              notificationDescription: `Sync failed for folder "${label}": ${e.payload.error}`,
              notificationLinkText: "View Files",
              notificationLink: "/files",
            });
            await refreshUnread();
          }),
        ]);
        if (cancelled) {
          results.forEach((u) => u());
        } else {
          unsubs.push(...results);
        }
      } catch (err) {
        console.warn("[FilesNotification] Failed to register event listeners:", err);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [areFilesNotificationsEnabled, polkadotAddress, oauthSession, refreshUnread]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);
}
