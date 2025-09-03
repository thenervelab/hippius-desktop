"use client";

import { FC, useEffect, useRef, useMemo, useState, useCallback } from "react";
import useUserIpfsFiles from "@/lib/hooks/use-user-ipfs-files";
import useRecentFiles from "@/lib/hooks/use-recent-files";
import { WaitAMoment } from "@/components/ui";
import SyncFolderSelector from "./SyncFolderSelector";
import {
  getPrivateSyncPath,
  setPrivateSyncPath,
  getPublicSyncPath,
  setPublicSyncPath
} from "@/lib/utils/syncPathUtils";
import { formatBytesFromBigInt } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { FileDetail } from "./files-table/UnpinFilesDialog";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  filterFiles,
  generateActiveFilters,
  ActiveFilter
} from "@/lib/utils/fileFilterUtils";
import { toast } from "sonner";
import FilesHeader from "./FilesHeader";
import FilesContent from "./FilesContent";
import { useAtomValue } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";
import { getViewModePreference, saveViewModePreference } from "@/lib/utils/userPreferencesDb";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

const Ipfs: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const activeSubMenuItem = useAtomValue(activeSubMenuItemAtom);
  const isPrivateView = activeSubMenuItem === "Private";

  // Regular files hook
  const {
    data: regularFilesData,
    isLoading: isRegularFilesLoading,
    refetch: refetchUserFiles,
    isRefetching,
    isFetching: isRegularFilesFetching,
    error
  } = useUserIpfsFiles();

  // Recent files hook
  const {
    data: recentFilesData,
    isLoading: isRecentFilesLoading,
    isFetching: isRecentFilesFetching,
    refetch: refetchRecentFiles
  } = useRecentFiles();

  // Set loading and fetching based on current view
  const isLoading = isRecentFiles ? isRecentFilesLoading : isRegularFilesLoading;
  const isFetching = isRecentFiles ? isRecentFilesFetching : isRegularFilesFetching;

  const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [shouldResetPagination, setShouldResetPagination] = useState(false);
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState("");
  const [selectedPublicFolderPath, setSelectedPublicFolderPath] = useState("");

  // Search state
  const [searchTerm, setSearchTerm] = useState<string>("");

  // Filter states
  const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedFileSize, setSelectedFileSize] = useState<number>(0);
  const [selectedSizeUnit, setSelectedSizeUnit] = useState<string>("GB");

  // Active filters state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);

  // State to track if sync folder is configured
  const [isSyncPathConfigured, setIsSyncPathConfigured] = useState<boolean | null>(null);
  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);

  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      console.log("recentFilesData", recentFilesData)
      return recentFilesData || [];
    } else if (regularFilesData?.files) {
      return regularFilesData.files.filter(file => !file.deleted);
    }
    return [];
  }, [isRecentFiles, recentFilesData, regularFilesData?.files]);

  // Filter data based on current view (public/private)
  const allFilteredData = useMemo(() => {
    if (isRecentFiles) {
      return allData;
    }

    let filtered = allData;
    if (
      activeSubMenuItem &&
      (activeSubMenuItem === "Private" || activeSubMenuItem === "Public")
    ) {
      filtered = filtered.filter((file) => {
        const fileType = file.type?.toLowerCase() || "";
        return fileType === activeSubMenuItem.toLowerCase();
      });
    }

    return filtered;
  }, [allData, activeSubMenuItem, isRecentFiles]);

  // Extract unpinned file details from data (only for regular files view)
  const unpinnedFileDetails = useMemo(() => {
    if (isRecentFiles || !regularFilesData?.files) return [];

    const filteredUnpinnedFiles = regularFilesData.files.filter((file) => !file.isAssigned);
    return filteredUnpinnedFiles.map((file) => ({
      filename: file.name || "Unnamed File",
      cid: decodeHexCid(file.cid),
      createdAt: file.createdAt
    }));
  }, [regularFilesData?.files, isRecentFiles]);

  // Update unpinned files state when unpinned file details change
  useEffect(() => {
    if (unpinnedFileDetails.length > 0) {
      setUnpinnedFiles(unpinnedFileDetails);
      setIsUnpinnedOpen(true);
    } else {
      setUnpinnedFiles(null);
      setIsUnpinnedOpen(false);
    }
  }, [unpinnedFileDetails]);

  // Filter data based on search and filter settings
  const filteredData = useMemo(() => {
    return filterFiles(allFilteredData, {
      searchTerm,
      fileTypes: selectedFileTypes,
      dateFilter: selectedDate,
      fileSize: selectedFileSize
    });
  }, [
    allFilteredData,
    searchTerm,
    selectedFileTypes,
    selectedDate,
    selectedFileSize
  ]);

  // Update active filters when filter settings change
  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      selectedFileTypes,
      selectedDate,
      selectedFileSize
    );
    setActiveFilters(newActiveFilters);
  }, [selectedFileTypes, selectedDate, selectedFileSize]);

  // Reset pagination when filters change
  useEffect(() => {
    setShouldResetPagination(true);
  }, [searchTerm, selectedFileTypes, selectedDate, selectedFileSize]);

  const handlePaginationReset = useCallback(() => {
    setShouldResetPagination(false);
  }, []);

  // Handle removing a filter
  const handleRemoveFilter = (filter: ActiveFilter) => {
    switch (filter.type) {
      case "fileType":
        setSelectedFileTypes((prev) =>
          prev.filter((type) => type !== filter.value)
        );
        break;

      case "date":
        setSelectedDate("");
        break;

      case "fileSize":
        setSelectedFileSize(0);
        break;
    }
  };

  // Handle applying filters from dialog
  const handleApplyFilters = useCallback(
    (
      fileTypes: FileTypes[],
      date: string,
      fileSize: number,
      sizeUnit: string
    ) => {
      setSelectedFileTypes(fileTypes);
      setSelectedDate(date);
      setSelectedFileSize(fileSize);
      setSelectedSizeUnit(sizeUnit);
      setIsFilterOpen(false);
    },
    []
  );

  // Format storage size with proper units based on view type
  const formattedStorageSize = useMemo(() => {
    if (isRecentFiles) return "";

    if (!regularFilesData) return "0 B";

    if (isPrivateView && regularFilesData.privateStorageSize !== undefined) {
      return formatBytesFromBigInt(regularFilesData.privateStorageSize);
    } else if (!isPrivateView && regularFilesData.publicStorageSize !== undefined) {
      return formatBytesFromBigInt(regularFilesData.publicStorageSize);
    } else {
      return "0 B";
    }
  }, [regularFilesData, isPrivateView, isRecentFiles]);

  // Handle resetting filters
  const handleResetFilters = useCallback(() => {
    setSelectedFileTypes([]);
    setSelectedDate("");
    setSelectedFileSize(0);
    setSelectedSizeUnit("GB");
  }, []);

  // Handle search input change
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  // Load public sync path
  useEffect(() => {
    (async () => {
      try {
        const publicfolderPath = await getPublicSyncPath();
        setSelectedPublicFolderPath(publicfolderPath);
      } catch {
        console.error("Failed to load public sync folder");
      }
    })();
  }, []);

  // Load private sync path
  useEffect(() => {
    (async () => {
      try {
        const privatefolderPath = await getPrivateSyncPath();
        setSelectedPrivateFolderPath(privatefolderPath);
      } catch {
        console.error("Failed to load private sync folder");
      }
    })();
  }, []);

  // Check if sync path is configured
  useEffect(() => {
    if (isRecentFiles) {
      setIsCheckingSyncPath(false);
      return;
    }

    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);
        const syncPath = isPrivateView
          ? selectedPrivateFolderPath
          : selectedPublicFolderPath;

        setIsSyncPathConfigured(!!syncPath);
      } catch (error) {
        console.error(
          `Failed to check ${isPrivateView ? "private" : "public"} sync path:`,
          error
        );
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, [isPrivateView, selectedPrivateFolderPath, selectedPublicFolderPath, isRecentFiles]);

  // Handle folder selection from SyncFolderSelector
  const handleFolderSelected = useCallback(
    async (path: string) => {
      try {
        if (!polkadotAddress || !mnemonic) {
          toast.error("Wallet authentication is required");
          return;
        }

        if (isPrivateView) {
          if (path === selectedPublicFolderPath) {
            toast.error("Private sync folder cannot be the same as public sync folder");
            return;
          }
          await setPrivateSyncPath(path, polkadotAddress, mnemonic);
        } else {
          if (path === selectedPrivateFolderPath) {
            toast.error("Public sync folder cannot be the same as private sync folder");
            return;
          }
          await setPublicSyncPath(path, polkadotAddress, mnemonic);
        }
        toast.success(
          `${isPrivateView ? "Private" : "Public"} sync folder set successfully`
        );
        setIsSyncPathConfigured(true);

        // Refresh files to get any new files from the configured path
        refetchUserFiles();
        return true;
      } catch (error) {
        console.error("Failed to set sync folder:", error);
        toast.error(
          `Failed to set sync folder: ${error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [refetchUserFiles, isPrivateView, selectedPrivateFolderPath, selectedPublicFolderPath, polkadotAddress, mnemonic]
  );

  // Load data on mount and set up interval refresh
  useEffect(() => {
    if (isRecentFiles) {
      return;
    }

    refetchUserFiles();

  }, [refetchUserFiles, isRecentFiles]);

  // Log error for debugging
  useEffect(() => {
    if (error) {
      console.error("Error in useUserIpfsFiles:", error);
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
    activeFilters.length
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

  // Determine what content to render
  let content;
  if (isCheckingSyncPath) {
    content = <WaitAMoment />;
  } else if (isSyncPathConfigured === false && !isRecentFiles) {
    content = (
      <SyncFolderSelector
        onFolderSelected={handleFolderSelected}
        isPrivateView={isPrivateView}
      />
    );
  } else {
    // Compute active sync folder path - for recent files, prioritize private path
    let syncFolderPath = "";

    if (isRecentFiles) {
      // For recent files, prioritize private path, then fall back to public
      syncFolderPath = selectedPrivateFolderPath || selectedPublicFolderPath;
    } else {
      // For regular files view, use the path matching the current view
      syncFolderPath = isPrivateView ? selectedPrivateFolderPath : selectedPublicFolderPath;
    }

    // Get file counts for view all button
    const privateFileCount = regularFilesData?.files.filter(f => f.type?.toLowerCase() === "private").length || 0;
    const publicFileCount = regularFilesData?.files.filter(f => f.type?.toLowerCase() === "public").length || 0;

    content = (
      <div className="w-full relative mt-6">
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
          setIsFilterOpen={setIsFilterOpen}
          refetchUserFiles={isRecentFiles ? refetchRecentFiles : refetchUserFiles}
          addButtonRef={addButtonRef}
          syncFolderPath={syncFolderPath}
          privateFileCount={privateFileCount}
          publicFileCount={publicFileCount}
        />

        <FilesContent
          isRecentFiles={isRecentFiles}
          isLoading={isLoading}
          isFetching={isFetching}
          isPrivateView={isPrivateView}
          filteredData={filteredData}
          displayedData={filteredData}
          searchTerm={searchTerm}
          activeFilters={activeFilters}
          viewMode={viewMode}
          shouldResetPagination={shouldResetPagination}
          handlePaginationReset={handlePaginationReset}
          unpinnedFiles={unpinnedFiles}
          isUnpinnedOpen={isUnpinnedOpen}
          isFilterOpen={isFilterOpen}
          setIsFilterOpen={setIsFilterOpen}
          selectedFileTypes={selectedFileTypes}
          selectedDate={selectedDate}
          selectedFileSize={selectedFileSize}
          selectedSizeUnit={selectedSizeUnit}
          handleApplyFilters={handleApplyFilters}
          handleResetFilters={handleResetFilters}
          error={error}
        />
      </div>
    );
  }

  return content;
};

export default Ipfs;
