"use client";

import { FC, useEffect, useRef, useMemo, useState } from "react";
import useUserIpfsFiles from "@/lib/hooks/use-user-ipfs-files";
import { RefreshButton, Icons, SearchInput, WaitAMoment } from "@/components/ui";
import AddButton from "./AddFileButton";
import FilesTable from "./files-table";
import CardView from "./card-view";
import { cn } from "@/lib/utils";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import FileDetailsDialog, {
  FileDetail,
} from "./files-table/UnpinFilesDialog";
import InsufficientCreditsDialog from "./InsufficientCreditsDialog";
import SidebarDialog from "@/components/ui/sidebar-dialog";
import UploadStatusWidget from "./UploadStatusWidget";
import FilterDialogContent from "./filter-dialog-content";
import IPFSNoEntriesFound from "./files-table/IpfsNoEntriesFound";

const Ipfs: FC = () => {
  const {
    data,
    isLoading,
    refetch: refetchUserFiles,
    isRefetching,
    isFetching,
    error,
  } = useUserIpfsFiles();
  const addButtonRef = useRef<{ openWithFiles(files: FileList): void }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [filterMode] = useState<"all" | "date" | "type">("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  // Unpinned files state - moved from FilesTable to parent
  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);

  // Filter out deleted files
  const filteredData = useMemo(() => {
    if (data?.files) {
      return data.files.filter((file) => !file.deleted);
    }
    return [];
  }, [data?.files]);

  // Extract unpinned file details from data
  const unpinnedFileDetails = useMemo(() => {
    if (!data?.files) return [];

    const filteredUnpinnedFiles = data.files.filter((file) => !file.isAssigned);
    return filteredUnpinnedFiles.map((file) => ({
      filename: file.name || "Unnamed File",
      cid: decodeHexCid(file.cid),
      createdAt: file.createdAt,
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

  const renderContent = () => {

    if (isLoading) {
      return <WaitAMoment />;
    }

    if (error || !filteredData.length) {
      return <IPFSNoEntriesFound />;
    }

    if (viewMode === "list") {
      return (
        <FilesTable
          showUnpinnedDialog={false}
          files={filteredData}
        />
      );
    } else {
      return (
        <CardView
          showUnpinnedDialog={false}
          files={filteredData}
        />
      );
    }
  };

  return (
    <div className="w-full relative mt-6">
      <div className="flex items-center w-full justify-end gap-6 flex-wrap">
        <div className="flex items-center gap-x-4">
          <RefreshButton
            refetching={isRefetching || isFetching}
            onClick={() => refetchUserFiles()}
          />

          <div className="">
            <SearchInput className="h-9" />
          </div>

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

          <div className="flex border border-grey-80 p-1 rounded">
            <button
              className={cn(
                "p-1 rounded cursor-pointer",
                filterMode === "date"
                  ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                  : "bg-grey-100 text-grey-70"
              )}
              onClick={() => setIsFilterOpen(true)}
              aria-label="Date Filter"
            >
              <Icons.Filter className="size-5" />
            </button>
          </div>
          {/* <div className="bg-grey-90 hover:bg-grey-80 rounded">
            <button
              className="px-4 py-3 bg-grey-90 hover:bg-grey-80 rounded text-sm font-medium text-grey-10 flex items-center gap-1 h-10"
              aria-label="Add Folder"
            >
              <Icons.FolderAdd className="size-4 text-grey-10" />
              <span>New Folder</span>
            </button>
          </div> */}

          <AddButton ref={addButtonRef} className="h-9" />
        </div>
      </div>

      <div className="w-full mt-4">
        {renderContent()}
      </div>

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
        <FilterDialogContent />
      </SidebarDialog>
    </div>
  );
};

export default Ipfs;
