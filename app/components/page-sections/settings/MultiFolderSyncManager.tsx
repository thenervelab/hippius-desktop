"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Icons,
  RevealTextLine,
  CardButton,
  IconButton,
  Graphsheet,
  Input,
} from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
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
  ServerCrash,
  Monitor,
  Clock,
  HardDrive,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";
import { AddLocalFolderDialog } from "./AddLocalFolderDialog";
import { getAllSyncPaths, removeSyncPath } from "@/app/lib/utils/syncPathUtils";
import {
  listRemoteFolders,
  deleteRemoteFolder,
  restoreRemoteFolders,
} from "@/app/lib/utils/restoreUtils";
import { REMOTE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useRemoteStorageStats";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getHcfsConfig, saveHcfsConfig, initializeSync } from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import {
  syncEngineStatusAtom,
  isSyncConfiguredAtom,
  SYNC_STOPPED_STORAGE_KEY,
} from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { Label } from "@/components/ui/label";

export default function MultiFolderSyncManager() {
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const queryClient = useQueryClient();
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<RemoteFolder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Remove folder dialog state
  const [removeDialog, setRemoveDialog] = useState<{
    open: boolean;
    folderId: string | null;
    folderName: string | null;
  }>({ open: false, folderId: null, folderName: null });
  const [isRemoving, setIsRemoving] = useState(false);

  // Pause sync dialog state
  const [pauseDialog, setPauseDialog] = useState<{
    open: boolean;
    folder: SyncFolder | null;
  }>({ open: false, folder: null });
  const [isPausing, setIsPausing] = useState(false);

  // Typed-name delete dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    folderName: string;
    folderId: string | null;
  }>({ open: false, folderName: "", folderId: null });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [isDeletingServer, setIsDeletingServer] = useState(false);

  // Sync destination dialog state
  const [syncDialog, setSyncDialog] = useState<{
    open: boolean;
    folder: RemoteFolder | null;
  }>({ open: false, folder: null });
  const [syncLocalPath, setSyncLocalPath] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [pendingAction, setPendingAction] = useState<"sync" | null>(null);

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
            syncPath.path.split(/[\\\u002f]/).filter(Boolean).pop() || syncPath.label;
          const label = syncPath.label || `sync-folder-${index}`;
          const isActive = await invoke<boolean>("is_drive_active", { label }).catch(() => true);

          return {
            id: label,
            folderName,
            localPath: syncPath.path,
            isLocal: true,
            status: isActive ? "syncing" as const : "paused" as const,
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
      toast.error("Failed to load sync folders");
    } finally {
      setIsLoading(false);
    }
  }, [polkadotAddress]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const refreshFoldersAndStats = useCallback(() => {
    loadFolders();
    queryClient.invalidateQueries({
      queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY],
    });
  }, [loadFolders, queryClient]);

  // ── Local folder actions ──────────────────────────────────────────────

  const handleRemoveFolder = async () => {
    const { folderId } = removeDialog;
    if (!folderId || !polkadotAddress) return;

    setIsRemoving(true);
    try {
      await removeSyncPath(polkadotAddress, folderId);
      toast.success("Folder removed from sync");
      refreshFoldersAndStats();
    } catch (error) {
      console.error("Failed to remove folder:", error);
      toast.error("Failed to remove folder");
    } finally {
      setIsRemoving(false);
      setRemoveDialog({ open: false, folderId: null, folderName: null });
    }
  };

  const handlePauseSync = async () => {
    const folder = pauseDialog.folder;
    if (!folder || !polkadotAddress) return;

    setIsPausing(true);
    try {
      await invoke("stop_drive", { label: folder.id });
      toast.success(`Sync paused for "${folder.folderName}"`);
      setSyncFolders((prev) =>
        prev.map((f) =>
          f.id === folder.id ? { ...f, status: "paused" as const } : f
        )
      );
    } catch (error) {
      console.error("Failed to pause sync:", error);
      toast.error("Failed to pause sync");
    } finally {
      setIsPausing(false);
      setPauseDialog({ open: false, folder: null });
    }
  };

  const handleResumeSync = async (folder: SyncFolder) => {
    if (!polkadotAddress) return;
    try {
      const mnemonic = (await getMnemonic()) ?? undefined;
      await initializeSync(polkadotAddress, folder.id, mnemonic);

      localStorage.removeItem(SYNC_STOPPED_STORAGE_KEY);
      appStore.set(syncEngineStatusAtom, "active");
      appStore.set(isSyncConfiguredAtom, true);

      toast.success(`Sync resumed for "${folder.folderName}"`);
      setSyncFolders((prev) =>
        prev.map((f) =>
          f.id === folder.id ? { ...f, status: "syncing" as const } : f
        )
      );
    } catch (error) {
      console.error("Failed to resume sync:", error);
      toast.error("Failed to resume sync");
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

    if (diff < 60000) return "Just now";

    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    }

    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    }

    return new Date(timestamp).toLocaleString();
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
      refreshFoldersAndStats();
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
        setShowHcfsSetup(true);
        return;
      }
    } catch {
      setPendingAction("sync");
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

  // ── Typed-name server delete ──────────────────────────────────────────

  const openDeleteServerDialog = (folderName: string, folderId?: string) => {
    setDeleteDialog({ open: true, folderName, folderId: folderId ?? null });
    setDeleteConfirmInput("");
  };

  const handleDeleteFromServer = async () => {
    if (!polkadotAddress) return;
    setIsDeletingServer(true);
    try {
      // Use folderId (local folder label) if present, otherwise folderName (remote)
      const label = deleteDialog.folderId ?? deleteDialog.folderName;
      const result = await deleteRemoteFolder(polkadotAddress, label);

      // If deleting from a local folder, also remove the sync path
      if (deleteDialog.folderId) {
        await removeSyncPath(polkadotAddress, deleteDialog.folderId).catch(() => {});
      }

      toast.success(
        `Folder deleted from server (${result.files_deleted} file${result.files_deleted !== 1 ? "s" : ""} removed)`
      );
      setDeleteDialog({ open: false, folderName: "", folderId: null });
      setDeleteConfirmInput("");
      refreshFoldersAndStats();
    } catch (error) {
      console.error("Failed to delete folder:", error);
      toast.error("Failed to delete folder from server");
    } finally {
      setIsDeletingServer(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ──────── Card 2: Local Sync Folders ──────── */}
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/folder-sync-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <div className="w-full flex justify-between gap-4">
                  <SectionHeader
                    Icon={Icons.File2}
                    title="Local Sync Folders"
                    subtitle="Manage folders on this device that sync to the Hippius network. Changes are encrypted and synced automatically."
                    info="Multi-folder sync allows you to keep different directories synchronized independently. Files are encrypted and synced to the Hippius network."
                    learnMoreUrl="https://docs.hippius.com/use/desktop/settings#multi-folder-sync"
                  />
                  <IconButton
                    className="w-[146px] h-[42px]"
                    icon={Plus}
                    text="Add Folder"
                    onClick={() => setShowAddDialog(true)}
                  />
                </div>
              </RevealTextLine>
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
                                  getStatusColor(folder.status)
                                )}
                              >
                                {getStatusText(folder.status)}
                              </span>
                            </div>
                            <p className="text-sm text-grey-60 truncate mb-1">
                              {folder.localPath}
                            </p>
                            {(folder.fileCount !== undefined ||
                              folder.lastSynced) && (
                              <div className="flex items-center gap-3 text-xs text-grey-70">
                                {folder.fileCount !== undefined && (
                                  <span>{folder.fileCount} files</span>
                                )}
                                {folder.lastSynced && (
                                  <span>
                                    · Last synced{" "}
                                    {formatLastSynced(folder.lastSynced)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                              <button className="p-2 hover:bg-grey-95 rounded transition-colors">
                                <MoreVertical className="size-4 text-grey-40" />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content className="bg-white border border-grey-80 rounded-lg shadow-lg p-1 min-w-[200px] z-[60]" sideOffset={5} align="end" avoidCollisions>
                                {folder.status === "syncing" ? (
                                  <DropdownMenu.Item
                                    className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                    onSelect={() => setPauseDialog({ open: true, folder })}
                                  >
                                    <PauseCircle className="size-4" />
                                    Pause Sync
                                  </DropdownMenu.Item>
                                ) : (
                                  <DropdownMenu.Item
                                    className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                    onSelect={() => handleResumeSync(folder)}
                                  >
                                    <PlayCircle className="size-4" />
                                    Resume Sync
                                  </DropdownMenu.Item>
                                )}
                                <DropdownMenu.Separator className="h-px bg-grey-80 my-1" />
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                  onSelect={() =>
                                    setRemoveDialog({
                                      open: true,
                                      folderId: folder.id,
                                      folderName: folder.folderName,
                                    })
                                  }
                                >
                                  <Trash2 className="size-4" />
                                  Remove Folder
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-error-50 hover:bg-error-95 rounded cursor-pointer outline-none"
                                  onSelect={() =>
                                    openDeleteServerDialog(
                                      folder.folderName,
                                      folder.id
                                    )
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
                )}
              </div>
            </div>
          </div>
        )}
      </InView>

      {/* ──────── Card 3: Sync from Other Devices ──────── */}
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <div className="w-full">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <SectionHeader
                  Icon={CloudDownload}
                  title="Sync from Other Devices"
                  subtitle="Folders synced from your other machines. Start syncing to download them to this device."
                />
              </RevealTextLine>
            </div>

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
                              <button className="p-2 hover:bg-grey-95 rounded transition-colors">
                                <MoreVertical className="size-4 text-grey-40" />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content className="bg-white border border-grey-80 rounded-lg shadow-lg p-1 min-w-[200px] z-[60]" sideOffset={5} align="end" avoidCollisions>
                                <DropdownMenu.Item
                                  className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                  onSelect={() => handleSyncRemoteFolder(folder)}
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
        )}
      </InView>

      {/* ──────── Dialogs ──────── */}

      {/* Add Local Folder Dialog */}
      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSuccess={refreshFoldersAndStats}
      />

      {/* Remove Folder Dialog */}
      <Dialog.Root
        open={removeDialog.open}
        onOpenChange={(open) => {
          if (!open && !isRemoving) {
            setRemoveDialog({ open: false, folderId: null, folderName: null });
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit" preventClose={isRemoving}>
          <Dialog.Title className="sr-only">Remove Folder from Sync</Dialog.Title>

          <div className="px-4 py-6 flex flex-col gap-5">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="size-14 flex justify-center items-center relative">
                <Graphsheet
                  majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                  minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                  className="absolute w-full h-full duration-500 opacity-30 z-0"
                />
                <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                  <Trash2 className="size-5 text-grey-100" />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-xl font-semibold text-grey-10">Remove Folder from Sync</h2>
                <p className="text-sm text-grey-50 max-w-sm">
                  Are you sure you want to remove &quot;
                  <span className="font-semibold text-grey-10">
                    {removeDialog.folderName}
                  </span>
                  &quot; from sync? Local files will remain on your device, but this folder will no longer be synchronized.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <CardButton
                className="w-full"
                variant="secondary"
                onClick={() => setRemoveDialog({ open: false, folderId: null, folderName: null })}
                disabled={isRemoving}
              >
                Cancel
              </CardButton>
              <CardButton
                className="w-full"
                variant="error"
                onClick={handleRemoveFolder}
                disabled={isRemoving}
                loading={isRemoving}
              >
                {isRemoving ? "Removing..." : "Remove Folder"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* Pause Sync Dialog */}
      <Dialog.Root
        open={pauseDialog.open}
        onOpenChange={(open) => {
          if (!open && !isPausing) {
            setPauseDialog({ open: false, folder: null });
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit" preventClose={isPausing}>
          <Dialog.Title className="sr-only">Pause Sync</Dialog.Title>

          <div className="px-4 py-6 flex flex-col gap-5">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="size-14 flex justify-center items-center relative">
                <Graphsheet
                  majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                  minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                  className="absolute w-full h-full duration-500 opacity-30 z-0"
                />
                <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                <div className="h-8 w-8 bg-grey-40 rounded-lg flex items-center justify-center z-20">
                  <PauseCircle className="size-5 text-grey-100" />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-xl font-semibold text-grey-10">Pause Sync</h2>
                <p className="text-sm text-grey-50 max-w-sm">
                  This will pause syncing for &quot;
                  <span className="font-semibold text-grey-10">
                    {pauseDialog.folder?.folderName}
                  </span>
                  &quot;. No new changes will be uploaded or downloaded until you resume.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <CardButton
                className="w-full"
                variant="secondary"
                onClick={() => setPauseDialog({ open: false, folder: null })}
                disabled={isPausing}
              >
                Cancel
              </CardButton>
              <CardButton
                className="w-full"
                variant="primary"
                onClick={handlePauseSync}
                disabled={isPausing}
                loading={isPausing}
              >
                {isPausing ? "Pausing..." : "Pause Sync"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* Sync Destination Dialog (for remote folders) */}
      <Dialog.Root
        open={syncDialog.open}
        onOpenChange={(open) => {
          if (!open && !isSyncing) {
            setSyncDialog({ open: false, folder: null });
            setSyncLocalPath("");
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit" preventClose={isSyncing}>
          <Dialog.Title className="sr-only">Choose Destination</Dialog.Title>

          <div className="px-4 py-6 flex flex-col gap-5">
            {/* Centered icon header */}
            <div className="flex flex-col items-center text-center gap-3">
              <div className="size-14 flex justify-center items-center relative">
                <Graphsheet
                  majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                  minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                  className="absolute w-full h-full duration-500 opacity-30 z-0"
                />
                <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                  <CloudDownload className="size-5 text-grey-100" />
                </div>
              </div>
              <h2 className="text-xl font-semibold text-grey-10">Choose Destination</h2>
              <p className="text-sm text-grey-50 max-w-sm">
                Select where to sync &quot;{syncDialog.folder?.folderName}&quot;
              </p>
            </div>

            {/* Folder info */}
            <div className="p-3 bg-grey-98 border border-grey-80 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <Folder className="size-4 text-primary-50" />
                <span className="font-medium text-sm text-grey-10">
                  {syncDialog.folder?.folderName}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-grey-60">
                {syncDialog.folder?.deviceName && (
                  <span className="flex items-center gap-1">
                    <Monitor className="size-3" />
                    {syncDialog.folder.deviceName}
                  </span>
                )}
                {(syncDialog.folder?.fileCount ?? 0) > 0 && (
                  <span>
                    {syncDialog.folder?.fileCount}{" "}
                    {syncDialog.folder?.fileCount === 1 ? "file" : "files"}
                  </span>
                )}
                {(syncDialog.folder?.totalBytes ?? 0) > 0 && (
                  <span>{formatBytes(syncDialog.folder?.totalBytes ?? 0)}</span>
                )}
              </div>
            </div>

            {/* Destination selection */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-grey-30">
                Local Destination
              </Label>
              {syncLocalPath ? (
                <div className="p-3 border border-grey-80 rounded-lg bg-grey-98">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-grey-60 break-all font-mono bg-white px-2 py-1.5 rounded border border-grey-90">
                        {syncLocalPath}/{syncDialog.folder?.folderName}
                      </p>
                    </div>
                    <button
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-primary-50 bg-white border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors"
                      onClick={handleSelectSyncDestination}
                      disabled={isSyncing}
                    >
                      Change
                    </button>
                  </div>
                </div>
              ) : (
                <CardButton
                  variant="secondary"
                  className="w-full justify-center"
                  icon={<Folder className="size-4" />}
                  appendToStart
                  onClick={handleSelectSyncDestination}
                  disabled={isSyncing}
                >
                  Choose Destination Folder
                </CardButton>
              )}
            </div>

            {/* Info box */}
            {syncLocalPath && (
              <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg animate-in fade-in duration-200">
                <p className="text-xs text-primary-40">
                  Files will be downloaded and kept in sync with your other
                  devices. Any local changes will sync back automatically.
                </p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <CardButton
                className="w-full"
                variant="secondary"
                onClick={() => {
                  setSyncDialog({ open: false, folder: null });
                  setSyncLocalPath("");
                }}
                disabled={isSyncing}
              >
                Cancel
              </CardButton>
              <CardButton
                className="w-full"
                variant="primary"
                onClick={handleStartSync}
                disabled={!syncLocalPath || isSyncing}
                loading={isSyncing}
              >
                {isSyncing ? "Starting Sync..." : "Start Syncing"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* Typed-name Delete Server Dialog */}
      <Dialog.Root
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open && !isDeletingServer) {
            setDeleteDialog({ open: false, folderName: "", folderId: null });
            setDeleteConfirmInput("");
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit" preventClose={isDeletingServer}>
          <Dialog.Title className="sr-only">Delete Folder from Server</Dialog.Title>

          <div className="px-4 py-6 flex flex-col gap-5">
            {/* Centered icon header */}
            <div className="flex flex-col items-center text-center gap-3">
              <div className="size-14 flex justify-center items-center relative">
                <Graphsheet
                  majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                  minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                  className="absolute w-full h-full duration-500 opacity-30 z-0"
                />
                <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                  <Icons.Trash className="size-6 text-grey-100" />
                </div>
              </div>
              <h2 className="text-xl font-semibold text-grey-10">Delete Folder from Server</h2>
              <p className="text-sm text-grey-50 max-w-sm">
                This will permanently delete all files for &quot;
                <span className="font-semibold text-grey-10">
                  {deleteDialog.folderName}
                </span>
                &quot; from the server. This action cannot be undone.
              </p>
            </div>

            {/* Type name to confirm */}
            <div className="space-y-2 text-left">
              <Label
                htmlFor="delete-confirm"
                className="text-sm font-medium text-grey-30"
              >
                Type the folder name to confirm:
              </Label>
              <Input
                id="delete-confirm"
                placeholder={deleteDialog.folderName}
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                disabled={isDeletingServer}
                className="border-grey-80 h-12 text-grey-30 w-full bg-white py-3 font-medium text-base rounded-lg"
              />
              {deleteConfirmInput.length > 0 &&
                deleteConfirmInput !== deleteDialog.folderName && (
                  <p className="text-xs text-error-50">
                    Folder name does not match. Please type &quot;
                    {deleteDialog.folderName}&quot; exactly.
                  </p>
                )}
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
              <CardButton
                className="w-full"
                variant="secondary"
                onClick={() => {
                  setDeleteDialog({ open: false, folderName: "", folderId: null });
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
                  deleteConfirmInput !== deleteDialog.folderName ||
                  isDeletingServer
                }
                loading={isDeletingServer}
              >
                {isDeletingServer ? "Deleting..." : "Delete Permanently"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* HCFS Setup Dialog */}
      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => {
          setShowHcfsSetup(false);
          setPendingAction(null);
        }}
        onComplete={handleHcfsSetupComplete}
        loading={isSyncing}
      />
    </>
  );
}
