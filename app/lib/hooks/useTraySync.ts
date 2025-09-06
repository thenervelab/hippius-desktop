"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { syncPercentAtom, lastUpdatedPercentAtom } from "@/app/lib/store/syncAtoms";
import { useAtomValue, useAtom } from 'jotai';
import { RecentFilesResponse } from "./use-recent-files";

// Export for backward compatibility
export function setTraySyncPercent(percent: number | null) {
  const effectivePercent = percent === null ? null : Math.min(100, Math.max(0, Math.round(percent)));

  // Convert to Option<u8> format expected by Rust
  const rustPercent = effectivePercent === null ? null : effectivePercent as number;

  console.log(`[Tray] Setting tray sync percent: ${rustPercent}`);
  invoke("update_tray_sync_status", { percent: rustPercent }).catch(err => {
    console.error("Failed to update tray sync status:", err);
  });
}

export function useTrayInit(polkadotAddress: string) {
  // Use atom to watch for sync percentage changes
  const currentPercent = useAtomValue(syncPercentAtom);
  const [lastUpdatedPercent, setLastUpdatedPercent] = useAtom(lastUpdatedPercentAtom);

  // Effect to update tray when sync percent changes
  useEffect(() => {
    // Only update if the percentage has actually changed
    if (currentPercent !== lastUpdatedPercent) {
      setLastUpdatedPercent(currentPercent);

      // Convert to Option<u8> format expected by Rust
      const rustPercent = currentPercent === null ? null :
        Math.min(100, Math.max(0, Math.round(currentPercent))) as number;

      console.log(`[Tray] Updating status window sync percent: ${rustPercent}`);
      invoke("update_tray_sync_status", { percent: rustPercent })
        .then(() => console.log("[Tray] Successfully updated sync status"))
        .catch(err => {
          console.error("Failed to update sync status:", err);
        });
    }
  }, [currentPercent, lastUpdatedPercent, setLastUpdatedPercent]);

  // Effect to update file activity in tray
  useEffect(() => {
    // Skip if no address is provided
    if (!polkadotAddress) return;

    const updateTrayFiles = async () => {
      try {
        // Get sync activity
        const resp = await invoke<RecentFilesResponse>("get_sync_activity", {
          accountId: polkadotAddress
        });

        // Process uploading files
        const fileItems: [string, string][] = [];

        if (resp?.uploading?.length) {
          for (const file of resp.uploading.slice(0, 3)) {
            fileItems.push([
              shortenName(file.fileName || "Unknown"),
              "Uploading"
            ]);
          }
        }

        // Process recent files (if we have space)
        if (resp?.recent?.length && fileItems.length < 5) {
          for (const file of resp.recent.slice(0, 5 - fileItems.length)) {
            fileItems.push([
              shortenName(file.fileName || "Unknown"),
              "Uploaded"
            ]);
          }
        }

        if (fileItems.length > 0) {
          await invoke("update_tray_files", { files: fileItems });
        }
      } catch (error) {
        console.error("Error updating file activity in tray:", error);
      }
    };

    // Call once immediately
    updateTrayFiles();

    // Set up interval to update every few seconds
    const intervalId = setInterval(updateTrayFiles, 3000);

    return () => clearInterval(intervalId);
  }, [polkadotAddress]);
}

// Helper function to shorten long filenames
function shortenName(name: string): string {
  if (!name) return name;
  if (name.length <= 30) return name;
  const head = name.slice(0, 15);
  const tail = name.slice(-12);
  return `${head}…${tail}`;
}