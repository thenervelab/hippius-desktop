import { useEffect, useRef, useState } from "react";
import { addNotification } from "@/app/lib/helpers/notificationsDb";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { syncPercentAtom, syncStatusAtom } from "@/app/lib/store/syncAtoms";
import useSyncActivity from "./useSyncActivity";
// import { toast } from "sonner";

export function useFilesNotification() {
  const [invokeCount, setInvokeCount] = useState<number>(0);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);

  // Use both atoms
  const setSyncPercent = useSetAtom(syncPercentAtom);
  const [syncStatus, setSyncStatus] = useAtom(syncStatusAtom);

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Use the same sync activity hook as other components
  const { data: syncFiles, isLoading } = useSyncActivity();

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);
  const lastUpdateTime = useRef(Date.now());
  // Ref to track the last sync complete timestamp to prevent duplicate notifications
  const lastSyncCompleteTime = useRef<number | null>(null);

  // Calculate sync metrics using the same logic as SyncStatusHandler
  const calculateSyncMetrics = () => {
    if (!syncFiles || syncFiles.length === 0) {
      return {
        syncPercent: null,
        totalFiles: 0,
        syncedFiles: 0,
        uploadingFiles: 0,
        isInProgress: false,
        isCompleted: false,
      };
    }

    const totalFiles = syncFiles.length;
    const uploadingFiles = syncFiles.filter(
      (file) => file.status === "uploading"
    ).length;
    const syncedFiles = syncFiles.filter(
      (file) => file.status === "uploaded"
    ).length;
    const isInProgress = uploadingFiles > 0;

    let syncPercent: number | null = null;
    if (totalFiles > 0) {
      if (uploadingFiles === 0) {
        // No uploading files means sync is complete
        syncPercent = 100;
      } else {
        // Calculate percentage based on uploaded files
        syncPercent = Math.round((syncedFiles / totalFiles) * 100);
      }
    }

    const isCompleted = syncPercent === 100;

    return {
      syncPercent,
      totalFiles,
      syncedFiles,
      uploadingFiles,
      isInProgress,
      isCompleted,
    };
  };

  const syncMetrics = calculateSyncMetrics();

  useEffect(() => {
    // Skip if loading, notifications are disabled, or no sync files
    if (isLoading || !areFilesNotificationsEnabled || !syncFiles) return;

    // Increment the invoke counter for debugging
    setInvokeCount((prevCount) => prevCount + 1);

    const { isInProgress, isCompleted, syncPercent } = syncMetrics;

    // Use a timestamp to track freshness of updates
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime.current;

    // Log every 3 seconds or when status changes
    if (
      timeSinceLastUpdate > 3000 ||
      !syncStatus ||
      isInProgress !== syncStatus.in_progress ||
      syncPercent !== syncStatus.percent
    ) {
      // console.log("[Sync Status]", syncMetrics, "Time since last log:", timeSinceLastUpdate);
      lastUpdateTime.current = now;
    }

    // Update sync status atom with calculated metrics
    const statusUpdate = {
      synced_files: syncMetrics.syncedFiles,
      total_files: syncMetrics.totalFiles,
      in_progress: isInProgress,
      percent: syncPercent || 0,
    };
    setSyncStatus(statusUpdate);

    // Update sync percentage atom - this triggers the tray update
    if (isInProgress) {
      setSyncPercent(syncPercent); // 0–100
    } else if (syncPercent === 100) {
      setSyncPercent(100);
    } else {
      // If not in progress and not 100%, don't show any sync status
      setSyncPercent(null);
    }

    // Track when sync starts
    if (isInProgress && !wasInProgress.current) {
      wasInProgress.current = true;
      notificationSent.current = false;
    }

    // Check if sync has completed - with additional time-based check
    const syncCompleted =
      wasInProgress.current && !isInProgress && syncPercent === 100;

    if (syncCompleted && !notificationSent.current) {
      const now = Date.now();
      // Only send notification if we haven't sent one in the last 5 seconds
      const shouldSendNotification =
        lastSyncCompleteTime.current === null ||
        now - lastSyncCompleteTime.current > 5000;

      if (shouldSendNotification) {
        // Add notification for completed sync
        const timestamp = new Date().toISOString();
        const notificationSubtype = `FileSyncComplete-${timestamp}`;

        addNotification({
          notificationType: "Files",
          notificationSubtype: notificationSubtype,
          notificationTitleText: "Files Sync Complete!",
          notificationDescription: `All your files have been successfully synchronized. Your files are now up to date.`,
          notificationLinkText: "View Files",
          notificationLink: "/files",
        }).then(() => {
          refreshUnread();
        });

        notificationSent.current = true;
        lastSyncCompleteTime.current = now;
      }
    }

    // Reset wasInProgress when sync is no longer in progress
    if (!isInProgress) {
      wasInProgress.current = false;
    }
  }, [
    syncFiles,
    isLoading,
    areFilesNotificationsEnabled,
    syncMetrics.isInProgress,
    syncMetrics.isCompleted,
    syncMetrics.syncPercent,
    syncMetrics.syncedFiles,
    syncMetrics.totalFiles,
    refreshUnread,
    setSyncPercent,
    syncStatus,
    setSyncStatus,
  ]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  return { syncStatus: syncMetrics, invokeCount };
}
