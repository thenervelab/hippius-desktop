"use client";

import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { removeSyncPath } from "@/lib/utils/syncPathUtils";
import { initializeSync } from "@/lib/utils/hcfsConfigUtils";
import {
  RemoteFolderRemovedDialog,
  type RemoteFolderRemovedInfo,
} from "@/components/page-sections/settings/multi-folder-sync/RemoteFolderRemovedDialog";
import {
  syncEngineStatusAtom,
  isSyncConfiguredAtom,
  triggerSyncPathRefreshAtom,
} from "@/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { getAllSyncPaths } from "@/lib/utils/syncPathUtils";

/**
 * Payload emitted by the backend when it detects that a previously-synced
 * folder has been removed from the server by another device.
 *
 * Event name: `hcfs_remote_folder_removed`
 */
interface RemoteFolderRemovedEvent {
  label: string;
  local_path: string;
}

/**
 * Invisible component that listens for the `hcfs_remote_folder_removed`
 * Tauri event and shows a dialog asking the user what to do.
 *
 * Mounted once in the pages layout alongside other event listeners.
 */
export default function RemoteFolderRemovalListener() {
  const { polkadotAddress, getMnemonic } = useWalletAuth();

  // Queue of removal notifications (handles multiple folders removed at once)
  const [queue, setQueue] = useState<RemoteFolderRemovedInfo[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const currentFolder = queue.length > 0 ? queue[0] : null;

  // ── Event listener ──────────────────────────────────────────────────

  useEffect(() => {
    const unlisten = listen<RemoteFolderRemovedEvent>(
      "hcfs_remote_folder_removed",
      (event) => {
        const { label, local_path } = event.payload;
        // Derive a human-friendly name from the path
        const folderName =
          local_path.split(/[\\/]/).filter(Boolean).pop() || label;

        setQueue((prev) => {
          // Avoid duplicates
          if (prev.some((f) => f.label === label)) return prev;
          return [...prev, { label, folderName, localPath: local_path }];
        });
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── Advance queue helper ────────────────────────────────────────────

  const advanceQueue = useCallback(() => {
    setQueue((prev) => prev.slice(1));
    setIsProcessing(false);
  }, []);

  /** Check remaining sync folders; if none left, reset onboarding state. */
  const checkAndResetIfNoFolders = useCallback(async () => {
    if (!polkadotAddress) return;
    const remainingPaths = await getAllSyncPaths(polkadotAddress).catch(() => []);
    if (remainingPaths.length === 0) {
      appStore.set(isSyncConfiguredAtom, false);
    }
    appStore.set(triggerSyncPathRefreshAtom, (prev) => prev + 1);
  }, [polkadotAddress]);

  // ── Actions ─────────────────────────────────────────────────────────

  const handleRemoveLocal = useCallback(async () => {
    if (!currentFolder || !polkadotAddress) return;
    setIsProcessing(true);
    try {
      await removeSyncPath(polkadotAddress, currentFolder.label);
      toast.success(`"${currentFolder.folderName}" removed from sync`);
      await checkAndResetIfNoFolders();
    } catch (error) {
      console.error("Failed to remove local sync path:", error);
      toast.error("Failed to remove folder from sync");
    } finally {
      advanceQueue();
    }
  }, [currentFolder, polkadotAddress, checkAndResetIfNoFolders, advanceQueue]);

  const handleResync = useCallback(async () => {
    if (!currentFolder || !polkadotAddress) return;
    setIsProcessing(true);
    try {
      const mnemonic = (await getMnemonic()) ?? undefined;
      await initializeSync(polkadotAddress, currentFolder.label, mnemonic);

      appStore.set(syncEngineStatusAtom, "active");
      appStore.set(isSyncConfiguredAtom, true);
      appStore.set(triggerSyncPathRefreshAtom, (prev) => prev + 1);

      toast.success(`Re-syncing "${currentFolder.folderName}" with server`);
    } catch (error) {
      console.error("Failed to re-sync folder:", error);
      toast.error("Failed to re-sync folder with server");
    } finally {
      advanceQueue();
    }
  }, [currentFolder, polkadotAddress, getMnemonic, advanceQueue]);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <RemoteFolderRemovedDialog
      open={currentFolder !== null}
      folder={currentFolder}
      isProcessing={isProcessing}
      onRemoveLocal={handleRemoveLocal}
      onResync={handleResync}
    />
  );
}
