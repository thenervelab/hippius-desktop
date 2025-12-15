"use client";

import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons, RefreshButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  FormattedUserFile,
  parseMinerIds,
} from "@/app/lib/hooks/use-user-files";
import FilesContent from "@/app/components/page-sections/files/FilesContent";
import { toast } from "sonner";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  filterFiles,
  generateActiveFilters,
} from "@/lib/utils/fileFilterUtils";
import { SearchInput } from "@/components/ui";
import FilterChips from "@/app/components/page-sections/files/filter-chips";
import { useAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";
import { downloadFolder } from "@/app/lib/utils/downloadFolder";
import AddFileToFolderButton from "@/app/components/page-sections/files/AddFileToFolderButton";
import {
  getViewModePreference,
  saveViewModePreference,
} from "@/lib/utils/userPreferencesDb";
import { getFolderPathArray } from "@/app/utils/folderPathUtils";
import AddFolderToFolderButton from "@/app/components/page-sections/files/AddFolderToFolderButton";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { usePagination } from "@/lib/hooks";
import { List } from "lucide-react";
import {
  getPrivateSyncPath,
  getPublicSyncPath,
} from "@/lib/utils/syncPathUtils";
import { useAtomValue } from "jotai";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import FolderBreadcrumb from "./FolderBreadcrumb";

interface FileEntry {
  file_name: string;
  file_size: number;
  cid: string;
  created_at: string;
  file_hash: string;
  last_charged_at: string;
  miner_ids: string | string[];
  source: string;
  is_folder: boolean;
  main_req_hash: string;
}

interface FolderViewProps {
  folderCid: string;
  folderName?: string;
  folderActualName?: string;
  mainFolderActualName?: string;
  subFolderPath?: string;
}

export default function FolderView({
  folderCid,
  folderName = "Folder",
  mainFolderActualName,
  subFolderPath,
}: FolderViewProps) {
  const router = useRouter();
  const { getParam } = useUrlParams();
  const { polkadotAddress } = useWalletAuth();
  const [activeSubMenuItem] = useAtom(activeSubMenuItemAtom);
  const [files, setFiles] = useState<FormattedUserFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [isDownloading, setIsDownloading] = useState(false);
  const isPrivateFolder = activeSubMenuItem === "Private";
  const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);
  const addFolderButtonRef = useRef<object>({});

  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [shouldResetPagination, setShouldResetPagination] = useState(false);
  const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedFileSize, setSelectedFileSize] = useState(0);

  const [syncFolderPath, setSyncFolderPath] = useState<string>("");
  const [isLoadingSyncPath, setIsLoadingSyncPath] = useState(true);
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);

  const filteredData = useMemo(() => {
    return filterFiles(files, {
      searchTerm,
      fileTypes: selectedFileTypes,
      dateFilter: selectedDate,
      fileSize: selectedFileSize,
    });
  }, [files, searchTerm, selectedFileTypes, selectedDate, selectedFileSize]);

  // Shared pagination state between list and card views
  const { paginatedData, setCurrentPage, currentPage, totalPages } =
    usePagination(filteredData, 12);

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
  }, [searchTerm, selectedFileTypes, selectedDate, selectedFileSize, viewMode]);

  // Handle pagination reset
  useEffect(() => {
    if (shouldResetPagination) {
      setCurrentPage(1);
    }
  }, [shouldResetPagination, setCurrentPage]);

  const loadFolderContents = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading) {
          setIsLoading(true);
        } else {
          setIsRefreshing(true);
        }

        // Parse the folder path into an array of folder names
        const folderPath = getFolderPathArray(
          mainFolderActualName,
          subFolderPath
        );

        const fileEntries = await invoke<FileEntry[]>("list_folder_contents", {
          accountId: polkadotAddress,
          scope: isPrivateFolder ? "private" : "public",
          mainFolderName: mainFolderActualName || null,
          subfolderPath: folderPath || null,
        });

        console.log("Fetched folder contents:", fileEntries);

        const formattedFiles = fileEntries.map((entry): FormattedUserFile => {
          const isErasureCodedFolder = entry.file_name.endsWith(
            ".folder.ec_metadata"
          );
          const isErasureCoded =
            !isErasureCodedFolder && entry.file_name.endsWith(".ec_metadata");
          const isFolder =
            !isErasureCodedFolder && entry.file_name.endsWith(".folder");

          let displayName = entry.file_name;
          if (isErasureCodedFolder) {
            displayName = entry.file_name.slice(
              0,
              -".folder.ec_metadata".length
            );
          } else if (isErasureCoded) {
            displayName = entry.file_name.slice(0, -".ec_metadata".length);
          } else if (isFolder) {
            displayName = entry.file_name.slice(0, -".folder".length);
          }
          return {
            cid: entry.cid,
            name: displayName || "Unnamed File",
            actualFileName: entry.file_name,
            size: entry.file_size,
            type: isPrivateFolder ? "private" : "public",
            fileHash: entry.file_hash,
            isAssigned: true,
            source: entry.source || "Unknown",
            createdAt: Number(entry.created_at),
            minerIds: parseMinerIds(entry.miner_ids),
            lastChargedAt: Number(entry.last_charged_at),
            isErasureCoded,
            isFolder: isFolder || entry.is_folder,
            parentFolderId: folderCid,
            parentFolderName: folderName,
            mainReqHash: entry.main_req_hash,
          };
        });

        setFiles(formattedFiles);
      } catch (error) {
        console.error("Error loading folder contents:", error);
        // toast.error(
        //     `Failed to load folder contents: ${error instanceof Error ? error.message : String(error)}`
        // );
      } finally {
        if (showLoading) {
          setIsLoading(false);
        } else {
          setIsRefreshing(false);
        }
      }
    },
    [
      folderCid,
      folderName,
      mainFolderActualName,
      subFolderPath,
      isPrivateFolder,
      polkadotAddress,
    ]
  );

  useEffect(() => {
    loadFolderContents();
  }, [loadFolderContents]);

  // Load sync path based on current view (private/public)
  useEffect(() => {
    (async () => {
      try {
        setIsLoadingSyncPath(true);
        const path = isPrivateFolder
          ? await getPrivateSyncPath()
          : await getPublicSyncPath();
        setSyncFolderPath(path || "");
      } catch (error) {
        console.error("Failed to load sync path:", error);
        setSyncFolderPath("");
      } finally {
        setIsLoadingSyncPath(false);
      }
    })();
  }, [isPrivateFolder]);

  // Reload sync path when settings are updated
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) {
      (async () => {
        try {
          setIsLoadingSyncPath(true);
          const path = isPrivateFolder
            ? await getPrivateSyncPath()
            : await getPublicSyncPath();
          setSyncFolderPath(path || "");
        } catch (error) {
          console.error("Failed to reload sync path:", error);
          setSyncFolderPath("");
        } finally {
          setIsLoadingSyncPath(false);
        }
      })();
    }
  }, [syncPathRefreshTrigger, isPrivateFolder]);
  const handleRefresh = () => {
    loadFolderContents(false);
  };

  function handlePaginationReset() {
    setShouldResetPagination(false);
  }

  const initiateDownloadFolder = async () => {
    try {
      // Ask for output directory
      const outputDir = (await open({
        directory: true,
        multiple: false,
      })) as string | null;

      if (!outputDir) {
        return; // User canceled directory selection
      }

      const folderSource = getParam("folderSource");
      const mainReqHash = getParam("mainReqHash");

      // Download folder
      setIsDownloading(true);
      const result = await downloadFolder({
        folderCid,
        folderName,
        polkadotAddress: polkadotAddress ?? "",
        isPrivate: isPrivateFolder,
        outputDir,
        source: folderSource,
        mainReqHash: mainReqHash,
      });

      if (result && !result.success) {
        toast.error(
          `Failed to download folder: ${result.message || "Unknown error"}`
        );
      } else if (result && result.success) {
        toast.success(`Folder downloaded successfully to ${outputDir}`);
      }
    } catch (error) {
      console.error("Error downloading folder:", error);
      toast.error(
        `Failed to download folder: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
    setShouldResetPagination(true);
  }, []);

  const handleRemoveFilter = useCallback((filter: ActiveFilter) => {
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
    setShouldResetPagination(true);
  }, []);

  useEffect(() => {
    const handleFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.files && addButtonRef.current) {
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

  // Check if sync path is empty (user skipped setup)
  const isSyncPathEmpty = syncFolderPath === "";

  const folderSource = getParam("folderSource");
  const mainReqHash = getParam("mainReqHash");

  return (
    <FileSelectionProvider>
      <div className="w-full relative mt-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <button
              className="flex gap-2 font-semibold text-lg items-center"
              onClick={() => router.push("/files")}
            >
              <Icons.ArrowLeft className="size-5 text-grey-10" />
              Back
            </button>
          </div>

          <div className="flex items-center gap-4">
            <RefreshButton onClick={handleRefresh} refetching={isRefreshing} />

            <div className="">
              <SearchInput
                className="h-9"
                value={searchTerm}
                onChange={handleSearchChange}
                placeholder="Search files"
              />
            </div>

            <div className="flex gap-2 border border-grey-80 p-1 rounded">
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "list"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => handleViewModeChange("list")}
                aria-label="List View"
              >
                <List className="size-5" />
              </button>
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "card"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => handleViewModeChange("card")}
                aria-label="Card View"
              >
                <Icons.Category className="size-5" />
              </button>
            </div>

            {/* Only show upload buttons if sync path is configured */}
            {!isSyncPathEmpty && !isLoadingSyncPath && (
              <>
                <AddFolderToFolderButton
                  ref={addFolderButtonRef}
                  className="h-9"
                  folderCid={folderCid}
                  folderName={folderName}
                  isPrivateFolder={isPrivateFolder}
                  mainFolderActualName={mainFolderActualName}
                  subFolderPath={subFolderPath}
                  onFolderAdded={handleRefresh}
                />

                <AddFileToFolderButton
                  ref={addButtonRef}
                  className="h-9"
                  folderCid={folderCid}
                  folderName={folderName}
                  isPrivateFolder={isPrivateFolder}
                  onFileAdded={handleRefresh}
                />
              </>
            )}

            <button
              onClick={initiateDownloadFolder}
              disabled={isDownloading}
              className={cn(
                "flex items-center justify-center gap-1 h-9 px-4 py-2 rounded border border-grey-80 bg-grey-90 text-grey-10 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50",
                isDownloading && "opacity-70 cursor-not-allowed"
              )}
            >
              {isDownloading ? (
                <Icons.Loader className="size-4 animate-spin" />
              ) : (
                <Icons.DocumentDownload className="size-4" />
              )}
              Download Folder
            </button>
          </div>
        </div>
        <FolderBreadcrumb
          mainFolderActualName={mainFolderActualName}
          subFolderPath={subFolderPath}
          folderSource={folderSource}
          mainReqHash={mainReqHash}
        />
        {activeFilters.length > 0 && (
          <FilterChips
            filters={activeFilters}
            onRemoveFilter={handleRemoveFilter}
            className="mt-4 mb-2"
          />
        )}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Icons.Loader className="size-10 text-primary-50 animate-spin mb-4" />
            <p className="text-grey-40">Loading folder contents...</p>
          </div>
        ) : (
          <>
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 min-h-[600px]">
                <div className="w-12 h-12 rounded-full bg-primary-90 flex items-center justify-center mb-2">
                  <Icons.Folder className="size-7 text-primary-50" />
                </div>
                <h3 className="text-lg font-medium text-grey-10 mb-1">
                  Empty Folder
                </h3>
                <p className="text-grey-50 text-sm max-w-[270px] text-center">
                  This folder does not contain any files.
                </p>
              </div>
            ) : (
              <FilesContent
                isRecentFiles={false}
                isLoading={false}
                isFetching={false}
                filteredData={filteredData}
                displayedData={paginatedData}
                searchTerm={searchTerm}
                activeFilters={activeFilters}
                viewMode={viewMode}
                shouldResetPagination={shouldResetPagination}
                handlePaginationReset={handlePaginationReset}
                isPrivateView={isPrivateFolder}
                currentPage={currentPage}
                totalPages={totalPages}
                setCurrentPage={setCurrentPage}
                isSyncPathEmpty={isSyncPathEmpty}
              />
            )}
          </>
        )}
      </div>
    </FileSelectionProvider>
  );
}
