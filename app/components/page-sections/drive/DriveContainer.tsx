"use client";

import React, {
  FC,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import useUserFiles from "@/app/lib/hooks/use-user-files";
import useRecentFiles from "@/lib/hooks/use-recent-files";
import { WaitAMoment } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import DriveOnboarding from "./DriveOnboarding";
import { getPrivateSyncPath, removeSyncPath } from "@/lib/utils/syncPathUtils";
import { deleteRemoteFolder } from "@/app/lib/utils/restoreUtils";
import SyncFolderTabs from "./SyncFolderTabs";
import { useRemoteStorageStats } from "@/app/lib/hooks/api/useRemoteStorageStats";
import useFilesCount from "@/app/lib/hooks/api/useFilesCount";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  generateActiveFilters,
  ActiveFilter,
} from "@/lib/utils/fileFilterUtils";
import { useFilteredFiles } from "@/app/lib/hooks/useFilteredFiles";
import DriveHeader from "./DriveHeader";
import DriveContent from "./DriveContent";
import { useAtomValue, useSetAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import {
  getViewModePreference,
  saveViewModePreference,
} from "@/lib/utils/userPreferencesDb";
import { useInfiniteScroll } from "@/lib/hooks/use-infinite-scroll";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  triggerSyncPathRefreshAtom,
  hasConfiguredDrivesAtom,
  driveStatusesAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import {
  SyncPausedAlert,
  IS_SYNC_PAUSED,
} from "@/components/ui/SyncPausedAlert";
import { SyncConnectivityAlert } from "@/components/ui/SyncConnectivityAlert";
import { HcfsSetupDialog } from "../settings/HcfsSetupDialog";
import { MnemonicBackupDialog } from "../settings/MnemonicBackupDialog";
import {
  PauseSyncDialog,
  RemoveFolderDialog,
  DeleteServerDialog,
  RemoteFolderBrowser,
} from "../settings/multi-folder-sync";
import { useHcfsSync } from "@/app/lib/hooks/useHcfsSync";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/app/lib/utils";

const DriveContainer: FC<{ isRecentFiles?: boolean }> = ({
  isRecentFiles = false,
}) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();

  // Indexer-based stats (same source as Home page for consistency)
  const { data: remoteStorageStats } = useRemoteStorageStats();
  const { data: remoteFileCount } = useFilesCount();

  // Regular files hook
  const {
    data: regularFilesData,
    isLoading: isRegularFilesLoading,
    refetch: refetchUserFiles,
    isRefetching,
    isFetching: isRegularFilesFetching,
    error,
  } = useUserFiles();

  // Recent files hook
  const {
    data: recentFilesData,
    isLoading: isRecentFilesLoading,
    isFetching: isRecentFilesFetching,
    refetch: refetchRecentFiles,
  } = useRecentFiles();

  // Set loading and fetching based on current view
  const isLoading = isRecentFiles
    ? isRecentFilesLoading
    : isRegularFilesLoading;
  const isFetching = isRecentFiles
    ? isRecentFilesFetching
    : isRegularFilesFetching;
  const addButtonRef = useRef<{
    openWithFiles(files: FileList): Promise<void>;
    openWithPaths(paths: string[]): Promise<void>;
    isDialogOpen(): boolean;
  }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");

  // Folder upload dialog state (lifted from DriveHeader so context menus can trigger it)
  const [isFolderUploadOpen, setIsFolderUploadOpen] = useState(false);

  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState(
    undefined as string | null | undefined,
  );

  // Loading states for sync paths
  const [isLoadingPrivatePath, setIsLoadingPrivatePath] = useState(true);

  // Folder tab state (null = "All")
  const [selectedFolderTab, setSelectedFolderTab] = useState<string | null>(
    null,
  );

  // Search state
  const [searchTerm, setSearchTerm] = useState<string>("");

  // Filter states - using a single atomic state to prevent race conditions
  const [filterState, setFilterState] = useState({
    fileTypes: [] as FileTypes[],
    date: "",
    fileSize: 0,
    fileSizes: [] as number[],
    lastUpdated: Date.now(),
  });

  // Active filters state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // State to track if sync folder is configured
  const [isSyncPathConfigured, setIsSyncPathConfigured] = useState<
    boolean | null
  >(null);
  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);
  const [showPrivateStartSyncingSelector, setShowPrivateStartSyncingSelector] =
    useState(false);

  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);
  const isSyncConfigured = useAtomValue(hasConfiguredDrivesAtom);

  // Per-drive sync status is owned by Rust and pushed via the
  // `useDriveStatuses` hook mounted in `SyncEventLogger`. The previous
  // global engine-status atom and its mount-time race are gone.

  // HCFS sync integration
  const {
    setupAndInitialize,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  // Tab context menu dialog states
  const [pauseDialog, setPauseDialog] = useState<{
    open: boolean;
    label: string | null;
  }>({ open: false, label: null });
  const [isPausing, setIsPausing] = useState(false);

  const [removeDialog, setRemoveDialog] = useState<{
    open: boolean;
    label: string | null;
  }>({ open: false, label: null });
  const [isRemoving, setIsRemoving] = useState(false);

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    folderName: string;
    label: string | null;
  }>({ open: false, folderName: "", label: null });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [isDeletingServer, setIsDeletingServer] = useState(false);

  // Browse contents dialog state
  const [browseDialog, setBrowseDialog] = useState<{
    open: boolean;
    label: string | null;
  }>({ open: false, label: null });

  // Sync folder labels from the query data
  const syncFolderLabels = useMemo(() => {
    if (regularFilesData && "syncFolderLabels" in regularFilesData) {
      return (
        (regularFilesData as { syncFolderLabels?: string[] })
          .syncFolderLabels ?? []
      );
    }
    return [];
  }, [regularFilesData]);

  // Paused labels and label → display name are derived from
  // driveStatusesAtom (the per-drive source of truth, mirrored from
  // Rust by useDriveStatuses). The previous local state + manual
  // get_all_sync_paths fetch was a stale mirror that lied whenever
  // the user paused / resumed from another surface (settings,
  // tray submenu, DriveOnboarding). Reading from the atom keeps
  // every per-drive UI in sync without round-trips.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  // `pausedLabels` is "labels not currently active" — includes both
  // `paused` (user intent) and the new `error` variant (emitted on
  // per-drive init failure). Click handlers below treat both as
  // "needs resume", which re-triggers `initialize_sync_inner` in Rust
  // and is the correct retry action for an errored drive.
  const pausedLabels = useMemo(
    () =>
      Array.from(driveStatuses.entries())
        .filter(([, entry]) => entry.status.kind !== "active")
        .map(([label]) => label),
    [driveStatuses],
  );
  const labelDisplayNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const [label, entry] of driveStatuses.entries()) {
      names[label] = entry.folderName;
    }
    return names;
  }, [driveStatuses]);

  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      return recentFilesData || [];
    } else if (regularFilesData?.files) {
      return regularFilesData.files.filter((file) => !file.deleted);
    }
    return [];
  }, [isRecentFiles, recentFilesData, regularFilesData?.files]);

  // Prune the list down to the private-files universe the files page
  // displays. The folder-tab cut is delegated to Rust's filter along with
  // every other filter — keeping the type cut here keeps recents vs.
  // private as a TS-owned concern (it's part of *which view* the user
  // picked, not a filter the chip UI exposes).
  const allFilteredData = useMemo(() => {
    if (isRecentFiles) return allData;
    return allData.filter(
      (file) => (file.type?.toLowerCase() || "") === "private",
    );
  }, [allData, isRecentFiles]);

  // Rust owns the filter chain — search, type, date, size, folder tab.
  // `useFilteredFiles` debounces fast typing so we don't IPC per keystroke.
  const filteredData = useFilteredFiles(allFilteredData, {
    searchTerm,
    fileTypes: filterState.fileTypes,
    dateFilter: filterState.date,
    fileSizes: filterState.fileSizes,
    folderTab: isRecentFiles ? null : selectedFolderTab,
  });

  // Infinite scroll state for list and card views
  const { visibleData, hasMore, loadMore, resetScroll } =
    useInfiniteScroll(filteredData);

  // Batch update helper to prevent multiple rapid filter updates
  const updateFilters = useCallback(
    (updates: Partial<typeof filterState>) => {
      setFilterState((prev) => ({
        ...prev,
        ...updates,
        lastUpdated: Date.now(),
      }));
      // Always reset scroll position when filters change
      resetScroll();
    },
    [resetScroll],
  );

  // Update active filters when filter settings change
  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      filterState.fileTypes,
      filterState.date,
      filterState.fileSize,
      filterState.fileSizes,
    );
    setActiveFilters(newActiveFilters);
  }, [
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
  ]);

  // Reset scroll when filters or folder tab change
  useEffect(() => {
    resetScroll();
  }, [
    searchTerm,
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
    selectedFolderTab,
    resetScroll,
  ]);

  // Handle removing a filter
  const handleRemoveFilter = useCallback(
    (filter: ActiveFilter) => {
      const updates: Partial<typeof filterState> = {};
      switch (filter.type) {
        case "fileType":
          updates.fileTypes = filterState.fileTypes.filter(
            (type: FileTypes) => type !== filter.value,
          );
          break;

        case "date":
          updates.date = "";
          break;

        case "fileSize":
          // Remove specific file size from the array
          const sizeValue = parseInt(filter.value);
          updates.fileSizes = filterState.fileSizes.filter(
            (size: number) => size !== sizeValue,
          );
          break;
      }

      updateFilters(updates);
    },
    [filterState.fileTypes, filterState.fileSizes, updateFilters],
  );

  // Header "Total Storage Used":
  //   - per-folder-tab: raw per-drive bytes from the Rust aggregator.
  //     Raw (not CID-deduplicated) is intentional — it matches what the
  //     user sees in the tab's rows. See 2026-04-17-folder-tab-stats-fix.md.
  //   - "All" tab: keep indexer value so it stays consistent with the
  //     Home page / Available Credits numbers.
  const formattedStorageSize = useMemo(() => {
    if (isRecentFiles) return "";

    if (selectedFolderTab) {
      const bytes =
        regularFilesData?.labelStats?.[selectedFolderTab]?.totalBytes ?? 0;
      return formatBytes(bytes, 2);
    }

    if (remoteStorageStats?.totalBytes) {
      return formatBytes(remoteStorageStats.totalBytes, 2);
    }

    return "0 B";
  }, [
    isRecentFiles,
    selectedFolderTab,
    regularFilesData?.labelStats,
    remoteStorageStats,
  ]);

  // Handle search input change
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  // Handle filter changes using atomic state updates
  const handleFileTypesChange = useCallback(
    (types: FileTypes[]) => {
      updateFilters({ fileTypes: types });
    },
    [updateFilters],
  );

  const handleDateChange = useCallback(
    (date: string) => {
      updateFilters({ date });
    },
    [updateFilters],
  );

  const handleFileSizesChange = useCallback(
    (sizes: number[]) => {
      updateFilters({ fileSizes: sizes });
    },
    [updateFilters],
  );

  // Load private sync path (with stale-request cancellation)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const result = await getPrivateSyncPath(polkadotAddress || undefined);
        if (!cancelled) {
          setSelectedPrivateFolderPath(result?.path ?? null);
        }
      } catch (err) {
        console.error("Failed to load private sync folder:", err);
        if (!cancelled) {
          setSelectedPrivateFolderPath(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPrivatePath(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [polkadotAddress]);

  // Reload sync path when sync is configured from another component/page
  // (e.g., user sets up sync on Files page, then navigates to Home)
  useEffect(() => {
    if (!isSyncConfigured || !polkadotAddress) return;
    // Only reload if we don't already have a path (avoids redundant fetches)
    if (selectedPrivateFolderPath) return;

    let cancelled = false;

    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const result = await getPrivateSyncPath(polkadotAddress);
        if (!cancelled) {
          setSelectedPrivateFolderPath(result?.path ?? null);
        }
      } catch {
        // Ignore — initial load will handle errors
      } finally {
        if (!cancelled) {
          setIsLoadingPrivatePath(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSyncConfigured, polkadotAddress]);

  // Check if sync path is configured
  useEffect(() => {
    if (isRecentFiles) {
      setIsCheckingSyncPath(false);
      return;
    }

    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);

        // Wait for private path to finish loading
        if (isLoadingPrivatePath) {
          return; // Don't check yet, still loading
        }

        const syncPath = selectedPrivateFolderPath;

        setIsSyncPathConfigured(syncPath !== null && syncPath !== undefined);
      } catch (error) {
        console.error(`Failed to check private sync path:`, error);
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, [selectedPrivateFolderPath, isRecentFiles, isLoadingPrivatePath]);

  const refreshUserFilesCallback = useCallback(() => {
    refetchUserFiles();
  }, [refetchUserFiles]);

  const refreshRecentFilesCallback = useCallback(() => {
    refetchRecentFiles();
  }, [refetchRecentFiles]);

  // Handle sync started from onboarding (folder added or remote folder synced)
  const handleOnboardingSyncStarted = useCallback(async () => {
    if (!polkadotAddress) return;
    // Reload sync paths so we pick up the newly added folder
    try {
      const result = await getPrivateSyncPath(polkadotAddress);
      setSelectedPrivateFolderPath(result?.path ?? null);
    } catch {
      // Ignore — we still want to mark as configured
    }
    setIsSyncPathConfigured(true);
    setShowPrivateStartSyncingSelector(false);
    triggerSyncPathRefresh((prev) => prev + 1);
    refetchUserFiles();
  }, [polkadotAddress, triggerSyncPathRefresh, refetchUserFiles]);

  const handleHcfsSetupComplete = useCallback(
    async (result: { serverUrl: string; password: string }) => {
      if (!polkadotAddress) return;

      try {
        const mnemonic = (await getMnemonic()) ?? undefined;
        const initResult = await setupAndInitialize(
          polkadotAddress,
          "default",
          result.serverUrl,
          result.password,
          mnemonic ?? undefined,
        );

        setShowHcfsSetup(false);

        if (initResult) {
          toast.success("Sync folder set — syncing started!");
          // Mark sync path as configured and hide selectors so files view shows
          setIsSyncPathConfigured(true);
          setShowPrivateStartSyncingSelector(false);
          // Directly reload path so local state updates immediately
          try {
            const pathResult = await getPrivateSyncPath(polkadotAddress);
            setSelectedPrivateFolderPath(pathResult?.path ?? null);
          } catch {
            // Will be retried by triggerSyncPathRefresh effect
          }
          // Refresh file list to show the synced files
          refetchUserFiles();
          // Signal other components about the change
          triggerSyncPathRefresh((prev) => prev + 1);

          if (initResult.mnemonic) {
            setShowMnemonicBackup(true);
          }
        }
      } catch (err) {
        console.error("Failed to setup HCFS:", err);
        toast.error("Sync setup failed. Please try again.");
      }
    },
    [
      polkadotAddress,
      setupAndInitialize,
      getMnemonic,
      refetchUserFiles,
      triggerSyncPathRefresh,
    ],
  );

  const handleMnemonicBackupConfirm = useCallback(() => {
    setShowMnemonicBackup(false);
    clearMnemonicBackup();
  }, [clearMnemonicBackup]);

  // Navigation to settings
  const handleNavigateToSettings = useCallback(() => {
    setActiveSettingsTab("Sync & Storage");
    setSettingsDialogOpen(true);
  }, [setActiveSettingsTab, setSettingsDialogOpen]);

  // Handle start syncing button click
  const handleStartSyncing = useCallback(() => {
    // If not on /files page, navigate to settings instead
    if (isRecentFiles) {
      handleNavigateToSettings();
      return;
    }

    // If on /files page, show the sync folder selector
    setShowPrivateStartSyncingSelector(true);
  }, [isRecentFiles, handleNavigateToSettings]);

  // Context menu handlers
  const handleContextUploadFile = useCallback(() => {
    addButtonRef.current?.openWithPaths([]);
  }, []);

  const handleContextAddFolder = useCallback(() => {
    setIsFolderUploadOpen(true);
  }, []);

  const handleContextAddSyncFolder = useCallback(() => {
    setActiveSettingsTab("Sync & Storage");
    setSettingsDialogOpen(true);
  }, [setActiveSettingsTab, setSettingsDialogOpen]);

  // Tab context menu handlers (operate on folder label strings).
  //
  // Path resolution + reveal-in-file-manager happens entirely in Rust
  // (`reveal_drive_in_finder`), so the FE never reads the `sync_paths`
  // table or imports the opener plugin just to figure out which on-disk
  // folder backs a label.
  const handleTabOpenInFinder = useCallback(async (label: string) => {
    try {
      await invoke("reveal_drive_in_finder", { label });
    } catch (err) {
      console.error("Failed to open folder:", err);
      toast.error("Failed to open folder");
    }
  }, []);

  // Tab context menu: open dialogs instead of executing directly
  const handleTabRemoveFromSync = useCallback((label: string) => {
    setRemoveDialog({ open: true, label });
  }, []);

  const handleTabDeleteFromServer = useCallback((label: string) => {
    setDeleteDialog({ open: true, folderName: label, label });
  }, []);

  const handleTabBrowseContents = useCallback((label: string) => {
    setBrowseDialog({ open: true, label });
  }, []);

  const handleTabPauseSync = useCallback(
    (label: string) => {
      const isPaused = pausedLabels.includes(label);
      if (isPaused) {
        // Resume directly (no confirmation needed, same as settings)
        (async () => {
          if (!polkadotAddress) return;
          try {
            const mnemonic = (await getMnemonic()) ?? undefined;
            await invoke("resume_drive", { label, mnemonic });
            // Per-drive Active status is emitted by Rust via the
            // hcfs_drive_status_changed event and lands in
            // driveStatusesAtom — pausedLabels is a memo over that
            // atom, so the tab badge updates without any local state.
            // hasConfiguredDrivesAtom recomputes from the same source.
            toast.success(`Sync resumed for "${label}"`);
          } catch (err) {
            console.error("Failed to resume sync:", err);
            toast.error("Failed to resume sync");
          }
        })();
      } else {
        setPauseDialog({ open: true, label });
      }
    },
    [pausedLabels, polkadotAddress, getMnemonic],
  );

  // Dialog confirmation handlers
  const handleConfirmPause = useCallback(async () => {
    const label = pauseDialog.label;
    if (!label || !polkadotAddress) return;
    setIsPausing(true);
    try {
      await invoke("pause_drive", { label });
      toast.success(`Sync paused for "${label}"`);
      // Atom updates via the hcfs_drive_status_changed event from
      // Rust — pausedLabels is a memo over driveStatusesAtom.
    } catch (err) {
      console.error("Failed to pause sync:", err);
      toast.error("Failed to pause sync");
    } finally {
      setIsPausing(false);
      setPauseDialog({ open: false, label: null });
    }
  }, [pauseDialog.label, polkadotAddress]);

  const handleConfirmRemove = useCallback(async () => {
    const label = removeDialog.label;
    if (!label || !polkadotAddress) return;
    setIsRemoving(true);
    try {
      await removeSyncPath(polkadotAddress, label);
      toast.success(`Folder "${label}" removed from sync`);
      triggerSyncPathRefresh((prev) => prev + 1);
      refetchUserFiles();
    } catch (err) {
      console.error("Failed to remove sync path:", err);
      toast.error("Failed to remove folder from sync");
    } finally {
      setIsRemoving(false);
      setRemoveDialog({ open: false, label: null });
    }
  }, [
    removeDialog.label,
    polkadotAddress,
    triggerSyncPathRefresh,
    refetchUserFiles,
  ]);

  const handleConfirmDeleteServer = useCallback(async () => {
    const label = deleteDialog.label;
    if (!label || !polkadotAddress) return;
    setIsDeletingServer(true);
    try {
      // delete_remote_folder also stops the drive and removes the sync path if local
      const result = await deleteRemoteFolder(polkadotAddress, label);
      toast.success(
        `Folder deleted from server (${result.files_deleted} file${result.files_deleted !== 1 ? "s" : ""} removed)`,
      );
      triggerSyncPathRefresh((prev) => prev + 1);
      refetchUserFiles();
    } catch (err) {
      console.error("Failed to delete from server:", err);
      toast.error("Failed to delete folder from server");
    } finally {
      setIsDeletingServer(false);
      setDeleteDialog({ open: false, folderName: "", label: null });
      setDeleteConfirmInput("");
    }
  }, [
    deleteDialog.label,
    polkadotAddress,
    triggerSyncPathRefresh,
    refetchUserFiles,
  ]);

  // Load data on mount and set up interval refresh
  useEffect(() => {
    if (isRecentFiles) {
      return;
    }

    refreshUserFilesCallback();
  }, [refreshUserFilesCallback, isRecentFiles]);

  // Log error for debugging
  useEffect(() => {
    if (error) {
      console.error("Error in useUserFiles:", error);
    }
  }, [error]);

  // Header "Number of Files":
  //   - "All" tab, no search/filters: indexer count (deduplicated).
  //   - Folder tab, no search/filters: Rust-aggregated per-label count
  //     (one entry per leaf file; empty folders contribute 0).
  //   - Search or filter active: count the filtered list. Folder rows
  //     contribute their recursive file_count; empty folders contribute 0.
  //     Safe from double-count because list_sync_folder is single-level —
  //     a folder row's descendants are never in regularFilesData.files.
  const displayedFileCount = useMemo(() => {
    if (searchTerm || activeFilters.length > 0) {
      return filteredData.reduce((count, item) => {
        if (item.isFolder) {
          return count + (item.fileCount ?? 0);
        }
        return count + 1;
      }, 0);
    }

    if (selectedFolderTab) {
      return regularFilesData?.labelStats?.[selectedFolderTab]?.fileCount ?? 0;
    }

    if (remoteFileCount !== undefined) {
      return remoteFileCount;
    }

    return 0;
  }, [
    filteredData,
    searchTerm,
    activeFilters.length,
    selectedFolderTab,
    remoteFileCount,
    regularFilesData?.labelStats,
  ]);

  // Handle file drop events
  useEffect(() => {
    const handleFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.files && addButtonRef.current) {
        console.log(
          "Handling files via global event",
          customEvent.detail.files,
        );
        addButtonRef.current.openWithFiles(customEvent.detail.files);
      }
    };

    window.addEventListener("hippius:file-drop", handleFileDrop);
    return () => {
      window.removeEventListener("hippius:file-drop", handleFileDrop);
    };
  }, []);

  // Load user's view mode preference on component mount
  useEffect(() => {
    async function loadViewModePreference() {
      const savedViewMode = await getViewModePreference();
      setViewMode(savedViewMode);
    }
    loadViewModePreference();
  }, []);

  // Update view mode and save preference
  const handleViewModeChange = useCallback((mode: "list" | "card") => {
    setViewMode(mode);
    saveViewModePreference(mode);
  }, []);

  // Reload sync paths when settings are updated
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) {
      let cancelled = false;

      // Reload private sync path
      (async () => {
        try {
          setIsLoadingPrivatePath(true);
          const result = await getPrivateSyncPath(polkadotAddress || undefined);
          if (!cancelled) {
            setSelectedPrivateFolderPath(result?.path ?? null);
            // Refetch file list so it reads from the new sync folder
            refetchUserFiles();
          }
        } catch (err) {
          console.error("Failed to reload private sync folder:", err);
        } finally {
          if (!cancelled) {
            setIsLoadingPrivatePath(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }
  }, [syncPathRefreshTrigger, polkadotAddress, refetchUserFiles]);

  // Computed values for current view (always private)
  const currentSyncPath = selectedPrivateFolderPath;
  const isCurrentSyncPathEmpty = !currentSyncPath;
  const showCurrentStartSyncingSelector = showPrivateStartSyncingSelector;

  // Recent files specific logic - check if private path is available.
  // While path is still loading, treat as "has paths" to avoid flashing
  // the Start Syncing button before the async load completes.
  const hasNoSyncPaths = useMemo(() => {
    if (!isRecentFiles) return false;
    if (isLoadingPrivatePath) return false;
    return (
      selectedPrivateFolderPath === null ||
      selectedPrivateFolderPath === undefined
    );
  }, [isRecentFiles, selectedPrivateFolderPath, isLoadingPrivatePath]);

  // For recent files, check if sync path is available (not empty).
  // While loading, optimistically assume path exists to prevent button flash.
  const hasAnySyncPath = useMemo(() => {
    if (!isRecentFiles) return false;
    if (isLoadingPrivatePath) return true;
    const hasPrivate =
      selectedPrivateFolderPath !== null &&
      selectedPrivateFolderPath !== undefined &&
      selectedPrivateFolderPath !== "";
    return hasPrivate;
  }, [isRecentFiles, selectedPrivateFolderPath, isLoadingPrivatePath]);

  // Determine what content to render
  let content;

  // Show loading while checking sync path or while loading sync paths
  const shouldShowLoading = isCheckingSyncPath || isLoadingPrivatePath;

  if (shouldShowLoading) {
    content = <WaitAMoment />;
  } else if (error && !isRecentFiles) {
    // `useUserFiles` exposes a terminal error (after TanStack Query's
    // retry budget is exhausted or the 15 s wall-clock cap in the
    // query fires). Without an explicit branch here the page stayed
    // blank with only the reauth banner at the top, which the user
    // reported as "loads indefinitely without displaying any content".
    content = (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <Typography.P size="md" className="font-medium text-error-60 mb-2">
          Couldn&apos;t load your files right now.
        </Typography.P>
        <Typography.P size="sm" className="text-grey-50 max-w-md">
          {error instanceof Error ? error.message : String(error)}
        </Typography.P>
        <button
          type="button"
          className="mt-6 text-sm font-medium text-primary-50 hover:text-primary-40"
          onClick={() => refetchUserFiles()}
        >
          Try again
        </button>
      </div>
    );
  } else if (isSyncPathConfigured === false && !isRecentFiles) {
    content = <DriveOnboarding onSyncStarted={handleOnboardingSyncStarted} />;
  } else if (showCurrentStartSyncingSelector && !isRecentFiles) {
    // Show onboarding when Start Syncing is clicked
    content = <DriveOnboarding onSyncStarted={handleOnboardingSyncStarted} />;
  } else {
    // Compute whether sync path is effectively empty
    let effectiveSyncPathEmpty = false;

    if (isRecentFiles) {
      effectiveSyncPathEmpty = !hasAnySyncPath;
    } else {
      effectiveSyncPathEmpty = isCurrentSyncPathEmpty;
    }

    // Get file count for view all button
    const privateFileCount =
      regularFilesData?.files.filter((f) => f.type?.toLowerCase() === "private")
        .length || 0;

    content = (
      <FileSelectionProvider>
        <div className={cn("w-full relative", !isRecentFiles && "px-3")}>
          {/* Sync Paused Alert */}
          {IS_SYNC_PAUSED && !isRecentFiles && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          {/* Sync connectivity alert. `SyncReauthRequiredAlert` is
              mounted globally in `ResponsiveContent` so it's visible
              on every authenticated route (not just /files). */}
          <div className="mb-4 space-y-2">
            <SyncConnectivityAlert
              variant={isRecentFiles ? "compact" : "banner"}
            />
          </div>

          <DriveHeader
            isRecentFiles={isRecentFiles}
            isRefetching={isRefetching}
            isFetching={isFetching}
            formattedStorageSize={formattedStorageSize}
            allFilteredDataLength={displayedFileCount}
            viewMode={viewMode}
            setViewMode={handleViewModeChange}
            searchTerm={searchTerm}
            handleSearchChange={handleSearchChange}
            activeFilters={activeFilters}
            handleRemoveFilter={handleRemoveFilter}
            refetchUserFiles={
              isRecentFiles
                ? refreshRecentFilesCallback
                : refreshUserFilesCallback
            }
            addButtonRef={addButtonRef}
            privateFileCount={privateFileCount}
            isSyncPathEmpty={effectiveSyncPathEmpty}
            onStartSyncing={handleStartSyncing}
            hasNoSyncPaths={hasNoSyncPaths}
            onNavigateToSettings={handleNavigateToSettings}
            selectedFileTypes={filterState.fileTypes}
            selectedDate={filterState.date}
            selectedFileSizes={filterState.fileSizes}
            onFileTypesChange={handleFileTypesChange}
            onDateChange={handleDateChange}
            onFileSizesChange={handleFileSizesChange}
            defaultFolderLabel={selectedFolderTab}
            isFolderUploadOpen={isFolderUploadOpen}
            onSetFolderUploadOpen={setIsFolderUploadOpen}
          />

          {!isRecentFiles && (
            <SyncFolderTabs
              labels={syncFolderLabels}
              displayNames={labelDisplayNames}
              selectedTab={selectedFolderTab}
              onTabChange={setSelectedFolderTab}
              onBrowseContents={handleTabBrowseContents}
              onPauseSync={handleTabPauseSync}
              onOpenInFinder={handleTabOpenInFinder}
              onRemoveFromSync={handleTabRemoveFromSync}
              onDeleteFromServer={handleTabDeleteFromServer}
              pausedLabels={pausedLabels}
            />
          )}

          <DriveContent
            isRecentFiles={isRecentFiles}
            isLoading={isLoading}
            filteredData={filteredData}
            displayedData={visibleData}
            searchTerm={searchTerm}
            activeFilters={activeFilters}
            viewMode={viewMode}
            error={error}
            addButtonRef={addButtonRef}
            hasMore={hasMore}
            loadMore={loadMore}
            isSyncPathEmpty={effectiveSyncPathEmpty}
            onSyncPathConfigured={
              isRecentFiles ? handleNavigateToSettings : handleStartSyncing
            }
            onUploadFile={handleContextUploadFile}
            onAddFolder={handleContextAddFolder}
            onAddSyncFolder={handleContextAddSyncFolder}
          />
        </div>
      </FileSelectionProvider>
    );
  }

  return (
    <>
      {content}

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isInitializing}
      />

      <MnemonicBackupDialog
        open={showMnemonicBackup}
        mnemonic={mnemonicToBackup || ""}
        onConfirm={handleMnemonicBackupConfirm}
        onClose={handleMnemonicBackupConfirm}
      />

      <PauseSyncDialog
        open={pauseDialog.open}
        folderName={pauseDialog.label ?? undefined}
        isPausing={isPausing}
        onClose={() => setPauseDialog({ open: false, label: null })}
        onConfirm={handleConfirmPause}
      />

      <RemoveFolderDialog
        open={removeDialog.open}
        folderName={removeDialog.label}
        isRemoving={isRemoving}
        onClose={() => setRemoveDialog({ open: false, label: null })}
        onConfirm={handleConfirmRemove}
      />

      <DeleteServerDialog
        open={deleteDialog.open}
        folderName={deleteDialog.folderName}
        confirmInput={deleteConfirmInput}
        isDeletingServer={isDeletingServer}
        onConfirmInputChange={setDeleteConfirmInput}
        onClose={() => {
          setDeleteDialog({ open: false, folderName: "", label: null });
          setDeleteConfirmInput("");
        }}
        onConfirm={handleConfirmDeleteServer}
      />

      {browseDialog.label && (
        <RemoteFolderBrowser
          open={browseDialog.open}
          onClose={() => setBrowseDialog({ open: false, label: null })}
          folder={{
            folderName: browseDialog.label,
            deviceName: "This Device",
            lastModified: 0,
            fileCount: 0,
            totalBytes: 0,
          }}
          accountId={polkadotAddress ?? ""}
          onSyncSelected={() => setBrowseDialog({ open: false, label: null })}
          isLocal
        />
      )}
    </>
  );
};

export default DriveContainer;
