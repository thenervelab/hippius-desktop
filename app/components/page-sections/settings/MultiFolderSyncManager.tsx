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
import { GET_USER_IPFS_FILES_QUERY_KEY } from "@/app/lib/hooks/use-user-files";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  getHcfsConfig,
  saveHcfsConfig,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import {
  syncEngineStatusAtom,
  isSyncConfiguredAtom,
  triggerSyncPathRefreshAtom,
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
  RemoteFolderBrowser,
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
  const [pendingAction, setPendingAction] = useState<"sync" | "browse" | null>(null);

  // Browse remote folder dialog state
  const [browseDialog, setBrowseDialog] = useState<{
    open: boolean;
    folder: RemoteFolder | null;
    isLocal: boolean;
  }>({ open: false, folder: null, isLocal: false });
  // Exclusion paths from browse → sync flow
  const [pendingExclusions, setPendingExclusions] = useState<string[]>([]);

  /** Check remaining sync folders; if none left, reset onboarding state. */
  const checkAndResetIfNoFolders = useCallback(async () => {
    if (!polkadotAddress) return;
    const remainingPaths = await getAllSyncPaths(polkadotAddress).catch((err: unknown) => {
      console.warn("getAllSyncPaths failed:", err);
      return [];
    });
    if (remainingPaths.length === 0) {
      appStore.set(isSyncConfiguredAtom, false);
    }
    appStore.set(triggerSyncPathRefreshAtom, (prev) => prev + 1);
  }, [polkadotAddress]);

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

      // Build a lookup from remote data so we can attach stats to local folders
      const remoteByLabel = new Map(
        remoteList.map((r) => [r.label, r])
      );

      const localFolders: SyncFolder[] = await Promise.all(
        syncPaths.map(async (syncPath, index) => {
          const folderName =
            syncPath.path.split(/[\\/]/).filter(Boolean).pop() ||
            syncPath.label;
          const label = syncPath.label || `sync-folder-${index}`;

          // Use the persisted is_paused flag (survives restarts).
          // Fall back to runtime is_drive_active check.
          let status: "syncing" | "paused" = "syncing";
          if (syncPath.isPaused) {
            status = "paused";
          } else {
            const isActive = await invoke<boolean>("is_drive_active", {
              label,
            }).catch(() => true);
            if (!isActive) status = "paused";
          }

          const remoteInfo = remoteByLabel.get(label);

          return {
            id: label,
            folderName,
            localPath: syncPath.path,
            isLocal: true,
            status,
            fileCount: remoteInfo?.file_count,
            totalBytes: remoteInfo?.total_bytes,
            lastModified: remoteInfo
              ? (remoteInfo.updated_at || remoteInfo.created_at) * 1000
              : undefined,
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

  const refreshFoldersAndStats = useCallback((delayMs = 0) => {
    const refresh = () => {
      loadFolders();
      queryClient.invalidateQueries({
        queryKey: [REMOTE_STORAGE_STATS_QUERY_KEY],
      });
      queryClient.invalidateQueries({
        queryKey: [GET_USER_IPFS_FILES_QUERY_KEY],
      });
    };
    refresh();
    if (delayMs > 0) {
      setTimeout(refresh, delayMs);
    }
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

      await checkAndResetIfNoFolders();
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
      await invoke("pause_drive", { label: folder.id });
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
      await invoke("resume_drive", { label: folder.id, mnemonic });

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
      let defaultPath: string | undefined;
      try {
        const { homeDir } = await import("@tauri-apps/api/path");
        defaultPath = await homeDir();
      } catch {
        // Fall back to OS default if homeDir is unavailable
      }
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Destination for Synced Files",
        defaultPath,
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

      // Apply any pending exclusion patterns from the browse dialog
      if (pendingExclusions.length > 0) {
        for (const path of pendingExclusions) {
          await invoke("add_exclude_pattern", {
            label: folder.folderName,
            pattern: path,
          }).catch((err: unknown) =>
            console.warn("Failed to add exclusion pattern:", err)
          );
        }
        setPendingExclusions([]);
      }

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
      } else if (pendingAction === "browse" && browseDialog.folder) {
        setBrowseDialog((prev) => ({ ...prev, open: true }));
      }
      setPendingAction(null);
    } catch (err) {
      console.error("Failed to save HCFS config:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  // ── Browse remote folder ─────────────────────────────────────────────

  const handleBrowseFolder = async (folder: RemoteFolder, isLocal = false) => {
    // Browsing requires the HCFS encryption key (derived from the drive password).
    // If HCFS config isn't set up yet, prompt the user first.
    if (!isLocal && polkadotAddress) {
      try {
        const config = await getHcfsConfig(polkadotAddress);
        if (!config.has_password) {
          setBrowseDialog({ open: false, folder, isLocal });
          setPendingAction("browse");
          setShowHcfsSetup(true);
          return;
        }
      } catch {
        setBrowseDialog({ open: false, folder, isLocal });
        setPendingAction("browse");
        setShowHcfsSetup(true);
        return;
      }
    }
    setBrowseDialog({ open: true, folder, isLocal });
  };

  const handleSyncSelectedFromBrowse = (
    folder: RemoteFolder,
    excludedPaths: string[]
  ) => {
    setPendingExclusions(excludedPaths);
    setBrowseDialog({ open: false, folder: null, isLocal: false });
    // Open the sync destination dialog for this folder
    setSyncDialog({ open: true, folder });
    setSyncLocalPath("");
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
      // Refresh immediately and again after a delay to allow the
      // server's user_summary to reflect the deleted files.
      refreshFoldersAndStats(2000);

      await checkAndResetIfNoFolders();
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
      <div className="flex flex-col gap-4 w-full">
        <div className="shadow-menu rounded-lg bg-white p-4 w-full">
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
            onBrowseFolder={(folder) => handleBrowseFolder({
              folderName: folder.folderName,
              deviceName: folder.deviceName ?? "This Device",
              lastModified: folder.lastModified ?? 0,
              fileCount: folder.fileCount ?? 0,
              totalBytes: folder.totalBytes ?? 0,
            }, true)}
          />
        </div>

        <div className="shadow-menu rounded-lg bg-white p-4 w-full mb-4">
          <RemoteFoldersSection
            remoteFolders={remoteFolders}
            isLoading={isLoading}
            onSyncFolder={handleSyncRemoteFolder}
            onDeleteFromServer={(folderName) =>
              openDeleteServerDialog(folderName)
            }
            onBrowseFolder={handleBrowseFolder}
          />
        </div>
      </div>

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

      {browseDialog.folder && (
        <RemoteFolderBrowser
          open={browseDialog.open}
          onClose={() => setBrowseDialog({ open: false, folder: null, isLocal: false })}
          folder={browseDialog.folder}
          accountId={polkadotAddress ?? ""}
          onSyncSelected={handleSyncSelectedFromBrowse}
          isLocal={browseDialog.isLocal}
        />
      )}
    </>
  );
}
