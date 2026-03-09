"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Icons } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import SectionHeader from "./SectionHeader";
import { InView } from "react-intersection-observer";
import {
  Folder,
  Plus,
  CloudDownload,
  MoreVertical,
  Trash2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";
import { AddLocalFolderDialog } from "./AddLocalFolderDialog";
import { RemoteFolderSelector } from "./RemoteFolderSelector";
import { getAllSyncPaths, removeSyncPath } from "@/app/lib/utils/syncPathUtils";
import { listRemoteFolders } from "@/app/lib/utils/restoreUtils";

export default function MultiFolderSyncManager() {
  const { polkadotAddress } = useWalletAuth();
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<RemoteFolder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    type: "pause" | "resume" | "remove" | null;
    folderId: string | null;
    folderName: string | null;
  }>({ open: false, type: null, folderId: null, folderName: null });

  const loadFolders = useCallback(async () => {
    if (!polkadotAddress) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      const [syncPaths, remoteList] = await Promise.all([
        getAllSyncPaths(polkadotAddress).catch(() => []),
        listRemoteFolders(polkadotAddress).catch(() => []),
      ]);

      const localFolders: SyncFolder[] = syncPaths.map(
        (syncPath, index) => {
          const folderName =
            syncPath.path.split(/[\\/]/).filter(Boolean).pop() ||
            syncPath.label;

          return {
            id: syncPath.label || `sync-folder-${index}`,
            folderName,
            localPath: syncPath.path,
            isLocal: true,
            status: "syncing",
          };
        },
      );

      const localLabelSet = new Set(
        localFolders.map((f) => f.id),
      );

      const remoteFoldersData: RemoteFolder[] = remoteList
        .filter((r) => !localLabelSet.has(r.label))
        .map((r) => ({
          folderName: r.label,
          deviceName: "Other Device",
          fileCount: r.file_count,
          lastModified: (r.updated_at || r.created_at) * 1000,
        }))
        .sort((a, b) => b.lastModified - a.lastModified);

      setSyncFolders(localFolders);
      setRemoteFolders(remoteFoldersData);
    } catch (error) {
      console.error("Failed to load folders:", error);
      toast.error("Failed to load sync folders");
    } finally {
      setIsLoading(false);
    }
  }, [polkadotAddress]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const openConfirmDialog = (
    type: "pause" | "resume" | "remove",
    folderId: string,
    folderName: string
  ) => {
    setConfirmDialog({ open: true, type, folderId, folderName });
  };

  const handleConfirmAction = async () => {
    const { type, folderId } = confirmDialog;
    if (!folderId || !polkadotAddress) return;

    try {
      switch (type) {
        case "remove":
          await removeSyncPath(polkadotAddress, folderId);
          toast.success("Folder removed from sync");
          break;
        case "pause":
          // Pause is handled by removing and noting intent;
          // full pause/resume will be added when backend supports it
          toast.info("Pause sync is not yet supported. You can remove the folder instead.");
          break;
        case "resume":
          toast.info("Resume sync is not yet supported.");
          break;
      }
      loadFolders();
    } catch (error) {
      console.error(`Failed to ${type} folder:`, error);
      toast.error(`Failed to ${type} folder`);
    } finally {
      setConfirmDialog({ open: false, type: null, folderId: null, folderName: null });
    }
  };

  const getConfirmDialogProps = () => {
    const { type, folderName } = confirmDialog;
    switch (type) {
      case "remove":
        return {
          title: "Remove Folder from Sync?",
          description: `Are you sure you want to remove "${folderName}" from sync? Local files will remain on your device, but this folder will no longer be synchronized across your devices.`,
          confirmText: "Remove Folder",
          variant: "danger" as const,
        };
      case "pause":
        return {
          title: "Pause Folder Sync?",
          description: `Do you want to pause syncing for "${folderName}"? You can resume syncing at any time.`,
          confirmText: "Pause Sync",
          variant: "warning" as const,
        };
      case "resume":
        return {
          title: "Resume Folder Sync?",
          description: `Do you want to resume syncing for "${folderName}"? Changes will start synchronizing immediately.`,
          confirmText: "Resume Sync",
          variant: "info" as const,
        };
      default:
        return {
          title: "",
          description: "",
          confirmText: "Confirm",
          variant: "info" as const,
        };
    }
  };

  const getStatusColor = (status: SyncFolder["status"]) => {
    switch (status) {
      case "syncing":
        return "bg-success-95 text-success-50 border-success-80";
      case "paused":
        return "bg-grey-95 text-grey-50 border-grey-80";
      case "error":
        return "bg-error-95 text-error-50 border-error-80";
    }
  };

  const getStatusText = (status: SyncFolder["status"]) => {
    switch (status) {
      case "syncing":
        return "Syncing";
      case "paused":
        return "Paused";
      case "error":
        return "Error";
    }
  };

  const formatLastSynced = (timestamp?: number) => {
    if (!timestamp) return null;
    
    const now = Date.now();
    const diff = now - timestamp;
    
    // Less than a minute
    if (diff < 60000) return "Just now";
    
    // Less than an hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    }
    
    // Less than a day
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    }
    
    // More than a day
    return new Date(timestamp).toLocaleString();
  };

  return (
    <>
      <InView triggerOnce>
        {({ ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full"
          >
            <SectionHeader
              Icon={Icons.File2}
              title="Sync Folders"
              subtitle="Manage folders that sync across your devices. Add multiple folders or sync folders from other machines."
              info="Multi-folder sync allows you to keep different directories synchronized independently. Files are encrypted and synced to the Hippius network."
              learnMoreUrl="https://docs.hippius.com/use/desktop/settings#multi-folder-sync"
            />

            {/* Action Buttons */}
            <div className="flex gap-3 mt-6 mb-6">
              <button
                className="flex-1 flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium text-white bg-primary-50 hover:bg-primary-40 border border-primary-40 rounded transition-colors"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="size-4" />
                Add Local Folder
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium text-grey-10 bg-grey-90 hover:bg-grey-80 border border-grey-80 rounded transition-colors"
                onClick={() => setShowRemoteDialog(true)}
              >
                <CloudDownload className="size-4" />
                Sync Remote Folder
                {remoteFolders.length > 0 && (
                  <span className="px-1.5 py-0.5 bg-primary-90 text-primary-50 text-xs rounded-full font-medium">
                    {remoteFolders.length}
                  </span>
                )}
              </button>
            </div>

            {/* Currently Synced Folders */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-grey-30">
                Synced on This Device ({syncFolders.length})
              </h3>

              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Icons.Loader className="size-6 animate-spin text-primary-50" />
                </div>
              ) : syncFolders.length === 0 ? (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center bg-grey-99">
                  <Folder className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50 mb-1">
                    No folders syncing yet
                  </p>
                  <p className="text-xs text-grey-60">
                    Add a local folder or sync one from another device to get started
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {syncFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="p-4 border border-grey-80 rounded-lg bg-white hover:bg-grey-98 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Folder className="size-4 text-grey-40 flex-shrink-0" />
                            <span className="font-medium text-base text-grey-10 truncate">
                              {folder.folderName}
                            </span>
                            <span
                              className={cn(
                                "text-xs font-medium px-2 py-0.5 rounded border",
                                getStatusColor(folder.status)
                              )}
                            >
                              {getStatusText(folder.status)}
                            </span>
                          </div>
                          <p className="text-sm text-grey-60 truncate mb-1">
                            {folder.localPath}
                          </p>
                          {(folder.fileCount !== undefined || folder.lastSynced) && (
                            <div className="flex items-center gap-3 text-xs text-grey-70">
                              {folder.fileCount !== undefined && (
                                <span>{folder.fileCount} files</span>
                              )}
                              {folder.lastSynced && (
                                <span>· Last synced {formatLastSynced(folder.lastSynced)}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Actions Menu */}
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button className="p-2 hover:bg-grey-95 rounded transition-colors">
                              <MoreVertical className="size-4 text-grey-40" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content className="bg-white border border-grey-80 rounded-lg shadow-lg p-1 min-w-[160px] z-50">
                              {folder.status === "syncing" ? (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                  onSelect={() => openConfirmDialog("pause", folder.id, folder.folderName)}
                                >
                                  <PauseCircle className="size-4" />
                                  Pause Sync
                                </DropdownMenu.Item>
                              ) : (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                  onSelect={() => openConfirmDialog("resume", folder.id, folder.folderName)}
                                >
                                  <PlayCircle className="size-4" />
                                  Resume Sync
                                </DropdownMenu.Item>
                              )}
                              <DropdownMenu.Separator className="h-px bg-grey-80 my-1" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-error-50 hover:bg-error-95 rounded cursor-pointer outline-none"
                                onSelect={() => openConfirmDialog("remove", folder.id, folder.folderName)}
                              >
                                <Trash2 className="size-4" />
                                Remove Folder
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Remote Folders Available */}
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-semibold text-grey-30">
                Available from Other Devices ({remoteFolders.length})
              </h3>
              <div className="p-4 border border-primary-80 bg-primary-98 rounded-lg">
                {remoteFolders.length > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-primary-40">
                      You have {remoteFolders.length} folder
                      {remoteFolders.length !== 1 ? "s" : ""} synced on other
                      devices that you can download to this machine.
                    </p>
                    <button
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-50 bg-white border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors whitespace-nowrap flex-shrink-0"
                      onClick={() => setShowRemoteDialog(true)}
                    >
                      <CloudDownload className="size-3.5" />
                      View Available Folders
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-primary-40">
                      No remote folders found yet. We check your on-chain synced folders.
                    </p>
                    <button
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-50 bg-white border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors whitespace-nowrap flex-shrink-0"
                      onClick={loadFolders}
                    >
                      <RefreshCw className="size-3.5" />
                      Refresh
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </InView>

      {/* Dialogs */}
      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSuccess={loadFolders}
      />
      <RemoteFolderSelector
        open={showRemoteDialog}
        onClose={() => setShowRemoteDialog(false)}
        remoteFolders={remoteFolders}
        onSuccess={loadFolders}
      />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) =>
          setConfirmDialog({ open, type: null, folderId: null, folderName: null })
        }
        onConfirm={handleConfirmAction}
        {...getConfirmDialogProps()}
      />
    </>
  );
}
