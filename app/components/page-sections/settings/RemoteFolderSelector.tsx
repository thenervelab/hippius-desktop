"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons, AbstractIconWrapper } from "@/components/ui";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, CloudDownload, Folder, Monitor, Clock, HardDrive } from "lucide-react";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import { restoreRemoteFolders } from "@/app/lib/utils/restoreUtils";
import { getHcfsConfig, saveHcfsConfig } from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import { syncEngineStatusAtom, isSyncConfiguredAtom, SYNC_STOPPED_STORAGE_KEY } from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";

interface RemoteFolderSelectorProps {
  open: boolean;
  onClose: () => void;
  remoteFolders: RemoteFolder[];
  onSuccess: () => void;
}

export const RemoteFolderSelector: React.FC<RemoteFolderSelectorProps> = ({
  open,
  onClose,
  remoteFolders,
  onSuccess,
}) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const [selectedFolder, setSelectedFolder] = useState<RemoteFolder | null>(null);
  const [localPath, setLocalPath] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  const handleSelectFolder = (folder: RemoteFolder) => {
    if (selectedFolder?.folderName === folder.folderName) {
      setSelectedFolder(null);
      setLocalPath("");
    } else {
      setSelectedFolder(folder);
      setLocalPath("");
    }
  };

  const handleSelectLocalPath = async () => {
    try {
      const { getSyncFolderDefaultPath } = await import("@/lib/utils/syncPathUtils");
      const defaultPath = await getSyncFolderDefaultPath();
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Local Destination for Synced Files",
        defaultPath,
      });

      if (typeof path === "string") {
        setLocalPath(path);
      }
    } catch (error) {
      console.error("Failed to select path:", error);
      toast.error("Failed to select destination folder");
    }
  };

  const doRestore = async () => {
    if (!polkadotAddress || !selectedFolder || !localPath) return;

    setIsSyncing(true);
    try {
      // Always try to get the mnemonic — it's required for cross-device
      // decryption. getMnemonic() falls back to in-memory login mnemonic
      // when the Drive isn't initialized yet (new device scenario).
      const mnemonic = await getMnemonic();

      const results = await restoreRemoteFolders(
        polkadotAddress,
        [selectedFolder.folderName],
        localPath,
        mnemonic ?? undefined,
      );

      const result = results[0];
      if (result && !result.success) {
        throw new Error(result.error ?? "Unknown error");
      }

      // Clear "sync stopped" state — syncing a remote folder means the user wants sync running
      localStorage.removeItem(SYNC_STOPPED_STORAGE_KEY);
      appStore.set(syncEngineStatusAtom, "active");
      appStore.set(isSyncConfiguredAtom, true);

      toast.success(`Started syncing ${selectedFolder.folderName}`);
      setSelectedFolder(null);
      setLocalPath("");
      onSuccess();
      onClose();
    } catch (error) {
      console.error("Failed to sync remote folder:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to start syncing remote folder"
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncFolder = async () => {
    if (!polkadotAddress) {
      toast.error("Wallet authentication is required");
      return;
    }

    if (!selectedFolder) {
      toast.error("Please select a folder to sync");
      return;
    }

    if (!localPath) {
      toast.error("Please select a local destination");
      return;
    }

    // Check if HCFS config (encryption password) exists
    try {
      const config = await getHcfsConfig(polkadotAddress);
      if (!config.has_password) {
        setShowHcfsSetup(true);
        return;
      }
    } catch {
      setShowHcfsSetup(true);
      return;
    }

    await doRestore();
  };

  const handleHcfsSetupComplete = async (result: {
    serverUrl: string;
    password: string;
  }) => {
    if (!polkadotAddress) return;

    try {
      await saveHcfsConfig(polkadotAddress, result.serverUrl, result.password);
      const mnemonic = await getMnemonic();
      if (mnemonic) {
        await invoke("persist_master_mnemonic", {
          accountId: polkadotAddress,
          mnemonic,
        }).catch((err: unknown) => console.warn("[RemoteFolderSelector] persist_master_mnemonic failed:", err));
      }
      setShowHcfsSetup(false);
      await doRestore();
    } catch (err) {
      console.error("Failed to save HCFS config:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  const handleClose = () => {
    if (!isSyncing) {
      setSelectedFolder(null);
      setLocalPath("");
      onClose();
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <>
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-grey-100 rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto z-50">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <AbstractIconWrapper className="size-10 relative">
                <CloudDownload className="absolute size-5 text-primary-50" />
              </AbstractIconWrapper>
              <div>
                <Dialog.Title className="text-lg font-semibold text-grey-10">
                  Sync Remote Folder
                </Dialog.Title>
                <Dialog.Description className="text-sm text-grey-60">
                  Choose a folder from your other devices to sync to this machine
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                className="p-1 hover:bg-grey-95 rounded transition-colors"
                disabled={isSyncing}
              >
                <X className="size-5 text-grey-50" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            {/* Remote Folders List */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-grey-30">
                Available Folders ({remoteFolders.length})
              </label>
              {remoteFolders.length === 0 ? (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center">
                  <CloudDownload className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50">
                    No remote folders available
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-2 custom-scrollbar">
                  <style jsx>{`
                    .custom-scrollbar::-webkit-scrollbar {
                      width: 6px;
                    }
                    .custom-scrollbar::-webkit-scrollbar-track {
                      background: #f5f5f5;
                      border-radius: 4px;
                    }
                    .custom-scrollbar::-webkit-scrollbar-thumb {
                      background: #999;
                      border-radius: 4px;
                    }
                    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                      background: #888;
                    }
                  `}</style>
                  {remoteFolders.map((folder) => {
                    const isSelected =
                      selectedFolder?.folderName === folder.folderName;
                    return (
                      <button
                        key={`${folder.deviceName}-${folder.folderName}`}
                        onClick={() => handleSelectFolder(folder)}
                        className={cn(
                          "w-full p-4 border rounded-lg text-left transition-all",
                          isSelected
                            ? "border-primary-50 bg-primary-98"
                            : "border-grey-80 bg-grey-100 hover:bg-grey-98"
                        )}
                        disabled={isSyncing}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Folder className="size-4 text-grey-40 flex-shrink-0" />
                              <span className="font-medium text-base text-grey-10 truncate">
                                {folder.folderName}
                              </span>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-grey-60">
                              <span className="flex items-center gap-1">
                                <Monitor className="size-3" />
                                {folder.deviceName}
                              </span>
                              <span className="flex items-center gap-1">
                                <Icons.File2 className="size-3" />
                                {folder.fileCount} {folder.fileCount === 1 ? 'file' : 'files'}
                              </span>
                              <span className="flex items-center gap-1">
                                <HardDrive className="size-3" />
                                {formatBytes(folder.totalBytes)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="size-3" />
                                {formatDate(folder.lastModified)}
                              </span>
                            </div>
                          </div>
                          {isSelected && (
                            <div className="ml-2">
                              <div className="p-1 bg-primary-50 rounded-full">
                                <Icons.Check className="size-3 text-white" />
                              </div>
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Local Destination Selection */}
            {selectedFolder && (
              <div className="space-y-2 animate-in fade-in duration-200">
                <label className="text-sm font-medium text-grey-30">
                  Local Destination
                </label>
                {localPath ? (
                  <div className="p-4 border border-grey-80 rounded-lg bg-grey-98">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <Folder className="size-4 text-grey-40 flex-shrink-0" />
                          <span className="font-medium text-sm text-grey-10">
                            Files will be synced to:
                          </span>
                        </div>
                        <p className="text-xs text-grey-60 break-all font-mono bg-grey-100 px-2 py-1.5 rounded border border-grey-90">
                          {localPath}/{selectedFolder?.folderName}
                        </p>
                      </div>
                      <button
                        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-primary-50 bg-grey-100 border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors"
                        onClick={handleSelectLocalPath}
                        disabled={isSyncing}
                      >
                        Change
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-medium text-grey-10 bg-grey-90 hover:bg-grey-80 border border-grey-80 rounded transition-colors disabled:opacity-50"
                    onClick={handleSelectLocalPath}
                    disabled={isSyncing}
                  >
                    <Folder className="size-4" />
                    Choose Destination Folder
                  </button>
                )}
              </div>
            )}

            {/* Info Box */}
            {selectedFolder && localPath && (
              <div className="p-3 bg-primary-98 border border-primary-90 rounded-lg animate-in fade-in duration-200">
                <p className="text-xs text-primary-40">
                  <strong>{selectedFolder.folderName}</strong> will be downloaded to{" "}
                  <span className="font-mono">{localPath}/{selectedFolder.folderName}</span>{" "}
                  and kept in sync with your other devices. Any changes you make
                  locally will sync back to all devices.
                </p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <button
                className="flex-1 py-2.5 px-4 text-sm font-medium rounded border border-grey-80 bg-grey-90 hover:bg-grey-80 text-grey-10 transition-colors disabled:opacity-50"
                onClick={handleClose}
                disabled={isSyncing}
              >
                Cancel
              </button>
              <button
                className="flex-1 py-2.5 px-4 text-sm font-medium rounded border border-primary-40 bg-primary-50 hover:bg-primary-40 text-white transition-colors disabled:opacity-50"
                onClick={handleSyncFolder}
                disabled={!selectedFolder || !localPath || isSyncing}
              >
                {isSyncing ? (
                  <span className="flex items-center justify-center gap-2">
                    <Icons.Loader className="size-4 animate-spin" />
                    Starting Sync...
                  </span>
                ) : (
                  "Start Syncing"
                )}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isSyncing}
      />
    </>
  );
};
