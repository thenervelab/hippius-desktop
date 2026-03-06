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
import SyncFolderSelector from "./SyncFolderSelector";
import {
  getPrivateSyncPath,
  setPrivateSyncPath,
} from "@/lib/utils/syncPathUtils";
import { formatBytesFromBigInt } from "@/lib/utils";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  filterFiles,
  generateActiveFilters,
  ActiveFilter,
} from "@/lib/utils/fileFilterUtils";
import FilesHeader from "./FilesHeader";
import FilesContent from "./FilesContent";
import { useAtomValue, useSetAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import {
  getViewModePreference,
  saveViewModePreference,
} from "@/lib/utils/userPreferencesDb";
import { usePagination } from "@/lib/hooks";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  triggerSyncPathRefreshAtom,
  syncEngineStatusAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";
import { SyncStoppedAlert } from "@/components/ui/SyncStoppedAlert";
import { HcfsSetupDialog } from "../settings/HcfsSetupDialog";
import { MnemonicBackupDialog } from "../settings/MnemonicBackupDialog";
import { useHcfsSync } from "@/app/lib/hooks/useHcfsSync";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

const FilesContainer: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();

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

  const addButtonRef = useRef<{ openWithFiles(files: FileList): void; openWithPaths(paths: string[]): void; isDialogOpen(): boolean }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [shouldResetPagination, setShouldResetPagination] = useState(false);
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState(
    undefined as string | null | undefined
  );

  // Loading states for sync paths
  const [isLoadingPrivatePath, setIsLoadingPrivatePath] = useState(true);

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
  const syncEngineStatus = useAtomValue(syncEngineStatusAtom);
  const setSyncEngineStatus = useSetAtom(syncEngineStatusAtom);

  // Ref to track current status without creating effect dependencies
  const syncStatusRef = useRef(syncEngineStatus);
  useEffect(() => {
    syncStatusRef.current = syncEngineStatus;
  }, [syncEngineStatus]);

  // Check if sync engine is active on mount and when sync path refreshes.
  // Does NOT depend on syncEngineStatus to avoid re-running on every status change.
  useEffect(() => {
    // Skip check if user is in the process of stopping or has stopped sync
    if (syncStatusRef.current === "stopping" || syncStatusRef.current === "stopped") return;

    (async () => {
      try {
        const active = await invoke<boolean>("is_drive_active");
        // Re-check after async gap — user may have clicked stop while await was pending
        if (syncStatusRef.current === "stopping" || syncStatusRef.current === "stopped") return;
        setSyncEngineStatus(active ? "active" : "stopped");
      } catch {
        // If we can't check, leave status as-is
      }
    })();
  }, [setSyncEngineStatus, syncPathRefreshTrigger]);

  // While stopping, keep checking until the drive is actually dropped
  useEffect(() => {
    if (syncEngineStatus !== "stopping") return;

    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const active = await invoke<boolean>("is_drive_active");
          if (!active && !cancelled) {
            setSyncEngineStatus("stopped");
            break;
          }
        } catch {
          // Ignore transient failures and keep polling
        }
      }
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [syncEngineStatus, setSyncEngineStatus]);

  // HCFS sync integration
  const {
    setupAndInitialize,
    tryInitializeSync,
    checkConfig,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      return recentFilesData || [];
    } else if (regularFilesData?.files) {
      return regularFilesData.files.filter((file) => !file.deleted);
    }
    return [];
  }, [isRecentFiles, recentFilesData, regularFilesData?.files]);

  // Filter data to show only private files
  const allFilteredData = useMemo(() => {
    if (isRecentFiles) {
      return allData;
    }

    return allData.filter((file) => {
      const fileType = file.type?.toLowerCase() || "";
      return fileType === "private";
    });
  }, [allData, isRecentFiles]);

  // Filter data based on search and filter settings
  const filteredData = useMemo(() => {
    return filterFiles(allFilteredData, {
      searchTerm,
      fileTypes: filterState.fileTypes,
      dateFilter: filterState.date,
      fileSize: filterState.fileSize,
      fileSizes: filterState.fileSizes,
    });
  }, [
    allFilteredData,
    searchTerm,
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
  ]);

  // Shared pagination state between list and card views
  const { paginatedData, setCurrentPage, currentPage, totalPages } =
    usePagination(filteredData, 12);

  // Batch update helper to prevent multiple rapid filter updates
  const updateFilters = useCallback(
    (updates: Partial<typeof filterState>) => {
      setFilterState((prev) => ({
        ...prev,
        ...updates,
        lastUpdated: Date.now(),
      }));
      // Always reset pagination when filters change
      setCurrentPage(1);
      setShouldResetPagination(true);
    },
    [setCurrentPage]
  );

  // Update active filters when filter settings change
  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      filterState.fileTypes,
      filterState.date,
      filterState.fileSize,
      filterState.fileSizes
    );
    setActiveFilters(newActiveFilters);
  }, [
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
  ]);

  // Reset pagination when filters change
  useEffect(() => {
    setShouldResetPagination(true);
  }, [
    searchTerm,
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
  ]);

  // Reset pagination when data changes
  useEffect(() => {
    // Force reset pagination
    setShouldResetPagination(true);
    setCurrentPage(1);
  }, [setCurrentPage]);

  // Handle pagination reset
  useEffect(() => {
    if (shouldResetPagination) {
      setCurrentPage(1);
    }
  }, [shouldResetPagination, setCurrentPage]);

  const handlePaginationReset = useCallback(() => {
    setShouldResetPagination(false);
  }, []);

  // Handle removing a filter
  const handleRemoveFilter = useCallback(
    (filter: ActiveFilter) => {
      const updates: Partial<typeof filterState> = {};
      switch (filter.type) {
        case "fileType":
          updates.fileTypes = filterState.fileTypes.filter(
            (type: FileTypes) => type !== filter.value
          );
          break;

        case "date":
          updates.date = "";
          break;

        case "fileSize":
          // Remove specific file size from the array
          const sizeValue = parseInt(filter.value);
          updates.fileSizes = filterState.fileSizes.filter(
            (size: number) => size !== sizeValue
          );
          break;
      }

      updateFilters(updates);
    },
    [filterState.fileTypes, filterState.fileSizes, updateFilters]
  );

  // Format private storage size
  const formattedStorageSize = useMemo(() => {
    if (isRecentFiles) return "";

    if (!regularFilesData) return "0 B";

    if (regularFilesData.privateStorageSize !== undefined) {
      return formatBytesFromBigInt(regularFilesData.privateStorageSize);
    }
    return "0 B";
  }, [regularFilesData, isRecentFiles]);

  // Handle search input change
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  // Handle filter changes using atomic state updates
  const handleFileTypesChange = useCallback(
    (types: FileTypes[]) => {
      updateFilters({ fileTypes: types });
    },
    [updateFilters]
  );

  const handleDateChange = useCallback(
    (date: string) => {
      updateFilters({ date });
    },
    [updateFilters]
  );

  const handleFileSizesChange = useCallback(
    (sizes: number[]) => {
      updateFilters({ fileSizes: sizes });
    },
    [updateFilters]
  );

  // Load private sync path
  useEffect(() => {
    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const privatefolderPath = (await getPrivateSyncPath(
          polkadotAddress || undefined
        )).path;
        setSelectedPrivateFolderPath(privatefolderPath);
      } catch {
        console.error("Failed to load private sync folder");
      } finally {
        setIsLoadingPrivatePath(false);
      }
    })();
  }, [polkadotAddress]);

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

        // Sync path is configured if it exists (even if empty string - means user skipped)
        // Only show selector if sync path is null/undefined (not set at all)
        setIsSyncPathConfigured(syncPath !== null && syncPath !== undefined);
      } catch (error) {
        console.error(
          `Failed to check private sync path:`,
          error
        );
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, [
    selectedPrivateFolderPath,
    isRecentFiles,
    isLoadingPrivatePath,
  ]);

  const refreshUserFilesCallback = useCallback(() => {
    refetchUserFiles();
  }, [refetchUserFiles]);

  const refreshRecentFilesCallback = useCallback(() => {
    refetchRecentFiles();
  }, [refetchRecentFiles]);

  // Handle folder selection from SyncFolderSelector
  const handleFolderSelected = useCallback(
    async (path: string) => {
      if (!polkadotAddress) return;

      try {
        // Save sync path and update UI immediately (fast operations)
        await setPrivateSyncPath(path, polkadotAddress);
        setSelectedPrivateFolderPath(path);

        // Signal other components (e.g. settings, dashboard) about the path change
        triggerSyncPathRefresh((prev) => prev + 1);

        // Check if HCFS config exists
        const hasConfig = await checkConfig(polkadotAddress);

        if (!hasConfig.has_password) {
          // Need to show setup dialog — user must enter password first
          setShowHcfsSetup(true);
        } else {
          // Config exists — show success immediately, sync in background
          toast.success("Sync folder set — syncing started!");
          setIsSyncPathConfigured(true);
          setShowPrivateStartSyncingSelector(false);
          refetchUserFiles();

          // Clear stopped flag — selecting a folder means user wants sync running
          localStorage.removeItem("hippius_sync_stopped");

          // Fire off stop + re-init in background (don't block UI)
          const mnemonic = (await getMnemonic()) ?? undefined;
          invoke("stop_sync").catch(() => { }).then(() =>
            tryInitializeSync(polkadotAddress!, "default", mnemonic ?? undefined).catch((err) =>
              console.error("[FilesContainer] Background sync init failed:", err)
            )
          );
        }
      } catch (err) {
        console.error("Failed to set sync folder:", err);
        toast.error("Failed to set sync folder");
      }
    },
    [polkadotAddress, checkConfig, tryInitializeSync, getMnemonic, triggerSyncPathRefresh, refetchUserFiles]
  );

  // Handle skipping sync folder setup
  const handleSkipSyncFolder = useCallback(async () => {
    if (!polkadotAddress) return;
    const emptyPath = "";
    await setPrivateSyncPath(emptyPath, polkadotAddress);
    setSelectedPrivateFolderPath(emptyPath);
    setIsSyncPathConfigured(true);
    setShowPrivateStartSyncingSelector(false);
  }, [polkadotAddress]);

  const handleHcfsSetupComplete = useCallback(async (result: { serverUrl: string; password: string }) => {
    if (!polkadotAddress) return;

    try {
      const mnemonic = (await getMnemonic()) ?? undefined;
      const initResult = await setupAndInitialize(
        polkadotAddress,
        "default",
        result.serverUrl,
        result.password,
        mnemonic ?? undefined
      );

      setShowHcfsSetup(false);

      if (initResult) {
        toast.success("Sync folder set — syncing started!");
        // Mark sync path as configured and hide selectors so files view shows
        setIsSyncPathConfigured(true);
        setShowPrivateStartSyncingSelector(false);
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
  }, [polkadotAddress, setupAndInitialize, getMnemonic, refetchUserFiles, triggerSyncPathRefresh]);

  const handleMnemonicBackupConfirm = useCallback(() => {
    setShowMnemonicBackup(false);
    clearMnemonicBackup();
  }, [clearMnemonicBackup]);

  // Navigation to settings
  const handleNavigateToSettings = useCallback(() => {
    setActiveSettingsTab("File Settings");
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

  // Handle folder selection from Start Syncing flow
  const handleStartSyncingFolderSelected = useCallback(
    async (path: string) => {
      try {
        await handleFolderSelected(path);
        // Hide the start syncing selector on success
        setShowPrivateStartSyncingSelector(false);
      } catch (error) {
        // Keep the selector open on error so user can try again
        console.error("Failed to set sync folder:", error);
      }
    },
    [handleFolderSelected]
  );

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

  // Get displayed file count
  const displayedFileCount = useMemo(() => {
    if (searchTerm || activeFilters.length > 0) {
      return filteredData.length;
    }
    return allFilteredData.length;
  }, [
    filteredData.length,
    allFilteredData.length,
    searchTerm,
    activeFilters.length,
  ]);

  // Handle file drop events
  useEffect(() => {
    const handleFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.files && addButtonRef.current) {
        console.log(
          "Handling files via global event",
          customEvent.detail.files
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
      // Reload private sync path
      (async () => {
        try {
          setIsLoadingPrivatePath(true);
          const privatefolderPath = (await getPrivateSyncPath(
            polkadotAddress || undefined
          )).path;
          setSelectedPrivateFolderPath(privatefolderPath);
          // Refetch file list so it reads from the new sync folder
          refetchUserFiles();
        } catch {
          console.error("Failed to reload private sync folder");
        } finally {
          setIsLoadingPrivatePath(false);
        }
      })();
    }
  }, [syncPathRefreshTrigger, polkadotAddress, refetchUserFiles]);

  // Computed values for current view (always private)
  const currentSyncPath = selectedPrivateFolderPath;
  const isCurrentSyncPathEmpty = currentSyncPath === "";
  const showCurrentStartSyncingSelector = showPrivateStartSyncingSelector;

  // Recent files specific logic - check if private path is available
  const hasNoSyncPaths = useMemo(() => {
    if (!isRecentFiles) return false;
    return (
      selectedPrivateFolderPath === null ||
      selectedPrivateFolderPath === undefined
    );
  }, [isRecentFiles, selectedPrivateFolderPath]);

  // For recent files, check if sync path is available (not empty)
  const hasAnySyncPath = useMemo(() => {
    if (!isRecentFiles) return false;
    const hasPrivate =
      selectedPrivateFolderPath !== null &&
      selectedPrivateFolderPath !== undefined &&
      selectedPrivateFolderPath !== "";
    return hasPrivate;
  }, [isRecentFiles, selectedPrivateFolderPath]);

  // Effective is private view (always true for private-only)
  const effectiveIsPrivateView = useMemo(() => {
    return true;
  }, []);

  // Determine what content to render
  let content;

  // Show loading while checking sync path or while loading sync paths
  const shouldShowLoading = isCheckingSyncPath || isLoadingPrivatePath;

  if (shouldShowLoading) {
    content = <WaitAMoment />;
  } else if (isSyncPathConfigured === false && !isRecentFiles) {
    content = (
      <SyncFolderSelector
        onFolderSelected={handleFolderSelected}
        onSkip={handleSkipSyncFolder}
      />
    );
  } else if (showCurrentStartSyncingSelector && !isRecentFiles) {
    // Show sync folder selector when Start Syncing is clicked
    content = (
      <SyncFolderSelector
        onFolderSelected={handleStartSyncingFolderSelected}
        onSkip={handleSkipSyncFolder}
      />
    );
  } else {
    // Compute active sync folder path
    let syncFolderPath = "";
    let effectiveSyncPathEmpty = false;

    if (isRecentFiles) {
      // For recent files, use private path
      const privatePath =
        selectedPrivateFolderPath !== null &&
          selectedPrivateFolderPath !== undefined &&
          selectedPrivateFolderPath !== ""
          ? selectedPrivateFolderPath
          : null;

      syncFolderPath = privatePath || "";
      effectiveSyncPathEmpty = !hasAnySyncPath;
    } else {
      // For regular files view, use the private path
      syncFolderPath = selectedPrivateFolderPath || "";
      effectiveSyncPathEmpty = isCurrentSyncPathEmpty;
    }

    // Get file count for view all button
    const privateFileCount =
      regularFilesData?.files.filter((f) => f.type?.toLowerCase() === "private")
        .length || 0;

    content = (
      <FileSelectionProvider>
        <div className="w-full relative mt-6">
          {/* Sync Paused Alert */}
          {IS_SYNC_PAUSED && !isRecentFiles && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          {/* Sync Stopped Alert */}
          <div className="mb-4">
            <SyncStoppedAlert variant={isRecentFiles ? "compact" : "banner"} />
          </div>

          <FilesHeader
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
            syncFolderPath={syncFolderPath}
            privateFileCount={privateFileCount}
            isSyncPathEmpty={effectiveSyncPathEmpty}
            onStartSyncing={handleStartSyncing}
            hasNoSyncPaths={hasNoSyncPaths}
            onNavigateToSettings={handleNavigateToSettings}
            isPrivateView={effectiveIsPrivateView}
            selectedFileTypes={filterState.fileTypes}
            selectedDate={filterState.date}
            selectedFileSizes={filterState.fileSizes}
            onFileTypesChange={handleFileTypesChange}
            onDateChange={handleDateChange}
            onFileSizesChange={handleFileSizesChange}
          />

          <FilesContent
            isRecentFiles={isRecentFiles}
            isLoading={isLoading}
            isFetching={isFetching}
            isPrivateView={effectiveIsPrivateView}
            filteredData={filteredData}
            displayedData={paginatedData}
            searchTerm={searchTerm}
            activeFilters={activeFilters}
            viewMode={viewMode}
            shouldResetPagination={shouldResetPagination}
            handlePaginationReset={handlePaginationReset}
            error={error}
            addButtonRef={addButtonRef}
            currentPage={currentPage}
            totalPages={totalPages}
            setCurrentPage={setCurrentPage}
            isSyncPathEmpty={effectiveSyncPathEmpty}
            onSyncPathConfigured={
              isRecentFiles ? handleNavigateToSettings : handleStartSyncing
            }
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
    </>
  );
};

export default FilesContainer;
