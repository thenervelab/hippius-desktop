"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
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
import {
  getHcfsConfig,
  saveHcfsConfig,
  initializeSync,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import {
  syncEngineStatusAtom,
  isSyncConfiguredAtom,
  SYNC_STOPPED_STORAGE_KEY,
} from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import {
  LocalFoldersSection,
  RemoteFoldersSection,
  RemoveFolderDialog,
  PauseSyncDialog,
  SyncDestinationDialog,
  DeleteServerDialog,
} from "./multi-folder-sync";

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

  // ── Data loading ──────────────────────────────────────────────────────

  const loadFolders = useCallback(async () => {
    if (!polkadotAddress) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      const [syncPaths, remoteList] = await Promise.all([
        getAllSyncPaths(polkadotAddress).catch((err) => {
          console.error("[MultiFolderSync] Failed to get sync paths:", err);
          return [];
        }),
        listRemoteFolders(polkadotAddress).catch((err) => {
          console.error("[MultiFolderSync] Failed to list remote folders:", err);
          return [];
        }),
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
        }).catch((err: unknown) => console.warn("[MultiFolderSyncManager] persist_master_mnemonic failed:", err));
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
      const label = deleteDialog.folderId ?? deleteDialog.folderName;
      const result = await deleteRemoteFolder(polkadotAddress, label);

      if (deleteDialog.folderId) {
        await removeSyncPath(polkadotAddress, deleteDialog.folderId).catch(
          () => {}
        );
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

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <>
      <LocalFoldersSection
        syncFolders={syncFolders}
        isLoading={isLoading}
        onAddFolder={() => setShowAddDialog(true)}
        onPauseFolder={(folder) => setPauseDialog({ open: true, folder })}
        onResumeFolder={handleResumeSync}
        onRemoveFolder={(folder) =>
          setRemoveDialog({
            open: true,
            folderId: folder.id,
            folderName: folder.folderName,
          })
        }
        onDeleteFromServer={openDeleteServerDialog}
      />

      <RemoteFoldersSection
        remoteFolders={remoteFolders}
        isLoading={isLoading}
        onSyncFolder={handleSyncRemoteFolder}
        onDeleteFromServer={(folderName) =>
          openDeleteServerDialog(folderName)
        }
      />

      {/* Dialogs */}

      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSuccess={refreshFoldersAndStats}
      />

      <RemoveFolderDialog
        open={removeDialog.open}
        folderName={removeDialog.folderName}
        isRemoving={isRemoving}
        onClose={() =>
          setRemoveDialog({ open: false, folderId: null, folderName: null })
        }
        onConfirm={handleRemoveFolder}
      />

      <PauseSyncDialog
        open={pauseDialog.open}
        folderName={pauseDialog.folder?.folderName}
        isPausing={isPausing}
        onClose={() => setPauseDialog({ open: false, folder: null })}
        onConfirm={handlePauseSync}
      />

      <SyncDestinationDialog
        open={syncDialog.open}
        folder={syncDialog.folder}
        syncLocalPath={syncLocalPath}
        isSyncing={isSyncing}
        onClose={() => {
          setSyncDialog({ open: false, folder: null });
          setSyncLocalPath("");
        }}
        onSelectDestination={handleSelectSyncDestination}
        onStartSync={handleStartSync}
      />

      <DeleteServerDialog
        open={deleteDialog.open}
        folderName={deleteDialog.folderName}
        confirmInput={deleteConfirmInput}
        isDeletingServer={isDeletingServer}
        onConfirmInputChange={setDeleteConfirmInput}
        onClose={() => {
          setDeleteDialog({ open: false, folderName: "", folderId: null });
          setDeleteConfirmInput("");
        }}
        onConfirm={handleDeleteFromServer}
      />

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
