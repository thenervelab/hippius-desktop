/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
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
import { SyncActivityItem } from "./useSyncActivity";

interface SyncStatusResponse {
  synced_files: number;
  total_files: number;
  in_progress: boolean;
  percent: number;
}

export function useFilesNotification() {
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const { polkadotAddress, oauthSession } = useWalletAuth();

  const setSyncPercent = useSetAtom(syncPercentAtom);
  const [syncStatus, setSyncStatus] = useAtom(syncStatusAtom);

  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const areFilesNotificationsEnabled = enabledTypes.includes("Files");

  // Refs to track sync state changes
  const wasInProgress = useRef(false);
  const notificationSent = useRef(false);
  const lastUpdateTime = useRef(Date.now());
  const lastSyncCompleteTime = useRef<number | null>(null);

  useEffect(() => {
    const getSyncStatus = async () => {
      try {
        if (!polkadotAddress) {
          return;
        }

        // Get sync activity data (new shape: SyncActivityItem[])
        const items = await invoke<SyncActivityItem[]>(
          "get_sync_activity",
          { limit: 50 }
        );

        // Derive sync metrics from activity items
        const totalFiles = items.length;
        const isInProgress = totalFiles > 0;
        const syncPercent = isInProgress ? 100 : 0;

        const status: SyncStatusResponse = {
          synced_files: totalFiles,
          total_files: totalFiles,
          in_progress: false,
          percent: syncPercent,
        };

        // Use a timestamp to track freshness of updates
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime.current;

        if (
          timeSinceLastUpdate > 3000 ||
          !syncStatus ||
          status.in_progress !== syncStatus.in_progress ||
          status.percent !== syncStatus.percent
        ) {
          lastUpdateTime.current = now;
        }

        setSyncStatus(status);

        if (status.in_progress) {
          setSyncPercent(status.percent);
        } else if (status.percent === 100) {
          setSyncPercent(100);
        } else {
          setSyncPercent(null);
        }

        // Track when sync starts
        if (status.in_progress && !wasInProgress.current) {
          wasInProgress.current = true;
          notificationSent.current = false;
        }

        // Check if sync has completed
        const syncCompleted =
          wasInProgress.current &&
          !status.in_progress &&
          status.percent === 100;

        if (syncCompleted && !notificationSent.current) {
          const now = Date.now();
          const shouldSendNotification =
            lastSyncCompleteTime.current === null ||
            now - lastSyncCompleteTime.current > 5000;

          if (shouldSendNotification) {
            const timestamp = new Date().toISOString();
            const notificationSubtype = `FileSyncComplete-${timestamp}`;
            const userAddress = oauthSession?.substrateAddress || polkadotAddress;
            if (!userAddress) return;

            await addNotification({
              userAddress: userAddress,
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

        if (!status.in_progress) {
          wasInProgress.current = false;
        }
      } catch (error) {
        console.error("Failed to get sync status:", error);
      }
    };

    if (!areFilesNotificationsEnabled || !polkadotAddress) return;

    const intervalId = setInterval(getSyncStatus, 1000);

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

  return { syncStatus };
}
