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
import FilesOnboarding from "./FilesOnboarding";
import {
  getPrivateSyncPath,
} from "@/lib/utils/syncPathUtils";
import SyncFolderTabs from "./SyncFolderTabs";
import { formatBytesFromBigInt } from "@/lib/utils";
import { useRemoteStorageStats } from "@/app/lib/hooks/api/useRemoteStorageStats";
import useFilesCount from "@/app/lib/hooks/api/useFilesCount";
import { formatBytes } from "@/app/lib/utils/formatBytes";
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
  isSyncConfiguredAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";
import { SyncStoppedAlert } from "@/components/ui/SyncStoppedAlert";
import { SyncConnectivityAlert } from "@/components/ui/SyncConnectivityAlert";
import { HcfsSetupDialog } from "../settings/HcfsSetupDialog";
import { MnemonicBackupDialog } from "../settings/MnemonicBackupDialog";
import { useHcfsSync } from "@/app/lib/hooks/useHcfsSync";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

const FilesContainer: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
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
  const addButtonRef = useRef<{ openWithFiles(files: FileList): void; openWithPaths(paths: string[]): void; isDialogOpen(): boolean }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [shouldResetPagination, setShouldResetPagination] = useState(false);
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState(
    undefined as string | null | undefined
  );

  // Loading states for sync paths
  const [isLoadingPrivatePath, setIsLoadingPrivatePath] = useState(true);

  // Folder tab state (null = "All")
  const [selectedFolderTab, setSelectedFolderTab] = useState<string | null>(
    null
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
  const syncEngineStatus = useAtomValue(syncEngineStatusAtom);
  const setSyncEngineStatus = useSetAtom(syncEngineStatusAtom);
  const isSyncConfigured = useAtomValue(isSyncConfiguredAtom);

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
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  // Sync folder labels from the query data
  const syncFolderLabels = useMemo(() => {
    if (regularFilesData && "syncFolderLabels" in regularFilesData) {
      return (regularFilesData as { syncFolderLabels?: string[] })
        .syncFolderLabels ?? [];
    }
    return [];
  }, [regularFilesData]);

  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      return recentFilesData || [];
    } else if (regularFilesData?.files) {
      return regularFilesData.files.filter((file) => !file.deleted);
    }
    return [];
  }, [isRecentFiles, recentFilesData, regularFilesData?.files]);

  // Filter data to show only private files, then by selected folder tab
  const allFilteredData = useMemo(() => {
    let data = allData;

    if (!isRecentFiles) {
      data = data.filter((file) => {
        const fileType = file.type?.toLowerCase() || "";
        return fileType === "private";
      });
    }

    if (selectedFolderTab && !isRecentFiles) {
      data = data.filter((file) => file.label === selectedFolderTab);
    }

    return data;
  }, [allData, isRecentFiles, selectedFolderTab]);

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

  // Reset pagination when filters or folder tab change
  useEffect(() => {
    setShouldResetPagination(true);
  }, [
    searchTerm,
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
    selectedFolderTab,
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

  // Format storage size — indexer stats at top level, local stats for folder tabs
  const formattedStorageSize = useMemo(() => {
    if (isRecentFiles) return "";

    // Folder-scoped view: use local computed size for that folder
    if (selectedFolderTab) {
      const tabSize = allFilteredData.reduce(
        (sum, f) => sum + BigInt(f.size ?? 0),
        BigInt(0)
      );
      return formatBytesFromBigInt(tabSize);
    }

    // Top-level "All" view: use indexer stats (same source as Home page)
    if (remoteStorageStats?.totalBytes) {
      return formatBytes(remoteStorageStats.totalBytes, 2);
    }

    return "0 B";
  }, [isRecentFiles, selectedFolderTab, allFilteredData, remoteStorageStats]);

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

  // Load private sync path (with stale-request cancellation)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const result = await getPrivateSyncPath(
          polkadotAddress || undefined
        );
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

    return () => { cancelled = true; };
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

    return () => { cancelled = true; };
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

        setIsSyncPathConfigured(
          syncPath !== null && syncPath !== undefined
        );
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
  }, [polkadotAddress, setupAndInitialize, getMnemonic, refetchUserFiles, triggerSyncPathRefresh]);

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

  // Get displayed file count — indexer stats at top level, local count for folder tabs/filters
  const displayedFileCount = useMemo(() => {
    // If search/filters active or folder tab selected, use local count
    const useLocalCount = selectedFolderTab
      || searchTerm
      || activeFilters.length > 0;

    if (!useLocalCount && remoteFileCount !== undefined) {
      return remoteFileCount;
    }

    const source = searchTerm || activeFilters.length > 0
      ? filteredData
      : allFilteredData;
    return source.reduce((count, item) => {
      if (item.isFolder) {
        // Use nested file count; treat empty folders as 1 item
        const nested = item.fileCount ?? 0;
        return count + (nested > 0 ? nested : 1);
      }
      return count + 1;
    }, 0);
  }, [
    filteredData,
    allFilteredData,
    searchTerm,
    activeFilters.length,
    selectedFolderTab,
    remoteFileCount,
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
      let cancelled = false;

      // Reload private sync path
      (async () => {
        try {
          setIsLoadingPrivatePath(true);
          const result = await getPrivateSyncPath(
            polkadotAddress || undefined
          );
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

      return () => { cancelled = true; };
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
  } else if (isSyncPathConfigured === false && !isRecentFiles) {
    content = (
      <FilesOnboarding
        onSyncStarted={handleOnboardingSyncStarted}
      />
    );
  } else if (showCurrentStartSyncingSelector && !isRecentFiles) {
    // Show onboarding when Start Syncing is clicked
    content = (
      <FilesOnboarding
        onSyncStarted={handleOnboardingSyncStarted}
      />
    );
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
        <div className="w-full relative mt-6">
          {/* Sync Paused Alert */}
          {IS_SYNC_PAUSED && !isRecentFiles && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          {/* Sync connectivity and stopped alerts */}
          <div className="mb-4 space-y-2">
            <SyncConnectivityAlert variant={isRecentFiles ? "compact" : "banner"} />
            <SyncStoppedAlert
              variant={isRecentFiles ? "compact" : "banner"}
              hasSyncPaths={isRecentFiles ? hasAnySyncPath : (isSyncPathConfigured ?? false)}
            />
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
          />

          {!isRecentFiles && (
            <SyncFolderTabs
              labels={syncFolderLabels}
              selectedTab={selectedFolderTab}
              onTabChange={setSelectedFolderTab}
            />
          )}

          <FilesContent
            isRecentFiles={isRecentFiles}
            isLoading={isLoading}
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
