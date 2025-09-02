"use client";

import { FC, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons, RefreshButton, SearchInput } from "@/components/ui";
import { cn } from "@/lib/utils";
import AddButton from "./AddFileButton";
import StorageStateList from "./storage-stats";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import FilterChips from "./filter-chips";
import FolderUploadDialog from "./FolderUploadDialog";
import { useFilesNavigation } from "@/lib/hooks/useFilesNavigation";
import { toast } from "sonner";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { openPath } from '@tauri-apps/plugin-opener';
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import DeleteAllFilesConfirmationDialog from "./DeleteAllFilesConfirmationDialog";
import { useAtomValue } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";


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
  setIsFilterOpen: (isOpen: boolean) => void;
  refetchUserFiles: () => void;
  addButtonRef: React.RefObject<{
    openWithFiles(files: FileList): void;
  } | null>;
  privateFileCount?: number;
  publicFileCount?: number;
  syncFolderPath?: string;
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
  setIsFilterOpen,
  refetchUserFiles,
  addButtonRef,
  privateFileCount = 0,
  publicFileCount = 0,
  syncFolderPath,
}) => {
  const [isFolderUploadOpen, setIsFolderUploadOpen] = useState(false);
  const [syncFolderPermissionGranted, setSyncFolderPermissionGranted] = useLocalStorage(
    'hippius-sync-folder-permission',
    false
  );
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();
  const { navigateToFilesView } = useFilesNavigation();
  const { polkadotAddress } = useWalletAuth();
  const activeSubMenuItem = useAtomValue(activeSubMenuItemAtom);
  const currentScope = activeSubMenuItem || (isRecentFiles ? "Private" : "Public");

  const handleViewAllFiles = () => {
    // Navigate to the appropriate files view based on the file counts
    navigateToFilesView(privateFileCount, publicFileCount);
    router.push('/files');
  };

  const handleOpenSyncFolder = async () => {
    try {
      if (!syncFolderPath) {
        toast.error("Sync folder not configured");
        return;
      }

      await openPath(syncFolderPath);

      if (!syncFolderPermissionGranted) {
        setSyncFolderPermissionGranted(true);
      }
    } catch (e) {
      console.error("Failed to open sync folder:", e);

      const errorMessage = e instanceof Error ? e.message : String(e);
      if (errorMessage.includes("permission") || errorMessage.includes("denied")) {
        toast.error("Permission to open folders was denied. Please try again and allow folder access.");
        setSyncFolderPermissionGranted(false);
      } else {
        toast.error(`Failed to open folder: ${errorMessage}`);
      }
    }
  };

  const handleDeleteAllFiles = async () => {
    if (!polkadotAddress) {
      toast.error("Account ID not available");
      return;
    }

    setIsDeleting(true);
    // Create a loading toast that will be updated later
    const toastId = toast.loading(`Deleting all ${currentScope.toLowerCase()} files...`);

    try {
      await invoke("wipe_s3_objects", {
        accountId: polkadotAddress,
        scope: currentScope.toLowerCase()
      });

      // Update the toast to success
      toast.success(`All ${currentScope.toLowerCase()} files have been deleted`, { id: toastId });
      refetchUserFiles(); // Refresh the file list
    } catch (error) {
      console.error("Failed to delete files:", error);
      // Update the toast to error
      toast.error(`Failed to delete files: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <>
      {!isRecentFiles && (
        <div className="flex items-center gap-4">
          <StorageStateList
            storageUsed={formattedStorageSize}
            numberOfFiles={allFilteredDataLength || 0}
          />
        </div>
      )}
      <div className="flex justify-between items-center w-full gap-6 flex-wrap mt-5">
        {isRecentFiles ? (
          <h2 className="text-lg font-medium text-grey-10">Recent Files</h2>
        ) : (
          <div className="">
            <SearchInput
              className="h-9"
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Search file"
            />
          </div>
        )}


        <div className="flex items-center gap-3 flex-wrap">
          <RefreshButton
            refetching={isRefetching || isFetching}
            onClick={() => refetchUserFiles()}
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
            <button
              onClick={handleViewAllFiles}
              className="px-2 py-2 items-center flex bg-grey-90  border border-grey-80 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
            >
              View All Files
              <Icons.ArrowRight className="size-[14px] ml-1" />
            </button>
          )}
          {!isRecentFiles && (
            <div className="flex border border-grey-80 p-1 rounded cursor-pointer" onClick={() => setIsFilterOpen(true)}>
              <button
                className="flex justify-center items-center p-1 bg-white text-grey-70 rounded"
                aria-label="Filter"
              >
                <Icons.Filter className="size-5" />
                {activeFilters.length > 0 && (
                  <span className="ml-1 p-1 bg-primary-100 text-primary-30 border border-primary-80 text-xs rounded min-w-4 h-4 flex items-center justify-center ">
                    {activeFilters.length}
                  </span>
                )}
              </button>
            </div>
          )}

          {/* Folder Upload button */}
          <button
            onClick={() => setIsFolderUploadOpen(true)}
            className="flex items-center justify-center gap-1 h-9 px-2 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
          >
            <Icons.FolderAdd className="size-4" />
            <span className="ml-1">Add Folder</span>
          </button>

          {/* Open Sync Folder button */}
          <button
            onClick={handleOpenSyncFolder}
            disabled={!syncFolderPath}
            className="flex items-center justify-between gap-1 h-9 px-2 py-2 bg-grey-100 text-sm font-meidum text-grey-10 border border-grey-80 rounded disabled:opacity-50 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
            title={syncFolderPath || "Sync folder not configured"}
          >
            <Icons.Folder className="size-4" />
            <span className="ml-1">Open Sync Folder</span>
          </button>

          {/* Delete All Files button - not showing in Recent Files view */}
          {!isRecentFiles && (
            <button
              onClick={() => setIsDeleteDialogOpen(true)}
              className="flex items-center justify-center gap-1 h-9 px-2 py-2 rounded bg-error-50 border border-error-60 text-white hover:bg-error-60 active:bg-error-70 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-error-50"
            >
              <Icons.Trash className="size-4" />
              <span className="ml-1">Delete All Files</span>
            </button>
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

      {/* Folder Upload Dialog */}
      <FolderUploadDialog
        open={isFolderUploadOpen}
        onClose={() => setIsFolderUploadOpen(false)}
        onRefresh={refetchUserFiles}
      />

      {/* Delete All Files Confirmation Dialog */}
      <DeleteAllFilesConfirmationDialog
        open={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteAllFiles}
        loading={isDeleting}
        scope={currentScope}
      />
    </>
  );
};

export default FilesHeader;
