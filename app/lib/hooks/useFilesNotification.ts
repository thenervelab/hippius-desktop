import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";

// Define interface for sync status response
interface SyncStatusResponse {
  synced_files: number;
  total_files: number;
  in_progress: boolean;
  percent: number;
}

export function useFilesNotification() {
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);

  useEffect(() => {
    // if (!areFilesNotificationsEnabled) return;

    // Function to get sync status
    const getSyncStatus = async () => {
      try {
        const status = await invoke<SyncStatusResponse>("get_sync_status");
        setSyncStatus(status);

        // Check if sync was previously in progress
        if (status.in_progress) {
          wasInProgress.current = true;
        }

        // Check if sync has completed (was in progress, now complete with 100%)
        if (
          wasInProgress.current &&
          !status.in_progress &&
          status.percent === 100 &&
          !notificationSent.current
        ) {
          // Add notification for completed sync
          const timestamp = new Date().toISOString();
          const notificationSubtype = `FileSyncComplete-${timestamp}`;

          await addNotification({
            notificationType: "Files",
            notificationSubtype: notificationSubtype,
            notificationTitleText: "File Sync Complete!",
            notificationDescription: `All your files have been successfully synchronized. Your files are now up to date.`,
            notificationLinkText: "View Files",
            notificationLink: "/",
          });

          notificationSent.current = true;
          await refreshUnread();
        }

        // If sync is starting again, reset notification sent flag
        if (status.in_progress && status.percent < 100) {
          notificationSent.current = false;
        }
      } catch (error) {
        console.error("Failed to get sync status:", error);
      }
    };

    // Get status immediately
    getSyncStatus();

    // Set up interval to periodically refresh the status
    const intervalId = setInterval(getSyncStatus, 500);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, [areFilesNotificationsEnabled, refreshUnread]);

  return syncStatus;
}
