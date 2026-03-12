"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Icons, IconButton, CardButton } from "@/components/ui";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import SectionHeader from "@/components/page-sections/settings/SectionHeader";
import {
  Folder,
  Plus,
  CloudDownload,
  MoreVertical,
  Clock,
  HardDrive,
  ServerCrash,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";
import { AddLocalFolderDialog } from "@/components/page-sections/settings/AddLocalFolderDialog";
import { getAllSyncPaths } from "@/app/lib/utils/syncPathUtils";
import {
  listRemoteFolders,
  restoreRemoteFolders,
  deleteRemoteFolder,
} from "@/app/lib/utils/restoreUtils";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  getHcfsConfig,
  saveHcfsConfig,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "@/components/page-sections/settings/HcfsSetupDialog";
import { SyncDestinationDialog } from "@/components/page-sections/settings/multi-folder-sync/SyncDestinationDialog";
import {
  syncEngineStatusAtom,
  isSyncConfiguredAtom,
  SYNC_STOPPED_STORAGE_KEY,
} from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";

interface FilesOnboardingProps {
  onSkip: () => void;
  onSyncStarted: () => void;
}

const FilesOnboarding: React.FC<FilesOnboardingProps> = ({
  onSkip,
  onSyncStarted,
}) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<RemoteFolder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  // Sync destination dialog state
  const [syncDialog, setSyncDialog] = useState<{
    open: boolean;
    folder: RemoteFolder | null;
  }>({ open: false, folder: null });
  const [syncLocalPath, setSyncLocalPath] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingAction, setPendingAction] = useState<"sync" | null>(null);

  // Delete from server dialog
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    folderName: string;
  }>({ open: false, folderName: "" });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [isDeletingServer, setIsDeletingServer] = useState(false);

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

      const localFolders: SyncFolder[] = await Promise.all(
        syncPaths.map(async (syncPath, index) => {
          const folderName =
            syncPath.path.split(/[\\\u002f]/).filter(Boolean).pop() ||
            syncPath.label;
          const label = syncPath.label || `sync-folder-${index}`;
          const isActive = await invoke<boolean>("is_drive_active", {
            label,
          }).catch(() => true);

          return {
            id: label,
            folderName,
            localPath: syncPath.path,
            isLocal: true,
            status: isActive ? ("syncing" as const) : ("paused" as const),
          };
        })
      );

      const localLabelSet = new Set(localFolders.map((f) => f.id));

      const remoteFoldersData: RemoteFolder[] = remoteList
        .filter((r) => !localLabelSet.has(r.label))
        .map((r) => ({
          folderName: r.label,
          deviceName: r.device_name || "Unknown Device",
          fileCount: r.file_count,
          totalBytes: r.total_bytes,
          lastModified: (r.updated_at || r.created_at) * 1000,
        }))
        .sort((a, b) => b.lastModified - a.lastModified);

      setSyncFolders(localFolders);
      setRemoteFolders(remoteFoldersData);
    } catch (error) {
      console.error("Failed to load folders:", error);
    } finally {
      setIsLoading(false);
    }
  }, [polkadotAddress]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // After a successful add, refresh folders + signal parent
  const handleAddSuccess = useCallback(() => {
    loadFolders();
    onSyncStarted();
  }, [loadFolders, onSyncStarted]);

  // ── Remote folder sync ────────────────────────────────────────────────

  const handleSyncRemoteFolder = (folder: RemoteFolder) => {
    setSyncDialog({ open: true, folder });
    setSyncLocalPath("");
  };

  const handleSelectSyncDestination = async () => {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Destination for Synced Files",
      });
      if (typeof path === "string") {
        setSyncLocalPath(path);
      }
    } catch (error) {
      console.error("Failed to select path:", error);
      toast.error("Failed to select destination folder");
    }
  };

  const doRestore = async () => {
    const folder = syncDialog.folder;
    if (!polkadotAddress || !folder || !syncLocalPath) return;

    setIsSyncing(true);
    try {
      const mnemonic = await getMnemonic();
      const results = await restoreRemoteFolders(
        polkadotAddress,
        [folder.folderName],
        syncLocalPath,
        mnemonic ?? undefined
      );

      const result = results[0];
      if (result && !result.success) {
        throw new Error(result.error ?? "Unknown error");
      }

      localStorage.removeItem(SYNC_STOPPED_STORAGE_KEY);
      appStore.set(syncEngineStatusAtom, "active");
      appStore.set(isSyncConfiguredAtom, true);

      toast.success(`Started syncing ${folder.folderName}`);
      setSyncDialog({ open: false, folder: null });
      setSyncLocalPath("");
      loadFolders();
      onSyncStarted();
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

  const handleStartSync = async () => {
    if (!polkadotAddress) {
      toast.error("Wallet authentication is required");
      return;
    }
    if (!syncDialog.folder) return;
    if (!syncLocalPath) {
      toast.error("Please select a local destination");
      return;
    }

    try {
      const config = await getHcfsConfig(polkadotAddress);
      if (!config.has_password) {
        setPendingAction("sync");
        setSyncDialog((prev) => ({ ...prev, open: false }));
        setShowHcfsSetup(true);
        return;
      }
    } catch {
      setPendingAction("sync");
      setSyncDialog((prev) => ({ ...prev, open: false }));
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
      if (pendingAction === "sync") {
        await doRestore();
      }
      setPendingAction(null);
    } catch (err) {
      console.error("Failed to save HCFS config:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  // ── Delete from server ────────────────────────────────────────────────

  const openDeleteServerDialog = (folderName: string) => {
    setDeleteDialog({ open: true, folderName });
    setDeleteConfirmInput("");
  };

  const handleDeleteFromServer = async () => {
    if (!polkadotAddress) return;
    setIsDeletingServer(true);
    try {
      const result = await deleteRemoteFolder(
        polkadotAddress,
        deleteDialog.folderName
      );
      toast.success(
        `Folder deleted from server (${result.files_deleted} file${result.files_deleted !== 1 ? "s" : ""} removed)`
      );
      setDeleteDialog({ open: false, folderName: "" });
      setDeleteConfirmInput("");
      loadFolders();
    } catch (error) {
      console.error("Failed to delete folder:", error);
      toast.error("Failed to delete folder from server");
    } finally {
      setIsDeletingServer(false);
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
      <div className="w-full flex flex-col gap-6 mt-6">

        {/* ──────── Local Sync Folders ──────── */}
        <div className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/folder-sync-bg-layer.png')] bg-repeat-round bg-cover">
          <div className="w-full flex justify-between gap-4">
            <SectionHeader
              Icon={Icons.File2}
              title="Local Sync Folders"
              subtitle="Manage folders on this device that sync to the Hippius network. Changes are encrypted and synced automatically."
            />
            <IconButton
              className="w-[146px] h-[42px]"
              icon={Plus}
              text="Add Folder"
              onClick={() => setShowAddDialog(true)}
            />
          </div>

          <div className="w-full">
            <div className="space-y-3 w-full">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Icons.Loader className="size-6 animate-spin text-primary-50" />
                </div>
              ) : syncFolders.length === 0 ? (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center bg-white/60">
                  <Folder className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50 mb-1">
                    No folders syncing yet
                  </p>
                  <p className="text-xs text-grey-60">
                    Add a local folder to get started with encrypted sync
                  </p>
                </div>
              ) : (
                <div className="space-y-2 w-full">
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
                                folder.status === "syncing"
                                  ? "bg-success-95 text-success-50 border-success-80"
                                  : "bg-grey-95 text-grey-50 border-grey-80"
                              )}
                            >
                              {folder.status === "syncing"
                                ? "Syncing"
                                : "Paused"}
                            </span>
                          </div>
                          <p className="text-sm text-grey-60 truncate">
                            {folder.localPath}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ──────── Sync from Other Devices ──────── */}
        <div className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover">
          <SectionHeader
            Icon={CloudDownload}
            title="Sync from Other Devices"
            subtitle="Folders synced from your other machines. Start syncing to download them to this device."
          />

          <div className="w-full">
            <div className="space-y-3 w-full">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Icons.Loader className="size-6 animate-spin text-primary-50" />
                </div>
              ) : remoteFolders.length > 0 ? (
                <div className="space-y-2 w-full">
                  {remoteFolders.map((folder) => (
                    <div
                      key={folder.folderName}
                      className="p-4 border border-grey-80 rounded-lg bg-white hover:bg-grey-98 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Folder className="size-4 text-primary-50 flex-shrink-0" />
                            <span className="font-medium text-base text-grey-10 truncate">
                              {folder.folderName}
                            </span>
                            <span className="text-xs font-medium px-2 py-0.5 rounded border bg-grey-95 text-grey-50 border-grey-80">
                              {folder.deviceName}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-grey-60 mt-1">
                            {folder.fileCount > 0 && (
                              <span className="flex items-center gap-1">
                                <Icons.File2 className="size-3" />
                                {folder.fileCount}{" "}
                                {folder.fileCount === 1 ? "file" : "files"}
                              </span>
                            )}
                            {folder.totalBytes > 0 && (
                              <span className="flex items-center gap-1">
                                <HardDrive className="size-3" />
                                {formatBytes(folder.totalBytes)}
                              </span>
                            )}
                            {folder.lastModified > 0 && (
                              <span className="flex items-center gap-1">
                                <Clock className="size-3" />
                                {formatDate(folder.lastModified)}
                              </span>
                            )}
                          </div>
                        </div>

                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button className="p-2 hover:bg-grey-90 rounded transition-colors">
                              <MoreVertical className="size-4 text-grey-40" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              className="bg-white border border-grey-80 rounded-lg shadow-lg p-1 min-w-[200px] z-[60]"
                              sideOffset={5}
                              align="end"
                              avoidCollisions
                            >
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-90 rounded cursor-pointer outline-none"
                                onSelect={() =>
                                  handleSyncRemoteFolder(folder)
                                }
                              >
                                <CloudDownload className="size-4" />
                                Sync to This Device
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator className="h-px bg-grey-80 my-1" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-error-50 hover:bg-error-95 rounded cursor-pointer outline-none"
                                onSelect={() =>
                                  openDeleteServerDialog(folder.folderName)
                                }
                              >
                                <ServerCrash className="size-4" />
                                Delete from Server
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center bg-white/60">
                  <CloudDownload className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50 mb-1">
                    No remote folders found
                  </p>
                  <p className="text-xs text-grey-60">
                    Folders synced from your other devices will appear here
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ──────── Skip button ──────── */}
        <div className="flex justify-end">
          <CardButton
            className="w-[120px] h-[48px]"
            variant="secondary"
            onClick={onSkip}
          >
            Skip for Now
          </CardButton>
        </div>
      </div>

      {/* ──────── Dialogs ──────── */}
      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSuccess={handleAddSuccess}
      />

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => {
          setShowHcfsSetup(false);
          setPendingAction(null);
        }}
        onComplete={handleHcfsSetupComplete}
      />

      {/* Sync destination dialog — uses shared component from settings */}
      <SyncDestinationDialog
        open={syncDialog.open}
        folder={syncDialog.folder}
        syncLocalPath={syncLocalPath}
        isSyncing={isSyncing}
        onClose={() => {
          if (!isSyncing) {
            setSyncDialog({ open: false, folder: null });
            setSyncLocalPath("");
          }
        }}
        onSelectDestination={handleSelectSyncDestination}
        onStartSync={handleStartSync}
      />

      {/* Delete from server dialog */}
      <Dialog.Root
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open && !isDeletingServer) {
            setDeleteDialog({ open: false, folderName: "" });
            setDeleteConfirmInput("");
          }
        }}
      >
        <DialogContainer
          className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit"
          preventClose={isDeletingServer}
        >
          <Dialog.Title className="sr-only">Delete from Server</Dialog.Title>
          <div className="px-4 py-6 flex flex-col gap-5">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center">
                <ServerCrash className="size-5 text-grey-100" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-xl font-semibold text-grey-10">
                  Delete from Server
                </h2>
                <p className="text-sm text-grey-50 max-w-sm">
                  This will permanently delete &quot;
                  <span className="font-semibold text-grey-10">
                    {deleteDialog.folderName}
                  </span>
                  &quot; and all its files from the server. Type the folder name
                  to confirm.
                </p>
              </div>
            </div>

            <input
              className="w-full px-3 py-2 border border-grey-80 rounded-lg text-sm focus:outline-none focus:border-primary-50"
              placeholder={deleteDialog.folderName}
              value={deleteConfirmInput}
              onChange={(e) => setDeleteConfirmInput(e.target.value)}
              disabled={isDeletingServer}
            />

            <div className="flex gap-3">
              <CardButton
                className="w-full"
                variant="secondary"
                onClick={() => {
                  setDeleteDialog({ open: false, folderName: "" });
                  setDeleteConfirmInput("");
                }}
                disabled={isDeletingServer}
              >
                Cancel
              </CardButton>
              <CardButton
                className="w-full"
                variant="error"
                onClick={handleDeleteFromServer}
                disabled={
                  isDeletingServer ||
                  deleteConfirmInput !== deleteDialog.folderName
                }
                loading={isDeletingServer}
              >
                {isDeletingServer ? "Deleting..." : "Delete"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>
    </>
  );
};

export default FilesOnboarding;
