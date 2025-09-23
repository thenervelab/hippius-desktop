/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SyncActivityResponse } from "./useSyncActivity";
// import { toast } from "sonner";
const processSyncActivity = (response: SyncActivityResponse) => {
  const allFiles = [];

  if (response.uploading) {
    for (const file of response.uploading) {
      allFiles.push({ ...file, status: "uploading" });
    }
  }
  if (response.recent) {
    for (const file of response.recent) {
      const isAlreadyProcessed = allFiles.some(
        (existingFile) => existingFile.fileHash === file.fileHash
      );
      if (!isAlreadyProcessed) {
        allFiles.push({ ...file, status: "uploaded" });
      }
    }
  }

  return allFiles;
};

const calculateSyncMetrics = (syncFiles: Array<any>) => {
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
  const { polkadotAddress } = useWalletAuth();

  // Use both atoms
  const setSyncPercent = useSetAtom(syncPercentAtom);
  const [syncStatus, setSyncStatus] = useAtom(syncStatusAtom);

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);
  const lastUpdateTime = useRef(Date.now());
  // Ref to track the last sync complete timestamp to prevent duplicate notifications
  const lastSyncCompleteTime = useRef<number | null>(null);

  useEffect(() => {
    const getSyncStatus = async () => {
      try {
        if (!polkadotAddress) {
          return;
        }

        // Increment the invoke counter
        setInvokeCount((prevCount) => prevCount + 1);

        // Get sync activity data
        const response = await invoke<SyncActivityResponse>(
          "get_sync_activity",
          {
            accountId: polkadotAddress,
          }
        );

        // Process the sync activity data
        const syncFiles = processSyncActivity(response);
        const metrics = calculateSyncMetrics(syncFiles);

        // Convert to the expected status format
        const status: SyncStatusResponse = {
          synced_files: metrics.syncedFiles,
          total_files: metrics.totalFiles,
          in_progress: metrics.isInProgress,
          percent: metrics.syncPercent || 0,
        };

        // Use a timestamp to track freshness of updates
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime.current;

        // Log every 3 seconds or when status changes
        if (
          timeSinceLastUpdate > 3000 ||
          !syncStatus ||
          status.in_progress !== syncStatus.in_progress ||
          status.percent !== syncStatus.percent
        ) {
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

        // Track when sync starts
        if (status.in_progress && !wasInProgress.current) {
          wasInProgress.current = true;
          notificationSent.current = false;
        }

        // Check if sync has completed - with additional time-based check
        const syncCompleted =
          wasInProgress.current &&
          !status.in_progress &&
          status.percent === 100;

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

            await addNotification({
              notificationType: "Files",
              notificationSubtype: notificationSubtype,
              notificationTitleText: "Files Sync Complete!",
              notificationDescription: `All your files have been successfully synchronized. Your files are now up to date.`,
              notificationLinkText: "View Files",
              notificationLink: "/#recent-files",
            });

            notificationSent.current = true;
            lastSyncCompleteTime.current = now;
            await refreshUnread();
          }
        }

        // Reset wasInProgress when sync is no longer in progress
        if (!status.in_progress) {
          wasInProgress.current = false;
        }
      } catch (error) {
        console.error("Failed to get sync status:", error);
      }
    };

    // Skip if notifications are disabled or no wallet address
    if (!areFilesNotificationsEnabled || !polkadotAddress) return;

    // Set up interval to periodically refresh the status - don't call immediately
    const intervalId = setInterval(getSyncStatus, 1000);

    // Clean up interval on component unmount
    return () => clearInterval(intervalId);
  }, [
    areFilesNotificationsEnabled,
    refreshUnread,
    setSyncPercent,
    syncStatus,
    setSyncStatus,
    polkadotAddress,
  ]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  return { syncStatus, invokeCount };
}
