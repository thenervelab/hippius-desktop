"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Icons, CardButton } from "@/components/ui";
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
        localFolders.map((f) => f.id.toLowerCase()),
      );

      const remoteFoldersData: RemoteFolder[] = remoteList
        .filter((r) => !localLabelSet.has(r.label.toLowerCase()))
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

  const handleRemoveFolder = async (folderId: string) => {
    if (!polkadotAddress) return;

    try {
      await removeSyncPath(polkadotAddress, folderId);
      toast.success("Folder removed from sync");
      loadFolders();
    } catch (error) {
      console.error("Failed to remove folder:", error);
      toast.error("Failed to remove folder");
    }
  };

  const handlePauseFolder = async (folderId: string) => {
    if (!polkadotAddress) return;

    try {
      // TODO: Uncomment when backend is ready
      // await invoke("pause_sync_folder", {
      //   accountId: polkadotAddress,
      //   folderId
      // });
      toast.success("Folder sync paused");
      loadFolders();
    } catch (error) {
      console.error("Failed to pause folder:", error);
      toast.error("Failed to pause folder sync");
    }
  };

  const handleResumeFolder = async (folderId: string) => {
    if (!polkadotAddress) return;

    try {
      // TODO: Uncomment when backend is ready
      // await invoke("resume_sync_folder", {
      //   accountId: polkadotAddress,
      //   folderId
      // });
      toast.success("Folder sync resumed");
      loadFolders();
    } catch (error) {
      console.error("Failed to resume folder:", error);
      toast.error("Failed to resume folder sync");
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
        {({ inView, ref }) => (
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
              <CardButton
                className="flex-1"
                variant="primary"
                icon={<Plus className="size-4" />}
                appendToStart
                onClick={() => setShowAddDialog(true)}
              >
                Add Local Folder
              </CardButton>
              <CardButton
                className="flex-1"
                variant="secondary"
                icon={<CloudDownload className="size-4" />}
                appendToStart
                onClick={() => setShowRemoteDialog(true)}
              >
                Sync Remote Folder
                {remoteFolders.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-primary-90 text-primary-50 text-xs rounded-full flex-shrink-0">
                    {remoteFolders.length}
                  </span>
                )}
              </CardButton>
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
                                  onSelect={() => handlePauseFolder(folder.id)}
                                >
                                  <PauseCircle className="size-4" />
                                  Pause Sync
                                </DropdownMenu.Item>
                              ) : (
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                  onSelect={() => handleResumeFolder(folder.id)}
                                >
                                  <PlayCircle className="size-4" />
                                  Resume Sync
                                </DropdownMenu.Item>
                              )}
                              <DropdownMenu.Separator className="h-px bg-grey-80 my-1" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-error-50 hover:bg-error-95 rounded cursor-pointer outline-none"
                                onSelect={() => handleRemoveFolder(folder.id)}
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
              <div className="p-4 border border-dashed border-primary-80 bg-primary-98 rounded-lg">
                {remoteFolders.length > 0 ? (
                  <>
                    <p className="text-sm text-primary-40 mb-2">
                      You have {remoteFolders.length} folder
                      {remoteFolders.length !== 1 ? "s" : ""} synced on other
                      devices that you can download to this machine.
                    </p>
                    <CardButton
                      variant="ghost"
                      className="text-primary-50 hover:bg-primary-95"
                      onClick={() => setShowRemoteDialog(true)}
                    >
                      View Available Folders
                    </CardButton>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-primary-40">
                      No remote folders found yet. We check your on-chain synced folders.
                    </p>
                    <CardButton
                      variant="ghost"
                      className="text-primary-50 hover:bg-primary-95 whitespace-nowrap"
                      onClick={loadFolders}
                      icon={<Icons.Refresh className="size-4" />}
                      appendToStart
                    >
                      Refresh
                    </CardButton>
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
    </>
  );
}
