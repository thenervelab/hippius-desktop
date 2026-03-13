"use client";

import { FC, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icons, RefreshButton, SearchInput } from "@/components/ui";
import { cn } from "@/lib/utils";
import AddButton from "./AddFileButton";
import StorageStateList from "./storage-stats";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import FilterChips from "./filter-chips";
import FolderUploadDialog from "./FolderUploadDialog";
import { useFilesNavigation } from "@/lib/hooks/useFilesNavigation";

import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";
import { List } from "lucide-react";
import StartSyncingButton from "@/app/components/StartSyncingButton";
import FilterPills from "./FilterPills";
import { FileTypes } from "@/lib/types/fileTypes";
import { IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";


interface FilesHeaderProps {
  isRecentFiles?: boolean;
  isRefetching?: boolean;
  isFetching?: boolean;
  formattedStorageSize: string;
  allFilteredDataLength: number;
  viewMode: "list" | "card";
  setViewMode: (mode: "list" | "card") => void;
  searchTerm: string;
  handleSearchChange: (value: string) => void;
  activeFilters: ActiveFilter[];
  handleRemoveFilter: (filter: ActiveFilter) => void;
  refetchUserFiles: () => void;
  addButtonRef: React.RefObject<{
    openWithFiles(files: FileList): void;
    openWithPaths(paths: string[]): void;
    isDialogOpen(): boolean;
  } | null>;
  privateFileCount?: number;
  publicFileCount?: number;
  isSyncPathEmpty?: boolean;
  onStartSyncing?: () => void;
  hasNoSyncPaths?: boolean;
  onNavigateToSettings?: () => void;
  isPrivateView?: boolean; // For recent files to determine upload type
  // New filter props
  selectedFileTypes: FileTypes[];
  selectedDate: string;
  selectedFileSizes: number[];
  onFileTypesChange: (types: FileTypes[]) => void;
  onDateChange: (date: string) => void;
  onFileSizesChange: (sizes: number[]) => void;
  defaultFolderLabel?: string | null;
}

const FilesHeader: FC<FilesHeaderProps> = ({
  isRecentFiles = false,
  isRefetching = false,
  isFetching = false,
  formattedStorageSize,
  allFilteredDataLength,
  viewMode,
  setViewMode,
  searchTerm,
  handleSearchChange,
  activeFilters,
  handleRemoveFilter,
  refetchUserFiles,
  addButtonRef,
  isSyncPathEmpty = false,
  onStartSyncing,
  hasNoSyncPaths = false,
  onNavigateToSettings,
  isPrivateView,
  // New filter props
  selectedFileTypes,
  selectedDate,
  selectedFileSizes,
  onFileTypesChange,
  onDateChange,
  onFileSizesChange,
  defaultFolderLabel,
}) => {
  const [isFolderUploadOpen, setIsFolderUploadOpen] = useState(false);

  const { navigateToFilesView } = useFilesNavigation();
  const { push } = useNavigationLoader();

  const handleViewAllFiles = () => {
    navigateToFilesView();
    push("/files");
  };



  return (
    <>
      {!isRecentFiles && (
        <div className="flex items-center justify-between gap-4">
          <StorageStateList
            storageUsed={formattedStorageSize}
            numberOfFiles={allFilteredDataLength || 0}
          />
          <div className="flex items-center gap-2">
            <SearchInput
              className="h-9"
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Search file"
            />
            <div className="flex gap-2 border border-grey-80 p-1 rounded justify-end">
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
                <List className="size-5" />
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
          </div>
        </div>
      )}
      <div className="flex justify-between items-center w-full gap-6 flex-wrap mt-4">
        {isRecentFiles ? (
          <h2 className="text-lg font-medium text-grey-10">Recent Files</h2>
        ) : (
          <FilterPills
            selectedFileTypes={selectedFileTypes}
            selectedDate={selectedDate}
            selectedFileSizes={selectedFileSizes}
            onFileTypesChange={onFileTypesChange}
            onDateChange={onDateChange}
            onFileSizesChange={onFileSizesChange}
          />
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <RefreshButton
            refetching={isRefetching || isFetching}
            onClick={() => {
              invoke("trigger_sync_now").catch((err: unknown) => console.warn("[FilesHeader] trigger_sync_now failed:", err));
              refetchUserFiles();
            }}
          />
          {isRecentFiles && (
            <>
              <div className="flex gap-2 border border-grey-80 p-1 rounded justify-end">
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
                  <List className="size-5" />
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
              <button
                onClick={handleViewAllFiles}
                className="px-2 py-2 items-center flex bg-grey-90  border border-grey-80 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
              >
                View All Files
                <Icons.ArrowRight className="size-[14px] ml-1" />
              </button>
            </>
          )}


          <>
            {/* Folder Upload button - disabled for recent files with no sync paths or when sync is paused */}
            {(!isRecentFiles || !hasNoSyncPaths) && !isSyncPathEmpty && (
              <button
                onClick={() => setIsFolderUploadOpen(true)}
                disabled={IS_SYNC_PAUSED}
                className={cn(
                  "flex items-center justify-center gap-1 h-9 px-2 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50",
                  IS_SYNC_PAUSED
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white"
                )}
              >
                <Icons.FolderAdd className="size-4" />
                <span className="ml-1">Add Folder</span>
              </button>
            )}
            {isRecentFiles && hasNoSyncPaths && (
              <button
                disabled
                className="flex items-center justify-center gap-1 h-9 px-2 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 opacity-50 cursor-not-allowed text-sm font-medium"
              >
                <Icons.FolderAdd className="size-4" />
                <span className="ml-1">Add Folder</span>
              </button>
            )}


            {/* Add File button - disabled for recent files with no sync paths or when sync is paused */}
            {isRecentFiles && hasNoSyncPaths ? (
              <button
                disabled
                className="flex items-center justify-center gap-1 h-9 px-2 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 opacity-50 cursor-not-allowed text-sm font-medium"
              >
                <Icons.AddCircle className="size-4" />
                <span className="ml-1">Add Files</span>
              </button>
            ) : (
              !isSyncPathEmpty && (
                <AddButton
                  ref={addButtonRef}
                  className="h-9"
                  isPrivateView={isPrivateView}
                  disabled={IS_SYNC_PAUSED}
                  defaultFolderLabel={defaultFolderLabel}
                />
              )
            )}

            {/* Start Syncing button - show for empty sync paths or no sync paths */}
            {(isSyncPathEmpty || (isRecentFiles && hasNoSyncPaths)) && (
              <StartSyncingButton
                className="h-9"
                onClick={isRecentFiles && hasNoSyncPaths ? onNavigateToSettings : onStartSyncing}
              />
            )}
          </>
        </div>
      </div>

      {/* Active Filters Display */}
      {activeFilters.length > 0 && !isRecentFiles && (
        <FilterChips
          filters={activeFilters}
          onRemoveFilter={handleRemoveFilter}
          className="mt-4 mb-2"
        />
      )}

      {/* Folder Upload Dialog */}
      <FolderUploadDialog
        open={isFolderUploadOpen}
        onClose={() => setIsFolderUploadOpen(false)}
        onRefresh={refetchUserFiles}
        defaultFolderLabel={defaultFolderLabel}
      />

    </>
  );
};

export default FilesHeader;
