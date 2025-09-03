import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { syncPercentAtom, syncStatusAtom } from "@/app/lib/store/syncAtoms";

// Define interface for sync status response
interface SyncStatusResponse {
  synced_files: number;
  total_files: number;
  in_progress: boolean;
  percent: number;
}

export function useFilesNotification() {
  const [invokeCount, setInvokeCount] = useState<number>(0);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);

  // Use both atoms
  const setSyncPercent = useSetAtom(syncPercentAtom);
  const [syncStatus, setSyncStatus] = useAtom(syncStatusAtom);

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);
  const lastUpdateTime = useRef(Date.now());

  useEffect(() => {
    // Function to get sync status with additional logging
    const getSyncStatus = async () => {
      try {
        // Increment the invoke counter
        setInvokeCount((prevCount) => prevCount + 1);

        // Get current status
        const status = await invoke<SyncStatusResponse>("get_sync_status");
        // const syncActivity = await invoke<SyncStatusResponse>("get_sync_activity", {
        //   accountId: "5CRyFwmSHJC7EeGLGbU1G8ycuoxu8sQxExhfBhkwNPtQU5n2"
        // });

        // console.log("Sync Activity:", syncActivity);


        // Use a timestamp to track freshness of updates
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime.current;

        // Log every 5 seconds or when status changes
        if (timeSinceLastUpdate > 5000 ||
          !syncStatus ||
          status.in_progress !== syncStatus.in_progress ||
          status.percent !== syncStatus.percent) {
          // console.log("[Sync Status]", status, "Time since last log:", timeSinceLastUpdate);
          lastUpdateTime.current = now;
        }

        // Update both atoms atomically to keep them in sync
        setSyncStatus(status);

        // Update sync percentage atom - this triggers the tray update
        if (status.in_progress) {
          setSyncPercent(status.percent); // 0–100
        } else if (status.percent === 100) {
          setSyncPercent(100);
        } else {
          // If not in progress and not 100%, don't show any sync status
          setSyncPercent(null);
        }

        // Check if sync was previously in progress
        if (status.in_progress) {
          wasInProgress.current = true;
        }

        // Check if sync has completed
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
            notificationTitleText: "Files Sync Complete!",
            notificationDescription: `All your files have been successfully synchronized. Your files are now up to date.`,
            notificationLinkText: "View Files",
            notificationLink: "/files",
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

    // Skip if notifications are disabled
    if (!areFilesNotificationsEnabled) return;

    // Get status immediately
    getSyncStatus();

    // Set up interval to periodically refresh the status
    const intervalId = setInterval(getSyncStatus, 1000);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, [
    areFilesNotificationsEnabled,
    refreshUnread,
    setSyncPercent,
    syncStatus,
    setSyncStatus,
  ]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  return { syncStatus, invokeCount };
}
