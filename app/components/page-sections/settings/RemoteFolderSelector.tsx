"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CardButton, Icons } from "@/components/ui";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, CloudDownload, Folder, Monitor, Clock } from "lucide-react";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import { restoreRemoteFolders } from "@/app/lib/utils/restoreUtils";
import { getHcfsConfig, saveHcfsConfig } from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";

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
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Local Destination for Synced Files",
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
        }).catch(() => {});
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
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto z-50">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-95 rounded-lg">
                <CloudDownload className="size-5 text-primary-50" />
              </div>
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
                <div className="space-y-2 max-h-64 overflow-y-auto">
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
                            : "border-grey-80 bg-white hover:bg-grey-98"
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
                                {folder.fileCount} files
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
                    <div className="flex items-center gap-2 mb-2">
                      <Folder className="size-4 text-grey-40 flex-shrink-0" />
                      <span className="font-medium text-sm text-grey-10">
                        Files will be synced to:
                      </span>
                    </div>
                    <p className="text-xs text-grey-60 break-all">{localPath}/{selectedFolder?.folderName}</p>
                    <CardButton
                      variant="ghost"
                      className="mt-2 text-sm"
                      onClick={handleSelectLocalPath}
                      disabled={isSyncing}
                    >
                      Change Destination
                    </CardButton>
                  </div>
                ) : (
                  <CardButton
                    variant="secondary"
                    className="w-full justify-center"
                    icon={<Folder className="size-4" />}
                    appendToStart
                    onClick={handleSelectLocalPath}
                    disabled={isSyncing}
                  >
                    Choose Destination Folder
                  </CardButton>
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
              <CardButton
                variant="secondary"
                className="flex-1"
                onClick={handleClose}
                disabled={isSyncing}
              >
                Cancel
              </CardButton>
              <CardButton
                variant="primary"
                className="flex-1"
                onClick={handleSyncFolder}
                disabled={!selectedFolder || !localPath || isSyncing}
              >
                {isSyncing ? (
                  <>
                    <Icons.Loader className="size-4 mr-2 animate-spin" />
                    Starting Sync...
                  </>
                ) : (
                  "Start Syncing"
                )}
              </CardButton>
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
