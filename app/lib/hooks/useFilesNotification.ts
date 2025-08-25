import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { setTraySyncPercent } from "./useTraySync";
// import { toast } from "sonner";

// Define interface for sync status response
interface SyncStatusResponse {
  synced_files: number;
  total_files: number;
  in_progress: boolean;
  percent: number;
}

export function useFilesNotification() {
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [invokeCount, setInvokeCount] = useState<number>(0);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);
  useEffect(() => {
    if (!areFilesNotificationsEnabled) return;

    // Function to get sync status
    const getSyncStatus = async () => {
      try {
        // Increment the invoke counter
        setInvokeCount((prevCount) => prevCount + 1);

        const status = await invoke<SyncStatusResponse>("get_sync_status");
        console.log("status", status);
        setSyncStatus(status);
        // toast.success(
        //   `Sync Staus: ${status.percent}% : ${status.in_progress ? "In Progress" : "Completed"}`
        // );
        if (status.in_progress) {
          await setTraySyncPercent(status.percent); // 0–100
        } else if (status.percent === 100) {
          await setTraySyncPercent(100); // Completed
        }
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

    // Get status immediately
    getSyncStatus();

    // Set up interval to periodically refresh the status
    const intervalId = setInterval(getSyncStatus, 100);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, [areFilesNotificationsEnabled, refreshUnread]);
  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  return { syncStatus, invokeCount };
}
