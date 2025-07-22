"use client";

import { FC, useEffect, useRef, useMemo, useState, useCallback } from "react";
import useUserIpfsFiles, {
  FormattedUserIpfsFile
} from "@/lib/hooks/use-user-ipfs-files";
import { useAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";
import {
  RefreshButton,
  Icons,
  SearchInput,
  WaitAMoment
} from "@/components/ui";
import AddButton from "./AddFileButton";
import FilesTable from "./files-table";
import CardView from "./card-view";
import Link from "next/link";
import SyncFolderSelector from "./SyncFolderSelector";
import {
  getPrivateSyncPath,
  setPrivateSyncPath
} from "@/lib/utils/syncPathUtils";
import { cn, formatBytesFromBigInt } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import FileDetailsDialog, { FileDetail } from "./files-table/UnpinFilesDialog";
import InsufficientCreditsDialog from "./InsufficientCreditsDialog";
import SidebarDialog from "@/components/ui/sidebar-dialog";
import UploadStatusWidget from "./UploadStatusWidget";
import FilterDialogContent from "./filter-dialog-content";
import IPFSNoEntriesFound from "./files-table/IpfsNoEntriesFound";
import FilterChips from "./filter-chips";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  filterFiles,
  generateActiveFilters,
  ActiveFilter
} from "@/lib/utils/fileFilterUtils";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { enrichFilesWithTimestamps } from "@/lib/utils/blockTimestampUtils";
import StorageStateList from "./storage-stats";
import { toast } from "sonner";

const Ipfs: FC<{ isRecentFiles?: boolean }> = ({ isRecentFiles = false }) => {
  const { api } = usePolkadotApi();
  const [activeSubMenuItem] = useAtom(activeSubMenuItemAtom);
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

  // State to track if private sync folder is configured
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

  // Format storage size with proper units
  const formattedStorageSize = useMemo(() => {
    if (!data?.totalStorageSize) return "0 B";
    return formatBytesFromBigInt(data.totalStorageSize);
  }, [data?.totalStorageSize]);

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
    // Signal pagination reset but don't directly change it
  }, []);

  useEffect(() => {
    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);
        const privateSyncPath = await getPrivateSyncPath();
        setIsSyncPathConfigured(!!privateSyncPath);
      } catch (error) {
        console.error("Failed to check sync path:", error);
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, []);

  // Handle folder selection from SyncFolderSelector
  const handleFolderSelected = useCallback(
    async (path: string) => {
      try {
        await setPrivateSyncPath(path);
        toast.success(`Sync folder set successfully`);
        setIsSyncPathConfigured(true);

        // Refresh files to get any new files from the configured path
        refetchUserFiles();
        return true;
      } catch (error) {
        console.error("Failed to set sync folder:", error);
        toast.error(
          `Failed to set sync folder: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    },
    [refetchUserFiles]
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

  const renderContent = () => {
    if (isLoading || isFetching || isProcessingTimestamps) {
      return <WaitAMoment isRecentFiles={isRecentFiles} />;
    }

    if (
      (!filteredData.length && !searchTerm && activeFilters.length === 0) ||
      error
    ) {
      return <IPFSNoEntriesFound isRecentFiles={isRecentFiles} />;
    }

    if (!filteredData.length && (searchTerm || activeFilters.length > 0)) {
      return (
        <div className="flex flex-col items-center justify-center py-16 min-h-[600px]">
          <div className="w-12 h-12 rounded-full bg-primary-90 flex items-center justify-center mb-2">
            <Icons.File className="size-7 text-primary-50" />
          </div>
          <h3 className="text-lg font-medium text-grey-10 mb-1">
            No matching files found
          </h3>
          <p className="text-grey-50 text-sm max-w-[270px] text-center">
            Try adjusting the filters or clearing them to see more results.
          </p>
        </div>
      );
    }

    if (viewMode === "list") {
      return (
        <FilesTable
          isRecentFiles={isRecentFiles}
          showUnpinnedDialog={false}
          files={displayedData}
          resetPagination={shouldResetPagination}
          onPaginationReset={handlePaginationReset}
        />
      );
    } else {
      return (
        <CardView
          isRecentFiles={isRecentFiles}
          showUnpinnedDialog={false}
          files={displayedData}
          resetPagination={shouldResetPagination}
          onPaginationReset={handlePaginationReset}
        />
      );
    }
  };

  // FIXED: Don't return early - instead render conditionally based on state
  // This ensures all hooks are called in the same order on every render

  // Determine what content to render
  let content;
  if (isCheckingSyncPath) {
    content = <WaitAMoment />;
  } else if (isSyncPathConfigured === false && !isRecentFiles) {
    content = <SyncFolderSelector onFolderSelected={handleFolderSelected} />;
  } else {
    content = (
      <div className="w-full relative mt-6">
        {/* Recent Files header and View All Files link */}
        <div className="flex items-center justify-between w-full gap-6 flex-wrap">
          {isRecentFiles ? (
            <h2 className="text-lg font-medium text-grey-10">Recent Files</h2>
          ) : (
            <div className="flex items-center gap-4">
              <StorageStateList
                storageUsed={formattedStorageSize}
                numberOfFiles={allFilteredData.length || 0}
              />
            </div>
          )}
          <div className="flex items-center gap-x-4">
            <RefreshButton
              refetching={isRefetching || isFetching}
              onClick={() => refetchUserFiles()}
            />

            {!isRecentFiles && (
              <div className="">
                <SearchInput
                  className="h-9"
                  value={searchTerm}
                  onChange={handleSearchChange}
                />
              </div>
            )}

            <div className="flex gap-2 border border-grey-80 p-1 rounded">
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "list"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => setViewMode("list")}
                aria-label="List View"
              >
                <Icons.Grid className="size-5" />
              </button>
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "card"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => setViewMode("card")}
                aria-label="Card View"
              >
                <Icons.Category className="size-5" />
              </button>
            </div>
            {isRecentFiles && (
              <Link
                href="/files"
                className="px-4 py-2.5 items-center flex bg-grey-90 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
              >
                View All Files
                <Icons.ArrowRight className="size-[14px] ml-1" />
              </Link>
            )}
            {!isRecentFiles && (
              <div className="flex border border-grey-80 p-1 rounded">
                <button
                  className="flex justify-center items-center p-1 cursor-pointer bg-white text-grey-70 rounded"
                  onClick={() => setIsFilterOpen(true)}
                  aria-label="Filter"
                >
                  <Icons.Filter className="size-5" />
                  {activeFilters.length > 0 && (
                    <span className="ml-1 p-1 bg-primary-100 text-primary-30 border border-primary-80 text-xs rounded min-w-4 h-4 flex items-center justify-center">
                      {activeFilters.length}
                    </span>
                  )}
                </button>
              </div>
            )}

            <AddButton ref={addButtonRef} className="h-9" />
          </div>
        </div>

        {/* Active Filters Display */}
        {activeFilters.length > 0 && !isRecentFiles && (
          <FilterChips
            filters={activeFilters}
            onRemoveFilter={handleRemoveFilter}
            onOpenFilterDialog={() => setIsFilterOpen(true)}
            className="mt-4 mb-2"
          />
        )}

        <div className="w-full mt-4">{renderContent()}</div>

        {unpinnedFiles && unpinnedFiles.length > 0 && (
          <FileDetailsDialog
            open={!isLoading && isUnpinnedOpen}
            unpinnedFiles={unpinnedFiles}
          />
        )}

        <InsufficientCreditsDialog />
        <UploadStatusWidget />

        {/* Filter Sidebar Dialog */}
        <SidebarDialog
          heading="Filter"
          open={isFilterOpen}
          onOpenChange={setIsFilterOpen}
        >
          <FilterDialogContent
            selectedFileTypes={selectedFileTypes}
            selectedDate={selectedDate}
            selectedFileSize={selectedFileSize}
            selectedSizeUnit={selectedSizeUnit}
            onApplyFilters={handleApplyFilters}
            onResetFilters={handleResetFilters}
          />
        </SidebarDialog>
      </div>
    );
  }

  return content;
};

export default Ipfs;
