"use client";

import { FC, useEffect, useRef, useMemo, useState, useCallback } from "react";
import useUserIpfsFiles, {
  FormattedUserIpfsFile
} from "@/lib/hooks/use-user-ipfs-files";
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
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { enrichFilesWithTimestamps } from "@/lib/utils/blockTimestampUtils";
import { toast } from "sonner";
import FilesHeader from "./FilesHeader";
import FilesContent from "./FilesContent";
import { useAtomValue } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

const Ipfs: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
  const { api } = usePolkadotApi();
  const activeSubMenuItem = useAtomValue(activeSubMenuItemAtom);
  const isPrivateView = activeSubMenuItem === "Private";

  const {
    data,
    isLoading,
    refetch: refetchUserFiles,
    isRefetching,
    isFetching,
    error
  } = useUserIpfsFiles();

  const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [shouldResetPagination, setShouldResetPagination] = useState(false);

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

  const [filesWithTimestamps, setFilesWithTimestamps] = useState<
    Array<FormattedUserIpfsFile & { timestamp?: Date | null }>
  >([]);
  const [isProcessingTimestamps, setIsProcessingTimestamps] = useState(false);

  // State to track if sync folder is configured
  const [isSyncPathConfigured, setIsSyncPathConfigured] = useState<
    boolean | null
  >(null);
  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);

  const allFilteredData = useMemo(() => {
    if (data?.files) {
      let filtered = data.files.filter((file) => !file.deleted);

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
    }
    return [];
  }, [data?.files, activeSubMenuItem]);

  // Extract unpinned file details from data
  const unpinnedFileDetails = useMemo(() => {
    if (!data?.files) return [];

    const filteredUnpinnedFiles = data.files.filter((file) => !file.isAssigned);
    return filteredUnpinnedFiles.map((file) => ({
      filename: file.name || "Unnamed File",
      cid: decodeHexCid(file.cid),
      createdAt: file.createdAt
    }));
  }, [data?.files]);

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

  // Enrich files with timestamps when allFilteredData or api changes
  useEffect(() => {
    const enrichFiles = async () => {
      if (allFilteredData.length && api) {
        setIsProcessingTimestamps(true);
        try {
          const enriched = await enrichFilesWithTimestamps(
            api,
            allFilteredData
          );
          setFilesWithTimestamps(
            enriched as Array<
              FormattedUserIpfsFile & { timestamp?: Date | null }
            >
          );
        } catch (error) {
          console.error("Error enriching files with timestamps:", error);
        } finally {
          setIsProcessingTimestamps(false);
        }
      } else {
        setFilesWithTimestamps([]);
        setIsProcessingTimestamps(false);
      }
    };

    enrichFiles();
  }, [allFilteredData, api]);

  const filteredData = useMemo(() => {
    return filterFiles(filesWithTimestamps, {
      searchTerm,
      fileTypes: selectedFileTypes,
      dateFilter: selectedDate,
      fileSize: selectedFileSize
    });
  }, [
    filesWithTimestamps,
    searchTerm,
    selectedFileTypes,
    selectedDate,
    selectedFileSize
  ]);

  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      selectedFileTypes,
      selectedDate,
      selectedFileSize
    );
    setActiveFilters(newActiveFilters);
  }, [selectedFileTypes, selectedDate, selectedFileSize]);

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
    if (!data) return "0 B";

    if (isPrivateView && data.privateStorageSize !== undefined) {
      return formatBytesFromBigInt(data.privateStorageSize);
    } else if (!isPrivateView && data.publicStorageSize !== undefined) {
      return formatBytesFromBigInt(data.publicStorageSize);
    } else {
      return "0 B";
    }
  }, [data, isPrivateView]);

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

  useEffect(() => {
    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);
        const syncPath = isPrivateView
          ? await getPrivateSyncPath()
          : await getPublicSyncPath();

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
  }, [isPrivateView]);

  // Handle folder selection from SyncFolderSelector
  const handleFolderSelected = useCallback(
    async (path: string) => {
      try {
        if (isPrivateView) {
          if (path === (await getPublicSyncPath())) {
            toast.error("Private sync folder cannot be the same as public sync folder");
            return;
          }
          await setPrivateSyncPath(path);
        } else {
          if (path === (await getPrivateSyncPath())) {
            toast.error("Public sync folder cannot be the same as private sync folder");
            return;
          }
          await setPublicSyncPath(path);
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
    [refetchUserFiles, isPrivateView]
  );

  // Load the table once on mount and set up interval refresh
  useEffect(() => {
    // Initial fetch
    refetchUserFiles();

    // Set up an interval to periodically refetch data
    const intervalId = setInterval(() => {
      refetchUserFiles();
    }, 300000); // Every 5 minutes

    // Clean up interval on unmount
    return () => clearInterval(intervalId);
  }, [refetchUserFiles]);

  // Log error for debugging
  useEffect(() => {
    if (error) {
      console.error("Error in useUserIpfsFiles:", error);
    }
  }, [error]);

  const displayedData = useMemo(() => {
    return isRecentFiles ? filteredData.slice(0, 2) : filteredData;
  }, [filteredData, isRecentFiles]);

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
    content = (
      <div className="w-full relative mt-6">
        <FilesHeader
          isRecentFiles={isRecentFiles}
          isRefetching={isRefetching}
          isFetching={isFetching}
          formattedStorageSize={formattedStorageSize}
          allFilteredDataLength={displayedFileCount}
          viewMode={viewMode}
          setViewMode={setViewMode}
          searchTerm={searchTerm}
          handleSearchChange={handleSearchChange}
          activeFilters={activeFilters}
          handleRemoveFilter={handleRemoveFilter}
          setIsFilterOpen={setIsFilterOpen}
          refetchUserFiles={refetchUserFiles}
          addButtonRef={addButtonRef}
        />

        <FilesContent
          isRecentFiles={isRecentFiles}
          isLoading={isLoading}
          isFetching={isFetching}
          isProcessingTimestamps={isProcessingTimestamps}
          isPrivateView={isPrivateView}
          filteredData={filteredData}
          displayedData={displayedData}
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
