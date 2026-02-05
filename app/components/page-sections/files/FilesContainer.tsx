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
import { toast } from "sonner";
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
  triggerUnpinnedFilesRefetchAtom,
  triggerSyncPathRefreshAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";

const FilesContainer: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
  const { polkadotAddress, oauthSession } = useWalletAuth();

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

  const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);
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
  const setTriggerUnpinnedFilesRefetch = useSetAtom(
    triggerUnpinnedFilesRefetchAtom
  );
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);
  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      console.log("recentFilesData", recentFilesData);
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

  // Handle resetting filters
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
        const privatefolderPath = await getPrivateSyncPath(
          polkadotAddress || undefined
        );
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

  const refreshUserFilesWithPinningQueue = useCallback(() => {
    refetchUserFiles();
    setTriggerUnpinnedFilesRefetch((prev) => prev + 1);
  }, [refetchUserFiles, setTriggerUnpinnedFilesRefetch]);

  const refreshRecentFilesWithPinningQueue = useCallback(() => {
    refetchRecentFiles();
    setTriggerUnpinnedFilesRefetch((prev) => prev + 1);
  }, [refetchRecentFiles, setTriggerUnpinnedFilesRefetch]);

  // Handle folder selection from SyncFolderSelector
  const handleFolderSelected = useCallback(
    async (path: string) => {
      try {
        if (!polkadotAddress) {
          toast.error("Wallet authentication is required");
          return;
        }

        await setPrivateSyncPath(path, polkadotAddress);
        setSelectedPrivateFolderPath(path);
        toast.success(
          `Private sync folder set successfully, syncing is now in progress.`
        );
        setIsSyncPathConfigured(true);

        // Refresh files to get any new files from the configured path
        refreshUserFilesWithPinningQueue();
        return true;
      } catch (error) {
        console.error("Failed to set sync folder:", error);
        toast.error(
          `Failed to set sync folder: ${error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [
      refreshUserFilesWithPinningQueue,
      polkadotAddress,
      oauthSession?.token,
    ]
  );

  // Handle skip sync folder setup
  const handleSkipSyncFolder = useCallback(async () => {
    try {
      if (!polkadotAddress) {
        toast.error("Wallet authentication is required");
        return;
      }

      // Set sync path to empty string to indicate user has skipped
      const emptyPath = "";
      await setPrivateSyncPath(
        emptyPath,
        polkadotAddress,
      );
      setSelectedPrivateFolderPath(emptyPath);

      // Set sync path as configured (with empty string) so selector doesn't show again
      setIsSyncPathConfigured(true);
      // Hide the start syncing selector
      setShowPrivateStartSyncingSelector(false);

      toast.success("Sync folder setup skipped. You can set it up later.");
    } catch (error) {
      console.error("Failed to skip sync folder setup:", error);
      toast.error(
        `Failed to skip sync folder setup: ${error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }, [polkadotAddress, oauthSession?.token]);

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

    refreshUserFilesWithPinningQueue();
  }, [refreshUserFilesWithPinningQueue, isRecentFiles]);

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
          const privatefolderPath = await getPrivateSyncPath(
            polkadotAddress || undefined
          );
          setSelectedPrivateFolderPath(privatefolderPath);
        } catch {
          console.error("Failed to reload private sync folder");
        } finally {
          setIsLoadingPrivatePath(false);
        }
      })();
    }
  }, [syncPathRefreshTrigger, polkadotAddress]);

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
        onSkip={handleSkipSyncFolder} // Allow skip option in Start Syncing flow
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
                ? refreshRecentFilesWithPinningQueue
                : refreshUserFilesWithPinningQueue
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

  return content;
};

export default FilesContainer;
