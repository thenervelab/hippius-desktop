"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRefreshWhileSyncing } from "@/app/lib/hooks/useRefreshWhileSyncing";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { SyncFolder, RemoteFolder } from "@/app/lib/types/sync-folder";
import { AddLocalFolderDialog } from "@/components/page-sections/settings/AddLocalFolderDialog";
import { removeSyncPath } from "@/app/lib/utils/syncPathUtils";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import {
  isSharedDrivesUnavailable,
  leaveSharedDrive,
} from "@/app/lib/tauri/sharedDrives";
import type { RemoveFolderMode } from "@/components/page-sections/settings/multi-folder-sync/RemoveFolderDialog";
import { deleteFolderErrorToast } from "@/app/lib/utils/deleteFolderError";
import {
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
import {
  LocalFoldersSection,
  RemoteFoldersSection,
  SharedWithMeSection,
  RemoveFolderDialog,
  PauseSyncDialog,
  SyncDestinationDialog,
  DeleteServerDialog,
  RemoteFolderBrowser,
  ExclusionsDialog,
} from "@/components/page-sections/settings/multi-folder-sync";
import {
  triggerSyncPathRefreshAtom,
  driveStatusesAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { applyDriveStatusToRow } from "@/app/lib/utils/driveRowStatus";
import { useAtomValue } from "jotai";

interface DriveOnboardingProps {
  // Fired when a folder is added or a remote folder is synced. `newLabel`
  // is the unique label of the newly added/synced folder; the parent uses
  // it to auto-select that folder in the breadcrumb.
  onSyncStarted: (newLabel?: string) => void;
  // When provided, clicking an existing local folder card switches the
  // drive's active folder to that label instead of just showing actions.
  // Used by the Local view inside DriveContainer.
  onSelectFolder?: (label: string) => void;
  // When provided, clicking a REMOTE folder card opens it as a browsable
  // drive in the files view (server-only browsing — no local sync needed).
  onOpenRemoteFolder?: (label: string) => void;
}

const DriveOnboarding: React.FC<DriveOnboardingProps> = ({
  onSyncStarted,
  onSelectFolder,
  onOpenRemoteFolder,
}) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const [syncFolders, setSyncFolders] = useState<SyncFolder[]>([]);

  // Reconcile each SyncFolder.status with the per-drive atom on every
  // change. This makes the per-folder pause/resume buttons reflect
  // pauses initiated from ANY surface (settings, tray submenu,
  // sibling components) instead of only the local handlers below.
  // The previous local-only mutations would silently lie when the
  // user paused from another surface.
  useEffect(() => {
    setSyncFolders((prev) =>
      // Three-state mapping (syncing / paused / error) lives in the shared
      // `applyDriveStatusToRow` resolver — MultiFolderSyncManager uses the
      // same one, so the two surfaces cannot diverge. An errored drive
      // (init failure, revoked shared drive) renders the error treatment
      // in LocalFoldersSection instead of being collapsed into "paused".
      prev.map((f) => applyDriveStatusToRow(driveStatuses.get(f.id), f))
    );
  }, [driveStatuses]);
  const [remoteFolders, setRemoteFolders] = useState<RemoteFolder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  // Remove folder dialog state. `mode: "leave"` is the member-drive
  // variant (shared drives): the confirm routes through
  // `leave_shared_drive` instead of the plain local remove.
  const [removeDialog, setRemoveDialog] = useState<{
    open: boolean;
    folderId: string | null;
    folderName: string | null;
    mode: RemoveFolderMode;
  }>({ open: false, folderId: null, folderName: null, mode: "remove" });
  const [isRemoving, setIsRemoving] = useState(false);

  // Pause sync dialog state
  // Drive label whose exclusions are being edited, or null when closed.
  const [exclusionsLabel, setExclusionsLabel] = useState<string | null>(null);
  const [pauseDialog, setPauseDialog] = useState<{
    open: boolean;
    folder: SyncFolder | null;
  }>({ open: false, folder: null });
  const [isPausing, setIsPausing] = useState(false);

  // Sync destination dialog state
  const [syncDialog, setSyncDialog] = useState<{
    open: boolean;
    folder: RemoteFolder | null;
  }>({ open: false, folder: null });
  const [syncLocalPath, setSyncLocalPath] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingAction, setPendingAction] = useState<"sync" | "browse" | null>(null);

  // Browse remote folder dialog state
  const [browseDialog, setBrowseDialog] = useState<{
    open: boolean;
    folder: RemoteFolder | null;
    isLocal: boolean;
  }>({ open: false, folder: null, isLocal: false });
  const [pendingExclusions, setPendingExclusions] = useState<string[]>([]);

  // Delete from server dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    folderName: string;
    folderId: string | null;
  }>({ open: false, folderName: "", folderId: null });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [isDeletingServer, setIsDeletingServer] = useState(false);

  const loadFolders = useCallback(async (opts?: { silent?: boolean }) => {
    if (!polkadotAddress) {
      setIsLoading(false);
      return;
    }

    try {
      // `silent` refreshes (the during-sync poll) must NOT toggle isLoading or
      // the folder list flashes its skeleton on every poll.
      if (!opts?.silent) setIsLoading(true);

      // Single Rust call: fetches local + remote folders, joins data, determines status
      const result = await invoke<{
        local: Array<{
          id: string;
          folderName: string;
          localPath: string;
          status: string;
          fileCount: number | null;
          totalBytes: number | null;
          lastModified: number | null;
          ownerSs58: string | null;
        }>;
        remote: Array<{
          folderName: string;
          deviceName: string;
          fileCount: number;
          totalBytes: number;
          lastModified: number;
          origin: { kind: "locallyRemoved" } | { kind: "otherDevice" };
        }>;
      }>("get_sync_folders_with_stats", { accountId: polkadotAddress });

      // Keep all three stat fields the Rust IPC returns
      // (`get_sync_folders_with_stats` already populates them). The
      // shared `LocalFoldersSection` renders them inline next to the
      // status pill, so dropping them here was the difference between
      // the Files-page card showing "default · Syncing" and the
      // Settings-page card showing "default · Syncing · 229.8 MB ·
      // 351 files · May 26, 2026 at 5:50 pm".
      const localFolders: SyncFolder[] = result.local.map((f) => ({
        id: f.id,
        folderName: f.folderName,
        localPath: f.localPath,
        isLocal: true,
        status: f.status as "syncing" | "paused",
        fileCount: f.fileCount ?? undefined,
        totalBytes: f.totalBytes ?? undefined,
        lastModified: f.lastModified ?? undefined,
        ownerSs58: f.ownerSs58 ?? undefined,
      }));

      const remoteFoldersData: RemoteFolder[] = result.remote.map((f) => ({
        folderName: f.folderName,
        deviceName: f.deviceName,
        fileCount: f.fileCount,
        totalBytes: f.totalBytes,
        lastModified: f.lastModified,
        origin: f.origin,
      }));

      setSyncFolders(localFolders);
      setRemoteFolders(remoteFoldersData);
    } catch (error) {
      console.error("Failed to load folders:", error);
    } finally {
      if (!opts?.silent) setIsLoading(false);
    }
  }, [polkadotAddress]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // Keep each folder's size + file count climbing as the sync uploads (the
  // server-side totals grow per committed file). Silent so the list updates in
  // place. See useRefreshWhileSyncing.
  useRefreshWhileSyncing(
    useCallback(() => {
      void loadFolders({ silent: true });
    }, [loadFolders]),
    !!polkadotAddress,
  );

  // Refresh when sync path state changes (e.g., Settings dialog closed)
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) {
      loadFolders();
    }
  }, [syncPathRefreshTrigger, loadFolders]);

  // After a successful add, refresh folders + signal parent. Forwarding
  // the new label lets DriveContainer auto-select the freshly added
  // folder in its breadcrumb.
  const handleAddSuccess = useCallback(
    (newLabel?: string) => {
      loadFolders();
      onSyncStarted(newLabel);
    },
    [loadFolders, onSyncStarted],
  );

  // ── Local folder actions ──────────────────────────────────────────────

  const handleRemoveFolder = async () => {
    const { folderId, mode } = removeDialog;
    if (!folderId || !polkadotAddress) return;

    setIsRemoving(true);
    try {
      if (mode === "leave") {
        // Member drive: leave_shared_drive ends the server membership and
        // removes the local drive. Feature-off server → the documented
        // escape hatch: the plain local remove, so the drive doesn't
        // strand un-removable.
        try {
          await leaveSharedDrive(folderId);
          toast.success("Left shared drive");
        } catch (error) {
          if (!isSharedDrivesUnavailable(error)) throw error;
          await removeSyncPath(polkadotAddress, folderId);
          toast.success("Folder removed from sync on this device");
        }
      } else {
        await removeSyncPath(polkadotAddress, folderId);
        toast.success("Folder removed from sync");
      }
      loadFolders();
    } catch (error) {
      console.error("Failed to remove folder:", error);
      toast.error(
        mode === "leave"
          ? `Failed to leave shared drive: ${errorMessage(error)}`
          : "Failed to remove folder",
      );
    } finally {
      setIsRemoving(false);
      setRemoveDialog({ open: false, folderId: null, folderName: null, mode: "remove" });
    }
  };

  const handlePauseSync = async () => {
    const folder = pauseDialog.folder;
    if (!folder || !polkadotAddress) return;

    setIsPausing(true);
    try {
      await invoke("pause_drive", { label: folder.id });
      toast.success(`Sync paused for "${folder.folderName}"`);
      // The per-drive Paused status from Rust lands in
      // driveStatusesAtom and the reconciliation effect above
      // flips this folder's status — no manual mutation needed.
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
      // `resume_drive`, not `initialize_sync`: resume must clear the
      // persisted `is_paused` flag (and emit the right Error status on
      // failure). Plain `initialize_sync` started the drive but left the
      // DB row paused, so the next auto_init pass re-paused the folder.
      // Same IPC the settings page and tray submenu use.
      await invoke("resume_drive", { label: folder.id, mnemonic });

      // Per-drive Active status is emitted by Rust via the
      // hcfs_drive_status_changed event — see useDriveStatuses.
      // hasConfiguredDrivesAtom recomputes from that automatically.

      toast.success(`Sync resumed for "${folder.folderName}"`);
      // Per-drive Active status from Rust lands in driveStatusesAtom
      // and the reconciliation effect flips this folder's status.
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

  const handleBrowseFolder = async (folder: RemoteFolder, isLocal = false) => {
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

      // Files unticked in the browse dialog are paths, not globs: the
      // selection IPC escapes each one so a bracket in a name cannot change
      // which file the rule matches.
      if (pendingExclusions.length > 0) {
        await invoke("apply_sync_selection", {
          label: folder.folderName,
          include: [],
          exclude: pendingExclusions,
        }).catch((err: unknown) =>
          console.warn("Failed to apply browse exclusions:", err)
        );
        setPendingExclusions([]);
      }

      toast.success(`Started syncing ${folder.folderName}`);
      setSyncDialog({ open: false, folder: null });
      setSyncLocalPath("");
      loadFolders();
      // Remote folders use folderName as their label on this device.
      onSyncStarted(folder.folderName);
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
      // A failed config read ≠ "no password set" (audit FE-low).
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

  // ── Delete from server ────────────────────────────────────────────────

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
      loadFolders();
    } catch (error) {
      console.error("Failed to delete folder:", errorMessage(error));
      toast.error(deleteFolderErrorToast(error));
      // Refetch so a folder the server actually deleted (despite a client-side
      // error) drops off the list instead of lingering as "failed" (F-2).
      loadFolders();
    } finally {
      setIsDeletingServer(false);
    }
  };

  return (
    <>
      {/* `px-3` mirrors the 12px gutter the drive page applies to the
          files view (see DriveContainer), so the Local cards line up
          with the files table when switching between the breadcrumb's
          "Local" and folder views. Settings reuses LocalFoldersSection /
          RemoteFoldersSection directly without this wrapper, so its
          gutter is unaffected. */}
      <div className="w-full flex flex-col gap-3 px-3">
        {/* ──────── Local Sync Folders (shared component) ──────── */}
        <LocalFoldersSection
          syncFolders={syncFolders}
          isLoading={isLoading}
          onAddFolder={() => setShowAddDialog(true)}
          onPauseFolder={(folder) => setPauseDialog({ open: true, folder })}
          onResumeFolder={handleResumeSync}
          onManageExclusions={(folder) => setExclusionsLabel(folder.id)}
          onRemoveFolder={(folder) =>
            setRemoveDialog({
              open: true,
              folderId: folder.id,
              folderName: folder.folderName,
              mode: "remove",
            })
          }
          onLeaveDrive={(folder) =>
            setRemoveDialog({
              open: true,
              folderId: folder.id,
              folderName: folder.folderName,
              mode: "leave",
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
          onSelectFolder={
            onSelectFolder
              ? (folder) => onSelectFolder(folder.id)
              : undefined
          }
        />

        {/* ──────── Sync from Other Devices (shared component) ──────── */}
        <RemoteFoldersSection
          remoteFolders={remoteFolders}
          isLoading={isLoading}
          onSyncFolder={handleSyncRemoteFolder}
          onDeleteFromServer={(folderName) =>
            openDeleteServerDialog(folderName)
          }
          onBrowseFolder={handleBrowseFolder}
          onOpenFolder={
            onOpenRemoteFolder
              ? (folder) => onOpenRemoteFolder(folder.folderName)
              : undefined
          }
        />

        {/* Flag-gated; renders nothing unless drives are shared with this
            account. onDriveAdded routes the new label to the breadcrumb
            exactly like a freshly added local folder. */}
        <SharedWithMeSection
          onDriveAdded={(label) => {
            loadFolders();
            onSyncStarted(label);
          }}
        />

      </div>

      {/* ──────── Dialogs ──────── */}
      <AddLocalFolderDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSuccess={handleAddSuccess}
      />

      <RemoveFolderDialog
        open={removeDialog.open}
        folderName={removeDialog.folderName}
        isRemoving={isRemoving}
        mode={removeDialog.mode}
        onClose={() =>
          setRemoveDialog({ open: false, folderId: null, folderName: null, mode: "remove" })
        }
        onConfirm={handleRemoveFolder}
      />

      <ExclusionsDialog
        open={exclusionsLabel !== null}
        label={exclusionsLabel ?? undefined}
        onClose={() => setExclusionsLabel(null)}
      />

      <PauseSyncDialog
        open={pauseDialog.open}
        folderName={pauseDialog.folder?.folderName}
        isPausing={isPausing}
        onClose={() => setPauseDialog({ open: false, folder: null })}
        onConfirm={handlePauseSync}
      />

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => {
          setShowHcfsSetup(false);
          setPendingAction(null);
        }}
        onComplete={handleHcfsSetupComplete}
      />

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
};

export default DriveOnboarding;
