"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";
import { AddLocalFolderDialog } from "./AddLocalFolderDialog";
import { removeSyncPath } from "@/app/lib/utils/syncPathUtils";
import {
  deleteRemoteFolder,
  restoreRemoteFolders,
} from "@/app/lib/utils/restoreUtils";
import { DRIVE_STORAGE_STATS_QUERY_KEY } from "@/app/lib/hooks/api/useDriveStorageStats";
import { GET_USER_IPFS_FILES_QUERY_KEY } from "@/app/lib/hooks/use-user-files";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  getHcfsConfig,
  saveHcfsConfig,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import {
  triggerSyncPathRefreshAtom,
  driveStatusesAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { useAtomValue } from "jotai";
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
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);

  // Reconcile each SyncFolder.status with the per-drive atom on every
  // change. The pause/resume buttons in this manager and in sibling
  // surfaces (the tray submenu, DriveContainer's tab menu,
  // DriveOnboarding) all flow through the same Rust events, which
  // land in driveStatusesAtom — this effect makes the local list
  // reflect them without optimistic mutations that would lie when
  // the user pauses from another surface.
  useEffect(() => {
    setSyncFolders((prev) =>
      prev.map((f) => {
        const entry = driveStatuses.get(f.id);
        if (!entry) return f;
        // Widen to `active` vs non-active so the new `error` variant
        // (emitted by auto_init_sync on per-drive init failure) renders
        // as non-syncing. The FE retry ladder in `tryAutoInitSync`
        // flips errored drives back to Active on success.
        const newStatus =
          entry.status.kind === "active" ? "syncing" : "paused";
        return f.status === newStatus ? f : { ...f, status: newStatus };
      })
    );
  }, [driveStatuses]);
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

  /**
   * Trigger a refresh after a folder list change.
   *
   * No need to peek `sync_paths` and toggle a "configured" flag — the
   * `hasConfiguredDrivesAtom` is derived from `driveStatusesAtom`, which
   * Rust keeps in sync via `hcfs_drive_status_changed` /
   * `hcfs_drive_removed` events. When the last drive is removed,
   * `driveStatusesAtom` empties and the derived atom flips to `false`
   * automatically.
   */
  const checkAndResetIfNoFolders = useCallback(() => {
    appStore.set(triggerSyncPathRefreshAtom, (prev) => prev + 1);
  }, []);

  // ── Data loading ──────────────────────────────────────────────────────

  const loadFolders = useCallback(async () => {
    if (!polkadotAddress) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      // Single Rust call: fetches local paths + remote folders, joins data,
      // determines status, filters, and sorts. No business logic in TypeScript.
      const result = await invoke<{
        local: Array<{
          id: string;
          folderName: string;
          localPath: string;
          status: string;
          fileCount: number | null;
          totalBytes: number | null;
          lastModified: number | null;
        }>;
        remote: Array<{
          folderName: string;
          deviceName: string;
          fileCount: number;
          totalBytes: number;
          lastModified: number;
        }>;
      }>("get_sync_folders_with_stats", { accountId: polkadotAddress });

      const localFolders: SyncFolder[] = result.local.map((f) => ({
        id: f.id,
        folderName: f.folderName,
        localPath: f.localPath,
        isLocal: true,
        status: f.status as "syncing" | "paused",
        fileCount: f.fileCount ?? undefined,
        totalBytes: f.totalBytes ?? undefined,
        lastModified: f.lastModified ?? undefined,
      }));

      const remoteFoldersData: RemoteFolder[] = result.remote.map((f) => ({
        folderName: f.folderName,
        deviceName: f.deviceName,
        fileCount: f.fileCount,
        totalBytes: f.totalBytes,
        lastModified: f.lastModified,
      }));

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
        queryKey: [DRIVE_STORAGE_STATS_QUERY_KEY],
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

      checkAndResetIfNoFolders();
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
      // Status flips via the driveStatusesAtom reconciliation effect.
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

      // Per-drive Active status is emitted by Rust via the
      // hcfs_drive_status_changed event — see useDriveStatuses.
      // hasConfiguredDrivesAtom recomputes from that automatically.

      toast.success(`Sync resumed for "${folder.folderName}"`);
      // Status flips via the driveStatusesAtom reconciliation effect.
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

      // Per-drive Active status is emitted by Rust via the
      // hcfs_drive_status_changed event — see useDriveStatuses.
      // hasConfiguredDrivesAtom recomputes from that automatically.

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
    } catch (err) {
      // A failed config read ≠ "no password set" — don't misroute a transient
      // error to the password setup screen (audit FE-low).
      console.error("Failed to read sync config:", err);
      toast.error("Couldn't check your sync configuration. Please try again.");
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
      } catch (err) {
        // A failed config read ≠ "no password set" (audit FE-low).
        console.error("Failed to read sync config:", err);
        toast.error("Couldn't check your sync configuration. Please try again.");
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
      // delete_remote_folder also stops the drive and removes the sync path if local
      const result = await deleteRemoteFolder(polkadotAddress, label);

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

      {/* Dialogs */}

      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        // Settings doesn't track an "active" folder, so we discard the
        // returned label and run the standard refresh — the drive page
        // uses the label to navigate to the new folder via its breadcrumb.
        onSuccess={() => refreshFoldersAndStats()}
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
